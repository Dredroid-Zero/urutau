import { clampDec, normalizeRa, type SkyPosition } from './astronomy';
import { parseWcs, type Header, type WcsModel } from './astrometry';
import type { RuntimeFlagDefinition } from '../types/spherex';

export type FitsHeaderValue = string | number | boolean;

export interface FitsHdu {
  index: number;
  name: string;
  xtension: string;
  bitpix: number;
  naxis: number;
  naxes: number[];
  headers: Record<string, FitsHeaderValue>;
  dataOffset: number;
  dataByteLength: number;
  /** Row-major 2D or 3D image floats (for IMAGE HDUs) */
  imageData?: Float32Array;
  /** Raw integer bitmap (for FLAGS HDU) */
  intData?: Int32Array | Uint32Array;
  /** Parsed binary table columns (for BINTABLE HDUs) */
  tableRows?: Record<string, unknown>[];
  /** HISTORY cards from header */
  history?: string[];
}

export interface TanSipWcs {
  crval1: number;
  crval2: number;
  crpix1: number;
  crpix2: number;
  cd1_1: number;
  cd1_2: number;
  cd2_1: number;
  cd2_2: number;
  aOrder: number;
  bOrder: number;
  a: Record<string, number>;
  b: Record<string, number>;
  apOrder: number;
  bpOrder: number;
  ap: Record<string, number>;
  bp: Record<string, number>;
  ctype1: string;
  ctype2: string;
  crpix1a?: number;
  crpix2a?: number;
}

export interface SpherexFlagSummary {
  totalPixels: number;
  flaggedPixels: number;
  cleanFraction: number;
  countsByFlag: Record<string, number>;
}

export interface WaveWcsTable {
  xGrid: number[];
  yGrid: number[];
  values: Float32Array; // [2 * ny * nx]: (wavelength_um, bandwidth_um)
  crpix1w: number;
  crpix2w: number;
}

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/**
 * Parses a Multi-Extension FITS (MEF) ArrayBuffer into structured HDUs.
 */
export function parseFitsBuffer(buffer: ArrayBuffer): FitsHdu[] {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const hdus: FitsHdu[] = [];
  let offset = 0;
  let index = 0;

  while (offset + 2880 <= bytes.length) {
    const headers: Record<string, FitsHeaderValue> = {};
    const history: string[] = [];
    let ended = false;

    while (!ended && offset + 2880 <= bytes.length) {
      for (let i = 0; i < 36; i++) {
        const cardBytes = bytes.subarray(offset + i * 80, offset + (i + 1) * 80);
        const card = asciiDecode(cardBytes);
        const keyword = card.slice(0, 8).trim();
        if (keyword === 'END') {
          ended = true;
          break;
        }
        if (keyword === 'HISTORY') {
          history.push(card.slice(8).trim());
          continue;
        }
        if (!keyword || keyword === 'COMMENT') continue;

        if (keyword === 'HIERARCH') {
          const eqIdx = card.indexOf('=');
          if (eqIdx > 9) {
            const hKey = card.slice(9, eqIdx).trim();
            const val = parseCardValue(card.slice(eqIdx + 1));
            if (val !== undefined) headers[hKey] = val;
          }
          continue;
        }

        if (card[8] === '=' && card[9] === ' ') {
          const val = parseCardValue(card.slice(10));
          if (val !== undefined) headers[keyword] = val;
        }
      }
      offset += 2880;
    }

    const bitpix = Number(headers.BITPIX ?? 8);
    const naxis = Number(headers.NAXIS ?? 0);
    const naxes: number[] = [];
    for (let a = 1; a <= naxis; a++) {
      naxes.push(Number(headers[`NAXIS${a}`] ?? 0));
    }
    const pcount = Number(headers.PCOUNT ?? 0);
    const gcount = Number(headers.GCOUNT ?? 1);
    const xtension = String(headers.XTENSION ?? (index === 0 ? 'PRIMARY' : 'UNKNOWN')).trim();
    const name = String(headers.EXTNAME ?? (index === 0 ? 'PRIMARY' : `HDU_${index}`)).trim();

    let elemCount = 0;
    if (naxis > 0) {
      elemCount = naxes.reduce((acc, dim) => acc * dim, 1);
    }
    const rawDataBytes = naxis === 0 ? 0 : gcount * (pcount + elemCount) * (Math.abs(bitpix) / 8);
    const paddedBytes = Math.ceil(rawDataBytes / 2880) * 2880;
    const dataOffset = offset;

    const hdu: FitsHdu = {
      index,
      name,
      xtension,
      bitpix,
      naxis,
      naxes,
      headers,
      dataOffset,
      dataByteLength: rawDataBytes,
      history: history.length > 0 ? history : undefined,
    };

    if (rawDataBytes > 0 && dataOffset + rawDataBytes <= bytes.length) {
      if (xtension === 'PRIMARY' || xtension === 'IMAGE') {
        const bscale = Number(headers.BSCALE ?? 1);
        const bzero = Number(headers.BZERO ?? 0);
        if (name === 'FLAGS' && (bitpix === 32 || bitpix === 16 || bitpix === 64)) {
          hdu.intData = decodeIntArray(view, dataOffset, elemCount, bitpix, bzero);
        } else {
          hdu.imageData = decodeFloatArray(view, dataOffset, elemCount, bitpix, bscale, bzero);
        }
      } else if (xtension === 'BINTABLE' && (name === 'WCS-WAVE' || name === 'EPSF')) {
        hdu.tableRows = parseBinTableHdu(bytes, view, dataOffset, headers, naxes);
      }
    }

    hdus.push(hdu);
    offset += paddedBytes;
    index++;
  }

  return hdus;
}

