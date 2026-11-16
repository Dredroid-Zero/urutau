import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AboutFeedback } from './components/AboutFeedback';
import { AstrometryPanel } from './components/AstrometryPanel';
import { NotebookReports } from './components/NotebookReports';
import { ObservationExplorer } from './components/ObservationExplorer';
import { SkyExplorer } from './components/SkyExplorer';
import { JourneyGuide } from './components/JourneyGuide';
import { TemporalViewer } from './components/TemporalViewer';
import { CUTOUT_DEFAULTS, FLAG_MASK_CONFIG } from './config/spherex';
import {
  angularSeparationArcsec,
  associateDetections,
  DEFAULT_CAUTION_MASK,
  DEFAULT_REJECT_MASK,
  FLAG_BITS,
  groupByDetector,
  mjdToYear,
  propagateLinear,
  type SourceStatus,
} from './lib/astrometry';
import {
  detectSourcesAsync,
  reprojectFrameAsync,
  stackFramesAsync,
} from './lib/astrometryClient';
import { degToDms, degToHms, SPHEREX_BANDS } from './lib/astronomy';
import { toAstrometryWcs } from './lib/fits';
import { TRANSLATIONS, type Language } from './lib/i18n';
import {
  deleteInvestigation,
  loadAllInvestigations,
  saveInvestigation,
} from './lib/notebookDb';
import {
  buildCommonSkyGrid,
  buildGridWcs,
  frameToAstrometryFrame,
  type ReprojectedResult,
} from './lib/processing';
import { CHALLENGE_TARGETS, type ChallengeTarget } from './lib/targets';
import type {
  ArchiveDiagnostics,
  AstrometricDetectionRecord,
  AstrometricTrackRecord,
  GaiaSource,
  InvestigationRecord,
  LoadedSpherexFrame,
  ResolvedTargetInfo,
  SpherexObservation,
} from './types/spherex';

type WorkspaceTab = 'explorer' | 'observations' | 'temporal' | 'notebook' | 'about';

function createEmptyInvestigation(
  targetName: string,
  raDeg: number,
  decDeg: number,
  radiusDeg: number,
): InvestigationRecord {
  const now = new Date().toISOString();
  return {
    id: `inv-${Date.now()}`,
    title: `${targetName} — SPHEREx Investigation`,
    targetName,
    raDeg,
    decDeg,
    regionRadiusDeg: radiusDeg,
    hypothesis: '',
    conclusions: '',
    createdAt: now,
    updatedAt: now,
    observations: [],
    detections: [],
    astrometryDetections: [],
    astrometryTracks: [],
    motionCandidates: [],
    epochNotes: [],
    snapshots: [],
  };
}

