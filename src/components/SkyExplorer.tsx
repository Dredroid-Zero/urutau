import React, { useEffect, useRef, useState } from 'react';
import {
  Compass,
  Crosshair,
  Grid3X3,
  Layers,
  Loader2,
  Maximize2,
  Minimize2,
  Radar,
  RotateCcw,
  Search,
  Sparkles,
} from 'lucide-react';
import { CUTOUT_DEFAULTS, estimateCutoutTransfer } from '../config/spherex';
import {
  degToDms,
  degToHms,
  parseCoordinateInput,
  propagatePosition,
} from '../lib/astronomy';
import type { Language } from '../lib/i18n';
import { TRANSLATIONS } from '../lib/i18n';
import { CHALLENGE_TARGETS, type ChallengeTarget } from '../lib/targets';
import type { ResolvedTargetInfo, SpherexObservation } from '../types/spherex';

export type SurveyLayerId =
  | 'spherex_cube'
  | 'dss2_color'
  | '2mass_color'
  | 'allwise_color';

interface SkyExplorerProps {
  lang: Language;
  raDeg: number;
  decDeg: number;
  fovDeg: number;
  cutoutSizeDeg: number;
  activeTarget: ChallengeTarget | null;
  observations: SpherexObservation[];
  onSelectPosition: (ra: number, dec: number, target?: ChallengeTarget | null) => void;
  onSelectTargetPreset: (target: ChallengeTarget) => Promise<void>;
  onChangeFov: (fov: number) => void;
  onChangeCutoutSize: (sizeDeg: number) => void;
  onQueryArchive: (ra: number, dec: number) => void;
  onGoToObservations: () => void;
  isQuerying: boolean;
  resolvingTargetId?: string | null;
  lastResolvedInfo?: ResolvedTargetInfo | null;
}

const SURVEY_CONFIGS: Record<
  SurveyLayerId,
  { labelEn: string; labelPt: string; hipsId: string; provenance: string; isSpherex: boolean }
> = {
  spherex_cube: {
    labelEn: 'SPHEREx DR1 All-Sky Cube (0.75–5.0 µm)',
    labelPt: 'Cubo All-Sky SPHEREx DR1 (0,75–5,0 µm)',
    hipsId: 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube',
    provenance: 'NASA/IPAC IRSA SPHEREx DR1 (Stacked mosaic · visualization only)',
    isSpherex: true,
  },
  dss2_color: {
    labelEn: 'DSS2 Color (Optical Reference, 1980s–1990s)',
    labelPt: 'DSS2 Cor (Referência Óptica, anos 1980–1990)',
    hipsId: 'https://irsa.ipac.caltech.edu/data/hips/CDS/DSS2/color',
    provenance: 'Complementary Optical Survey · Not SPHEREx',
    isSpherex: false,
  },
  '2mass_color': {
    labelEn: '2MASS JHKs Color (NIR Reference, 1997–2001)',
    labelPt: '2MASS JHKs Cor (Referência NIR, 1997–2001)',
    hipsId: 'https://irsa.ipac.caltech.edu/data/hips/CDS/2MASS/Color',
    provenance: 'Complementary NIR Survey · Not SPHEREx',
    isSpherex: false,
  },
  allwise_color: {
    labelEn: 'AllWISE W1–W4 Color (MIR Reference, 2010)',
    labelPt: 'AllWISE W1–W4 Cor (Referência MIR, 2010)',
    hipsId: 'https://irsa.ipac.caltech.edu/data/hips/CDS/AllWISE/RGB-W4-W2-W1',
    provenance: 'Complementary MIR Survey · Not SPHEREx',
    isSpherex: false,
  },
};

const SPHEREX_PREVIEW_CHANNELS = [
  { frame: 1, wavelength: '0.753 µm (Band 1)' },
  { frame: 10, wavelength: '0.932 µm (Band 1)' },
  { frame: 22, wavelength: '1.254 µm (Band 2)' },
  { frame: 38, wavelength: '1.818 µm (Band 3)' },
  { frame: 63, wavelength: '3.293 µm (Band 4)' },
  { frame: 75, wavelength: '4.076 µm (Band 5)' },
  { frame: 91, wavelength: '4.635 µm (Band 6)' },
];