function asciiDecode(slice: Uint8Array): string {
  let out = '';
  for (let i = 0; i < slice.length; i++) {
    out += String.fromCharCode(slice[i]);
  }
  return out;
}

function parseCardValue(raw: string): FitsHeaderValue | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("'")) {
    // FITS string value
    let val = '';
    for (let i = 1; i < trimmed.length; i++) {
      if (trimmed[i] === "'") {
        if (trimmed[i + 1] === "'") {
          val += "'";
          i++;
        } else {
          return val.trimEnd();
        }
      } else {
        val += trimmed[i];
      }
    }
    return val.trimEnd();
  }
  const slashIdx = trimmed.indexOf('/');
  const token = (slashIdx >= 0 ? trimmed.slice(0, slashIdx) : trimmed).trim();
  if (token === 'T') return true;
  if (token === 'F') return false;
  const num = Number(token);
  if (!Number.isNaN(num) && token !== '') return num;
  return token;
}

function decodeFloatArray(
  view: DataView,
  offset: number,
  count: number,
  bitpix: number,
  bscale: number,
  bzero: number,
): Float32Array {
  const out = new Float32Array(count);
  const step = Math.abs(bitpix) / 8;
  for (let i = 0; i < count; i++) {
    const pos = offset + i * step;
    let raw = 0;
    if (bitpix === -32) {
      raw = view.getFloat32(pos, false);
    } else if (bitpix === -64) {
      raw = view.getFloat64(pos, false);
    } else if (bitpix === 16) {
      raw = view.getInt16(pos, false);
    } else if (bitpix === 32) {
      raw = view.getInt32(pos, false);
    } else if (bitpix === 8) {
      raw = view.getUint8(pos);
    }
    out[i] = bscale === 1 && bzero === 0 ? raw : raw * bscale + bzero;
  }
  return out;
}

function decodeIntArray(
  view: DataView,
  offset: number,
  count: number,
  bitpix: number,
  bzero: number,
): Uint32Array {
  const out = new Uint32Array(count);
  const step = Math.abs(bitpix) / 8;
  for (let i = 0; i < count; i++) {
    const pos = offset + i * step;
    let raw = 0;
    if (bitpix === 32) {
      raw = view.getInt32(pos, false) + bzero;
    } else if (bitpix === 16) {
      raw = view.getInt16(pos, false) + bzero;
    } else if (bitpix === 64) {
      raw = Number(view.getBigInt64(pos, false));
    }
    out[i] = raw >>> 0;
  }
  return out;
}

