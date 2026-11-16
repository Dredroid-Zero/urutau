import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CUTOUT_DEFAULTS,
  estimateCutoutTransfer,
  SEARCHABLE_COLLECTIONS,
  SPHEREX_ENDPOINTS,
  TAP_SCHEMA_CONFIG,
} from './src/config/spherex';
import { getSpherexHipsCubeTileInfo, SPHEREX_BANDS } from './src/lib/astronomy';
import {
  extractFlagDefinitions,
  extractWaveWcs,
  extractWcsFromHeader,
  parseFitsBuffer,
  summarizeFlags,
  toAstrometryWcs,
  wavelengthAtPixel,
  worldToPixel,
} from './src/lib/fits';
import type {
  ArchiveDiagnostics,
  GaiaSource,
  ResolvedTargetInfo,
  SpherexObservation,
} from './src/types/spherex';

const projectRoot = process.cwd();

export interface UrutauServerOptions {
  port?: number;
  host?: string;
  staticDir?: string;
  dataDir?: string;
  production?: boolean;
}

export interface UrutauServerHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
}

export const SPHEREX_DR1_CUBE_WAVELENGTHS_UM = [
  0.753, 0.771, 0.790, 0.809, 0.828, 0.848, 0.868, 0.889, 0.910, 0.932, 0.955, 0.978, 1.001, 1.025, 1.050, 1.075, 1.102,
  1.113, 1.139, 1.167, 1.195, 1.224, 1.254, 1.284, 1.315, 1.346, 1.378, 1.412, 1.446, 1.481, 1.517, 1.554, 1.592, 1.631,
  1.656, 1.695, 1.735, 1.775, 1.818, 1.861, 1.905, 1.949, 1.995, 2.041, 2.089, 2.139, 2.189, 2.240, 2.292, 2.345, 2.399,
  2.445, 2.506, 2.575, 2.646, 2.719, 2.794, 2.871, 2.951, 3.033, 3.118, 3.204, 3.293, 3.383, 3.476, 3.570, 3.667, 3.768,
  3.833, 3.867, 3.901, 3.935, 3.970, 4.005, 4.040, 4.076, 4.112, 4.148, 4.184, 4.220, 4.257, 4.294, 4.331, 4.368, 4.405,
  4.435, 4.467, 4.500, 4.533, 4.566, 4.600, 4.635, 4.669, 4.704, 4.739, 4.773, 4.808, 4.843, 4.879, 4.915, 4.951, 4.988,
];

// Bounded LRU-like in-memory caches
const cutoutCache = new Map<string, { timestamp: number; payload: unknown }>();
const MAX_CUTOUT_CACHE = 48;
let cachedMocBuffer: { timestamp: number; buf: Buffer } | null = null;

function setCache(key: string, payload: unknown) {
  if (cutoutCache.size >= MAX_CUTOUT_CACHE) {
    const oldestKey = cutoutCache.keys().next().value;
    if (oldestKey) cutoutCache.delete(oldestKey);
  }
  cutoutCache.set(key, { timestamp: Date.now(), payload });
}

// Bounded concurrency limiter for upstream IRSA/Gaia/SIMBAD requests
function createConcurrencyLimiter(maxConcurrent: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return async function runLimited<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= maxConcurrent) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = queue.shift();
      if (next) next();
    }
  };
}

const upstreamLimit = createConcurrencyLimiter(CUTOUT_DEFAULTS.maxConcurrentDownloads);

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 15000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'User-Agent': 'URUTAU-Astronomical-Explorer/2.0 (GEPPAA-UNILAB)',
        ...(init.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  timeoutMs = 15000,
  maxAttempts: number = CUTOUT_DEFAULTS.retryAttempts,
): Promise<Response> {
  let lastResp: Response | null = null;
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const resp = await upstreamLimit(() => fetchWithTimeout(url, init, timeoutMs));
      if (resp.ok || (resp.status >= 400 && resp.status < 500 && resp.status !== 429)) {
        return resp;
      }
      lastResp = resp;
    } catch (err) {
      lastErr = err as Error;
    }
    if (attempt < maxAttempts - 1) {
      const delayMs = 450 * Math.pow(2.2, attempt);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  if (lastResp) return lastResp;
  throw lastErr ?? new Error('Upstream request failed after retries.');
}

function decodeXmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function parseVotableRows(xml: string): { fields: string[]; rows: Record<string, string>[] } {
  const fields: string[] = [];
  const fieldRegex = /<FIELD\b[^>]*>/gi;
  let fMatch: RegExpExecArray | null;
  while ((fMatch = fieldRegex.exec(xml)) !== null) {
    const tag = fMatch[0];
    const nameMatch = tag.match(/\bname="([^"]+)"/i) || tag.match(/\bID="([^"]+)"/i);
    fields.push(nameMatch ? nameMatch[1] : `col_${fields.length}`);
  }

  const rows: Record<string, string>[] = [];
  const trRegex = /<TR>([\s\S]*?)<\/TR>/gi;
  let trMatch: RegExpExecArray | null;
  while ((trMatch = trRegex.exec(xml)) !== null) {
    const trBody = trMatch[1];
    const tdRegex = /<TD>([\s\S]*?)<\/TD>/gi;
    let tdMatch: RegExpExecArray | null;
    const row: Record<string, string> = {};
    let idx = 0;
    while ((tdMatch = tdRegex.exec(trBody)) !== null) {
      const colName = fields[idx] ?? `col_${idx}`;
      row[colName] = decodeXmlEntities(tdMatch[1]);
      idx++;
    }
    if (idx > 0) rows.push(row);
  }
  return { fields, rows };
}