async function decodePngUrlToLuminance(
  url: string,
): Promise<{ width: number; height: number; data: Float32Array }> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} loading cube tile`);
  const blob = await resp.blob();
  const bmp = await createImageBitmap(blob);
  const size = 96;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  const sx = Math.max(0, Math.floor((bmp.width - 128) / 2));
  const sy = Math.max(0, Math.floor((bmp.height - 128) / 2));
  ctx.drawImage(bmp, sx, sy, Math.min(128, bmp.width), Math.min(128, bmp.height), 0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const srcIdx = ((size - 1 - y) * size + x) * 4;
      const lum =
        (0.2126 * img.data[srcIdx] +
          0.7152 * img.data[srcIdx + 1] +
          0.0722 * img.data[srcIdx + 2]) /
        255;
      out[y * size + x] = lum;
    }
  }
  bmp.close();
  return { width: size, height: size, data: out };
}

function readInitialUrlState() {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const ra = Number(params.get('ra'));
  const dec = Number(params.get('dec'));
  const fov = Number(params.get('fov'));
  const tabParam = params.get('t') as WorkspaceTab | null;
  const embed = params.get('embed') === '1';
  const validTabs: WorkspaceTab[] = ['explorer', 'observations', 'temporal', 'notebook', 'about'];
  return {
    ra: Number.isFinite(ra) && params.has('ra') ? ((ra % 360) + 360) % 360 : null,
    dec: Number.isFinite(dec) && params.has('dec') ? Math.max(-90, Math.min(90, dec)) : null,
    fov: Number.isFinite(fov) && fov >= 0.03 && fov <= 60 ? fov : null,
    tab: tabParam && validTabs.includes(tabParam) ? tabParam : null,
    embed,
  };
}

function enrichDetectionsWithGaia(
  detectionsByFrame: Record<string, AstrometricDetectionRecord[]>,
  gaiaSources: GaiaSource[],
): Record<string, AstrometricDetectionRecord[]> {
  if (gaiaSources.length === 0) return detectionsByFrame;
  const next: Record<string, AstrometricDetectionRecord[]> = {};
  for (const [fid, list] of Object.entries(detectionsByFrame)) {
    next[fid] = list.map((d) => {
      const year = mjdToYear(d.mjd > 0 ? d.mjd : 61000);
      let bestId: string | undefined;
      let bestSep = Infinity;
      for (const g of gaiaSources) {
        const [gra, gdec] = propagateLinear(g.ra, g.dec, g.pmra, g.pmdec, g.epochYear, year);
        const sep = angularSeparationArcsec(d.ra, d.dec, gra, gdec);
        if (sep < bestSep) {
          bestSep = sep;
          bestId = g.sourceId;
        }
      }
      return bestSep < 30
        ? { ...d, nearestGaiaId: bestId, nearestGaiaSepArcsec: bestSep }
        : { ...d, nearestGaiaId: undefined, nearestGaiaSepArcsec: undefined };
    });
  }
  return next;
}

export default function App() {
  const urlInit = useMemo(() => readInitialUrlState(), []);
  const embedMode = urlInit?.embed ?? false;

  const [lang, setLang] = useState<Language>(() => typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('pt') ? 'pt' : 'en');
  const t = TRANSLATIONS[lang];

  const [activeTab, setActiveTab] = useState<WorkspaceTab>(urlInit?.tab ?? 'explorer');
  const initialTarget = CHALLENGE_TARGETS[0]; // WISE 0855
  const [activeTarget, setActiveTarget] = useState<ChallengeTarget | null>(
    urlInit?.ra !== null ? null : initialTarget,
  );
  const [raDeg, setRaDeg] = useState<number>(urlInit?.ra ?? initialTarget.raDeg ?? 133.7951292);
  const [decDeg, setDecDeg] = useState<number>(urlInit?.dec ?? initialTarget.decDeg ?? -7.2451472);
  const [fovDeg, setFovDeg] = useState<number>(urlInit?.fov ?? 0.75);
  const [cutoutSizeDeg, setCutoutSizeDeg] = useState<number>(CUTOUT_DEFAULTS.defaultFovDeg);
  const [searchRadiusDeg, setSearchRadiusDeg] = useState<number>(0.15);

  const [resolvingTargetId, setResolvingTargetId] = useState<string | null>(null);
  const [lastResolvedInfo, setLastResolvedInfo] = useState<ResolvedTargetInfo | null>(null);

  const [observations, setObservations] = useState<SpherexObservation[]>([]);
  const [diagnostics, setDiagnostics] = useState<ArchiveDiagnostics | null>(null);
  const [cubeWavelengthsUm, setCubeWavelengthsUm] = useState<number[]>([]);
  const [isQuerying, setIsQuerying] = useState(false);
  const [loadingCutoutId, setLoadingCutoutId] = useState<string | null>(null);

  const [frames, setFrames] = useState<LoadedSpherexFrame[]>([]);
  const [reprojectedByFrame, setReprojectedByFrame] = useState<Record<string, ReprojectedResult>>({});
  const [activeFrameIdx, setActiveFrameIdx] = useState<number>(0);
  const [isStacking, setIsStacking] = useState(false);

  // Astrometry & Gaia DR3 state (wired to src/lib/astrometry.ts)
  const [snrThreshold, setSnrThreshold] = useState<number>(5.0);
  const [maxRateArcsecYr, setMaxRateArcsecYr] = useState<number>(15.0);
  const [extraScatterArcsec, setExtraScatterArcsec] = useState<number>(0);
  const [rejectMask, setRejectMask] = useState<number>(DEFAULT_REJECT_MASK);
  const [cautionMask, setCautionMask] = useState<number>(DEFAULT_CAUTION_MASK);
  const [isDetecting, setIsDetecting] = useState(false);
  const [isQueryingGaia, setIsQueryingGaia] = useState(false);
  const [gaiaSources, setGaiaSources] = useState<GaiaSource[]>([]);
  const [gaiaMirrorUsed, setGaiaMirrorUsed] = useState<string | null>(null);
  const [detectionsByFrame, setDetectionsByFrame] = useState<
    Record<string, AstrometricDetectionRecord[]>
  >({});
  const [tracks, setTracks] = useState<AstrometricTrackRecord[]>([]);
  const [selectedSource, setSelectedSource] = useState<AstrometricDetectionRecord | null>(null);

  // IndexedDB Investigation Notebook state
  const [investigations, setInvestigations] = useState<InvestigationRecord[]>([]);
  const [activeInvId, setActiveInvId] = useState<string>('');
  const [statusNotice, setStatusNotice] = useState<{ type: 'info' | 'error'; text: string } | null>(
    null,
  );

  const showNotice = useCallback((text: string, type: 'info' | 'error' = 'info') => {
    setStatusNotice({ text, type });
  }, []);

  // Sync URL query parameters cleanly via history.replaceState
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    params.set('ra', raDeg.toFixed(6));
    params.set('dec', decDeg.toFixed(6));
    params.set('fov', fovDeg.toFixed(3));
    params.set('t', activeTab);
    if (embedMode) params.set('embed', '1');
    const nextUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState(null, '', nextUrl);
  }, [raDeg, decDeg, fovDeg, activeTab, embedMode]);

  // Load persisted investigations from IndexedDB on boot
  useEffect(() => {
    let mounted = true;
    loadAllInvestigations().then((list) => {
      if (!mounted) return;
      if (list.length > 0) {
        setInvestigations(list);
        setActiveInvId(list[0].id);
      } else {
        const seed = createEmptyInvestigation(
          initialTarget.name,
          initialTarget.raDeg ?? 133.7951292,
          initialTarget.decDeg ?? -7.2451472,
          0.15,
        );
        setInvestigations([seed]);
        setActiveInvId(seed.id);
        saveInvestigation(seed);
      }
    });
    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateActiveInvestigation = useCallback(
    (patch: Partial<InvestigationRecord>) => {
      setInvestigations((prev) =>
        prev.map((inv) => {
          if (inv.id !== activeInvId) return inv;
          const updated: InvestigationRecord = {
            ...inv,
            ...patch,
            updatedAt: new Date().toISOString(),
          };
          saveInvestigation(updated);
          return updated;
        }),
      );
    },
    [activeInvId],
  );

  const handleCreateInvestigation = () => {
    const label = activeTarget
      ? activeTarget.name
      : `${degToHms(raDeg, 1)} ${degToDms(decDeg, 0)}`;
    const next = createEmptyInvestigation(label, raDeg, decDeg, searchRadiusDeg);
    setInvestigations((prev) => [next, ...prev]);
    setActiveInvId(next.id);
    saveInvestigation(next);
    setActiveTab('notebook');
    showNotice(`Created investigation "${next.title}".`);
  };

  const handleImportInvestigation = (imported: InvestigationRecord) => {
    setInvestigations((prev) => [imported, ...prev]);
    setActiveInvId(imported.id);
    saveInvestigation(imported);
    showNotice(`Imported investigation "${imported.title}".`);
  };

  const handleDeleteInvestigation = (id: string) => {
    deleteInvestigation(id);
    setInvestigations((prev) => {
      const remaining = prev.filter((i) => i.id !== id);
      if (activeInvId === id && remaining.length > 0) {
        setActiveInvId(remaining[0].id);
      }
      return remaining;
    });
  };

  const queryArchive = useCallback(
    async (qRa: number, qDec: number, qRadius = searchRadiusDeg) => {
      setIsQuerying(true);
      setStatusNotice(null);
      setObservations([]);
      setDiagnostics(null);
      try {
        const resp = await fetch(
          `/api/spherex/observations?ra=${qRa}&dec=${qDec}&radius=${qRadius}`,
        );
        const data = await resp.json();
        if (!resp.ok) {
          showNotice(data.error || 'Archive query failed.', 'error');
          return;
        }
        setObservations(data.observations || []);
        setDiagnostics(data.diagnostics || null);
        setCubeWavelengthsUm(data.cubeWavelengthsUm || []);
      } catch (err) {
        showNotice(`Network error querying IRSA archive: ${(err as Error).message}`, 'error');
      } finally {
        setIsQuerying(false);
      }
    },
    [searchRadiusDeg, showNotice],
  );

  // Initial archive query on mount
  useEffect(() => {
    queryArchive(raDeg, decDeg, 0.15);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Automatically reproject frames onto common sky-aligned grid (North up, East left) in Web Worker
  useEffect(() => {
    if (frames.length === 0) {
      setReprojectedByFrame({});
      return;
    }
    let cancelled = false;
    const grid = buildCommonSkyGrid(frames, raDeg, decDeg);

    async function runReprojections() {
      const updates: Record<string, ReprojectedResult> = {};
      for (const f of frames) {
        if (f.isStacked) {
          // Stacked frame is already on the sky-aligned grid
          const wcs = f.astrometryWcs ?? buildGridWcs(grid);
          updates[f.frameId] = {
            frameId: f.frameId,
            grid: {
              centerRa: wcs.crval[0],
              centerDec: wcs.crval[1],
              scaleArcsec: Math.abs(wcs.cdelt[0]) * 3600,
              width: f.width,
              height: f.height,
            },
            wcs,
            data: f.image,
            variance: f.variance,
            insideFootprint: new Uint8Array(f.width * f.height).fill(1),
          };
          continue;
        }
        const af = frameToAstrometryFrame(f);
        if (!af) continue;
        try {
          const rep = await reprojectFrameAsync(af, grid, rejectMask);
          if (!cancelled) {
            updates[f.frameId] = {
              frameId: f.frameId,
              grid: rep.grid,
              wcs: rep.wcs,
              data: rep.data,
              variance: rep.variance,
              insideFootprint: rep.insideFootprint,
            };
          }
        } catch {
          // ignore un-reprojectable frames
        }
      }
      if (!cancelled) {
        setReprojectedByFrame(updates);
      }
    }

    runReprojections();
    return () => {
      cancelled = true;
    };
  }, [frames, raDeg, decDeg, rejectMask]);

  const handleSelectTargetPreset = async (target: ChallengeTarget) => {
    setStatusNotice(null);
    if (!target.simbadResolveRequired && target.raDeg !== null && target.decDeg !== null) {
      setActiveTarget(target);
      setRaDeg(target.raDeg);
      setDecDeg(target.decDeg);
      setLastResolvedInfo(null);
      await queryArchive(target.raDeg, target.decDeg);
      return;
    }

    setResolvingTargetId(target.id);
    try {
      const resp = await fetch(
        `/api/resolve-target?name=${encodeURIComponent(target.simbadId)}`,
      );
      const data = await resp.json();
      if (!resp.ok) {
        showNotice(
          data.error || `Could not resolve ${target.name} via SIMBAD / CDS Sesame.`,
          'error',
        );
        return;
      }
      const resolved: ResolvedTargetInfo = data;
      const updatedTarget: ChallengeTarget = {
        ...target,
        raDeg: resolved.ra,
        decDeg: resolved.dec,
        pmRaMasYr: resolved.pmRaMasYr,
        pmDecMasYr: resolved.pmDecMasYr,
        epochYear: resolved.epochYear,
        resolvedInfo: resolved,
      };
      setActiveTarget(updatedTarget);
      setLastResolvedInfo(resolved);
      setRaDeg(resolved.ra);
      setDecDeg(resolved.dec);
      showNotice(
        `Resolved ${target.name} via ${resolved.source}: (${resolved.ra.toFixed(5)}°, ${resolved.dec.toFixed(5)}°), PM=(${resolved.pmRaMasYr.toFixed(1)}, ${resolved.pmDecMasYr.toFixed(1)}) mas/yr.`,
      );
      await queryArchive(resolved.ra, resolved.dec);
    } catch (err) {
      showNotice(`Error resolving ${target.name}: ${(err as Error).message}`, 'error');
    } finally {
      setResolvingTargetId(null);
    }
  };

  const setObsStatus = (id: string, patch: Partial<SpherexObservation>) => {
    setObservations((prev) => prev.map((o) => (o.id === id ? { ...o, ...patch } : o)));
  };

  const fetchCutoutFrame = async (obs: SpherexObservation): Promise<LoadedSpherexFrame> => {
    setObsStatus(obs.id, { fetchStatus: 'retrieving', fetchError: undefined });
    try {
      const reqRa = raDeg;
      const reqDec = decDeg;
      const resp = await fetch(
        `/api/spherex/cutout?path=${encodeURIComponent(obs.cutoutPath)}&ra=${reqRa}&dec=${reqDec}&size=${cutoutSizeDeg}`,
      );
      const data = await resp.json();
      if (!resp.ok) {
        const msg = data.error || `HTTP ${resp.status}`;
        setObsStatus(obs.id, { fetchStatus: 'failed', fetchError: msg });
        throw new Error(msg);
      }

      const toFloat32 = (arr: (number | null)[]) => {
        const out = new Float32Array(arr.length);
        for (let i = 0; i < arr.length; i++) {
          out[i] = arr[i] === null ? Number.NaN : arr[i]!;
        }
        return out;
      };

      const waveWcs = data.waveWcs
        ? {
            xGrid: data.waveWcs.xGrid,
            yGrid: data.waveWcs.yGrid,
            values: new Float32Array(data.waveWcs.values),
            crpix1w: data.waveWcs.crpix1w,
            crpix2w: data.waveWcs.crpix2w,
          }
        : null;

      const updatedObs: SpherexObservation = {
        ...obs,
        dateObs: data.dateObs || obs.dateObs,
        mjdObs: data.mjdObs || obs.mjdObs,
        exposureSec: data.exposureSec || obs.exposureSec,
        version: data.version || obs.version,
        targetWavelengthUm: data.targetWavelengthUm ?? obs.targetWavelengthUm,
        fetchStatus: 'retrieved',
        fetchError: undefined,
      };
      setObsStatus(obs.id, updatedObs);

      return {
        frameId: obs.id,
        observation: updatedObs,
        width: data.width,
        height: data.height,
        image: toFloat32(data.image),
        variance: data.variance ? toFloat32(data.variance) : undefined,
        zodi: data.zodi ? toFloat32(data.zodi) : undefined,
        flags: data.flags ? new Uint32Array(data.flags) : undefined,
        flagSummary: data.flagSummary,
        flagDefinitions: data.flagDefinitions,
        wcs: data.wcs,
        astrometryWcs: data.astrometryWcs ?? (data.wcs ? toAstrometryWcs(data.headersSummary ?? {}) : null),
        waveWcs,
        targetWavelengthUm: data.targetWavelengthUm,
        targetBandwidthUm: data.targetBandwidthUm,
        isSpectralCubeSlice: false,
        psfFwhmArcsec: data.psfFwhmArcsec,
        version: data.version,
        exposureSec: data.exposureSec,
        l2DqaFlag: data.l2DqaFlag,
        contaminationFlags: data.contaminationFlags ?? {
          heAirglow: false,
          aurora: false,
          shuttleGlow: false,
        },
        headersSummary: data.headersSummary ?? {},
        cutoutCenterRa: reqRa,
        cutoutCenterDec: reqDec,
        cutoutSizeDeg,
      };
    } catch (err) {
      setObsStatus(obs.id, { fetchStatus: 'failed', fetchError: (err as Error).message });
      throw err;
    }
  };

  const handleOpenObservation = async (obs: SpherexObservation) => {
    setLoadingCutoutId(obs.id);
    setStatusNotice(null);
    try {
      const frame = await fetchCutoutFrame(obs);
      setFrames((prev) => {
        const existsIdx = prev.findIndex((f) => f.frameId === frame.frameId);
        if (existsIdx >= 0) {
          const copy = [...prev];
          copy[existsIdx] = frame;
          setActiveFrameIdx(existsIdx);
          return copy;
        }
        const next = [...prev, frame];
        setActiveFrameIdx(next.length - 1);
        return next;
      });
      setActiveTab('temporal');
      showNotice(
        `Loaded SPHEREx FITS cutout ${obs.obsId} (${frame.width}×${frame.height} px, ${frame.observation.release} ${frame.version ?? ''}).`,
      );
    } catch (err) {
      showNotice((err as Error).message, 'error');
    } finally {
      setLoadingCutoutId(null);
    }
  };

  const handleOpenMultipleObservations = async (obsList: SpherexObservation[]) => {
    setLoadingCutoutId('batch');
    setStatusNotice(null);
    const loaded: LoadedSpherexFrame[] = [];
    const errors: string[] = [];
    for (const obs of obsList.slice(0, 8)) {
      try {
        loaded.push(await fetchCutoutFrame(obs));
      } catch (err) {
        errors.push(`${obs.obsId}: ${(err as Error).message}`);
      }
    }
    setLoadingCutoutId(null);
    if (loaded.length > 0) {
      setFrames(loaded);
      setActiveFrameIdx(0);
      setDetectionsByFrame({});
      setTracks([]);
      setSelectedSource(null);
      setActiveTab('temporal');
      showNotice(
        `Loaded ${loaded.length}/${obsList.slice(0, 8).length} cutouts${errors.length ? ` (${errors.length} failed — see table status)` : ''}.`,
      );
    } else if (errors.length > 0) {
      showNotice(errors[0], 'error');
    }
  };

  const handleLoadVerifiedMultiSlew = async () => {
    setLoadingCutoutId('verified-multislew');
    setStatusNotice(null);
    try {
      const resp = await fetch('/api/spherex/verified-multislew');
      const data = await resp.json();
      const obsList: SpherexObservation[] = data.observations || [];
      // Point target center at the verified QR3 pointing so cutouts overlap cleanly
      setRaDeg(data.ra);
      setDecDeg(data.dec);
      setActiveTarget(CHALLENGE_TARGETS.find((c) => c.id === 'spherex-qr3-cal') ?? null);
      setLastResolvedInfo(null);
      setObservations((prev) => {
        const ids = new Set(prev.map((o) => o.id));
        return [...obsList.filter((o) => !ids.has(o.id)), ...prev];
      });

      const loaded: LoadedSpherexFrame[] = [];
      for (const obs of obsList) {
        // Use the verified pointing coordinates directly
        const reqResp = await fetch(
          `/api/spherex/cutout?path=${encodeURIComponent(obs.cutoutPath)}&ra=${data.ra}&dec=${data.dec}&size=${cutoutSizeDeg}`,
        );
        const fData = await reqResp.json();
        if (!reqResp.ok) continue;
        const toFloat32 = (arr: (number | null)[]) => {
          const out = new Float32Array(arr.length);
          for (let i = 0; i < arr.length; i++) out[i] = arr[i] === null ? Number.NaN : arr[i]!;
          return out;
        };
        const waveWcs = fData.waveWcs
          ? {
              xGrid: fData.waveWcs.xGrid,
              yGrid: fData.waveWcs.yGrid,
              values: new Float32Array(fData.waveWcs.values),
              crpix1w: fData.waveWcs.crpix1w,
              crpix2w: fData.waveWcs.crpix2w,
            }
          : null;
        loaded.push({
          frameId: obs.id,
          observation: {
            ...obs,
            dateObs: fData.dateObs || obs.dateObs,
            mjdObs: fData.mjdObs || obs.mjdObs,
            exposureSec: fData.exposureSec || obs.exposureSec,
            version: fData.version || obs.version,
            targetWavelengthUm: fData.targetWavelengthUm,
            fetchStatus: 'retrieved',
          },
          width: fData.width,
          height: fData.height,
          image: toFloat32(fData.image),
          variance: fData.variance ? toFloat32(fData.variance) : undefined,
          zodi: fData.zodi ? toFloat32(fData.zodi) : undefined,
          flags: fData.flags ? new Uint32Array(fData.flags) : undefined,
          flagSummary: fData.flagSummary,
          flagDefinitions: fData.flagDefinitions,
          wcs: fData.wcs,
          astrometryWcs: fData.astrometryWcs,
          waveWcs,
          targetWavelengthUm: fData.targetWavelengthUm,
          targetBandwidthUm: fData.targetBandwidthUm,
          isSpectralCubeSlice: false,
          psfFwhmArcsec: fData.psfFwhmArcsec,
          version: fData.version,
          exposureSec: fData.exposureSec,
          l2DqaFlag: fData.l2DqaFlag,
          contaminationFlags: fData.contaminationFlags ?? {
            heAirglow: false,
            aurora: false,
            shuttleGlow: false,
          },
          headersSummary: fData.headersSummary ?? {},
          cutoutCenterRa: data.ra,
          cutoutCenterDec: data.dec,
          cutoutSizeDeg,
        });
      }

      if (loaded.length > 0) {
        setFrames(loaded);
        setActiveFrameIdx(0);
        setDetectionsByFrame({});
        setTracks([]);
        setSelectedSource(null);
        setActiveTab('temporal');
        showNotice(
          `Loaded ${loaded.length} verified QR3 consecutive slew exposures (2026W21_2A_0001_2D1..4D1) from IRSA.`,
        );
      }
    } catch (err) {
      showNotice(`Could not load verified QR3 sequence: ${(err as Error).message}`, 'error');
    } finally {
      setLoadingCutoutId(null);
    }
  };

  const handleLoadCubeSlices = async (sliceFrames: number[]) => {
    setLoadingCutoutId('cube');
    setStatusNotice(null);
    try {
      const loaded: LoadedSpherexFrame[] = [];
      for (const frameNum of sliceFrames) {
        const bandIdx = Math.min(5, Math.floor((frameNum - 1) / 17));
        const band = SPHEREX_BANDS[bandIdx];
        const wavelength =
          cubeWavelengthsUm[frameNum - 1] ?? (band.lambdaMinUm + band.lambdaMaxUm) / 2;
        const { width, height, data } = await decodePngUrlToLuminance(
          `/api/spherex/cube-tile?ra=${raDeg}&dec=${decDeg}&frame=${frameNum}`,
        );
        const cubeWcs = toAstrometryWcs({
          CTYPE1: 'RA---TAN',
          CTYPE2: 'DEC--TAN',
          CRVAL1: raDeg,
          CRVAL2: decDeg,
          CRPIX1: width / 2,
          CRPIX2: height / 2,
          CD1_1: -0.0035786,
          CD1_2: 0,
          CD2_1: 0,
          CD2_2: 0.0035786,
        });
        const obs: SpherexObservation = {
          id: `dr1-cube-${raDeg.toFixed(2)}-${decDeg.toFixed(2)}-ch${frameNum}`,
          obsId: `DR1-CUBE-CH${String(frameNum).padStart(3, '0')}`,
          productId: `spherex_allsky_cube_ch${frameNum}_${wavelength.toFixed(3)}um`,
          collection: 'spherex_dr1_cube',
          release: 'DR1',
          surveyMode: 'All-Sky Cube',
          detector: band.detector,
          bandpassName: band.bandpassName,
          lambdaMinUm: band.lambdaMinUm,
          lambdaMaxUm: band.lambdaMaxUm,
          targetWavelengthUm: wavelength,
          dateObs: '2025-2026 DR1 Mosaic',
          mjdObs: 61000,
          ra: raDeg,
          dec: decDeg,
          qualityStatus: 'DR1 HiPS Cube Slice (Visualization)',
          accessUrl: 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube',
          cutoutPath: '',
          provenanceSource: 'IRSA-HIPS5-CUBE',
          fetchStatus: 'retrieved',
        };
        loaded.push({
          frameId: obs.id,
          observation: obs,
          width,
          height,
          image: data,
          wcs: {
            crval1: raDeg,
            crval2: decDeg,
            crpix1: width / 2,
            crpix2: height / 2,
            cd1_1: -0.0035786,
            cd1_2: 0,
            cd2_1: 0,
            cd2_2: 0.0035786,
            aOrder: 0,
            bOrder: 0,
            a: {},
            b: {},
            apOrder: 0,
            bpOrder: 0,
            ap: {},
            bp: {},
            ctype1: 'RA---TAN',
            ctype2: 'DEC--TAN',
          },
          astrometryWcs: cubeWcs,
          sliceWavelengthUm: wavelength,
          targetWavelengthUm: wavelength,
          isSpectralCubeSlice: true,
          l2DqaFlag: 'HiPS Visualization Slice',
          contaminationFlags: { heAirglow: false, aurora: false, shuttleGlow: false },
          headersSummary: {
            CUBE_CHANNEL: frameNum,
            WAVELENGTH_UM: wavelength,
            NOTE: 'DR1 All-Sky HiPS Cube slice across wavelength (not multi-epoch)',
          },
          cutoutCenterRa: raDeg,
          cutoutCenterDec: decDeg,
          cutoutSizeDeg: 0.35,
        });
      }
      if (loaded.length > 0) {
        setFrames(loaded);
        setActiveFrameIdx(0);
        setDetectionsByFrame({});
        setTracks([]);
        setSelectedSource(null);
        setActiveTab('temporal');
        showNotice(
          `Extracted ${loaded.length} SPHEREx DR1 All-Sky Cube spectral slices (0.85–4.64 µm).`,
        );
      }
    } catch (err) {
      showNotice(`Could not extract DR1 Cube slices: ${(err as Error).message}`, 'error');
    } finally {
      setLoadingCutoutId(null);
    }
  };

  const handleStackDetector = async (detector: number, method: 'median' | 'mean') => {
    const inputs = frames.filter(
      (f) => !f.isStacked && !f.isSpectralCubeSlice && f.observation.detector === detector,
    );
    if (inputs.length < 2) return;
    setIsStacking(true);
    try {
      const grid = buildCommonSkyGrid(inputs, raDeg, decDeg);
      const repItems: Array<{ data: Float32Array; variance?: Float32Array }> = [];
      for (const f of inputs) {
        const existing = reprojectedByFrame[f.frameId];
        if (existing && existing.grid.width === grid.width && existing.grid.height === grid.height) {
          repItems.push({ data: existing.data, variance: existing.variance });
        } else {
          const af = frameToAstrometryFrame(f);
          if (af) {
            const rep = await reprojectFrameAsync(af, grid, rejectMask);
            repItems.push({ data: rep.data, variance: rep.variance });
          }
        }
      }
      if (repItems.length < 2) {
        showNotice('Not enough WCS-valid frames to stack for this detector.', 'error');
        return;
      }

      const stacked = await stackFramesAsync(repItems, grid.width, grid.height, method);
      const wcsModel = buildGridWcs(grid);
      const meanMjd = inputs.reduce((s, f) => s + f.observation.mjdObs, 0) / inputs.length;
      const stackedId = `stack-d${detector}-${method}-${Date.now()}`;
      const band = inputs[0].observation;
      const stackedObs: SpherexObservation = {
        ...band,
        id: stackedId,
        obsId: `STACK-${method.toUpperCase()}-D${detector} (N=${repItems.length})`,
        dateObs: inputs[0].observation.dateObs,
        mjdObs: meanMjd,
        provenanceSource: 'IRSA-CUTOUT-VERIFIED',
        fetchStatus: 'retrieved',
      };
      const stackedFrame: LoadedSpherexFrame = {
        frameId: stackedId,
        observation: stackedObs,
        width: grid.width,
        height: grid.height,
        image: stacked.data,
        variance: stacked.variance,
        wcs: {
          crval1: wcsModel.crval[0],
          crval2: wcsModel.crval[1],
          crpix1: wcsModel.crpix[0],
          crpix2: wcsModel.crpix[1],
          cd1_1: -wcsModel.cdelt[0],
          cd1_2: 0,
          cd2_1: 0,
          cd2_2: wcsModel.cdelt[1],
          aOrder: 0,
          bOrder: 0,
          a: {},
          b: {},
          apOrder: 0,
          bpOrder: 0,
          ap: {},
          bp: {},
          ctype1: 'RA---TAN',
          ctype2: 'DEC--TAN',
        },
        astrometryWcs: wcsModel,
        targetWavelengthUm: inputs[0].targetWavelengthUm,
        isSpectralCubeSlice: false,
        isStacked: true,
        stackedFromCount: repItems.length,
        stackMethod: method,
        psfFwhmArcsec: inputs[0].psfFwhmArcsec,
        version: inputs[0].version,
        l2DqaFlag: `Stacked ${method} (${repItems.length} frames)`,
        contaminationFlags: { heAirglow: false, aurora: false, shuttleGlow: false },
        headersSummary: {
          STACK_METHOD: method,
          STACK_COUNT: repItems.length,
          DETECTOR: detector,
        },
        cutoutCenterRa: raDeg,
        cutoutCenterDec: decDeg,
        cutoutSizeDeg,
      };
      setFrames((prev) => {
        const next = [...prev, stackedFrame];
        setActiveFrameIdx(next.length - 1);
        return next;
      });
      showNotice(
        `Created sky-aligned ${method} stack for Detector D${detector} from ${repItems.length} frames.`,
      );
    } catch (err) {
      showNotice(`Stacking failed: ${(err as Error).message}`, 'error');
    } finally {
      setIsStacking(false);
    }
  };

  const handleRunDetection = async () => {
    if (frames.length === 0) return;
    setIsDetecting(true);
    setStatusNotice(null);
    try {
      const nextByFrame: Record<string, AstrometricDetectionRecord[]> = {};
      const allRecords: AstrometricDetectionRecord[] = [];

      for (const f of frames) {
        const af = frameToAstrometryFrame(f);
        if (!af) continue;
        const dets = await detectSourcesAsync(af, {
          snrThreshold,
          rejectMask,
          cautionMask,
          systematicArcsec: extraScatterArcsec > 0 ? extraScatterArcsec : undefined,
        });
        const frameRecords: AstrometricDetectionRecord[] = dets.map((d, idx) => ({
          ...d,
          id: `${f.frameId}-src-${idx + 1}`,
          obsId: f.observation.obsId,
          dateObs: f.observation.dateObs,
          release: f.observation.release,
          version: f.version ?? f.observation.version ?? '',
          wavelengthUm: f.targetWavelengthUm ?? f.sliceWavelengthUm,
          bandwidthUm: f.targetBandwidthUm,
          rejectMaskUsed: rejectMask,
          cautionMaskUsed: cautionMask,
          systematicArcsec: extraScatterArcsec > 0 ? extraScatterArcsec : undefined,
        }));
        nextByFrame[f.frameId] = frameRecords;
        allRecords.push(...frameRecords);
      }

      const enrichedByFrame = enrichDetectionsWithGaia(nextByFrame, gaiaSources);
      const flatEnriched = Object.values(enrichedByFrame).flat();
      setDetectionsByFrame(enrichedByFrame);
      setSelectedSource(flatEnriched[0] ?? null);

      // Group strictly by detector before cross-epoch association (never mix detectors)
      const byDet = groupByDetector(flatEnriched);
      const recordByKey = new Map<string, AstrometricDetectionRecord>();
      flatEnriched.forEach((r) => recordByKey.set(`${r.frameId}|${r.x.toFixed(4)}|${r.y.toFixed(4)}`, r));

      const nextTracks: AstrometricTrackRecord[] = [];
      let trackCounter = 1;
      for (const [det, detList] of byDet.entries()) {
        const associated = associateDetections(detList, maxRateArcsecYr, 3, extraScatterArcsec);
        for (const tr of associated) {
          if (tr.detections.length < 2) continue;
          const mappedDets = tr.detections.map(
            (d) =>
              recordByKey.get(`${d.frameId}|${d.x.toFixed(4)}|${d.y.toFixed(4)}`) ??
              (d as AstrometricDetectionRecord),
          );
          nextTracks.push({
            id: `TRK-D${det}-${String(trackCounter++).padStart(2, '0')}`,
            detector: det,
            detections: mappedDets,
            fit: tr.fit,
            status: tr.status,
          });
        }
      }

      setTracks(nextTracks);
      showNotice(
        `astrometry.ts detected ${flatEnriched.length} source(s) across ${frames.length} frame(s); ${nextTracks.length} per-detector track(s).`,
      );
    } catch (err) {
      showNotice(`Detection failed: ${(err as Error).message}`, 'error');
    } finally {
      setIsDetecting(false);
    }
  };

  const handleQueryGaia = async () => {
    setIsQueryingGaia(true);
    setStatusNotice(null);
    try {
      const radius = Math.max(0.05, cutoutSizeDeg);
      const resp = await fetch(`/api/gaia-dr3?ra=${raDeg}&dec=${decDeg}&radius=${radius}`);
      const data = await resp.json();
      if (!resp.ok) {
        showNotice(data.error || 'Gaia DR3 query failed.', 'error');
        return;
      }
      const sources: GaiaSource[] = data.sources || [];
      setGaiaSources(sources);
      setGaiaMirrorUsed(data.mirrorUsed || 'Gaia DR3');
      setDetectionsByFrame((prev) => enrichDetectionsWithGaia(prev, sources));
      showNotice(`Loaded ${sources.length} Gaia DR3 reference star(s) via ${data.mirrorUsed}.`);
    } catch (err) {
      showNotice(`Gaia DR3 network error: ${(err as Error).message}`, 'error');
    } finally {
      setIsQueryingGaia(false);
    }
  };

  const handleToggleRejectBit = (bit: number) => {
    if (bit === FLAG_BITS.SOURCE) return; // Never reject SOURCE bit 21
    setRejectMask((prev) => (prev ^ (1 << bit)) >>> 0);
  };

  const handleToggleCautionBit = (bit: number) => {
    setCautionMask((prev) => (prev ^ (1 << bit)) >>> 0);
  };

  const handleUpdateSourceStatus = (id: string, status: SourceStatus) => {
    setDetectionsByFrame((prev) => {
      const next: Record<string, AstrometricDetectionRecord[]> = {};
      for (const [fid, arr] of Object.entries(prev)) {
        next[fid] = arr.map((s) => (s.id === id ? { ...s, status } : s));
      }
      return next;
    });
    setSelectedSource((prev) => (prev && prev.id === id ? { ...prev, status } : prev));
  };

  const handleUpdateTrackStatus = (trackId: string, status: SourceStatus) => {
    setTracks((prev) => prev.map((tr) => (tr.id === trackId ? { ...tr, status } : tr)));
  };

  const activeInvestigation =
    investigations.find((i) => i.id === activeInvId) ?? investigations[0] ?? null;

  const handleSaveObservationToNotebook = (obs: SpherexObservation) => {
    if (!activeInvestigation) return;
    const exists = activeInvestigation.observations.some((o) => o.id === obs.id);
    if (!exists) {
      updateActiveInvestigation({
        observations: [...activeInvestigation.observations, obs],
      });
    }
    showNotice(`Saved observation ${obs.obsId} to "${activeInvestigation.title}".`);
  };

  const handleSaveSnapshotToNotebook = (label: string, dataUrl: string) => {
    if (!activeInvestigation) return;
    updateActiveInvestigation({
      snapshots: [
        { id: `snap-${Date.now()}`, label, dataUrl, createdAt: new Date().toISOString() },
        ...activeInvestigation.snapshots,
      ],
    });
    showNotice(`Saved visual snapshot "${label}" to Notebook.`);
  };

  const handleAddEpochNote = (frame: LoadedSpherexFrame, note: string) => {
    if (!activeInvestigation) return;
    updateActiveInvestigation({
      epochNotes: [
        {
          id: `note-${Date.now()}`,
          frameId: frame.frameId,
          obsId: frame.observation.obsId,
          dateObs: frame.observation.dateObs,
          note,
          createdAt: new Date().toISOString(),
        },
        ...activeInvestigation.epochNotes,
      ],
    });
    showNotice(`Saved epoch note for ${frame.observation.obsId}.`);
  };

  const handleSaveDetectionsToNotebook = (
    sources: AstrometricDetectionRecord[],
    savedTracks: AstrometricTrackRecord[],
  ) => {
    if (!activeInvestigation) return;
    const existingIds = new Set((activeInvestigation.astrometryDetections ?? []).map((d) => d.id));
    const mergedDets = [
      ...(activeInvestigation.astrometryDetections ?? []),
      ...sources.filter((s) => !existingIds.has(s.id)),
    ];
    const existingTrkIds = new Set((activeInvestigation.astrometryTracks ?? []).map((t) => t.id));
    const mergedTracks = [
      ...(activeInvestigation.astrometryTracks ?? []),
      ...savedTracks.filter((tr) => !existingTrkIds.has(tr.id)),
    ];
    updateActiveInvestigation({
      astrometryDetections: mergedDets,
      astrometryTracks: mergedTracks,
      processingSettings: {
        snrThreshold,
        maxRateArcsecYr,
        rejectMask: FLAG_MASK_CONFIG ? rejectMask : DEFAULT_REJECT_MASK,
        cautionMask,
        extraScatterArcsec,
        reprojectedToSkyGrid: true,
      },
    });
    showNotice(
      `Saved ${sources.length} astrometric detection(s) and ${savedTracks.length} track(s) to "${activeInvestigation.title}".`,
    );
  };

  const activeFrame = frames[activeFrameIdx] ?? null;
  const targetExpectedPm = useMemo(() => {
    const pmRa = activeTarget?.pmRaMasYr ?? lastResolvedInfo?.pmRaMasYr;
    const pmDec = activeTarget?.pmDecMasYr ?? lastResolvedInfo?.pmDecMasYr;
    if (pmRa === null || pmRa === undefined || pmDec === null || pmDec === undefined) return null;
    if (Math.hypot(pmRa, pmDec) < 50) return null;
    return {
      name: activeTarget?.name ?? lastResolvedInfo?.name ?? 'Target',
      pmRaMasYr: pmRa,
      pmDecMasYr: pmDec,
    };
  }, [activeTarget, lastResolvedInfo]);

  return (
    <div className="min-h-screen bg-[#07090E] text-slate-100 flex flex-col">
      {/* Strict 3-Zone Top Bar Contract (hidden in ?embed=1 mode) */}
      {!embedMode && (
        <header className="border-b border-slate-800 bg-[#07090E] px-4 md:px-6 py-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 md:gap-8">
          <button
            type="button"
            onClick={() => setActiveTab('explorer')}
            className="text-lg font-bold tracking-wider text-slate-100 whitespace-nowrap shrink-0 cursor-pointer"
          >
            URUTAU
          </button>

          <nav className="order-last w-full border-t border-slate-800/70 pt-2 md:order-none md:w-auto md:border-t-0 md:pt-0 flex items-center gap-4 md:gap-6 overflow-x-auto text-xs font-medium">
            {(
              [
                ['explorer', lang === 'pt' ? '1 · Explorar o céu' : '1 · Explore the sky'],
                ['observations', lang === 'pt' ? '2 · Escolher imagens' : '2 · Choose images'],
                ['temporal', lang === 'pt' ? '3 · Ver mudanças' : '3 · Watch changes'],
                ['notebook', lang === 'pt' ? '4 · Meus registros' : '4 · My discoveries'],
                ['about', lang === 'pt' ? 'Sobre' : 'About'],
              ] as const
            ).map(([tabId, label]) => {
              const isActive = activeTab === tabId;
              return (
                <button
                  key={tabId}
                  type="button"
                  onClick={() => setActiveTab(tabId)}
                  aria-current={isActive ? 'page' : undefined}
                  className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    isActive
                      ? 'border-cyan-400 text-cyan-200'
                      : 'border-transparent text-slate-400 hover:text-slate-100'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </nav>

          <div className="shrink-0">
            <button
              type="button"
              onClick={() => setActiveTab('explorer')}
              className="px-3.5 py-2 rounded bg-cyan-600 hover:bg-cyan-500 text-slate-950 text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer"
            >
              {lang === 'pt' ? 'Explorar agora' : 'Start exploring'}
            </button>
          </div>
        </header>
      )}

      {/* Slim Workspace Context & Language Ribbon */}
      {!embedMode && (
        <div className="bg-[#0B0E17] border-b border-slate-800/80 px-4 md:px-6 py-1.5 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex flex-wrap items-center gap-2.5 text-slate-400">
            <span className="text-slate-200 font-medium">{t.subtitle}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono text-cyan-300 tabular-nums">
              {activeTarget
                ? lang === 'pt'
                  ? activeTarget.namePt
                  : activeTarget.name
                : 'Custom Region'}{' '}
              ({degToHms(raDeg, 2)} {degToDms(decDeg, 1)})
            </span>
          </div>

          <div className="flex items-center gap-3">
            {statusNotice && (
              <span
                className={`text-xs ${
                  statusNotice.type === 'error' ? 'text-rose-400' : 'text-emerald-300'
                }`}
              >
                {statusNotice.text}
              </span>
            )}
            <div className="inline-flex items-center bg-[#07090E] border border-slate-800 rounded p-0.5">
              <button
                type="button"
                onClick={() => setLang('en')}
                className={`px-2 py-0.5 text-[11px] font-mono rounded cursor-pointer ${
                  lang === 'en'
                    ? 'bg-slate-800 text-cyan-300 font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                EN
              </button>
              <button
                type="button"
                onClick={() => setLang('pt')}
                className={`px-2 py-0.5 text-[11px] font-mono rounded cursor-pointer ${
                  lang === 'pt'
                    ? 'bg-slate-800 text-cyan-300 font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                PT
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Content Workspace */}
      <main id="main-content" className="flex-1 p-3 md:p-4 max-w-[1600px] w-full mx-auto">
        {!embedMode && activeTab !== 'about' && (
          <JourneyGuide lang={lang} activeTab={activeTab} observationCount={observations.length} frameCount={frames.length} onNavigate={setActiveTab} />
        )}
        {activeTab === 'explorer' && (
          <SkyExplorer
            lang={lang}
            raDeg={raDeg}
            decDeg={decDeg}
            fovDeg={fovDeg}
            cutoutSizeDeg={cutoutSizeDeg}
            activeTarget={activeTarget}
            observations={observations}
            onSelectPosition={(ra, dec, tgt) => {
              setRaDeg(ra);
              setDecDeg(dec);
              if (tgt !== undefined) {
                setActiveTarget(tgt);
                if (tgt === null || tgt.id !== activeTarget?.id) {
                  setLastResolvedInfo(null);
                }
              }
            }}
            onSelectTargetPreset={handleSelectTargetPreset}
            onChangeFov={setFovDeg}
            onChangeCutoutSize={setCutoutSizeDeg}
            onQueryArchive={(ra, dec) => queryArchive(ra, dec)}
            onGoToObservations={() => setActiveTab('observations')}
            isQuerying={isQuerying}
            resolvingTargetId={resolvingTargetId}
            lastResolvedInfo={lastResolvedInfo}
          />
        )}

        {activeTab === 'observations' && (
          <ObservationExplorer
            lang={lang}
            raDeg={raDeg}
            decDeg={decDeg}
            searchRadiusDeg={searchRadiusDeg}
            cutoutSizeDeg={cutoutSizeDeg}
            onChangeRadius={setSearchRadiusDeg}
            observations={observations}
            diagnostics={diagnostics}
            cubeWavelengthsUm={cubeWavelengthsUm}
            isQuerying={isQuerying}
            loadingCutoutId={loadingCutoutId}
            onRefreshQuery={() => queryArchive(raDeg, decDeg, searchRadiusDeg)}
            onLoadVerifiedMultiSlew={handleLoadVerifiedMultiSlew}
            onLoadCubeSlices={handleLoadCubeSlices}
            onOpenObservation={handleOpenObservation}
            onOpenMultipleObservations={handleOpenMultipleObservations}
            onSaveObservationToNotebook={handleSaveObservationToNotebook}
          />
        )}

        {activeTab === 'temporal' && (
          <div className="space-y-6">
            <TemporalViewer
              lang={lang}
              frames={frames}
              reprojectedByFrame={reprojectedByFrame}
              activeIndex={activeFrameIdx}
              onChangeIndex={setActiveFrameIdx}
              targetRa={raDeg}
              targetDec={decDeg}
              rejectMask={rejectMask}
              cautionMask={cautionMask}
              astrometryDetectionsByFrame={detectionsByFrame}
              astrometryTracks={tracks}
              gaiaSources={gaiaSources}
              selectedSourceId={selectedSource?.id ?? null}
              onSelectSource={setSelectedSource}
              onStackDetector={handleStackDetector}
              isStacking={isStacking}
              onSaveSnapshot={handleSaveSnapshotToNotebook}
              onAddEpochNote={handleAddEpochNote}
              onLoadQuickDemo={handleLoadVerifiedMultiSlew}
              embedMode={embedMode}
            />

            {!embedMode && (
              <AstrometryPanel
                lang={lang}
                frames={frames}
                activeFrame={activeFrame}
                snrThreshold={snrThreshold}
                maxRateArcsecYr={maxRateArcsecYr}
                extraScatterArcsec={extraScatterArcsec}
                rejectMask={rejectMask}
                cautionMask={cautionMask}
                onChangeSnr={setSnrThreshold}
                onChangeMaxRate={setMaxRateArcsecYr}
                onChangeExtraScatter={setExtraScatterArcsec}
                onToggleRejectBit={handleToggleRejectBit}
                onToggleCautionBit={handleToggleCautionBit}
                onRunDetection={handleRunDetection}
                isDetecting={isDetecting}
                onQueryGaia={handleQueryGaia}
                isQueryingGaia={isQueryingGaia}
                gaiaSources={gaiaSources}
                gaiaMirrorUsed={gaiaMirrorUsed}
                detectionsByFrame={detectionsByFrame}
                tracks={tracks}
                selectedSource={selectedSource}
                onSelectSource={setSelectedSource}
                onUpdateSourceStatus={handleUpdateSourceStatus}
                onUpdateTrackStatus={handleUpdateTrackStatus}
                onSaveDetectionsToNotebook={handleSaveDetectionsToNotebook}
                targetExpectedPm={targetExpectedPm}
              />
            )}
          </div>
        )}

        {activeTab === 'notebook' && (
          <NotebookReports
            lang={lang}
            investigations={investigations}
            activeId={activeInvId}
            onSelectInvestigation={setActiveInvId}
            onCreateInvestigation={handleCreateInvestigation}
            onImportInvestigation={handleImportInvestigation}
            onDeleteInvestigation={handleDeleteInvestigation}
            onUpdateActive={updateActiveInvestigation}
            onAttachCurrentRegion={() =>
              updateActiveInvestigation({
                targetName: activeTarget ? activeTarget.name : 'Custom Region',
                raDeg,
                decDeg,
                regionRadiusDeg: searchRadiusDeg,
              })
            }
          />
        )}

        {activeTab === 'about' && <AboutFeedback lang={lang} />}
      </main>
    </div>
  );
}