function parseBinTableHdu(
  bytes: Uint8Array,
  view: DataView,
  dataOffset: number,
  headers: Record<string, FitsHeaderValue>,
  naxes: number[],
): Record<string, unknown>[] {
  const rowBytes = naxes[0] ?? 0;
  const numRows = naxes[1] ?? 0;
  const tfields = Number(headers.TFIELDS ?? 0);
  if (rowBytes <= 0 || numRows <= 0 || tfields <= 0) return [];

  const fields: { name: string; repeat: number; code: string; byteSize: number }[] = [];
  for (let f = 1; f <= tfields; f++) {
    const name = String(headers[`TTYPE${f}`] ?? `COL_${f}`).trim();
    const tform = String(headers[`TFORM${f}`] ?? '').trim();
    const m = tform.match(/^(\d*)([A-Z])/);
    if (!m) return [];
    const repeat = m[1] ? Number(m[1]) : 1;
    const code = m[2];
    const unitBytes = code === 'D' ? 8 : code === 'E' || code === 'J' ? 4 : code === 'I' ? 2 : 1;
    fields.push({ name, repeat, code, byteSize: repeat * unitBytes });
  }

  const maxRows = Math.min(numRows, 500);
  const rows: Record<string, unknown>[] = [];
  for (let r = 0; r < maxRows; r++) {
    let cursor = dataOffset + r * rowBytes;
    const row: Record<string, unknown> = {};
    for (const field of fields) {
      if (cursor + field.byteSize > bytes.length) break;
      if (field.repeat === 1) {
        if (field.code === 'J') row[field.name] = view.getInt32(cursor, false);
        else if (field.code === 'E') row[field.name] = view.getFloat32(cursor, false);
        else if (field.code === 'D') row[field.name] = view.getFloat64(cursor, false);
        else if (field.code === 'I') row[field.name] = view.getInt16(cursor, false);
      } else {
        if (field.code === 'J') {
          const arr: number[] = [];
          for (let k = 0; k < field.repeat; k++) arr.push(view.getInt32(cursor + k * 4, false));
          row[field.name] = arr;
        } else if (field.code === 'E') {
          const arr = new Float32Array(field.repeat);
          for (let k = 0; k < field.repeat; k++) arr[k] = view.getFloat32(cursor + k * 4, false);
          row[field.name] = arr;
        } else if (field.code === 'D' && field.name !== 'EPSF') {
          const arr = new Float64Array(field.repeat);
          for (let k = 0; k < field.repeat; k++) arr[k] = view.getFloat64(cursor + k * 8, false);
          row[field.name] = arr;
        }
      }
      cursor += field.byteSize;
    }
    rows.push(row);
  }
  return rows;
}

export function extractWcsFromHeader(headers: Record<string, FitsHeaderValue>): TanSipWcs | null {
  const crval1 = Number(headers.CRVAL1);
  const crval2 = Number(headers.CRVAL2);
  const crpix1 = Number(headers.CRPIX1);
  const crpix2 = Number(headers.CRPIX2);
  if (![crval1, crval2, crpix1, crpix2].every(Number.isFinite)) return null;

  const cdelt1 = Number(headers.CDELT1 ?? 1);
  const cdelt2 = Number(headers.CDELT2 ?? 1);
  const cd1_1 = headers.CD1_1 !== undefined ? Number(headers.CD1_1) : Number(headers.PC1_1 ?? 1) * cdelt1;
  const cd1_2 = headers.CD1_2 !== undefined ? Number(headers.CD1_2) : Number(headers.PC1_2 ?? 0) * cdelt1;
  const cd2_1 = headers.CD2_1 !== undefined ? Number(headers.CD2_1) : Number(headers.PC2_1 ?? 0) * cdelt2;
  const cd2_2 = headers.CD2_2 !== undefined ? Number(headers.CD2_2) : Number(headers.PC2_2 ?? 1) * cdelt2;

  const aOrder = Number(headers.A_ORDER ?? 0);
  const bOrder = Number(headers.B_ORDER ?? 0);
  const apOrder = Number(headers.AP_ORDER ?? 0);
  const bpOrder = Number(headers.BP_ORDER ?? 0);

  const a: Record<string, number> = {};
  const b: Record<string, number> = {};
  const ap: Record<string, number> = {};
  const bp: Record<string, number> = {};

  for (const [k, v] of Object.entries(headers)) {
    if (typeof v !== 'number') continue;
    if (/^A_\d+_\d+$/.test(k)) a[k] = v;
    else if (/^B_\d+_\d+$/.test(k)) b[k] = v;
    else if (/^AP_\d+_\d+$/.test(k)) ap[k] = v;
    else if (/^BP_\d+_\d+$/.test(k)) bp[k] = v;
  }

  return {
    crval1,
    crval2,
    crpix1,
    crpix2,
    cd1_1,
    cd1_2,
    cd2_1,
    cd2_2,
    aOrder,
    bOrder,
    a,
    b,
    apOrder,
    bpOrder,
    ap,
    bp,
    ctype1: String(headers.CTYPE1 ?? 'RA---TAN'),
    ctype2: String(headers.CTYPE2 ?? 'DEC--TAN'),
    crpix1a: headers.CRPIX1A !== undefined ? Number(headers.CRPIX1A) : undefined,
    crpix2a: headers.CRPIX2A !== undefined ? Number(headers.CRPIX2A) : undefined,
  };
}