export const SkyExplorer: React.FC<SkyExplorerProps> = ({
  lang,
  raDeg,
  decDeg,
  fovDeg,
  cutoutSizeDeg,
  activeTarget,
  observations,
  onSelectPosition,
  onSelectTargetPreset,
  onChangeFov,
  onChangeCutoutSize,
  onQueryArchive,
  onGoToObservations,
  isQuerying,
  resolvingTargetId,
  lastResolvedInfo,
}) => {
  const t = TRANSLATIONS[lang];
  const aladinContainerRef = useRef<HTMLDivElement | null>(null);
  const aladinRef = useRef<any>(null);
  const aladinInstanceRef = useRef<any>(null);
  const aladinModRef = useRef<any>(null);
  const fallbackCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointerDownPosRef = useRef<{ x: number; y: number } | null>(null);

  const [searchInput, setSearchInput] = useState(
    `${degToHms(raDeg, 3)} ${degToDms(decDeg, 2)}`,
  );
  const [searchError, setSearchError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  const [surveyId, setSurveyId] = useState<SurveyLayerId>('spherex_cube');
  const [showGrid, setShowGrid] = useState(true);
  const [showCoverage, setShowCoverage] = useState(true);
  const [atlasMode, setAtlasMode] = useState<'aladin' | 'canvas'>('aladin');
  const [aladinStatus, setAladinStatus] = useState<'loading' | 'ready' | 'fallback'>('loading');
  const [cubeFrame, setCubeFrame] = useState<number>(63);
  const [epochYear, setEpochYear] = useState<number>(2026.5);
  const [cursorSky, setCursorSky] = useState<{ ra: number; dec: number }>({ ra: raDeg, dec: decDeg });
  const [dragStart, setDragStart] = useState<{ x: number; y: number; ra: number; dec: number; moved: boolean } | null>(null);

  useEffect(() => {
    setSearchInput(`${degToHms(raDeg, 3)} ${degToDms(decDeg, 2)}`);
  }, [raDeg, decDeg]);

  const cutoutEstimate = estimateCutoutTransfer(cutoutSizeDeg, Math.max(1, Math.min(6, observations.length || 4)));

  const applySurveyToAladin = (inst: any, A: any, id: SurveyLayerId, sliceIdx: number) => {
    const cfg = SURVEY_CONFIGS[id];
    if (id === 'spherex_cube' && typeof A?.HiPS === 'function') {
      const hips = A.HiPS(cfg.hipsId, {
        name: cfg.labelEn,
        emMin: 0.753e-6,
        emMax: 4.988e-6,
        colormap: 'inferno',
        successCallback: () => {
          try {
            hips.setSliceNumber?.(sliceIdx);
          } catch {
            // ignore
          }
        },
      });
      inst.setBaseImageLayer(hips);
      setTimeout(() => {
        try {
          inst.getBaseImageLayer?.()?.setSliceNumber?.(sliceIdx);
        } catch {
          // ignore
        }
      }, 250);
    } else {
      inst.setImageSurvey(cfg.hipsId);
    }
  };

  // Initialize Aladin Lite v3 safely
  useEffect(() => {
    if (atlasMode !== 'aladin') return;
    let cancelled = false;

    async function bootAladin() {
      if (!aladinContainerRef.current) return;
      try {
        const mod = await import('aladin-lite');
        const A = mod.default;
        await A.init;
        if (cancelled || !aladinContainerRef.current) return;

        aladinModRef.current = A;
        aladinContainerRef.current.innerHTML = '';
        const instance = A.aladin(aladinContainerRef.current, {
          survey: SURVEY_CONFIGS[surveyId].hipsId,
          fov: fovDeg,
          target: `${raDeg} ${decDeg}`,
          log: false,
          showCooGrid: showGrid,
          showCooGridControl: false,
          showSimbadPointerControl: false,
          showShareControl: false,
          showFullscreenControl: false,
          showGotoControl: false,
          showZoomControl: false,
          showLayersControl: false,
          showSettingsControl: false,
          showProjectionControl: false,
          showFrame: false,
          showCooLocation: false,
          showFov: false,
          showStatusBar: false,
          showContextMenu: false,
          showReticle: true,
          reticleColor: '#06b6d4',
          gridColor: '#38bdf8',
          gridOpacity: 0.35,
          cooFrame: 'ICRSd',
        });

        aladinRef.current = instance;
        aladinInstanceRef.current = instance;
        applySurveyToAladin(instance, A, surveyId, cubeFrame);
        setAladinStatus('ready');

        instance.on('mouseMove', (pos: { ra: number; dec: number } | null) => {
          if (pos && Number.isFinite(pos.ra) && Number.isFinite(pos.dec)) {
            setCursorSky({ ra: pos.ra, dec: pos.dec });
          }
        });

        instance.on('positionChanged', (pos: { ra: number; dec: number }) => {
          if (pos && Number.isFinite(pos.ra) && Number.isFinite(pos.dec)) {
            setCursorSky({ ra: pos.ra, dec: pos.dec });
          }
        });
      } catch {
        if (!cancelled) {
          setAladinStatus('fallback');
          setAtlasMode('canvas');
        }
      }
    }

    bootAladin();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atlasMode]);

  // Sync target RA/Dec, FoV, and Grid into Aladin Lite
  useEffect(() => {
    const inst = aladinInstanceRef.current;
    if (!inst || atlasMode !== 'aladin') return;
    try {
      inst.gotoRaDec(raDeg, decDeg);
      inst.setFov(fovDeg);
      inst.showCooGrid(showGrid);
    } catch {
      // ignore transient updates
    }
  }, [raDeg, decDeg, fovDeg, showGrid, atlasMode]);

  // Sync Survey Layer into Aladin Lite
  useEffect(() => {
    const inst = aladinInstanceRef.current;
    const A = aladinModRef.current;
    if (!inst || !A || atlasMode !== 'aladin') return;
    try {
      applySurveyToAladin(inst, A, surveyId, cubeFrame);
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surveyId, atlasMode]);

  // Update SPHEREx HiPS Cube wavelength slice
  useEffect(() => {
    const inst = aladinInstanceRef.current;
    if (!inst || surveyId !== 'spherex_cube' || atlasMode !== 'aladin') return;
    try {
      const baseSurvey = inst.getBaseImageLayer?.();
      if (baseSurvey && typeof baseSurvey.setSliceNumber === 'function') {
        baseSurvey.setSliceNumber(cubeFrame);
      }
    } catch {
      // ignore
    }
  }, [cubeFrame, surveyId, atlasMode]);

  // Sync Real SPHEREx Coverage MOC + Footprint Polygons + Target Markers + PM Vector on Aladin
  useEffect(() => {
    const inst = aladinRef.current;
    const A = aladinModRef.current;
    if (!inst || !A || atlasMode !== 'aladin' || aladinStatus !== 'ready') return;
    try {
      if (typeof inst.removeLayers === 'function') {
        inst.removeLayers();
      }

      // 1. Real SPHEREx Coverage Overlay (HiPS MOC + returned s_region/poly footprints)
      if (showCoverage) {
        if (typeof A.MOCFromURL === 'function' && typeof inst.addMOC === 'function') {
          try {
            const moc = A.MOCFromURL('/api/spherex/hips-moc', {
              name: 'SPHEREx DR1 Coverage MOC',
              color: '#06b6d4',
              lineWidth: 1.2,
              perimeter: true,
              opacity: 0.35,
            });
            inst.addMOC(moc);
          } catch {
            // ignore MOC errors
          }
        }
        const withPolys = observations.filter((o) => o.footprintPolygon && o.footprintPolygon.length >= 3);
        if (withPolys.length > 0 && typeof A.graphicOverlay === 'function' && typeof A.polygon === 'function') {
          const fpOverlay = A.graphicOverlay({ color: '#38bdf8', lineWidth: 1.5, name: 'SPHEREx Observation Footprints' });
          for (const obs of withPolys.slice(0, 25)) {
            fpOverlay.add(A.polygon(obs.footprintPolygon));
          }
          inst.addOverlay(fpOverlay);
        }
      }

      // 2. Active Target Reticle & Cutout FoV Box
      if (typeof A.graphicOverlay === 'function' && typeof A.polyline === 'function') {
        const boxOverlay = A.graphicOverlay({ color: '#22d3ee', lineWidth: 1.5 });
        const half = cutoutSizeDeg / 2;
        const cosD = Math.max(0.15, Math.cos((decDeg * Math.PI) / 180));
        const dRa = half / cosD;
        boxOverlay.add(
          A.polyline([
            [raDeg - dRa, decDeg - half],
            [raDeg + dRa, decDeg - half],
            [raDeg + dRa, decDeg + half],
            [raDeg - dRa, decDeg + half],
            [raDeg - dRa, decDeg - half],
          ]),
        );

        // Proper motion vector if known
        const pmRa = activeTarget?.pmRaMasYr ?? lastResolvedInfo?.pmRaMasYr ?? 0;
        const pmDec = activeTarget?.pmDecMasYr ?? lastResolvedInfo?.pmDecMasYr ?? 0;
        const refEp = activeTarget?.epochYear ?? lastResolvedInfo?.epochYear ?? 2000;
        if (Math.hypot(pmRa, pmDec) > 200) {
          const posNow = propagatePosition(raDeg, decDeg, pmRa, pmDec, refEp, epochYear);
          boxOverlay.add(A.polyline([[raDeg, decDeg], [posNow.ra, posNow.dec]]));
        }
        inst.addOverlay(boxOverlay);
      }

      // 3. Challenge target pins (for those with known coordinates)
      if (typeof A.catalog === 'function') {
        const cat = A.catalog({ name: 'Challenge Targets', sourceSize: 12, color: '#f59e0b', shape: 'circle' });
        for (const tgt of CHALLENGE_TARGETS) {
          if (tgt.raDeg !== null && tgt.decDeg !== null) {
            cat.addSources([A.source(tgt.raDeg, tgt.decDeg, { name: tgt.name })]);
          }
        }
        inst.addCatalog(cat);
      }
    } catch {
      // ignore optional overlay errors
    }
  }, [activeTarget, lastResolvedInfo, epochYear, atlasMode, aladinStatus, showCoverage, observations, raDeg, decDeg, cutoutSizeDeg]);

  // Render Precision 2D Celestial Canvas Atlas (when in 2D mode or fallback)
  useEffect(() => {
    const canvas = fallbackCanvasRef.current;
    if (!canvas || atlasMode !== 'canvas') return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(300, Math.floor(rect.width));
    const h = Math.max(300, Math.floor(rect.height));
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#05070c';
    ctx.fillRect(0, 0, w, h);

    const scalePxPerDeg = Math.min(w, h) / Math.max(0.02, fovDeg);
    const cosDec0 = Math.max(0.15, Math.cos((decDeg * Math.PI) / 180));

    const project = (ra: number, dec: number) => {
      let dRa = ra - raDeg;
      if (dRa > 180) dRa -= 360;
      if (dRa < -180) dRa += 360;
      const x = w / 2 - dRa * cosDec0 * scalePxPerDeg;
      const y = h / 2 - (dec - decDeg) * scalePxPerDeg;
      return { x, y };
    };

    const gridCellDeg = fovDeg > 20 ? 5 : fovDeg > 4 ? 1 : fovDeg > 0.5 ? 0.25 : 0.05;
    const minDec = Math.max(-89, Math.floor((decDeg - fovDeg) / gridCellDeg) * gridCellDeg);
    const maxDec = Math.min(89, Math.ceil((decDeg + fovDeg) / gridCellDeg) * gridCellDeg);
    const raSpan = Math.min(180, fovDeg / cosDec0);

    if (showGrid) {
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.16)';
      ctx.lineWidth = 1;
      ctx.font = '11px "JetBrains Mono", monospace';
      ctx.fillStyle = 'rgba(148, 163, 184, 0.75)';

      for (let d = minDec; d <= maxDec; d += gridCellDeg) {
        const p1 = project(raDeg - raSpan, d);
        const p2 = project(raDeg + raSpan, d);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
        if (p1.y > 16 && p1.y < h - 16) {
          ctx.fillText(`${d.toFixed(gridCellDeg < 1 ? 2 : 0)}°`, 12, p1.y - 4);
        }
      }

      const raStep = gridCellDeg / cosDec0;
      const startRa = Math.floor((raDeg - raSpan) / raStep) * raStep;
      const endRa = Math.ceil((raDeg + raSpan) / raStep) * raStep;
      for (let r = startRa; r <= endRa; r += raStep) {
        const p1 = project(r, minDec);
        const p2 = project(r, maxDec);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
        if (p2.x > 40 && p2.x < w - 40) {
          ctx.fillText(`${((r % 360 + 360) % 360).toFixed(gridCellDeg < 1 ? 2 : 0)}°`, p2.x + 4, 22);
        }
      }
    }

    // Draw real observation footprints if available
    if (showCoverage) {
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
      ctx.lineWidth = 1.2;
      for (const obs of observations.slice(0, 25)) {
        if (!obs.footprintPolygon || obs.footprintPolygon.length < 3) continue;
        ctx.beginPath();
        obs.footprintPolygon.forEach(([pr, pd], idx) => {
          const pt = project(pr, pd);
          if (idx === 0) ctx.moveTo(pt.x, pt.y);
          else ctx.lineTo(pt.x, pt.y);
        });
        ctx.closePath();
        ctx.stroke();
      }
    }

    // Cutout FoV box around selected sky region
    const half = cutoutSizeDeg / 2;
    const dRaBox = half / cosDec0;
    const corners = [
      project(raDeg - dRaBox, decDeg - half),
      project(raDeg + dRaBox, decDeg - half),
      project(raDeg + dRaBox, decDeg + half),
      project(raDeg - dRaBox, decDeg + half),
    ];
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    corners.forEach((c, idx) => (idx === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y)));
    ctx.closePath();
    ctx.stroke();

    // Plot Challenge Targets with resolved or challenge coords
    for (const target of CHALLENGE_TARGETS) {
      if (target.raDeg === null || target.decDeg === null) continue;
      const p = project(target.raDeg, target.decDeg);
      if (p.x >= -20 && p.x <= w + 20 && p.y >= -20 && p.y <= h + 20) {
        ctx.strokeStyle = target.id === activeTarget?.id ? '#06b6d4' : '#f59e0b';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = target.id === activeTarget?.id ? '#67e8f9' : '#fcd34d';
        ctx.font = '12px "IBM Plex Sans", sans-serif';
        ctx.fillText(lang === 'pt' ? target.namePt : target.name, p.x + 11, p.y + 4);
      }
    }

    // Center reticle
    const cx = w / 2;
    const cy = h / 2;
    ctx.strokeStyle = '#06b6d4';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - 16, cy);
    ctx.lineTo(cx - 5, cy);
    ctx.moveTo(cx + 5, cy);
    ctx.lineTo(cx + 16, cy);
    ctx.moveTo(cx, cy - 16);
    ctx.lineTo(cx, cy - 5);
    ctx.moveTo(cx, cy + 5);
    ctx.lineTo(cx, cy + 16);
    ctx.stroke();
  }, [atlasMode, raDeg, decDeg, fovDeg, cutoutSizeDeg, showGrid, showCoverage, observations, activeTarget, lang]);

  const handleSearchSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSearchError(null);
    const trimmed = searchInput.trim();
    if (!trimmed) return;

    const parsed = parseCoordinateInput(trimmed);
    if (parsed) {
      onSelectPosition(parsed.ra, parsed.dec, null);
      onQueryArchive(parsed.ra, parsed.dec);
      return;
    }

    setResolving(true);
    try {
      const resp = await fetch(`/api/resolve-target?name=${encodeURIComponent(trimmed)}`);
      const data = await resp.json();
      if (!resp.ok) {
        setSearchError(data.error || 'Could not resolve target.');
      } else {
        onSelectPosition(data.ra, data.dec, null);
        onQueryArchive(data.ra, data.dec);
      }
    } catch {
      setSearchError('Network error resolving target name.');
    } finally {
      setResolving(false);
    }
  };

  const handleAladinPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    pointerDownPosRef.current = { x: e.clientX, y: e.clientY };
  };

  const handleAladinPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = pointerDownPosRef.current;
    pointerDownPosRef.current = null;
    if (!start) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) return;
    const inst = aladinInstanceRef.current;
    if (!inst || typeof inst.pix2world !== 'function') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ox = e.clientX - rect.left;
    const oy = e.clientY - rect.top;
    try {
      const sky = inst.pix2world(ox, oy, 'icrs');
      if (Array.isArray(sky) && Number.isFinite(sky[0]) && Number.isFinite(sky[1])) {
        const clickedRa = ((sky[0] % 360) + 360) % 360;
        const clickedDec = Math.max(-90, Math.min(90, sky[1]));
        onSelectPosition(clickedRa, clickedDec, null);
        onQueryArchive(clickedRa, clickedDec);
      }
    } catch {
      // ignore invalid projection clicks outside sphere
    }
  };

  const pmRaActive = activeTarget?.pmRaMasYr ?? lastResolvedInfo?.pmRaMasYr ?? null;
  const pmDecActive = activeTarget?.pmDecMasYr ?? lastResolvedInfo?.pmDecMasYr ?? null;
  const refEpochActive = activeTarget?.epochYear ?? lastResolvedInfo?.epochYear ?? 2000;
  const propagated =
    pmRaActive !== null && pmDecActive !== null
      ? propagatePosition(raDeg, decDeg, pmRaActive, pmDecActive, refEpochActive, epochYear)
      : null;

  return (
    <div className="flex flex-col lg:flex-row h-[calc(100vh-7.5rem)] min-h-[640px] bg-[#07090E] border border-slate-800 rounded-md overflow-hidden">
      {/* Left Control & Target Rail */}
      <aside className="w-full lg:w-[360px] shrink-0 bg-[#0B0E17] border-b lg:border-b-0 lg:border-r border-slate-800 flex flex-col overflow-y-auto p-4 gap-5">
        <div>
          <h2 className="text-sm font-semibold text-slate-100 tracking-wide mb-2">
            {t.searchPlaceholder.split('(')[0].trim()}
          </h2>
          <form onSubmit={handleSearchSubmit} className="flex flex-col gap-2">
            <label htmlFor="sky-search-input" className="sr-only">
              {t.searchPlaceholder}
            </label>
            <div className="relative">
              <input
                id="sky-search-input"
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder={t.searchPlaceholder}
                className="w-full bg-[#07090E] border border-slate-700 focus:border-cyan-500 rounded px-3 py-2 pr-9 text-xs font-mono text-slate-100 placeholder:text-slate-500 focus:outline-none"
              />
              <Search className="w-3.5 h-3.5 text-slate-400 absolute right-3 top-2.5 pointer-events-none" />
            </div>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={resolving}
                className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs font-medium py-2 px-3 rounded border border-slate-700 transition-colors cursor-pointer whitespace-nowrap"
              >
                {resolving ? '...' : t.goBtn}
              </button>
              <button
                type="button"
                onClick={() => {
                  onQueryArchive(raDeg, decDeg);
                  onGoToObservations();
                }}
                disabled={isQuerying}
                className="flex-1 bg-cyan-600 hover:bg-cyan-500 text-slate-950 text-xs font-semibold py-2 px-3 rounded transition-colors cursor-pointer whitespace-nowrap"
              >
                {t.queryArchiveBtn}
              </button>
            </div>
          </form>
          {searchError && <p className="text-xs text-rose-400 mt-2">{searchError}</p>}
        </div>

        {/* Cutout Size & Transfer Estimator */}
        <div className="border-t border-slate-800 pt-4 space-y-2">
          <div className="flex items-center justify-between">
            <label htmlFor="cutout-size-select" className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              {t.cutoutSizeLabel}
            </label>
            <span className="text-xs font-mono text-cyan-300 tabular-nums">
              {cutoutSizeDeg.toFixed(2)}° ({(cutoutSizeDeg * 60).toFixed(1)}')
            </span>
          </div>
          <select
            id="cutout-size-select"
            value={cutoutSizeDeg}
            onChange={(e) => onChangeCutoutSize(Number(e.target.value))}
            className="w-full bg-[#07090E] border border-slate-700 rounded px-2.5 py-1.5 text-xs font-mono text-slate-100"
          >
            <option value={0.05}>0.05° (3.0' · Default ~29×29 px)</option>
            <option value={0.10}>0.10° (6.0' · ~59×59 px)</option>
            <option value={0.15}>0.15° (9.0' · ~88×88 px)</option>
            <option value={CUTOUT_DEFAULTS.maxFovDeg}>0.20° (12.0' · Max ~117×117 px)</option>
          </select>
          <p className="text-[11px] font-mono text-slate-400 tabular-nums">
            Est. {cutoutEstimate.pixelsPerSide}×{cutoutEstimate.pixelsPerSide} px · ~{cutoutEstimate.mbPerFrame.toFixed(1)} MB/frame (~{cutoutEstimate.estimatedSeconds}s for {Math.max(1, Math.min(6, observations.length || 4))} frames)
          </p>
        </div>

        {/* Challenge & Reference Targets */}
        <div className="border-t border-slate-800 pt-4">
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2.5">
            {t.challengeTargets}
          </h3>
          <div className="flex flex-col gap-1.5">
            {CHALLENGE_TARGETS.map((target) => {
              const isActive = activeTarget?.id === target.id;
              const isResolvingThis = resolvingTargetId === target.id;
              const resolved = target.resolvedInfo ?? (isActive && lastResolvedInfo?.query === target.simbadId ? lastResolvedInfo : undefined);
              return (
                <button
                  key={target.id}
                  type="button"
                  disabled={isResolvingThis}
                  onClick={() => onSelectTargetPreset(target)}
                  className={`text-left px-3 py-2 rounded border transition-colors cursor-pointer ${
                    isActive
                      ? 'bg-cyan-950/40 border-cyan-500/60 text-slate-100'
                      : 'bg-[#07090E] border-slate-800 hover:border-slate-700 text-slate-300'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold truncate flex items-center gap-1.5">
                      {isResolvingThis && <Loader2 className="w-3 h-3 animate-spin text-cyan-400" />}
                      {lang === 'pt' ? target.namePt : target.name}
                    </span>
                    <span className="text-[11px] font-mono text-slate-400 shrink-0">
                      {target.simbadResolveRequired
                        ? resolved
                          ? 'SIMBAD OK'
                          : 'SIMBAD Live'
                        : target.category === 'high-pm'
                        ? 'Challenge'
                        : 'QR3 Cal'}
                    </span>
                  </div>
                  <div className="text-[11px] font-mono text-slate-400 mt-0.5 tabular-nums">
                    {resolved
                      ? `${degToHms(resolved.ra, 2)} · ${degToDms(resolved.dec, 1)}`
                      : `${target.raDisplay} · ${target.decDisplay}`}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Active Target Proper Motion & Scientific Context */}
        {(activeTarget || lastResolvedInfo) && (
          <div className="border-t border-slate-800 pt-4 space-y-2.5">
            {propagated && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-300">
                    {t.epochPropagation}
                  </span>
                  <span className="text-xs font-mono text-cyan-400 tabular-nums">
                    {epochYear.toFixed(1)}
                  </span>
                </div>
                <input
                  type="range"
                  aria-label={t.epochPropagation}
                  min={2000}
                  max={2027}
                  step={0.5}
                  value={epochYear}
                  onChange={(e) => setEpochYear(Number(e.target.value))}
                  className="w-full accent-cyan-500 cursor-pointer"
                />
                <div className="text-[11px] font-mono text-slate-300 bg-[#07090E] border border-slate-800 rounded p-2 space-y-1 tabular-nums">
                  <div>RA ({epochYear.toFixed(1)}): {degToHms(propagated.ra, 3)}</div>
                  <div>Dec ({epochYear.toFixed(1)}): {degToDms(propagated.dec, 2)}</div>
                  {pmRaActive !== null && pmDecActive !== null && (
                    <div className="text-slate-400">
                      PM: ({pmRaActive.toFixed(1)}, {pmDecActive.toFixed(1)}) mas/yr
                    </div>
                  )}
                </div>
              </>
            )}
            {activeTarget && (
              <>
                <p className="text-xs text-slate-400 leading-relaxed">
                  {lang === 'pt' ? activeTarget.summaryPt : activeTarget.summaryEn}
                </p>
                {(activeTarget.resolutionNoteEn || activeTarget.resolutionNotePt) && (
                  <p className="text-[11px] text-amber-300 bg-amber-950/25 border border-amber-500/30 rounded p-2 leading-relaxed">
                    {lang === 'pt' ? activeTarget.resolutionNotePt : activeTarget.resolutionNoteEn}
                  </p>
                )}
                <p className="text-[11px] text-slate-500 font-mono">
                  {activeTarget.coordEpochNote}
                </p>
              </>
            )}
            {lastResolvedInfo && (
              <div className="text-[11px] font-mono text-emerald-300 bg-emerald-950/20 border border-emerald-500/30 rounded p-2">
                {lastResolvedInfo.source}: {lastResolvedInfo.name} ({lastResolvedInfo.otype}, J{lastResolvedInfo.epochYear})
              </div>
            )}
          </div>
        )}

        {/* Survey Layer Selector */}
        <div className="border-t border-slate-800 pt-4 space-y-2">
          <label htmlFor="survey-select" className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5" />
            {t.surveyLayer}
          </label>
          <select
            id="survey-select"
            value={surveyId}
            onChange={(e) => setSurveyId(e.target.value as SurveyLayerId)}
            className="w-full bg-[#07090E] border border-slate-700 rounded px-2.5 py-2 text-xs text-slate-100 focus:border-cyan-500 focus:outline-none"
          >
            {Object.entries(SURVEY_CONFIGS).map(([id, cfg]) => (
              <option key={id} value={id}>
                {lang === 'pt' ? cfg.labelPt : cfg.labelEn}
              </option>
            ))}
          </select>
          <div className={`text-[11px] ${SURVEY_CONFIGS[surveyId].isSpherex ? 'text-cyan-400' : 'text-amber-400'}`}>
            {SURVEY_CONFIGS[surveyId].provenance}
          </div>

          {surveyId === 'spherex_cube' && (
            <div className="pt-2 space-y-1">
              <label htmlFor="cube-slice-select" className="text-[11px] text-slate-400 block">
                {t.cubeWavelengthChannel}
              </label>
              <select
                id="cube-slice-select"
                value={cubeFrame}
                onChange={(e) => setCubeFrame(Number(e.target.value))}
                className="w-full bg-[#07090E] border border-slate-700 rounded px-2 py-1.5 text-xs font-mono text-slate-200"
              >
                {SPHEREX_PREVIEW_CHANNELS.map((ch) => (
                  <option key={ch.frame} value={ch.frame}>
                    Ch {ch.frame} · {ch.wavelength}
                  </option>
                ))}
              </select>
              <p className="text-[10px] text-slate-500">{t.cubeResolutionNote}</p>
            </div>
          )}
        </div>
      </aside>

      {/* Main Sky Atlas Viewport */}
      <div className="flex-1 flex flex-col relative min-h-[420px]">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2 bg-[#0B0E17] border-b border-slate-800 text-xs">
          <div className="flex flex-wrap items-center gap-4 font-mono tabular-nums">
            <span className="text-slate-300 flex items-center gap-1.5">
              <Crosshair className="w-3.5 h-3.5 text-cyan-400" />
              ICRS {degToHms(raDeg, 3)} {degToDms(decDeg, 2)}
            </span>
            <span className="text-slate-500">
              ({raDeg.toFixed(5)}°, {decDeg.toFixed(5)}°)
            </span>
            <span className="text-slate-400">
              {t.fovLabel}: {fovDeg >= 1 ? `${fovDeg.toFixed(1)}°` : `${(fovDeg * 60).toFixed(1)}'`}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShowCoverage((v) => !v)}
              className={`px-2.5 py-1 rounded border text-xs flex items-center gap-1.5 cursor-pointer whitespace-nowrap ${
                showCoverage
                  ? 'bg-cyan-950/50 border-cyan-500/60 text-cyan-200'
                  : 'bg-[#07090E] border-slate-700 text-slate-300 hover:border-slate-600'
              }`}
            >
              <Radar className="w-3.5 h-3.5" />
              {t.coverageLayer}
            </button>
            <button
              type="button"
              onClick={() => setShowGrid((v) => !v)}
              className={`px-2.5 py-1 rounded border text-xs flex items-center gap-1.5 cursor-pointer whitespace-nowrap ${
                showGrid
                  ? 'bg-cyan-950/50 border-cyan-500/60 text-cyan-200'
                  : 'bg-[#07090E] border-slate-700 text-slate-300 hover:border-slate-600'
              }`}
            >
              <Grid3X3 className="w-3.5 h-3.5" />
              {t.coordGrid}
            </button>
            <button
              type="button"
              onClick={() => onChangeFov(Math.max(0.05, fovDeg * 0.5))}
              aria-label="Zoom In"
              className="p-1.5 rounded bg-[#07090E] border border-slate-700 text-slate-300 hover:text-white cursor-pointer"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onChangeFov(Math.min(60, fovDeg * 2))}
              aria-label="Zoom Out"
              className="p-1.5 rounded bg-[#07090E] border border-slate-700 text-slate-300 hover:text-white cursor-pointer"
            >
              <Minimize2 className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onChangeFov(0.75)}
              aria-label="Reset FoV"
              className="p-1.5 rounded bg-[#07090E] border border-slate-700 text-slate-300 hover:text-white cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setAtlasMode((m) => (m === 'aladin' ? 'canvas' : 'aladin'))}
              className="px-2.5 py-1 rounded bg-[#07090E] border border-slate-700 text-xs text-slate-300 hover:text-white cursor-pointer whitespace-nowrap"
            >
              {atlasMode === 'aladin' ? t.atlasModeCanvas : t.atlasModeAladin}
            </button>
          </div>
        </div>

        <div className="flex-1 relative bg-[#05070c]" data-testid="sky-atlas-viewport">
          {atlasMode === 'aladin' ? (
            <div
              className="w-full h-full relative"
              onPointerDown={handleAladinPointerDown}
              onPointerUp={handleAladinPointerUp}
            >
              <div ref={aladinContainerRef} className="aladin-container" />
              {aladinStatus === 'loading' && (
                <div className="absolute inset-0 flex items-center justify-center bg-[#05070c]/80 text-xs font-mono text-slate-400 pointer-events-none">
                  Initializing Aladin Lite v3 HiPS sky atlas...
                </div>
              )}
            </div>
          ) : (
            <canvas
              ref={fallbackCanvasRef}
              onMouseDown={(e) => setDragStart({ x: e.clientX, y: e.clientY, ra: raDeg, dec: decDeg, moved: false })}
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const scale = Math.min(rect.width, rect.height) / Math.max(0.02, fovDeg);
                const cosD = Math.max(0.15, Math.cos((decDeg * Math.PI) / 180));
                if (dragStart) {
                  const dx = e.clientX - dragStart.x;
                  const dy = e.clientY - dragStart.y;
                  const moved = dragStart.moved || Math.hypot(dx, dy) > 4;
                  if (moved !== dragStart.moved) setDragStart({ ...dragStart, moved });
                  const newRa = ((dragStart.ra + dx / (scale * cosD)) % 360 + 360) % 360;
                  const newDec = Math.max(-89.9, Math.min(89.9, dragStart.dec + dy / scale));
                  onSelectPosition(newRa, newDec, activeTarget);
                } else {
                  const dx = e.clientX - rect.left - rect.width / 2;
                  const dy = e.clientY - rect.top - rect.height / 2;
                  const hoverRa = ((raDeg - dx / (scale * cosD)) % 360 + 360) % 360;
                  const hoverDec = Math.max(-90, Math.min(90, decDeg - dy / scale));
                  setCursorSky({ ra: hoverRa, dec: hoverDec });
                }
              }}
              onMouseUp={(e) => {
                if (dragStart && !dragStart.moved) {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const scale = Math.min(rect.width, rect.height) / Math.max(0.02, fovDeg);
                  const cosD = Math.max(0.15, Math.cos((decDeg * Math.PI) / 180));
                  const dx = e.clientX - rect.left - rect.width / 2;
                  const dy = e.clientY - rect.top - rect.height / 2;
                  const clickRa = ((raDeg - dx / (scale * cosD)) % 360 + 360) % 360;
                  const clickDec = Math.max(-90, Math.min(90, decDeg - dy / scale));
                  onSelectPosition(clickRa, clickDec, null);
                  onQueryArchive(clickRa, clickDec);
                }
                setDragStart(null);
              }}
              onMouseLeave={() => setDragStart(null)}
              onWheel={(e) => {
                e.preventDefault();
                const factor = e.deltaY > 0 ? 1.25 : 0.8;
                onChangeFov(Math.max(0.03, Math.min(60, fovDeg * factor)));
              }}
              className="w-full h-full cursor-crosshair block"
            />
          )}

          {/* Bottom-left live cursor & click-to-select hint */}
          <div className="absolute bottom-3 left-3 max-w-[calc(100%-1.5rem)] bg-[#07090E]/90 border border-slate-800 rounded px-3 py-1.5 text-[11px] font-mono text-slate-300 pointer-events-none flex flex-wrap items-center gap-3 tabular-nums">
            <span className="flex items-center gap-1 text-cyan-400">
              <Compass className="w-3 h-3" />
              N ↑ · E ←
            </span>
            <span>
              Cursor: {degToHms(cursorSky.ra, 2)} {degToDms(cursorSky.dec, 1)}
            </span>
            <span className="text-slate-500">Click map to select & search</span>
          </div>

          {/* Bottom-right direct investigation CTA (kept clear of Aladin watermark) */}
          <div className="absolute bottom-14 right-3 flex items-center gap-2 z-20">
            <button
              type="button"
              onClick={() => {
                onQueryArchive(raDeg, decDeg);
                onGoToObservations();
              }}
              className="bg-cyan-600 hover:bg-cyan-500 text-slate-950 text-xs font-semibold px-3.5 py-2 rounded shadow-lg flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
            >
              <Sparkles className="w-3.5 h-3.5" />
              {t.queryArchiveBtn}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