function parseFootprintPolygon(sRegion?: string): [number, number][] | undefined {
  if (!sRegion) return undefined;
  const polyMatch = sRegion.match(/POLYGON(?:\s+ICRS)?\s+([\d\s.+eE-]+)$/i);
  if (!polyMatch) return undefined;
  const nums = polyMatch[1].trim().split(/\s+/).map(Number).filter(Number.isFinite);
  if (nums.length < 6) return undefined;
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    pts.push([nums[i], nums[i + 1]]);
  }
  return pts.length >= 3 ? pts : undefined;
}

function parsePathMetadata(accessUrl: string, bandpassRaw?: string) {
  let detector = 1;
  const detMatch = accessUrl.match(/_\d+D([1-6])_spx/i) || bandpassRaw?.match(/D([1-6])/i);
  if (detMatch) detector = Number(detMatch[1]);
  const bandInfo = SPHEREX_BANDS[Math.max(0, Math.min(5, detector - 1))];

  let cutoutPath = '';
  const pathMatch = accessUrl.match(/\/ibe\/data\/spherex\/([^?]+)/i);
  if (pathMatch) cutoutPath = pathMatch[1];

  const periodMatch = cutoutPath.match(/level2\/([^/]+)\//i);
  const versionMatch = cutoutPath.match(/\/(l2b-v\d+-[^/]+)\//i);
  const obsMatch = cutoutPath.match(/level2_(.+?)D[1-6]_spx/i);
  const relMatch = cutoutPath.match(/^(dr1|qr3|qr2|dr2)\//i);

  return {
    detector,
    cutoutPath,
    planningPeriod: periodMatch?.[1] ?? 'Unknown',
    version: versionMatch?.[1] ?? 'v1',
    obsIdFromPath: obsMatch?.[1],
    releaseFromPath: relMatch ? (relMatch[1].toUpperCase() as 'DR1' | 'QR3' | 'QR2' | 'DR2') : undefined,
    bandpassName: bandInfo.bandpassName,
    lambdaMinUm: bandInfo.lambdaMinUm,
    lambdaMaxUm: bandInfo.lambdaMaxUm,
  };
}

function parseVersionRank(ver?: string): number {
  if (!ver) return 0;
  const m = ver.match(/v(\d+)/i);
  const dateM = ver.match(/(\d{4}-\d{2,3})/);
  const major = m ? Number(m[1]) * 1_000_000 : 0;
  const sub = dateM ? Number(dateM[1].replace('-', '')) : 0;
  return major + sub;
}

function mapRowToObservation(
  row: Record<string, string>,
  fallbackCollection: SpherexObservation['collection'],
  provenanceSource: SpherexObservation['provenanceSource'],
  queryRa: number,
  queryDec: number,
): SpherexObservation | null {
  const accessUrlRaw = row.access_url || row.uri || '';
  if (!accessUrlRaw) return null;
  const accessUrl = accessUrlRaw.startsWith('http')
    ? accessUrlRaw
    : `https://irsa.ipac.caltech.edu/${accessUrlRaw.replace(/^\/+/, '')}`;

  const meta = parsePathMetadata(accessUrl, row.energy_bandpassname || row.em_min);
  const obsId = row.obs_id || meta.obsIdFromPath || row.obs_publisher_did || 'SPHEREx-OBS';
  const mjdObs = Number(row.t_min || row.time_bounds_lower || 0);
  const dateObs = mjdObs > 40000
    ? new Date((mjdObs - 40587) * 86400 * 1000).toISOString()
    : row.t_min || 'Unknown';
  const ra = Number(row.s_ra ?? row.ra ?? queryRa);
  const dec = Number(row.s_dec ?? row.dec ?? queryDec);
  const release = meta.releaseFromPath ?? (fallbackCollection.includes('qr3') ? 'QR3' : 'DR1');
  const isDeep = fallbackCollection.endsWith('_deep') || accessUrl.includes('deep');
  const col =
    release === 'QR3'
      ? isDeep
        ? 'spherex_qr3_deep'
        : 'spherex_qr3'
      : isDeep
      ? 'spherex_dr1_deep'
      : 'spherex_dr1';

  const est = estimateCutoutTransfer(CUTOUT_DEFAULTS.defaultFovDeg, 1);

  return {
    id: `${col}-${obsId}-D${meta.detector}-${meta.version}`,
    obsId,
    productId: row.obs_publisher_did || `${obsId}D${meta.detector}_${meta.version}`,
    planningPeriod: meta.planningPeriod,
    version: meta.version,
    collection: col,
    release,
    surveyMode: isDeep ? 'Deep' : 'Wide',
    detector: meta.detector,
    bandpassName: meta.bandpassName,
    lambdaMinUm: meta.lambdaMinUm,
    lambdaMaxUm: meta.lambdaMaxUm,
    dateObs,
    mjdObs,
    ra: Number.isFinite(ra) ? ra : queryRa,
    dec: Number.isFinite(dec) ? dec : queryDec,
    exposureSec: Number.isFinite(Number(row.t_exptime)) ? Number(row.t_exptime) : undefined,
    sRegion: row.s_region || row.poly || undefined,
    footprintPolygon: parseFootprintPolygon(row.s_region || row.poly),
    estimatedSizeMb: Number(est.mbPerFrame.toFixed(2)),
    qualityStatus: row.calib_level ? `Level ${row.calib_level}` : 'Level 2',
    accessUrl: accessUrl.split('?')[0],
    cutoutPath: meta.cutoutPath,
    cloudAccess: row.cloud_access || undefined,
    provenanceSource,
    fetchStatus: 'listed',
  };
}

function deduplicateObservations(list: SpherexObservation[]): {
  deduped: SpherexObservation[];
  removed: number;
} {
  const byKey = new Map<string, SpherexObservation>();
  let removed = 0;
  for (const obs of list) {
    const key = `${obs.obsId}::D${obs.detector}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, obs);
    } else {
      removed++;
      if (parseVersionRank(obs.version) > parseVersionRank(existing.version)) {
        byKey.set(key, obs);
      }
    }
  }
  return { deduped: Array.from(byKey.values()), removed };
}

// Verified real QR3 consecutive slews from IRSA SPHEREx Archive Documentation
const VERIFIED_QR3_MULTI_SLEW: SpherexObservation[] = [
  {
    id: 'verified-2026W21_2A_0001_2D1',
    obsId: '2026W21_2A_0001_2',
    productId: 'level2_2026W21_2A_0001_2D1_spx_l2b-v27-2026-268',
    planningPeriod: '2026W21_2A',
    version: 'l2b-v27-2026-268',
    collection: 'spherex_qr3',
    release: 'QR3',
    surveyMode: 'Wide',
    detector: 1,
    bandpassName: 'SPHEREx-D1',
    lambdaMinUm: 0.75,
    lambdaMaxUm: 1.09,
    dateObs: '2026-05-21T12:08:41.580Z',
    mjdObs: 61181.506037,
    ra: 337.8783221,
    dec: -5.1891588,
    exposureSec: 112.5,
    estimatedSizeMb: 3.96,
    qualityStatus: 'Pass (L2DQAFLG)',
    accessUrl: 'https://irsa.ipac.caltech.edu/ibe/data/spherex/qr3/level2/2026W21_2A/l2b-v27-2026-268/1/level2_2026W21_2A_0001_2D1_spx_l2b-v27-2026-268.fits',
    cutoutPath: 'qr3/level2/2026W21_2A/l2b-v27-2026-268/1/level2_2026W21_2A_0001_2D1_spx_l2b-v27-2026-268.fits',
    provenanceSource: 'IRSA-CUTOUT-VERIFIED',
    fetchStatus: 'listed',
  },
  {
    id: 'verified-2026W21_2A_0001_3D1',
    obsId: '2026W21_2A_0001_3',
    productId: 'level2_2026W21_2A_0001_3D1_spx_l2b-v27-2026-268',
    planningPeriod: '2026W21_2A',
    version: 'l2b-v27-2026-268',
    collection: 'spherex_qr3',
    release: 'QR3',
    surveyMode: 'Wide',
    detector: 1,
    bandpassName: 'SPHEREx-D1',
    lambdaMinUm: 0.75,
    lambdaMaxUm: 1.09,
    dateObs: '2026-05-21T12:10:50.511Z',
    mjdObs: 61181.507529,
    ra: 337.8783221,
    dec: -5.1891588,
    exposureSec: 112.5,
    estimatedSizeMb: 3.96,
    qualityStatus: 'Pass (L2DQAFLG)',
    accessUrl: 'https://irsa.ipac.caltech.edu/ibe/data/spherex/qr3/level2/2026W21_2A/l2b-v27-2026-268/1/level2_2026W21_2A_0001_3D1_spx_l2b-v27-2026-268.fits',
    cutoutPath: 'qr3/level2/2026W21_2A/l2b-v27-2026-268/1/level2_2026W21_2A_0001_3D1_spx_l2b-v27-2026-268.fits',
    provenanceSource: 'IRSA-CUTOUT-VERIFIED',
    fetchStatus: 'listed',
  },
  {
    id: 'verified-2026W21_2A_0001_4D1',
    obsId: '2026W21_2A_0001_4',
    productId: 'level2_2026W21_2A_0001_4D1_spx_l2b-v27-2026-268',
    planningPeriod: '2026W21_2A',
    version: 'l2b-v27-2026-268',
    collection: 'spherex_qr3',
    release: 'QR3',
    surveyMode: 'Wide',
    detector: 1,
    bandpassName: 'SPHEREx-D1',
    lambdaMinUm: 0.75,
    lambdaMaxUm: 1.09,
    dateObs: '2026-05-21T12:12:59.443Z',
    mjdObs: 61181.509021,
    ra: 337.8783221,
    dec: -5.1891588,
    exposureSec: 112.5,
    estimatedSizeMb: 3.96,
    qualityStatus: 'Pass (L2DQAFLG)',
    accessUrl: 'https://irsa.ipac.caltech.edu/ibe/data/spherex/qr3/level2/2026W21_2A/l2b-v27-2026-268/1/level2_2026W21_2A_0001_4D1_spx_l2b-v27-2026-268.fits',
    cutoutPath: 'qr3/level2/2026W21_2A/l2b-v27-2026-268/1/level2_2026W21_2A_0001_4D1_spx_l2b-v27-2026-268.fits',
    provenanceSource: 'IRSA-CUTOUT-VERIFIED',
    fetchStatus: 'listed',
  },
];

export async function startServer(options: UrutauServerOptions = {}): Promise<UrutauServerHandle> {
  const app = express();
  const port = options.port ?? 3000;
  const host = options.host ?? '127.0.0.1';
  const staticDir = options.staticDir ?? path.join(projectRoot, 'dist');
  const dataDir = options.dataDir ?? path.join(projectRoot, 'data');
  const production = options.production ?? process.env.NODE_ENV === 'production';
  app.use(express.json({ limit: '4mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'urutau-backend', timestamp: new Date().toISOString() });
  });

  // Live TAP schema check for spherex
  app.get('/api/spherex/tap-schema', async (_req, res) => {
    const query = `SELECT table_name, column_name, datatype, unit, description FROM TAP_SCHEMA.columns WHERE table_name LIKE '${TAP_SCHEMA_CONFIG.schemaName}.%'`;
    try {
      const resp = await fetchWithRetry(
        SPHEREX_ENDPOINTS.irsaTapSync,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            REQUEST: 'doQuery',
            LANG: 'ADQL',
            FORMAT: 'votable',
            QUERY: query,
          }).toString(),
        },
        CUTOUT_DEFAULTS.tapTimeoutMs,
        2,
      );
      if (!resp.ok) {
        res.status(resp.status).json({
          ok: false,
          status: resp.status,
          errorType: 'service_outage',
          message: `IRSA TAP returned HTTP ${resp.status} for TAP_SCHEMA.columns.`,
        });
        return;
      }
      const xml = await resp.text();
      const { rows } = parseVotableRows(xml);
      res.json({ ok: true, count: rows.length, columns: rows });
    } catch (err) {
      res.status(504).json({
        ok: false,
        errorType: 'timeout',
        message: `IRSA TAP schema check failed: ${(err as Error).message}`,
      });
    }
  });

  // Resolve astronomical target name via SIMBAD / CDS Sesame (returns full coordinates, epoch, PM)
  app.get('/api/resolve-target', async (req, res) => {
    const name = String(req.query.name ?? '').trim();
    if (!name) {
      res.status(400).json({ error: 'Missing target name', errorType: 'validation' });
      return;
    }

    // 1. Try CDS Sesame mirrors (verified reliable)
    for (const base of SPHEREX_ENDPOINTS.sesameMirrors) {
      const url = `${base}?${encodeURIComponent(name)}`;
      try {
        const resp = await fetchWithRetry(url, {}, 8000, 2);
        if (!resp.ok) continue;
        const xml = await resp.text();
        const raMatch = xml.match(/<jradeg>([^<]+)<\/jradeg>/);
        const decMatch = xml.match(/<jdedeg>([^<]+)<\/jdedeg>/);
        if (!raMatch || !decMatch) continue;
        const onameMatch = xml.match(/<oname>([^<]+)<\/oname>/);
        const otypeMatch = xml.match(/<otype>([^<]+)<\/otype>/);
        const pmRaMatch = xml.match(/<pmRA>([^<]+)<\/pmRA>/);
        const pmDecMatch = xml.match(/<pmDE>([^<]+)<\/pmDE>/);

        const resolved: ResolvedTargetInfo = {
          query: name,
          name: onameMatch ? decodeXmlEntities(onameMatch[1]) : name,
          ra: Number(raMatch[1]),
          dec: Number(decMatch[1]),
          pmRaMasYr: pmRaMatch ? Number(pmRaMatch[1]) : 0,
          pmDecMasYr: pmDecMatch ? Number(pmDecMatch[1]) : 0,
          epochYear: 2000.0,
          otype: otypeMatch ? decodeXmlEntities(otypeMatch[1]) : 'Astronomical Object',
          source: `CDS Sesame (${new URL(base).hostname})`,
          resolvedAt: new Date().toISOString(),
        };
        res.json(resolved);
        return;
      } catch {
        // try next mirror
      }
    }

    // 2. Try SIMBAD TAP fallback if reachable
    try {
      const safeName = name.replace(/'/g, "''");
      const adql = `SELECT TOP 1 main_id, ra, dec, pmra, pmdec, otype FROM basic JOIN ident ON basic.oid = ident.oidref WHERE ident.id = '${safeName}'`;
      const resp = await fetchWithRetry(
        SPHEREX_ENDPOINTS.simbadTapSync,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            REQUEST: 'doQuery',
            LANG: 'ADQL',
            FORMAT: 'votable',
            QUERY: adql,
          }).toString(),
        },
        8000,
        1,
      );
      if (resp.ok) {
        const xml = await resp.text();
        const { rows } = parseVotableRows(xml);
        if (rows.length > 0 && Number.isFinite(Number(rows[0].ra))) {
          const r = rows[0];
          const resolved: ResolvedTargetInfo = {
            query: name,
            name: r.main_id || name,
            ra: Number(r.ra),
            dec: Number(r.dec),
            pmRaMasYr: Number(r.pmra || 0),
            pmDecMasYr: Number(r.pmdec || 0),
            epochYear: 2000.0,
            otype: r.otype || 'Astronomical Object',
            source: 'SIMBAD TAP',
            resolvedAt: new Date().toISOString(),
          };
          res.json(resolved);
          return;
        }
      }
    } catch {
      // ignore
    }

    res.status(404).json({
      error: `Target "${name}" could not be resolved via SIMBAD / CDS Sesame.`,
      errorType: 'not_found',
    });
  });

  // Gaia DR3 Cone Search proxy (VizieR IDIA primary + ARI Heidelberg TAP fallback)
  app.get('/api/gaia-dr3', async (req, res) => {
    const ra = Number(req.query.ra);
    const dec = Number(req.query.dec);
    const radiusDeg = Math.min(0.25, Math.max(0.01, Number(req.query.radius ?? 0.05)));
    if (!Number.isFinite(ra) || !Number.isFinite(dec)) {
      res.status(400).json({ error: 'Invalid RA/Dec parameters.' });
      return;
    }

    // 1. VizieR IDIA ASU-TSV (verified fast & reliable)
    try {
      const vizierUrl = `${SPHEREX_ENDPOINTS.gaiaVizierMirror}?-source=I/355/gaiadr3&-c=${ra.toFixed(6)}%20${dec.toFixed(6)}&-c.rd=${radiusDeg.toFixed(4)}&-out=Source,RA_ICRS,DE_ICRS,pmRA,pmDE,Gmag&-out.sort=Gmag&-out.max=80`;
      const resp = await fetchWithRetry(vizierUrl, {}, 12000, 2);
      if (resp.ok) {
        const tsv = await resp.text();
        const lines = tsv.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
        if (lines.length >= 3) {
          const headers = lines[0].split('\t').map((h) => h.trim());
          // Skip unit row (line 1) and dashed separator row (line 2)
          const sources: GaiaSource[] = [];
          for (let i = 3; i < lines.length; i++) {
            const cols = lines[i].split('\t');
            if (cols.length < 3) continue;
            const row: Record<string, string> = {};
            headers.forEach((h, idx) => {
              row[h] = (cols[idx] ?? '').trim();
            });
            const sRa = Number(row.RA_ICRS);
            const sDec = Number(row.DE_ICRS);
            if (!Number.isFinite(sRa) || !Number.isFinite(sDec)) continue;
            sources.push({
              sourceId: row.Source || `Gaia-${i}`,
              ra: sRa,
              dec: sDec,
              pmra: Number.isFinite(Number(row.pmRA)) ? Number(row.pmRA) : 0,
              pmdec: Number.isFinite(Number(row.pmDE)) ? Number(row.pmDE) : 0,
              gMag: Number.isFinite(Number(row.Gmag)) ? Number(row.Gmag) : undefined,
              epochYear: 2016.0,
            });
          }
          res.json({
            ra,
            dec,
            radiusDeg,
            epochYear: 2016.0,
            mirrorUsed: 'VizieR IDIA (I/355/gaiadr3)',
            sources,
          });
          return;
        }
      }
    } catch {
      // fall through to ARI TAP
    }

    // 2. ARI Heidelberg Gaia TAP fallback
    try {
      const adql = `SELECT TOP 80 source_id, ra, dec, pmra, pmdec, phot_g_mean_mag FROM gaiadr3.gaia_source WHERE 1=CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', ${ra.toFixed(6)}, ${dec.toFixed(6)}, ${radiusDeg.toFixed(4)})) ORDER BY phot_g_mean_mag ASC`;
      const resp = await fetchWithRetry(
        SPHEREX_ENDPOINTS.gaiaAriTapSync,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            REQUEST: 'doQuery',
            LANG: 'ADQL',
            FORMAT: 'csv',
            QUERY: adql,
          }).toString(),
        },
        15000,
        2,
      );
      if (resp.ok) {
        const csv = await resp.text();
        const lines = csv.split(/\r?\n/).filter((l) => l.trim());
        const sources: GaiaSource[] = [];
        for (let i = 1; i < lines.length; i++) {
          const [sourceId, sRa, sDec, pmra, pmdec, gmag] = lines[i].split(',');
          if (!Number.isFinite(Number(sRa)) || !Number.isFinite(Number(sDec))) continue;
          sources.push({
            sourceId,
            ra: Number(sRa),
            dec: Number(sDec),
            pmra: Number(pmra) || 0,
            pmdec: Number(pmdec) || 0,
            gMag: Number.isFinite(Number(gmag)) ? Number(gmag) : undefined,
            epochYear: 2016.0,
          });
        }
        res.json({
          ra,
          dec,
          radiusDeg,
          epochYear: 2016.0,
          mirrorUsed: 'ARI Heidelberg Gaia DR3 TAP',
          sources,
        });
        return;
      }
    } catch (err) {
      res.status(504).json({
        error: `Gaia DR3 lookup failed on all mirrors: ${(err as Error).message}`,
        errorType: 'service_outage',
      });
      return;
    }

    res.status(502).json({
      error: 'Gaia DR3 mirrors are currently unreachable.',
      errorType: 'service_outage',
    });
  });

  // Observation Query: Primary IRSA TAP + SIA2 fallback/cross-check + DR1 Cube probe
  app.get('/api/spherex/observations', async (req, res) => {
    const ra = Number(req.query.ra);
    const dec = Number(req.query.dec);
    const radius = Math.min(1.0, Math.max(0.01, Number(req.query.radius ?? 0.15)));
    const detectorFilter = req.query.detector ? Number(req.query.detector) : undefined;

    if (!Number.isFinite(ra) || !Number.isFinite(dec) || dec < -90 || dec > 90) {
      res.status(400).json({ error: 'Invalid RA or Dec coordinates.', errorType: 'validation' });
      return;
    }

    const cubeInfo = getSpherexHipsCubeTileInfo(ra, dec);
    const diagnostics: ArchiveDiagnostics = {
      tapStatus: 'skipped',
      tapMessage: '',
      siaStatus: 'skipped',
      siaMessage: '',
      cubeAvailable: false,
      cubeInfo,
      dedupRemovedCount: 0,
      queriedAt: new Date().toISOString(),
    };

    const rawObservations: SpherexObservation[] = [];

    // 1. Check live SPHEREx DR1 All-Sky HiPS Cube availability for this coordinate
    const cubeProbePromise = fetchWithTimeout(
      `${SPHEREX_ENDPOINTS.irsaHipsCube}/Norder5/Dir${cubeInfo.dirId}/Npix${cubeInfo.ipix}_1.png`,
      { method: 'HEAD' },
      6000,
    )
      .then((r) => {
        diagnostics.cubeAvailable = r.ok;
      })
      .catch(() => {
        diagnostics.cubeAvailable = false;
      });

    // 2. Primary Query: IRSA TAP on spherex.artifact JOIN spherex.plane
    const bandClause =
      detectorFilter && detectorFilter >= 1 && detectorFilter <= 6
        ? ` AND p.energy_bandpassname = 'SPHEREx-D${detectorFilter}'`
        : '';
    const adql = `SELECT TOP 200 'https://irsa.ipac.caltech.edu/' || a.uri AS uri, a.planeid, p.time_bounds_lower, p.energy_bandpassname, p.poly FROM ${TAP_SCHEMA_CONFIG.artifactTable} a JOIN ${TAP_SCHEMA_CONFIG.planeTable} p ON a.planeid = p.planeid WHERE 1 = CONTAINS(POINT('ICRS', ${ra.toFixed(6)}, ${dec.toFixed(6)}), p.poly)${bandClause} ORDER BY p.time_bounds_lower`;

    const tapPromise = (async () => {
      try {
        const tapResp = await fetchWithRetry(
          SPHEREX_ENDPOINTS.irsaTapSync,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              REQUEST: 'doQuery',
              LANG: 'ADQL',
              FORMAT: 'votable',
              QUERY: adql,
            }).toString(),
          },
          CUTOUT_DEFAULTS.tapTimeoutMs,
          2,
        );
        if (!tapResp.ok) {
          diagnostics.tapStatus = 'upstream_error';
          diagnostics.tapMessage = `IRSA TAP returned HTTP ${tapResp.status} (external IRSA proxy/gateway error).`;
          return false;
        }
        const tapXml = await tapResp.text();
        if (tapXml.includes('QUERY_STATUS') && tapXml.includes('ERROR')) {
          diagnostics.tapStatus = 'upstream_error';
          diagnostics.tapMessage = 'IRSA TAP query returned VOTABLE ERROR.';
          return false;
        }
        const { fields, rows } = parseVotableRows(tapXml);
        diagnostics.tapStatus = 'ok';
        diagnostics.tapColumnsCount = fields.length;
        diagnostics.tapMessage = `IRSA TAP returned ${rows.length} record(s).`;
        for (const r of rows) {
          const obs = mapRowToObservation(r, 'spherex_dr1', 'IRSA-TAP', ra, dec);
          if (obs) rawObservations.push(obs);
        }
        return true;
      } catch (err) {
        diagnostics.tapStatus = 'timeout';
        diagnostics.tapMessage = `IRSA TAP timed out: ${(err as Error).message}`;
        return false;
      }
    })();

    const [, tapOk] = await Promise.all([cubeProbePromise, tapPromise]);

    // 3. SIA2 Fallback (or cross-check) across DR1 & QR3 collections
    if (!tapOk || rawObservations.length === 0) {
      const siaErrors: number[] = [];
      let siaSuccess = 0;
      await Promise.all(
        SEARCHABLE_COLLECTIONS.map(async (col) => {
          const url = `${SPHEREX_ENDPOINTS.irsaSia2}?COLLECTION=${col}&POS=circle+${ra.toFixed(6)}+${dec.toFixed(6)}+${radius.toFixed(4)}`;
          try {
            const resp = await fetchWithRetry(url, {}, 12000, 2);
            if (!resp.ok) {
              siaErrors.push(resp.status);
              return;
            }
            const text = await resp.text();
            if (text.includes('QUERY_STATUS') && text.includes('ERROR')) {
              siaErrors.push(500);
              return;
            }
            siaSuccess++;
            const { rows } = parseVotableRows(text);
            for (const r of rows) {
              const obs = mapRowToObservation(r, col, 'IRSA-SIA2', ra, dec);
              if (obs && (!detectorFilter || obs.detector === detectorFilter)) {
                rawObservations.push(obs);
              }
            }
          } catch {
            siaErrors.push(504);
          }
        }),
      );

      if (siaSuccess === 0 && siaErrors.length > 0) {
        diagnostics.siaStatus = siaErrors.includes(504) ? 'timeout' : 'upstream_error';
        diagnostics.siaMessage = `IRSA SIA2 returned HTTP ${siaErrors[0]} (external IRSA service outage).`;
      } else {
        diagnostics.siaStatus = 'ok';
        diagnostics.siaMessage = `IRSA SIA2 queried ${siaSuccess}/${SEARCHABLE_COLLECTIONS.length} collections (${rawObservations.length} records).`;
      }
    } else {
      diagnostics.siaStatus = 'skipped';
      diagnostics.siaMessage = 'Primary TAP query succeeded; SIA2 fallback skipped.';
    }

    const { deduped, removed } = deduplicateObservations(rawObservations);
    diagnostics.dedupRemovedCount = removed;
    deduped.sort((a, b) => a.mjdObs - b.mjdObs);

    res.json({
      ra,
      dec,
      radius,
      observations: deduped,
      diagnostics,
      cubeWavelengthsUm: SPHEREX_DR1_CUBE_WAVELENGTHS_UM,
    });
  });

  app.get('/api/spherex/verified-multislew', (_req, res) => {
    res.json({
      fieldTitle: 'SPHEREx QR3 Multi-Slew Calibration Pointing (2026W21_2A_0001)',
      ra: 337.8783221,
      dec: -5.1891588,
      observations: VERIFIED_QR3_MULTI_SLEW,
    });
  });

  // Cutout download & multi-HDU FITS parse (with concurrency limit, 3x retries, 2-min timeout)
  app.get('/api/spherex/cutout', async (req, res) => {
    const cutoutPath = String(req.query.path ?? '').trim();
    const ra = Number(req.query.ra);
    const dec = Number(req.query.dec);
    const size = Math.min(
      CUTOUT_DEFAULTS.maxFovDeg,
      Math.max(CUTOUT_DEFAULTS.minFovDeg, Number(req.query.size ?? CUTOUT_DEFAULTS.defaultFovDeg)),
    );

    if (!cutoutPath || cutoutPath.includes('..') || !/^(dr1|qr3|qr2|dr2)\//.test(cutoutPath)) {
      res.status(400).json({ error: 'Invalid SPHEREx IBE cutout path.', errorType: 'validation' });
      return;
    }
    if (!Number.isFinite(ra) || !Number.isFinite(dec)) {
      res.status(400).json({ error: 'Invalid RA/Dec parameters.', errorType: 'validation' });
      return;
    }

    const cacheKey = `${cutoutPath}|${ra.toFixed(5)}|${dec.toFixed(5)}|${size.toFixed(3)}`;
    const cached = cutoutCache.get(cacheKey);
    if (cached) {
      res.json(cached.payload);
      return;
    }

    const irsaUrl = `${SPHEREX_ENDPOINTS.irsaIbeBase}/${cutoutPath}?center=${ra},${dec}&size=${size}&gzip=false`;
    try {
      const resp = await fetchWithRetry(irsaUrl, {}, CUTOUT_DEFAULTS.cutoutTimeoutMs, CUTOUT_DEFAULTS.retryAttempts);
      if (!resp.ok) {
        res.status(resp.status).json({
          error: `IRSA Cutout Service returned HTTP ${resp.status} for ${cutoutPath}.`,
          errorType: resp.status >= 500 ? 'service_outage' : 'archive_error',
          irsaUrl,
        });
        return;
      }

      const arrayBuf = await resp.arrayBuffer();
      const hdus = parseFitsBuffer(arrayBuf);
      const primaryHdu = hdus[0];
      const imageHdu = hdus.find((h) => h.name === 'IMAGE') ?? hdus.find((h) => h.imageData);
      if (!imageHdu || !imageHdu.imageData) {
        res.status(422).json({
          error: 'Downloaded FITS cutout did not contain a readable IMAGE HDU.',
          errorType: 'parse_error',
        });
        return;
      }

      const flagsHdu = hdus.find((h) => h.name === 'FLAGS');
      const varianceHdu = hdus.find((h) => h.name === 'VARIANCE');
      const zodiHdu = hdus.find((h) => h.name === 'ZODI');
      const waveHdu = hdus.find((h) => h.name === 'WCS-WAVE');

      const width = imageHdu.naxes[0] ?? 0;
      const height = imageHdu.naxes[1] ?? 0;
      const wcs = extractWcsFromHeader(imageHdu.headers);
      const astrometryWcs = toAstrometryWcs(imageHdu.headers);
      const waveWcs = waveHdu ? extractWaveWcs(waveHdu, imageHdu.headers) : null;
      const flagDefinitions = flagsHdu ? extractFlagDefinitions(flagsHdu.headers) : [];
      const flagSummary = flagsHdu?.intData
        ? summarizeFlags(flagsHdu.intData, flagsHdu.headers)
        : undefined;

      // Compute central wavelength & bandwidth at the requested sky coordinate (not assuming cutout center = target)
      let targetWavelengthUm: number | undefined;
      let targetBandwidthUm: number | undefined;
      if (waveWcs && wcs) {
        const px = worldToPixel(ra, dec, wcs);
        if (px) {
          const cx = Math.max(0, Math.min(width - 1, px.x));
          const cy = Math.max(0, Math.min(height - 1, px.y));
          const w = wavelengthAtPixel(cx, cy, waveWcs);
          if (Number.isFinite(w.wavelengthUm)) targetWavelengthUm = w.wavelengthUm;
          if (Number.isFinite(w.bandwidthUm)) targetBandwidthUm = w.bandwidthUm;
        }
      }

      const version = String(primaryHdu?.headers.VERSION ?? imageHdu.headers.VERSION ?? '');
      const psfFwhmArcsec = Number(imageHdu.headers.PSF_FWHM ?? CUTOUT_DEFAULTS.psfFwhmArcsec);

      const payload = {
        width,
        height,
        image: Array.from(imageHdu.imageData, (v) => (Number.isFinite(v) ? Number(v.toFixed(6)) : null)),
        variance: varianceHdu?.imageData
          ? Array.from(varianceHdu.imageData, (v) => (Number.isFinite(v) ? Number(v.toFixed(6)) : null))
          : undefined,
        zodi: zodiHdu?.imageData
          ? Array.from(zodiHdu.imageData, (v) => (Number.isFinite(v) ? Number(v.toFixed(6)) : null))
          : undefined,
        flags: flagsHdu?.intData ? Array.from(flagsHdu.intData) : undefined,
        flagSummary,
        flagDefinitions,
        wcs,
        astrometryWcs,
        waveWcs: waveWcs
          ? {
              xGrid: waveWcs.xGrid,
              yGrid: waveWcs.yGrid,
              values: Array.from(waveWcs.values, (v) => Number(v.toFixed(5))),
              crpix1w: waveWcs.crpix1w,
              crpix2w: waveWcs.crpix2w,
            }
          : null,
        targetWavelengthUm,
        targetBandwidthUm,
        psfFwhmArcsec,
        version,
        dateObs: String(imageHdu.headers['DATE-OBS'] ?? ''),
        mjdObs: Number(imageHdu.headers['MJD-OBS'] ?? 0),
        exposureSec: Number(imageHdu.headers.XPOSURE ?? 0),
        l2DqaFlag: String(imageHdu.headers.L2DQAFLG ?? 'Unknown'),
        contaminationFlags: {
          heAirglow: Boolean(imageHdu.headers.HE_AIRGLOW_CONT),
          aurora: Boolean(imageHdu.headers.AURORA_CONT),
          shuttleGlow: Boolean(imageHdu.headers.SHUTTLE_GLOW_CONT),
        },
        headersSummary: {
          OBSID: imageHdu.headers.OBSID ?? '',
          DETECTOR: imageHdu.headers.DETECTOR ?? '',
          VERSION: version,
          BUNIT: imageHdu.headers.BUNIT ?? 'MJy / sr',
          PSF_FWHM: psfFwhmArcsec,
          CTYPE1: imageHdu.headers.CTYPE1 ?? '',
          CTYPE2: imageHdu.headers.CTYPE2 ?? '',
          CRVAL1: imageHdu.headers.CRVAL1 ?? ra,
          CRVAL2: imageHdu.headers.CRVAL2 ?? dec,
          CRPIX1A: imageHdu.headers.CRPIX1A ?? '',
          CRPIX2A: imageHdu.headers.CRPIX2A ?? '',
          ZODIMDL: zodiHdu?.headers.ZODIMDL ?? 'KEL98_WAVESCL_V1',
          FITS_BYTES: arrayBuf.byteLength,
          HDU_COUNT: hdus.length,
        },
        irsaUrl,
      };

      setCache(cacheKey, payload);
      res.json(payload);
    } catch (err) {
      res.status(502).json({
        error: `Failed to retrieve SPHEREx FITS cutout from IRSA: ${(err as Error).message}`,
        errorType: 'network_error',
        irsaUrl,
      });
    }
  });

  app.get('/api/spherex/download-fits', async (req, res) => {
    const cutoutPath = String(req.query.path ?? '').trim();
    const ra = Number(req.query.ra);
    const dec = Number(req.query.dec);
    const size = Math.min(
      CUTOUT_DEFAULTS.maxFovDeg,
      Math.max(CUTOUT_DEFAULTS.minFovDeg, Number(req.query.size ?? CUTOUT_DEFAULTS.defaultFovDeg)),
    );

    if (!cutoutPath || cutoutPath.includes('..') || !/^(dr1|qr3|qr2|dr2)\//.test(cutoutPath)) {
      res.status(400).json({ error: 'Invalid cutout path.' });
      return;
    }

    const irsaUrl = `${SPHEREX_ENDPOINTS.irsaIbeBase}/${cutoutPath}?center=${ra},${dec}&size=${size}&gzip=false`;
    try {
      const resp = await fetchWithRetry(irsaUrl, {}, CUTOUT_DEFAULTS.cutoutTimeoutMs, 2);
      if (!resp.ok) {
        res.status(resp.status).send(`Upstream IRSA error ${resp.status}`);
        return;
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      const filename = cutoutPath.split('/').pop() || 'spherex-cutout.fits';
      res.setHeader('Content-Type', 'application/fits');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(buf);
    } catch (err) {
      res.status(502).send(`Download failed: ${(err as Error).message}`);
    }
  });

  app.get('/api/spherex/cube-tile', async (req, res) => {
    const ra = Number(req.query.ra);
    const dec = Number(req.query.dec);
    const frame = Math.min(102, Math.max(1, Math.round(Number(req.query.frame ?? 1))));
    if (!Number.isFinite(ra) || !Number.isFinite(dec)) {
      res.status(400).json({ error: 'Invalid coordinates.' });
      return;
    }
    const tile = getSpherexHipsCubeTileInfo(ra, dec);
    const tileUrl = `${SPHEREX_ENDPOINTS.irsaHipsCube}/Norder5/Dir${tile.dirId}/Npix${tile.ipix}_${frame}.png`;
    try {
      const resp = await fetchWithRetry(tileUrl, {}, 12000, 2);
      if (!resp.ok) {
        res.status(resp.status).json({ error: `HiPS tile returned HTTP ${resp.status}`, tileUrl });
        return;
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(buf);
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  app.get('/api/spherex/hips-moc', async (_req, res) => {
    if (cachedMocBuffer && Date.now() - cachedMocBuffer.timestamp < 3600_000) {
      res.setHeader('Content-Type', 'application/fits');
      res.send(cachedMocBuffer.buf);
      return;
    }
    try {
      const resp = await fetchWithRetry(`${SPHEREX_ENDPOINTS.irsaHipsCube}/Moc.fits`, {}, 10000, 2);
      if (!resp.ok) {
        res.status(resp.status).send('MOC unavailable');
        return;
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      cachedMocBuffer = { timestamp: Date.now(), buf };
      res.setHeader('Content-Type', 'application/fits');
      res.send(buf);
    } catch (err) {
      res.status(502).send((err as Error).message);
    }
  });

  app.post('/api/feedback', async (req, res) => {
    const { name, affiliation, category, message } = req.body ?? {};
    if (!message || typeof message !== 'string' || message.trim().length < 5) {
      res.status(400).json({ error: 'Please provide a descriptive feedback message (min 5 characters).' });
      return;
    }

    const entry = {
      id: `fb-${Date.now()}`,
      name: String(name ?? 'Anonymous').slice(0, 120),
      affiliation: String(affiliation ?? '').slice(0, 120),
      category: String(category ?? 'scientific').slice(0, 40),
      message: message.trim().slice(0, 4000),
      createdAt: new Date().toISOString(),
    };

    try {
      await fs.mkdir(dataDir, { recursive: true });
      const filePath = path.join(dataDir, 'feedback.json');
      let list: unknown[] = [];
      try {
        const existing = await fs.readFile(filePath, 'utf-8');
        list = JSON.parse(existing);
      } catch {
        list = [];
      }
      list.unshift(entry);
      await fs.writeFile(filePath, JSON.stringify(list, null, 2), 'utf-8');
      res.json({ ok: true, entry });
    } catch (err) {
      res.status(500).json({ error: `Could not save feedback: ${(err as Error).message}` });
    }
  });

  if (!production) {
    // Development-only module, omitted from the Windows portable package.
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(staticDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  }

  return new Promise<UrutauServerHandle>((resolve, reject) => {
    const listener = app.listen(port, host);
    listener.once('error', reject);
    listener.once('listening', () => {
      const address = listener.address();
      if (!address || typeof address === 'string') {
        listener.close();
        reject(new Error('Could not determine the local listening port.'));
        return;
      }
      const url = `http://${host}:${address.port}`;
      console.log(`URUTAU server listening on ${url}`);
      resolve({
        port: address.port,
        url,
        close: () => new Promise<void>((done, fail) => {
          listener.close(err => (err ? fail(err) : done()));
        }),
      });
    });
  });
}

if (process.env.URUTAU_EMBEDDED !== '1') {
  void startServer().catch(err => {
    console.error('URUTAU could not start:', err);
    process.exitCode = 1;
  });
}