function evalSipPoly(coeffs: Record<string, number>, prefix: string, order: number, u: number, v: number): number {
  if (order <= 0) return 0;
  let sum = 0;
  for (let p = 0; p <= order; p++) {
    for (let q = 0; q <= order - p; q++) {
      const c = coeffs[`${prefix}_${p}_${q}`];
      if (c) sum += c * Math.pow(u, p) * Math.pow(v, q);
    }
  }
  return sum;
}

/**
 * Converts 0-based image pixel coordinates (x0, y0) to ICRS (ra, dec) using TAN-SIP WCS.
 */
export function pixelToWorld(x0: number, y0: number, wcs: TanSipWcs): SkyPosition {
  // FITS 1-based pixel coordinates
  const u = (x0 + 1) - wcs.crpix1;
  const v = (y0 + 1) - wcs.crpix2;
  const uDist = u + evalSipPoly(wcs.a, 'A', wcs.aOrder, u, v);
  const vDist = v + evalSipPoly(wcs.b, 'B', wcs.bOrder, u, v);

  // Intermediate world coordinates (xi, eta) in degrees -> radians
  const xi = (wcs.cd1_1 * uDist + wcs.cd1_2 * vDist) * DEG2RAD;
  const eta = (wcs.cd2_1 * uDist + wcs.cd2_2 * vDist) * DEG2RAD;

  const ra0 = wcs.crval1 * DEG2RAD;
  const dec0 = wcs.crval2 * DEG2RAD;
  const cosDec0 = Math.cos(dec0);
  const sinDec0 = Math.sin(dec0);

  const rho = Math.hypot(xi, eta);
  if (rho === 0) {
    return { ra: normalizeRa(wcs.crval1), dec: clampDec(wcs.crval2) };
  }
  const c = Math.atan(rho);
  const sinC = Math.sin(c);
  const cosC = Math.cos(c);

  const dec = Math.asin(cosC * sinDec0 + (eta * sinC * cosDec0) / rho);
  const ra = ra0 + Math.atan2(xi * sinC, rho * cosDec0 * cosC - eta * sinDec0 * sinC);

  return {
    ra: normalizeRa(ra * RAD2DEG),
    dec: clampDec(dec * RAD2DEG),
  };
}

/**
 * Converts ICRS (ra, dec) to 0-based pixel coordinates (x0, y0) using TAN-SIP WCS.
 */
export function worldToPixel(raDeg: number, decDeg: number, wcs: TanSipWcs): { x: number; y: number } | null {
  const ra = raDeg * DEG2RAD;
  const dec = decDeg * DEG2RAD;
  const ra0 = wcs.crval1 * DEG2RAD;
  const dec0 = wcs.crval2 * DEG2RAD;

  const cosDec = Math.cos(dec);
  const sinDec = Math.sin(dec);
  const cosDec0 = Math.cos(dec0);
  const sinDec0 = Math.sin(dec0);
  const dRa = ra - ra0;

  const denom = sinDec0 * sinDec + cosDec0 * cosDec * Math.cos(dRa);
  if (denom <= 0) return null;

  const xi = ((cosDec * Math.sin(dRa)) / denom) * RAD2DEG;
  const eta = ((cosDec0 * sinDec - sinDec0 * cosDec * Math.cos(dRa)) / denom) * RAD2DEG;

  const det = wcs.cd1_1 * wcs.cd2_2 - wcs.cd1_2 * wcs.cd2_1;
  if (Math.abs(det) < 1e-18) return null;

  const uDist = (wcs.cd2_2 * xi - wcs.cd1_2 * eta) / det;
  const vDist = (-wcs.cd2_1 * xi + wcs.cd1_1 * eta) / det;

  let u = uDist;
  let v = vDist;

  if (wcs.apOrder > 0 || wcs.bpOrder > 0) {
    u = uDist + evalSipPoly(wcs.ap, 'AP', wcs.apOrder, uDist, vDist);
    v = vDist + evalSipPoly(wcs.bp, 'BP', wcs.bpOrder, uDist, vDist);
  } else if (wcs.aOrder > 0 || wcs.bOrder > 0) {
    // Fixed-point refinement when inverse SIP keywords aren't present
    for (let iter = 0; iter < 5; iter++) {
      u = uDist - evalSipPoly(wcs.a, 'A', wcs.aOrder, u, v);
      v = vDist - evalSipPoly(wcs.b, 'B', wcs.bOrder, u, v);
    }
  }

  return {
    x: u + wcs.crpix1 - 1,
    y: v + wcs.crpix2 - 1,
  };
}

export function extractWaveWcs(hdu: FitsHdu, imageHeaders: Record<string, FitsHeaderValue>): WaveWcsTable | null {
  if (!hdu.tableRows || hdu.tableRows.length === 0) return null;
  const row = hdu.tableRows[0];
  const xGrid = row.X as number[] | undefined;
  const yGrid = row.Y as number[] | undefined;
  const values = row.VALUES as Float32Array | undefined;
  if (!xGrid || !yGrid || !values) return null;
  return {
    xGrid,
    yGrid,
    values,
    crpix1w: Number(imageHeaders.CRPIX1W ?? imageHeaders.CRPIX1A ?? 0),
    crpix2w: Number(imageHeaders.CRPIX2W ?? imageHeaders.CRPIX2A ?? 0),
  };
}

/**
 * Bilinear interpolation of central wavelength (um) and bandwidth (um) at 0-based cutout pixel (x0, y0).
 */
export function wavelengthAtPixel(x0: number, y0: number, wave: WaveWcsTable): { wavelengthUm: number; bandwidthUm: number } {
  // Convert 0-based cutout pixel to 1-based original detector coords used by WCS-WAVE
  const xOrig = 1 + x0 - wave.crpix1w;
  const yOrig = 1 + y0 - wave.crpix2w;
  const nx = wave.xGrid.length;
  const ny = wave.yGrid.length;

  let i0 = 0;
  for (let i = 0; i < nx - 1; i++) {
    if (xOrig >= wave.xGrid[i]) i0 = i;
  }
  const i1 = Math.min(nx - 1, i0 + 1);

  let j0 = 0;
  for (let j = 0; j < ny - 1; j++) {
    if (yOrig >= wave.yGrid[j]) j0 = j;
  }
  const j1 = Math.min(ny - 1, j0 + 1);

  const tx = i1 === i0 ? 0 : Math.max(0, Math.min(1, (xOrig - wave.xGrid[i0]) / (wave.xGrid[i1] - wave.xGrid[i0])));
  const ty = j1 === j0 ? 0 : Math.max(0, Math.min(1, (yOrig - wave.yGrid[j0]) / (wave.yGrid[j1] - wave.yGrid[j0])));

  const getVal = (ix: number, jy: number, comp: 0 | 1) => wave.values[(jy * nx + ix) * 2 + comp];
  const interp = (comp: 0 | 1) => {
    const v00 = getVal(i0, j0, comp);
    const v10 = getVal(i1, j0, comp);
    const v01 = getVal(i0, j1, comp);
    const v11 = getVal(i1, j1, comp);
    return (1 - tx) * (1 - ty) * v00 + tx * (1 - ty) * v10 + (1 - tx) * ty * v01 + tx * ty * v11;
  };

  return { wavelengthUm: interp(0), bandwidthUm: interp(1) };
}

export const SPHEREX_DEFAULT_FLAGS: { bit: number; name: string }[] = [
  { bit: 0, name: 'TRANSIENT' },
  { bit: 1, name: 'OVERFLOW' },
  { bit: 2, name: 'SUR_ERROR' },
  { bit: 6, name: 'NONFUNC' },
  { bit: 7, name: 'DICHROIC' },
  { bit: 9, name: 'MISSING_DATA' },
  { bit: 15, name: 'NONLINEAR' },
  { bit: 17, name: 'PERSIST' },
  { bit: 18, name: 'SNOWBALL' },
  { bit: 19, name: 'BLOOM' },
  { bit: 20, name: 'HALO' },
];

export function extractFlagDefinitions(headers: Record<string, FitsHeaderValue>): RuntimeFlagDefinition[] {
  const defs: RuntimeFlagDefinition[] = [];
  for (let bit = 0; bit < 32; bit++) {
    const suffix = String(bit).padStart(4, '0');
    const name = headers[`MSKN${suffix}`];
    if (typeof name === 'string' && name.trim()) {
      const desc = headers[`MSKD${suffix}`];
      const maskVal = headers[`MSKM${suffix}`];
      defs.push({
        bit,
        mask: typeof maskVal === 'number' ? maskVal : 1 << bit,
        name: name.trim(),
        description: typeof desc === 'string' ? desc.trim() : name.trim(),
      });
    }
  }
  return defs;
}

export function toAstrometryWcs(headers: Record<string, FitsHeaderValue>): WcsModel | null {
  try {
    const normalized: Header = { ...headers };
    // Support CD matrix headers (e.g. DR1 HiPS Cube or legacy WCS) by translating to PC + CDELT=1
    if (normalized.PC1_1 === undefined && normalized.CD1_1 !== undefined) {
      normalized.PC1_1 = Number(normalized.CD1_1);
      normalized.PC1_2 = Number(normalized.CD1_2 ?? 0);
      normalized.PC2_1 = Number(normalized.CD2_1 ?? 0);
      normalized.PC2_2 = Number(normalized.CD2_2 ?? 1);
      normalized.CDELT1 = 1;
      normalized.CDELT2 = 1;
    }
    return parseWcs(normalized);
  } catch {
    return null;
  }
}

export function summarizeFlags(flags: Uint32Array | Int32Array, headers: Record<string, FitsHeaderValue>): SpherexFlagSummary {
  const runtimeDefs = extractFlagDefinitions(headers);
  const defs = runtimeDefs.length > 0
    ? runtimeDefs.map((d) => ({ mask: d.mask, name: d.name }))
    : SPHEREX_DEFAULT_FLAGS.map((f) => ({ mask: 1 << f.bit, name: f.name }));

  const countsByFlag: Record<string, number> = {};
  for (const d of defs) countsByFlag[d.name] = 0;

  let flaggedPixels = 0;
  for (let i = 0; i < flags.length; i++) {
    const val = flags[i] >>> 0;
    if (val !== 0) flaggedPixels++;
    for (const d of defs) {
      if ((val & d.mask) !== 0) countsByFlag[d.name]++;
    }
  }

  return {
    totalPixels: flags.length,
    flaggedPixels,
    cleanFraction: flags.length > 0 ? 1 - flaggedPixels / flags.length : 1,
    countsByFlag,
  };
}

export type StretchMode = 'linear' | 'log' | 'sqrt' | 'asinh' | 'zscale';

export function computePercentileLimits(data: Float32Array, lowPct = 2, highPct = 99.2): { min: number; max: number; median: number } {
  const finite: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (Number.isFinite(v)) finite.push(v);
  }
  if (finite.length === 0) return { min: 0, max: 1, median: 0 };
  finite.sort((a, b) => a - b);
  const lo = finite[Math.floor((lowPct / 100) * (finite.length - 1))];
  const hi = finite[Math.floor((highPct / 100) * (finite.length - 1))];
  const med = finite[Math.floor(0.5 * (finite.length - 1))];
  return {
    min: lo,
    max: hi > lo ? hi : lo + 1e-3,
    median: med,
  };
}

export function stretchNormalized(value: number, vmin: number, vmax: number, mode: StretchMode): number {
  if (!Number.isFinite(value)) return 0;
  const span = Math.max(1e-9, vmax - vmin);
  const norm = Math.max(0, Math.min(1, (value - vmin) / span));
  switch (mode) {
    case 'linear':
      return norm;
    case 'sqrt':
      return Math.sqrt(norm);
    case 'log':
      return Math.log10(1 + 999 * norm) / 3;
    case 'asinh': {
      const a = 0.08;
      return Math.asinh(norm / a) / Math.asinh(1 / a);
    }
    case 'zscale':
    default: {
      const a = 0.14;
      return Math.asinh(norm / a) / Math.asinh(1 / a);
    }
  }
}

function formatFitsCard(key: string, val: FitsHeaderValue): string {
  const k = key.toUpperCase().slice(0, 8).padEnd(8, ' ');
  if (typeof val === 'boolean') {
    return `${k}=                    ${val ? 'T' : 'F'}`.padEnd(80, ' ').slice(0, 80);
  }
  if (typeof val === 'number') {
    const numStr = Number.isInteger(val) ? String(val) : val.toPrecision(10);
    return `${k}= ${numStr.padStart(20, ' ')}`.padEnd(80, ' ').slice(0, 80);
  }
  const escaped = String(val).replace(/'/g, "''").slice(0, 66);
  return `${k}= '${escaped}'`.padEnd(80, ' ').slice(0, 80);
}

/**
 * Serializes a processed/derived 2D Float32 image as a valid FITS file,
 * preserving provenance headers and appending HISTORY cards.
 */
export function buildProcessedFitsBuffer(params: {
  width: number;
  height: number;
  data: Float32Array;
  wcs?: WcsModel | null;
  preservedHeaders?: Record<string, FitsHeaderValue>;
  historyEntries: string[];
}): ArrayBuffer {
  const { width, height, data, wcs, preservedHeaders = {}, historyEntries } = params;
  const cards: string[] = [
    formatFitsCard('SIMPLE', true),
    formatFitsCard('BITPIX', -32),
    formatFitsCard('NAXIS', 2),
    formatFitsCard('NAXIS1', width),
    formatFitsCard('NAXIS2', height),
  ];

  const skipKeys = new Set([
    'SIMPLE', 'BITPIX', 'NAXIS', 'NAXIS1', 'NAXIS2', 'EXTEND', 'END',
    'CRPIX1', 'CRPIX2', 'CRVAL1', 'CRVAL2', 'PC1_1', 'PC1_2', 'PC2_1', 'PC2_2', 'CDELT1', 'CDELT2',
  ]);
  for (const [k, v] of Object.entries(preservedHeaders)) {
    if (skipKeys.has(k.toUpperCase()) || v === undefined || v === '') continue;
    if (/^[A-Z0-9_-]{1,8}$/i.test(k)) {
      cards.push(formatFitsCard(k, v));
    }
  }

  if (wcs) {
    cards.push(formatFitsCard('CTYPE1', 'RA---TAN'));
    cards.push(formatFitsCard('CTYPE2', 'DEC--TAN'));
    cards.push(formatFitsCard('CRPIX1', wcs.crpix[0]));
    cards.push(formatFitsCard('CRPIX2', wcs.crpix[1]));
    cards.push(formatFitsCard('CRVAL1', wcs.crval[0]));
    cards.push(formatFitsCard('CRVAL2', wcs.crval[1]));
    cards.push(formatFitsCard('PC1_1', wcs.pc[0][0]));
    cards.push(formatFitsCard('PC1_2', wcs.pc[0][1]));
    cards.push(formatFitsCard('PC2_1', wcs.pc[1][0]));
    cards.push(formatFitsCard('PC2_2', wcs.pc[1][1]));
    cards.push(formatFitsCard('CDELT1', wcs.cdelt[0]));
    cards.push(formatFitsCard('CDELT2', wcs.cdelt[1]));
  }

  for (const entry of historyEntries) {
    // Wrap long history lines to 72 chars per FITS card
    for (let i = 0; i < entry.length; i += 70) {
      cards.push(`HISTORY ${entry.slice(i, i + 70)}`.padEnd(80, ' '));
    }
  }
  cards.push('END'.padEnd(80, ' '));

  const headerBlocks = Math.ceil((cards.length * 80) / 2880);
  const headerBytes = headerBlocks * 2880;
  const rawDataBytes = width * height * 4;
  const dataBlocks = Math.ceil(rawDataBytes / 2880);
  const totalBytes = headerBytes + dataBlocks * 2880;

  const buf = new ArrayBuffer(totalBytes);
  const bytes = new Uint8Array(buf);
  bytes.fill(32, 0, headerBytes);
  for (let idx = 0; idx < cards.length; idx++) {
    const c = cards[idx];
    for (let j = 0; j < 80; j++) {
      bytes[idx * 80 + j] = c.charCodeAt(j);
    }
  }

  const view = new DataView(buf);
  for (let i = 0; i < width * height; i++) {
    view.setFloat32(headerBytes + i * 4, data[i], false);
  }
  return buf;
}

