import React, { useEffect, useMemo, useRef, useState } from 'react';
import { applyPalette, GIFEncoder, quantize } from 'gifenc';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Columns2,
  Compass,
  Crosshair,
  Diff,
  Download,
  Film,
  Flag,
  Layers,
  Loader2,
  Pause,
  Play,
  Repeat,
  RotateCcw,
  Sparkles,
  SunMoon,
} from 'lucide-react';
import {
  mjdToYear,
  pixelToSky,
  propagateLinear,
  skyToPixel,
  type WcsModel,
} from '../lib/astrometry';
import { degToDms, degToHms } from '../lib/astronomy';
import { triggerBinaryDownload } from '../lib/exports';
import {
  buildProcessedFitsBuffer,
  computePercentileLimits,
  pixelToWorld,
  stretchNormalized,
  wavelengthAtPixel,
  type StretchMode,
} from '../lib/fits';
import type { Language } from '../lib/i18n';
import { TRANSLATIONS } from '../lib/i18n';
import { computeDifferenceImage, type ReprojectedResult } from '../lib/processing';
import type {
  AstrometricDetectionRecord,
  AstrometricTrackRecord,
  GaiaSource,
  LoadedSpherexFrame,
  ManualMark,
} from '../types/spherex';

type ColormapId = 'grayscale' | 'inferno' | 'viridis' | 'coolwarm';

interface TemporalViewerProps {
  lang: Language;
  frames: LoadedSpherexFrame[];
  reprojectedByFrame: Record<string, ReprojectedResult>;
  activeIndex: number;
  onChangeIndex: (idx: number) => void;
  targetRa: number;
  targetDec: number;
  rejectMask: number;
  cautionMask: number;
  astrometryDetectionsByFrame: Record<string, AstrometricDetectionRecord[]>;
  astrometryTracks: AstrometricTrackRecord[];
  gaiaSources: GaiaSource[];
  selectedSourceId: string | null;
  onSelectSource: (src: AstrometricDetectionRecord) => void;
  onStackDetector: (detector: number, method: 'median' | 'mean') => void;
  isStacking?: boolean;
  onSaveSnapshot: (label: string, dataUrl: string) => void;
  onAddEpochNote: (frame: LoadedSpherexFrame, note: string) => void;
  manualMarks: ManualMark[];
  onAddManualMark: (mark: ManualMark) => void;
  onRemoveManualMark: (id: string) => void;
  onLoadQuickDemo: () => void;
  embedMode?: boolean;
}

function sampleColormap(t: number, cmap: ColormapId): [number, number, number] {
  const c = Math.max(0, Math.min(1, t));
  if (cmap === 'grayscale') {
    const v = Math.round(c * 255);
    return [v, v, v];
  }
  if (cmap === 'inferno') {
    const r = Math.round(Math.min(255, Math.pow(c, 0.65) * 280));
    const g = Math.round(Math.min(255, Math.max(0, (c - 0.28) * 350)));
    const b = Math.round(Math.min(255, c < 0.5 ? c * 260 : (1 - c) * 240 + 40));
    return [r, g, b];
  }
  if (cmap === 'viridis') {
    const r = Math.round(68 + c * (253 - 68) * c);
    const g = Math.round(1 + Math.sin(c * Math.PI * 0.85) * 210);
    const b = Math.round(84 + (1 - c) * 100);
    return [Math.min(255, r), Math.min(255, g), Math.min(255, b)];
  }
  // coolwarm
  const r = Math.round(59 + c * 185);
  const g = Math.round(76 + Math.sin(c * Math.PI) * 145);
  const b = Math.round(192 - c * 140);
  return [r, g, b];
}

function getDisplayImageSpec(
  frame: LoadedSpherexFrame,
  reprojectedByFrame: Record<string, ReprojectedResult>,
  useSkyGrid: boolean,
): {
  width: number;
  height: number;
  data: Float32Array;
  wcs: WcsModel | null;
  isReprojected: boolean;
} {
  const rep = useSkyGrid ? reprojectedByFrame[frame.frameId] : undefined;
  if (rep) {
    return {
      width: rep.grid.width,
      height: rep.grid.height,
      data: rep.data,
      wcs: rep.wcs,
      isReprojected: true,
    };
  }
  return {
    width: frame.width,
    height: frame.height,
    data: frame.image,
    wcs: frame.astrometryWcs ?? null,
    isReprojected: false,
  };
}

function projectSkyToCanvas(
  ra: number,
  dec: number,
  wcs: WcsModel | null,
  iw: number,
  ih: number,
  drawX: number,
  drawY: number,
  drawW: number,
  drawH: number,
): { sx: number; sy: number } | null {
  if (!wcs) return null;
  try {
    const [px, py] = skyToPixel(wcs, ra, dec);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
    const sx = drawX + ((px + 0.5) / iw) * drawW;
    const sy = drawY + ((ih - 1 - py + 0.5) / ih) * drawH;
    return { sx, sy };
  } catch {
    return null;
  }
}

function renderImageToCanvas(
  canvas: HTMLCanvasElement,
  params: {
    width: number;
    height: number;
    data: Float32Array;
    wcs: WcsModel | null;
    rawFrame: LoadedSpherexFrame;
    isReprojected: boolean;
    stretch: StretchMode;
    brightness: number;
    contrast: number;
    invert: boolean;
    cmap: ColormapId;
    zoom: number;
    panX: number;
    panY: number;
    symmetricLimits?: boolean;
    showFlags?: boolean;
    rejectMask?: number;
    cautionMask?: number;
    showCrosshair?: boolean;
    targetRa?: number;
    targetDec?: number;
    showGaia?: boolean;
    gaiaSources?: GaiaSource[];
    detections?: AstrometricDetectionRecord[];
    selectedSourceId?: string | null;
    tracks?: AstrometricTrackRecord[];
    manualMarks?: ManualMark[];
  },
) {
  const rect = canvas.getBoundingClientRect();
  const cw = Math.max(320, Math.floor(rect.width || 560));
  const ch = Math.max(280, Math.floor(rect.height || 430));
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.fillStyle = '#05070c';
  ctx.fillRect(0, 0, cw, ch);

  const { width: iw, height: ih, data, wcs, rawFrame, isReprojected } = params;
  if (iw <= 0 || ih <= 0) return;

  const off = document.createElement('canvas');
  off.width = iw;
  off.height = ih;
  const octx = off.getContext('2d');
  if (!octx) return;
  const imgData = octx.createImageData(iw, ih);

  let { min, max } = computePercentileLimits(data, 1.5, 99.4);
  if (params.symmetricLimits) {
    const absMax = Math.max(Math.abs(min), Math.abs(max), 1e-4);
    min = -absMax;
    max = absMax;
  }

  for (let y = 0; y < ih; y++) {
    for (let x = 0; x < iw; x++) {
      const fitsY = ih - 1 - y;
      const idx = fitsY * iw + x;
      const val = data[idx];
      const outIdx = (y * iw + x) * 4;

      if (!Number.isFinite(val)) {
        // NaN / masked / outside footprint — draw subtle checkerboard slate, never zero-fill
        const dark = ((x + y) & 1) === 0 ? 11 : 16;
        imgData.data[outIdx] = dark;
        imgData.data[outIdx + 1] = dark + 3;
        imgData.data[outIdx + 2] = dark + 9;
        imgData.data[outIdx + 3] = 255;
        continue;
      }

      let norm = stretchNormalized(val, min, max, params.stretch);
      norm = (norm - 0.5) * params.contrast + 0.5 + params.brightness;
      norm = Math.max(0, Math.min(1, norm));
      if (params.invert) norm = 1 - norm;
      let [r, g, b] = sampleColormap(norm, params.cmap);

      // Apply FLAGS pixel tint in native view (or reprojected if sizes match)
      if (params.showFlags && !isReprojected && rawFrame.flags && idx < rawFrame.flags.length) {
        const fv = rawFrame.flags[idx] >>> 0;
        if (params.rejectMask && (fv & params.rejectMask) !== 0) {
          r = Math.min(255, Math.round(r * 0.35 + 170));
          g = Math.round(g * 0.35 + 20);
          b = Math.round(b * 0.35 + 35);
        } else if (params.cautionMask && (fv & params.cautionMask) !== 0) {
          r = Math.min(255, Math.round(r * 0.55 + 115));
          g = Math.min(255, Math.round(g * 0.55 + 80));
          b = Math.round(b * 0.55 + 10);
        }
      }

      imgData.data[outIdx] = r;
      imgData.data[outIdx + 1] = g;
      imgData.data[outIdx + 2] = b;
      imgData.data[outIdx + 3] = 255;
    }
  }
  octx.putImageData(imgData, 0, 0);

  const baseScale = Math.min((cw * 0.88) / iw, (ch * 0.88) / ih) * params.zoom;
  const drawW = iw * baseScale;
  const drawH = ih * baseScale;
  const drawX = (cw - drawW) / 2 + params.panX;
  const drawY = (ch - drawH) / 2 + params.panY;

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, drawX, drawY, drawW, drawH);

  ctx.strokeStyle = 'rgba(56, 189, 248, 0.25)';
  ctx.lineWidth = 1;
  ctx.strokeRect(drawX, drawY, drawW, drawH);

  // Target coordinate crosshair (fixed on sky target, never recentered on moving pixel)
  if (params.showCrosshair && params.targetRa !== undefined && params.targetDec !== undefined) {
    const pt = projectSkyToCanvas(
      params.targetRa,
      params.targetDec,
      wcs,
      iw,
      ih,
      drawX,
      drawY,
      drawW,
      drawH,
    );
    if (pt) {
      ctx.strokeStyle = 'rgba(34, 211, 238, 0.85)';
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(pt.sx - 13, pt.sy);
      ctx.lineTo(pt.sx - 4, pt.sy);
      ctx.moveTo(pt.sx + 4, pt.sy);
      ctx.lineTo(pt.sx + 13, pt.sy);
      ctx.moveTo(pt.sx, pt.sy - 13);
      ctx.lineTo(pt.sx, pt.sy - 4);
      ctx.moveTo(pt.sx, pt.sy + 4);
      ctx.lineTo(pt.sx, pt.sy + 13);
      ctx.stroke();
    }
  }

  // Gaia DR3 overlay propagated from 2016.0 to frame MJD epoch
  if (params.showGaia && params.gaiaSources && params.gaiaSources.length > 0 && wcs) {
    const frameYear = mjdToYear(rawFrame.observation.mjdObs > 0 ? rawFrame.observation.mjdObs : 61000);
    for (const g of params.gaiaSources) {
      const [raEp, decEp] = propagateLinear(g.ra, g.dec, g.pmra, g.pmdec, g.epochYear, frameYear);
      const pt = projectSkyToCanvas(raEp, decEp, wcs, iw, ih, drawX, drawY, drawW, drawH);
      if (!pt || pt.sx < drawX || pt.sx > drawX + drawW || pt.sy < drawY || pt.sy > drawY + drawH) continue;
      ctx.strokeStyle = '#34d399';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(pt.sx, pt.sy - 6);
      ctx.lineTo(pt.sx + 6, pt.sy);
      ctx.lineTo(pt.sx, pt.sy + 6);
      ctx.lineTo(pt.sx - 6, pt.sy);
      ctx.closePath();
      ctx.stroke();
      if (g.gMag !== undefined && g.gMag < 17) {
        ctx.fillStyle = '#6ee7b7';
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.fillText(`G${g.gMag.toFixed(1)}`, pt.sx + 7, pt.sy - 4);
      }
    }
  }

  // Detected sources projected via WCS onto displayed grid
  if (params.detections && params.detections.length > 0) {
    for (const src of params.detections) {
      const pt = wcs
        ? projectSkyToCanvas(src.ra, src.dec, wcs, iw, ih, drawX, drawY, drawW, drawH)
        : {
            sx: drawX + ((src.x + 0.5) / iw) * drawW,
            sy: drawY + ((ih - 1 - src.y + 0.5) / ih) * drawH,
          };
      if (!pt) continue;
      const isSelected = src.id === params.selectedSourceId;
      ctx.strokeStyle = isSelected ? '#22d3ee' : src.rejectFlagged ? '#f43f5e' : '#f59e0b';
      ctx.lineWidth = isSelected ? 2 : 1.3;
      ctx.beginPath();
      ctx.arc(pt.sx, pt.sy, isSelected ? 10 : 7, 0, Math.PI * 2);
      ctx.stroke();
      if (isSelected) {
        ctx.fillStyle = '#22d3ee';
        ctx.font = '11px "JetBrains Mono", monospace';
        ctx.fillText(`SNR ${src.snr.toFixed(1)}`, pt.sx + 12, pt.sy - 4);
      }
    }
  }

  // Cross-epoch tracks
  if (params.tracks && params.tracks.length > 0 && wcs) {
    for (const tr of params.tracks) {
      if (tr.detections.length < 2) continue;
      ctx.strokeStyle = tr.status === 'user-confirmed' ? '#10b981' : '#38bdf8';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      for (const d of tr.detections) {
        const pt = projectSkyToCanvas(d.ra, d.dec, wcs, iw, ih, drawX, drawY, drawW, drawH);
        if (!pt) continue;
        if (!started) {
          ctx.moveTo(pt.sx, pt.sy);
          started = true;
        } else {
          ctx.lineTo(pt.sx, pt.sy);
        }
      }
      if (started) ctx.stroke();
    }
  }
  // Manual labels are anchored by ICRS coordinates, not by screen pixels.
  if (params.manualMarks?.length && wcs) {
    for (const mark of params.manualMarks) {
      const pt = projectSkyToCanvas(mark.raDeg, mark.decDeg, wcs, iw, ih, drawX, drawY, drawW, drawH);
      if (!pt || pt.sx < drawX || pt.sx > drawX + drawW || pt.sy < drawY || pt.sy > drawY + drawH) continue;
      ctx.save();
      ctx.strokeStyle = mark.color;
      ctx.fillStyle = mark.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (mark.shape === 'circle') ctx.arc(pt.sx, pt.sy, 12, 0, Math.PI * 2);
      else {
        ctx.moveTo(pt.sx - 10, pt.sy); ctx.lineTo(pt.sx + 10, pt.sy);
        ctx.moveTo(pt.sx, pt.sy - 10); ctx.lineTo(pt.sx, pt.sy + 10);
      }
      ctx.stroke();
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText(mark.label.slice(0, 32), pt.sx + 16, pt.sy - 12);
      ctx.restore();
    }
  }
}

export const TemporalViewer: React.FC<TemporalViewerProps> = ({
  lang,
  frames,
  reprojectedByFrame,
  activeIndex,
  onChangeIndex,
  targetRa,
  targetDec,
  rejectMask,
  cautionMask,
  astrometryDetectionsByFrame,
  astrometryTracks,
  gaiaSources,
  selectedSourceId,
  onSelectSource,
  onStackDetector,
  isStacking = false,
  onSaveSnapshot,
  onAddEpochNote,
  manualMarks,
  onAddManualMark,
  onRemoveManualMark,
  onLoadQuickDemo,
  embedMode = false,
}) => {
  const t = TRANSLATIONS[lang];
  const mainCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const compareCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [detectorFilter, setDetectorFilter] = useState<string>('ALL');
  const [wlWindowFilter, setWlWindowFilter] = useState(false);

  const [isPlaying, setIsPlaying] = useState(false);
  const [fps, setFps] = useState(2);
  const [stretch, setStretch] = useState<StretchMode>('asinh');
  const [cmap, setCmap] = useState<ColormapId>('inferno');
  const [brightness, setBrightness] = useState(0);
  const [contrast, setContrast] = useState(1);
  const [invert, setInvert] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragOrigin, setDragOrigin] = useState<{ mx: number; my: number; px: number; py: number } | null>(null);

  const [useSkyGrid, setUseSkyGrid] = useState(true);
  const [showFlags, setShowFlags] = useState(false);
  const [showCrosshair, setShowCrosshair] = useState(true);
  const [showGaiaOverlay, setShowGaiaOverlay] = useState(true);

  const [compareMode, setCompareMode] = useState(false);
  const [blinkMode, setBlinkMode] = useState(false);
  const [blinkToggle, setBlinkToggle] = useState(false);
  const [diffMode, setDiffMode] = useState(false);
  const [compareIndex, setCompareIndex] = useState(0);
  const [exportingGif, setExportingGif] = useState(false);
  const [noteInput, setNoteInput] = useState('');
  const [markMode, setMarkMode] = useState(false);
  const [markLabel, setMarkLabel] = useState('');
  const [markColor, setMarkColor] = useState('#fbbf24');
  const [markShape, setMarkShape] = useState<'circle' | 'cross'>('circle');
  const [showFlagTable, setShowFlagTable] = useState(false);

  const [probe, setProbe] = useState<{
    x: number;
    y: number;
    val: number;
    sigma?: number;
    zodi?: number;
    ra?: number;
    dec?: number;
    waveUm?: number;
    flagVal?: number;
  } | null>(null);

  const availableDetectors = useMemo(() => {
    const s = new Set<number>();
    frames.forEach((f) => s.add(f.observation.detector));
    return Array.from(s).sort((a, b) => a - b);
  }, [frames]);

  // Filtered sequence indices (keeping band vs time strict)
  const visibleIndices = useMemo(() => {
    const refFrame = frames[activeIndex] ?? frames[0];
    const refWl = refFrame?.targetWavelengthUm ?? refFrame?.sliceWavelengthUm;
    const out: number[] = [];
    frames.forEach((f, idx) => {
      if (detectorFilter !== 'ALL' && String(f.observation.detector) !== detectorFilter) return;
      if (wlWindowFilter && refWl) {
        const wl = f.targetWavelengthUm ?? f.sliceWavelengthUm;
        if (wl !== undefined && Math.abs(wl - refWl) > 0.03 * refWl) return;
      }
      out.push(idx);
    });
    return out.length > 0 ? out : frames.map((_, i) => i);
  }, [frames, detectorFilter, wlWindowFilter, activeIndex]);

  const activeFrame = frames[activeIndex] ?? null;
  const compareFrame = frames[compareIndex] ?? frames[0] ?? null;

  // Displayed frame (swaps during Blink A/B)
  const displayedFrame = blinkMode && blinkToggle && compareFrame ? compareFrame : activeFrame;

  const hasMixedBandsOrCube = useMemo(() => {
    const shownFrames = visibleIndices.map((i) => frames[i]).filter(Boolean);
    if (shownFrames.length <= 1) return shownFrames[0]?.isSpectralCubeSlice ?? false;
    const bands = new Set(shownFrames.map((f) => f.observation.bandpassName));
    return bands.size > 1 || shownFrames.some((f) => f.isSpectralCubeSlice);
  }, [frames, visibleIndices]);

  // Playback timer over filtered frames
  useEffect(() => {
    if ((!isPlaying && !blinkMode) || frames.length <= 1) return;
    const id = window.setInterval(() => {
      if (blinkMode) {
        setBlinkToggle((b) => !b);
      } else {
        const pos = visibleIndices.indexOf(activeIndex);
        const nextPos = pos >= 0 ? (pos + 1) % visibleIndices.length : 0;
        onChangeIndex(visibleIndices[nextPos]);
      }
    }, Math.round(1000 / Math.max(0.5, fps)));
    return () => window.clearInterval(id);
  }, [isPlaying, blinkMode, fps, frames.length, visibleIndices, activeIndex, onChangeIndex]);

  // Difference image data (A - B on sky-aligned reprojected grid)
  const diffPayload = useMemo(() => {
    if (!diffMode || !activeFrame || !compareFrame) return null;
    const specA = getDisplayImageSpec(activeFrame, reprojectedByFrame, true);
    const specB = getDisplayImageSpec(compareFrame, reprojectedByFrame, true);
    if (specA.width !== specB.width || specA.height !== specB.height) return null;
    return {
      width: specA.width,
      height: specA.height,
      data: computeDifferenceImage(specA.data, specB.data),
      wcs: specA.wcs,
      sameDetector: activeFrame.observation.detector === compareFrame.observation.detector,
    };
  }, [diffMode, activeFrame, compareFrame, reprojectedByFrame]);

  // Draw primary canvas
  useEffect(() => {
    if (!mainCanvasRef.current || !displayedFrame) return;
    if (diffMode && diffPayload) {
      renderImageToCanvas(mainCanvasRef.current, {
        width: diffPayload.width,
        height: diffPayload.height,
        data: diffPayload.data,
        wcs: diffPayload.wcs,
        rawFrame: displayedFrame,
        isReprojected: true,
        stretch: 'linear',
        brightness,
        contrast,
        invert,
        cmap: 'coolwarm',
        zoom,
        panX: pan.x,
        panY: pan.y,
        symmetricLimits: true,
        showCrosshair,
        targetRa,
        targetDec,
        showGaia: showGaiaOverlay,
        gaiaSources,
        detections: astrometryDetectionsByFrame[displayedFrame.frameId],
        selectedSourceId,
        tracks: astrometryTracks,
        manualMarks,
      });
      return;
    }

    const spec = getDisplayImageSpec(displayedFrame, reprojectedByFrame, useSkyGrid);
    renderImageToCanvas(mainCanvasRef.current, {
      width: spec.width,
      height: spec.height,
      data: spec.data,
      wcs: spec.wcs,
      rawFrame: displayedFrame,
      isReprojected: spec.isReprojected,
      stretch,
      brightness,
      contrast,
      invert,
      cmap,
      zoom,
      panX: pan.x,
      panY: pan.y,
      showFlags,
      rejectMask,
      cautionMask,
      showCrosshair,
      targetRa,
      targetDec,
      showGaia: showGaiaOverlay,
      gaiaSources,
      detections: astrometryDetectionsByFrame[displayedFrame.frameId],
      selectedSourceId,
      tracks: astrometryTracks,
      manualMarks,
    });
  }, [
    displayedFrame,
    reprojectedByFrame,
    useSkyGrid,
    diffMode,
    diffPayload,
    stretch,
    brightness,
    contrast,
    invert,
    cmap,
    zoom,
    pan,
    showFlags,
    rejectMask,
    cautionMask,
    showCrosshair,
    targetRa,
    targetDec,
    showGaiaOverlay,
    gaiaSources,
    astrometryDetectionsByFrame,
    selectedSourceId,
    astrometryTracks,
    manualMarks,
  ]);

  // Draw comparison canvas
  useEffect(() => {
    if (!compareMode || !compareCanvasRef.current || !compareFrame) return;
    const spec = getDisplayImageSpec(compareFrame, reprojectedByFrame, useSkyGrid);
    renderImageToCanvas(compareCanvasRef.current, {
      width: spec.width,
      height: spec.height,
      data: spec.data,
      wcs: spec.wcs,
      rawFrame: compareFrame,
      isReprojected: spec.isReprojected,
      stretch,
      brightness,
      contrast,
      invert,
      cmap,
      zoom,
      panX: pan.x,
      panY: pan.y,
      showFlags,
      rejectMask,
      cautionMask,
      showCrosshair,
      targetRa,
      targetDec,
      showGaia: showGaiaOverlay,
      gaiaSources,
      detections: astrometryDetectionsByFrame[compareFrame.frameId],
      selectedSourceId,
      tracks: astrometryTracks,
      manualMarks,
    });
  }, [
    compareMode,
    compareFrame,
    reprojectedByFrame,
    useSkyGrid,
    stretch,
    brightness,
    contrast,
    invert,
    cmap,
    zoom,
    pan,
    showFlags,
    rejectMask,
    cautionMask,
    showCrosshair,
    targetRa,
    targetDec,
    showGaiaOverlay,
    gaiaSources,
    astrometryDetectionsByFrame,
    selectedSourceId,
    astrometryTracks,
    manualMarks,
  ]);

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!displayedFrame) return;
    if (dragOrigin) {
      setPan({
        x: dragOrigin.px + (e.clientX - dragOrigin.mx),
        y: dragOrigin.py + (e.clientY - dragOrigin.my),
      });
      return;
    }

    const spec = diffMode && diffPayload
      ? { width: diffPayload.width, height: diffPayload.height, data: diffPayload.data, wcs: diffPayload.wcs, isReprojected: true }
      : getDisplayImageSpec(displayedFrame, reprojectedByFrame, useSkyGrid);

    const rect = e.currentTarget.getBoundingClientRect();
    const cw = rect.width;
    const ch = rect.height;
    const iw = spec.width;
    const ih = spec.height;
    const baseScale = Math.min((cw * 0.88) / iw, (ch * 0.88) / ih) * zoom;
    const drawW = iw * baseScale;
    const drawH = ih * baseScale;
    const drawX = (cw - drawW) / 2 + pan.x;
    const drawY = (ch - drawH) / 2 + pan.y;

    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const ix = Math.floor(((mx - drawX) / drawW) * iw);
    const iyFlipped = Math.floor(((my - drawY) / drawH) * ih);
    const iy = ih - 1 - iyFlipped;

    if (ix < 0 || ix >= iw || iy < 0 || iy >= ih) {
      setProbe(null);
      return;
    }

    const idx = iy * iw + ix;
    const val = spec.data[idx];
    let ra: number | undefined;
    let dec: number | undefined;
    if (spec.wcs) {
      [ra, dec] = pixelToSky(spec.wcs, ix, iy);
    } else if (displayedFrame.wcs) {
      const p = pixelToWorld(ix, iy, displayedFrame.wcs);
      ra = p.ra;
      dec = p.dec;
    }

    const wave = !spec.isReprojected && displayedFrame.waveWcs
      ? wavelengthAtPixel(ix, iy, displayedFrame.waveWcs)
      : undefined;

    setProbe({
      x: ix,
      y: iy,
      val,
      sigma: !spec.isReprojected && displayedFrame.variance && displayedFrame.variance[idx] >= 0
        ? Math.sqrt(displayedFrame.variance[idx])
        : undefined,
      zodi: !spec.isReprojected && displayedFrame.zodi ? displayedFrame.zodi[idx] : undefined,
      ra,
      dec,
      waveUm: wave?.wavelengthUm ?? displayedFrame.targetWavelengthUm ?? displayedFrame.sliceWavelengthUm,
      flagVal: !spec.isReprojected && displayedFrame.flags ? displayedFrame.flags[idx] : undefined,
    });
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!displayedFrame) return;
    if (markMode) {
      const spec = getDisplayImageSpec(displayedFrame, reprojectedByFrame, useSkyGrid);
      const rect = e.currentTarget.getBoundingClientRect();
      const scale = Math.min(rect.width * 0.88 / spec.width, rect.height * 0.88 / spec.height) * zoom;
      const drawW = spec.width * scale;
      const drawH = spec.height * scale;
      const drawX = (rect.width - drawW) / 2 + pan.x;
      const drawY = (rect.height - drawH) / 2 + pan.y;
      const x = ((e.clientX - rect.left - drawX) / drawW) * spec.width;
      const y = spec.height - 1 - ((e.clientY - rect.top - drawY) / drawH) * spec.height;
      if (x < 0 || x >= spec.width || y < 0 || y >= spec.height) return;
      const coords = spec.wcs
        ? pixelToSky(spec.wcs, x, y)
        : displayedFrame.wcs
          ? (() => { const p = pixelToWorld(x, y, displayedFrame.wcs!); return [p.ra, p.dec]; })()
          : null;
      if (!coords || !Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) return;
      onAddManualMark({
        id: `mark-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        label: markLabel.trim() || 'Object',
        color: markColor,
        shape: markShape,
        raDeg: coords[0],
        decDeg: coords[1],
        pixelX: x,
        pixelY: y,
        frameId: displayedFrame.frameId,
        obsId: displayedFrame.observation.obsId,
        dateObs: displayedFrame.observation.dateObs,
        createdAt: new Date().toISOString(),
        kind: 'user-annotation',
      });
      setMarkMode(false);
      setMarkLabel('');
      return;
    }
    const dets = astrometryDetectionsByFrame[displayedFrame.frameId];
    if (!dets || dets.length === 0) return;

    const spec = getDisplayImageSpec(displayedFrame, reprojectedByFrame, useSkyGrid);
    const rect = e.currentTarget.getBoundingClientRect();
    const iw = spec.width;
    const ih = spec.height;
    const baseScale = Math.min((rect.width * 0.88) / iw, (rect.height * 0.88) / ih) * zoom;
    const drawW = iw * baseScale;
    const drawH = ih * baseScale;
    const drawX = (rect.width - drawW) / 2 + pan.x;
    const drawY = (rect.height - drawH) / 2 + pan.y;

    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const ix = ((mx - drawX) / drawW) * iw;
    const iy = ih - 1 - ((my - drawY) / drawH) * ih;

    let nearest: AstrometricDetectionRecord | null = null;
    let minD = 4.0;
    for (const s of dets) {
      let sx = s.x;
      let sy = s.y;
      if (spec.wcs) {
        try {
          [sx, sy] = skyToPixel(spec.wcs, s.ra, s.dec);
        } catch {
          // keep native x,y
        }
      }
      const d = Math.hypot(sx - ix, sy - iy);
      if (d < minD) {
        minD = d;
        nearest = s;
      }
    }
    if (nearest) onSelectSource(nearest);
  };

  const handleExportGif = async () => {
    const seq = visibleIndices.map((i) => frames[i]).filter(Boolean);
    if (seq.length === 0) return;
    setExportingGif(true);
    try {
      const gif = GIFEncoder();
      const size = 340;
      const off = document.createElement('canvas');
      off.width = size;
      off.height = size;
      const ctx = off.getContext('2d');
      if (!ctx) return;

      for (const f of seq) {
        const spec = getDisplayImageSpec(f, reprojectedByFrame, useSkyGrid);
        renderImageToCanvas(off, {
          width: spec.width,
          height: spec.height,
          data: spec.data,
          wcs: spec.wcs,
          rawFrame: f,
          isReprojected: spec.isReprojected,
          stretch,
          brightness,
          contrast,
          invert,
          cmap,
          zoom: 1,
          panX: 0,
          panY: 0,
          showCrosshair,
          targetRa,
          targetDec,
          showGaia: showGaiaOverlay,
          gaiaSources,
          detections: astrometryDetectionsByFrame[f.frameId],
        manualMarks,
        });
        // Burn rich metadata onto GIF frame: obsId, detector, lambda, UTC, MJD, release, version
        ctx.fillStyle = 'rgba(7, 9, 14, 0.84)';
        ctx.fillRect(0, 0, size, 36);
        ctx.fillStyle = '#e2e8f0';
        ctx.font = '10px monospace';
        const wl = f.targetWavelengthUm ?? f.sliceWavelengthUm;
        const line1 = `${f.observation.obsId} · D${f.observation.detector} ${wl ? `${wl.toFixed(3)}um` : ''} · ${f.observation.release} ${f.version ?? ''}`;
        const line2 = `${f.observation.dateObs.slice(0, 19)} UTC · MJD ${f.observation.mjdObs.toFixed(4)}`;
        ctx.fillText(line1.slice(0, 52), 8, 14);
        ctx.fillStyle = '#67e8f9';
        ctx.fillText(line2.slice(0, 52), 8, 28);

        const img = ctx.getImageData(0, 0, size, size);
        const palette = quantize(img.data, 256);
        const index = applyPalette(img.data, palette);
        gif.writeFrame(index, size, size, {
          palette,
          delay: Math.round(1000 / Math.max(0.5, fps)),
        });
      }

      gif.finish();
      const bytes = gif.bytes();
      const blob = new Blob([new Uint8Array(bytes)], { type: 'image/gif' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `urutau-spherex-${Date.now()}.gif`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } finally {
      setExportingGif(false);
    }
  };

  const handleExportPng = (saveToNotebook = false) => {
    if (!mainCanvasRef.current || !activeFrame) return;
    const dataUrl = mainCanvasRef.current.toDataURL('image/png');
    if (saveToNotebook) {
      onSaveSnapshot(
        `${activeFrame.observation.obsId} (${activeFrame.observation.bandpassName})`,
        dataUrl,
      );
      return;
    }
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `${activeFrame.observation.obsId}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleExportProcessedFits = () => {
    if (!activeFrame) return;
    if (diffMode && diffPayload && compareFrame) {
      const buf = buildProcessedFitsBuffer({
        width: diffPayload.width,
        height: diffPayload.height,
        data: diffPayload.data,
        wcs: diffPayload.wcs,
        preservedHeaders: {
          OBSID: `${activeFrame.observation.obsId}-MINUS-${compareFrame.observation.obsId}`,
          DETECTOR: activeFrame.observation.detector,
          BUNIT: 'MJy / sr',
          RELEASE: activeFrame.observation.release,
        },
        historyEntries: [
          `URUTAU difference image: ${activeFrame.observation.obsId} minus ${compareFrame.observation.obsId}`,
          `Reprojected onto fixed ICRS grid (North up, East left)`,
          `Reject mask: 0x${(rejectMask >>> 0).toString(16)}, Caution mask: 0x${(cautionMask >>> 0).toString(16)}`,
        ],
      });
      triggerBinaryDownload(`${activeFrame.observation.obsId}-diff.fits`, buf);
      return;
    }

    const spec = getDisplayImageSpec(activeFrame, reprojectedByFrame, useSkyGrid);
    const buf = buildProcessedFitsBuffer({
      width: spec.width,
      height: spec.height,
      data: spec.data,
      wcs: spec.wcs,
      preservedHeaders: {
        OBSID: activeFrame.observation.obsId,
        DETECTOR: activeFrame.observation.detector,
        'DATE-OBS': activeFrame.observation.dateObs,
        'MJD-OBS': activeFrame.observation.mjdObs,
        VERSION: activeFrame.version ?? '',
        RELEASE: activeFrame.observation.release,
        BUNIT: 'MJy / sr',
        PSF_FWHM: activeFrame.psfFwhmArcsec ?? 7.5,
      },
      historyEntries: [
        `URUTAU processed FITS export (${activeFrame.isStacked ? `stacked ${activeFrame.stackMethod} N=${activeFrame.stackedFromCount}` : spec.isReprojected ? 'WCS sky-reprojected' : 'cutout'})`,
        `Source frame: ${activeFrame.frameId} (${activeFrame.observation.release} ${activeFrame.version ?? ''})`,
        `Reject mask: 0x${(rejectMask >>> 0).toString(16)}, Caution mask: 0x${(cautionMask >>> 0).toString(16)}`,
      ],
    });
    triggerBinaryDownload(`${activeFrame.observation.obsId}-processed.fits`, buf);
  };

  if (frames.length === 0) {
    return (
      <div className="bg-[#0B0E17] border border-slate-800 rounded-md p-10 text-center space-y-4">
        <h3 className="text-base font-semibold text-slate-100">{t.temporalTitle}</h3>
        <p className="text-xs text-slate-400 max-w-xl mx-auto leading-relaxed">
          No FITS cutouts or SPHEREx DR1 All-Sky Cube frames are loaded in the Temporal Lab yet. Load observations from the Observations tab, or load the verified SPHEREx QR3 multi-slew sequence directly.
        </p>
        <button
          type="button"
          onClick={onLoadQuickDemo}
          className="bg-cyan-600 hover:bg-cyan-500 text-slate-950 text-xs font-semibold px-4 py-2 rounded cursor-pointer"
        >
          {t.loadMultiSlewBtn}
        </button>
      </div>
    );
  }

  const activeDetCount = activeFrame
    ? frames.filter((f) => !f.isStacked && !f.isSpectralCubeSlice && f.observation.detector === activeFrame.observation.detector).length
    : 0;

  return (
    <div className="space-y-3">
      {/* Scientific Bandpass vs Epoch Caution Banner */}
      <div
        className={`border rounded-md px-4 py-2.5 text-xs flex flex-wrap items-center justify-between gap-2 ${
          hasMixedBandsOrCube
            ? 'bg-amber-950/30 border-amber-500/40 text-amber-200'
            : 'bg-cyan-950/25 border-cyan-500/30 text-cyan-200'
        }`}
      >
        <div className="flex items-center gap-2.5">
          {hasMixedBandsOrCube ? (
            <AlertTriangle className="w-4 h-4 shrink-0" />
          ) : (
            <CheckCircle2 className="w-4 h-4 shrink-0" />
          )}
          <span>{hasMixedBandsOrCube ? t.epochWarningBand : t.epochConfirmed}</span>
        </div>

        {/* Single-Detector & Wavelength Window Filter */}
        <div className="flex items-center gap-2">
          <select
            aria-label="Temporal Detector Filter"
            value={detectorFilter}
            onChange={(e) => {
              const val = e.target.value;
              setDetectorFilter(val);
              if (val !== 'ALL') {
                const matchIdx = frames.findIndex((f) => String(f.observation.detector) === val);
                if (matchIdx >= 0) onChangeIndex(matchIdx);
              }
            }}
            className="bg-[#07090E] border border-slate-700 rounded px-2 py-1 text-xs font-mono text-slate-100"
          >
            <option value="ALL">All Detectors ({frames.length})</option>
            {availableDetectors.map((d) => (
              <option key={d} value={String(d)}>
                Detector D{d} ({frames.filter((f) => f.observation.detector === d).length})
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setWlWindowFilter((v) => !v)}
            className={`px-2 py-1 rounded border text-[11px] font-mono cursor-pointer ${
              wlWindowFilter
                ? 'bg-cyan-950/60 border-cyan-500 text-cyan-200'
                : 'bg-[#07090E] border-slate-700 text-slate-300'
            }`}
          >
            λ ±3%
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
        {/* Left Image Controls */}
        {!embedMode && (
          <div className="xl:col-span-3 bg-[#0B0E17] border border-slate-800 rounded-md p-4 space-y-3.5">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label htmlFor="stretch-select" className="text-[11px] font-medium text-slate-400 block">
                  {t.stretchMode}
                </label>
                <select
                  id="stretch-select"
                  value={stretch}
                  onChange={(e) => setStretch(e.target.value as StretchMode)}
                  className="w-full bg-[#07090E] border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-100"
                >
                  <option value="asinh">Asinh</option>
                  <option value="zscale">ZScale</option>
                  <option value="log">Log</option>
                  <option value="sqrt">Sqrt</option>
                  <option value="linear">Linear</option>
                </select>
              </div>
              <div className="space-y-1">
                <label htmlFor="cmap-select" className="text-[11px] font-medium text-slate-400 block">
                  {t.colormap}
                </label>
                <select
                  id="cmap-select"
                  value={cmap}
                  onChange={(e) => setCmap(e.target.value as ColormapId)}
                  className="w-full bg-[#07090E] border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-100"
                >
                  <option value="inferno">Inferno</option>
                  <option value="grayscale">Grayscale</option>
                  <option value="viridis">Viridis</option>
                  <option value="coolwarm">Coolwarm</option>
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex justify-between text-xs">
                <span className="text-slate-400">{t.brightness}</span>
                <span className="font-mono text-slate-200 tabular-nums">{brightness.toFixed(2)}</span>
              </div>
              <input
                type="range"
                aria-label={t.brightness}
                min={-0.5}
                max={0.5}
                step={0.02}
                value={brightness}
                onChange={(e) => setBrightness(Number(e.target.value))}
                className="w-full accent-cyan-500 cursor-pointer"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex justify-between text-xs">
                <span className="text-slate-400">{t.contrast}</span>
                <span className="font-mono text-slate-200 tabular-nums">{contrast.toFixed(2)}×</span>
              </div>
              <input
                type="range"
                aria-label={t.contrast}
                min={0.4}
                max={3.0}
                step={0.05}
                value={contrast}
                onChange={(e) => setContrast(Number(e.target.value))}
                className="w-full accent-cyan-500 cursor-pointer"
              />
            </div>

            {/* Scientific Overlays & Alignment */}
            <div className="border-t border-slate-800 pt-3 grid grid-cols-2 gap-1.5 text-[11px]">
              <button
                type="button"
                onClick={() => setUseSkyGrid((v) => !v)}
                className={`px-2 py-1.5 rounded border flex items-center justify-center gap-1 cursor-pointer ${
                  useSkyGrid
                    ? 'bg-cyan-950/50 border-cyan-500/60 text-cyan-200'
                    : 'bg-[#07090E] border-slate-700 text-slate-300'
                }`}
              >
                <Compass className="w-3 h-3" />
                {t.reprojectGrid}
              </button>
              <button
                type="button"
                onClick={() => setShowCrosshair((v) => !v)}
                className={`px-2 py-1.5 rounded border flex items-center justify-center gap-1 cursor-pointer ${
                  showCrosshair
                    ? 'bg-cyan-950/50 border-cyan-500/60 text-cyan-200'
                    : 'bg-[#07090E] border-slate-700 text-slate-300'
                }`}
              >
                <Crosshair className="w-3 h-3" />
                {t.crosshairToggle}
              </button>
              <button
                type="button"
                onClick={() => setShowFlags((v) => !v)}
                className={`px-2 py-1.5 rounded border flex items-center justify-center gap-1 cursor-pointer ${
                  showFlags
                    ? 'bg-amber-950/50 border-amber-500/60 text-amber-200'
                    : 'bg-[#07090E] border-slate-700 text-slate-300'
                }`}
              >
                <Flag className="w-3 h-3" />
                {t.flagOverlay}
              </button>
              <button
                type="button"
                onClick={() => setShowGaiaOverlay((v) => !v)}
                className={`px-2 py-1.5 rounded border flex items-center justify-center gap-1 cursor-pointer ${
                  showGaiaOverlay && gaiaSources.length > 0
                    ? 'bg-emerald-950/40 border-emerald-500/60 text-emerald-200'
                    : 'bg-[#07090E] border-slate-700 text-slate-300'
                }`}
              >
                <Sparkles className="w-3 h-3" />
                Gaia ({gaiaSources.length})
              </button>
              <button
                type="button"
                onClick={() => setInvert((v) => !v)}
                className={`px-2 py-1.5 rounded border flex items-center justify-center gap-1 cursor-pointer ${
                  invert
                    ? 'bg-cyan-950/50 border-cyan-500/60 text-cyan-200'
                    : 'bg-[#07090E] border-slate-700 text-slate-300'
                }`}
              >
                <SunMoon className="w-3 h-3" />
                {t.invert}
              </button>
              <button
                type="button"
                onClick={() => {
                  setZoom(1);
                  setPan({ x: 0, y: 0 });
                  setBrightness(0);
                  setContrast(1);
                }}
                className="px-2 py-1.5 rounded bg-[#07090E] border border-slate-700 text-slate-300 hover:text-white flex items-center justify-center gap-1 cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" />
                {t.resetView}
              </button>
            </div>

            {/* Compare, Blink A/B, Difference A-B */}
            <div className="border-t border-slate-800 pt-3 space-y-2">
              <div className="grid grid-cols-3 gap-1.5 text-[11px]">
                <button
                  type="button"
                  onClick={() => {
                    setCompareMode((v) => !v);
                    setDiffMode(false);
                    setBlinkMode(false);
                  }}
                  className={`px-2 py-1.5 rounded border flex items-center justify-center gap-1 cursor-pointer ${
                    compareMode
                      ? 'bg-cyan-950/50 border-cyan-500/60 text-cyan-200'
                      : 'bg-[#07090E] border-slate-700 text-slate-300'
                  }`}
                >
                  <Columns2 className="w-3 h-3" />
                  Split
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setBlinkMode((v) => !v);
                    setCompareMode(false);
                    setDiffMode(false);
                  }}
                  className={`px-2 py-1.5 rounded border flex items-center justify-center gap-1 cursor-pointer ${
                    blinkMode
                      ? 'bg-cyan-950/50 border-cyan-500/60 text-cyan-200'
                      : 'bg-[#07090E] border-slate-700 text-slate-300'
                  }`}
                >
                  <Repeat className="w-3 h-3" />
                  {t.blinkMode}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDiffMode((v) => !v);
                    setCompareMode(false);
                    setBlinkMode(false);
                  }}
                  className={`px-2 py-1.5 rounded border flex items-center justify-center gap-1 cursor-pointer ${
                    diffMode
                      ? 'bg-cyan-950/50 border-cyan-500/60 text-cyan-200'
                      : 'bg-[#07090E] border-slate-700 text-slate-300'
                  }`}
                >
                  <Diff className="w-3 h-3" />
                  A - B
                </button>
              </div>

              {(compareMode || blinkMode || diffMode) && (
                <select
                  aria-label="Comparison Frame B"
                  value={compareIndex}
                  onChange={(e) => setCompareIndex(Number(e.target.value))}
                  className="w-full bg-[#07090E] border border-slate-700 rounded px-2 py-1.5 text-xs font-mono text-slate-200"
                >
                  {frames.map((f, i) => (
                    <option key={f.frameId} value={i}>
                      B=#{i + 1}: {f.observation.obsId} (D{f.observation.detector})
                    </option>
                  ))}
                </select>
              )}
              {diffMode && diffPayload && !diffPayload.sameDetector && (
                <p className="text-[11px] text-amber-300">
                  Warning: Frame A and B are from different detectors; residuals reflect spectral/PSF differences.
                </p>
              )}
            </div>

            {/* Per-Detector Stacking */}
            {activeFrame && activeDetCount >= 2 && (
              <div className="border-t border-slate-800 pt-3 grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  disabled={isStacking}
                  onClick={() => onStackDetector(activeFrame.observation.detector, 'median')}
                  className="px-2 py-1.5 rounded bg-[#07090E] hover:bg-slate-800 border border-slate-700 text-[11px] font-medium text-cyan-200 flex items-center justify-center gap-1 cursor-pointer"
                >
                  {isStacking ? <Loader2 className="w-3 h-3 animate-spin" /> : <Layers className="w-3 h-3" />}
                  Median D{activeFrame.observation.detector}
                </button>
                <button
                  type="button"
                  disabled={isStacking}
                  onClick={() => onStackDetector(activeFrame.observation.detector, 'mean')}
                  className="px-2 py-1.5 rounded bg-[#07090E] hover:bg-slate-800 border border-slate-700 text-[11px] font-medium text-slate-200 flex items-center justify-center gap-1 cursor-pointer"
                >
                  Mean D{activeFrame.observation.detector}
                </button>
              </div>
            )}

            {/* Export Actions */}
            <div className="border-t border-slate-800 pt-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={exportingGif}
                onClick={handleExportGif}
                className="px-2.5 py-2 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-100 flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
              >
                <Film className="w-3.5 h-3.5" />
                {exportingGif ? 'Encoding...' : t.exportGif}
              </button>
              <button
                type="button"
                onClick={() => handleExportPng(false)}
                className="px-2.5 py-2 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-100 flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" />
                {t.exportPng}
              </button>
              <button
                type="button"
                onClick={handleExportProcessedFits}
                className="px-2.5 py-2 rounded bg-[#07090E] hover:bg-slate-800 border border-slate-700 text-xs font-medium text-slate-200 flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5 text-cyan-400" />
                {t.exportProcessedFits}
              </button>
              <button
                type="button"
                onClick={() => handleExportPng(true)}
                className="px-2.5 py-2 rounded bg-[#07090E] hover:bg-slate-800 border border-cyan-500/40 text-xs font-medium text-cyan-200 flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
              >
                <Camera className="w-3.5 h-3.5" />
                Snapshot
              </button>
            </div>
          </div>
        )}

        {/* Center/Right Image Stage + Playback */}
        <div className={`${embedMode ? 'xl:col-span-12' : 'xl:col-span-9'} flex flex-col gap-3`}>
          {/* Active Frame Metadata Provenance Strip */}
          {displayedFrame && (
            <div className="bg-[#0B0E17] border border-slate-800 rounded-md px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs font-mono tabular-nums">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="text-cyan-300 font-semibold">
                  {diffMode && compareFrame
                    ? `DIFF: ${activeFrame?.observation.obsId} − ${compareFrame.observation.obsId}`
                    : displayedFrame.observation.obsId}
                </span>
                <span className="text-slate-500">·</span>
                <span className="text-slate-200">
                  {displayedFrame.observation.bandpassName}
                  {displayedFrame.targetWavelengthUm
                    ? ` (λ=${displayedFrame.targetWavelengthUm.toFixed(3)} µm)`
                    : displayedFrame.sliceWavelengthUm
                    ? ` (${displayedFrame.sliceWavelengthUm.toFixed(3)} µm)`
                    : ` (${displayedFrame.observation.lambdaMinUm}–${displayedFrame.observation.lambdaMaxUm} µm)`}
                </span>
                <span className="text-slate-500">·</span>
                <span className="text-slate-300">
                  {displayedFrame.observation.dateObs.slice(0, 19).replace('T', ' ')} UTC (MJD {displayedFrame.observation.mjdObs.toFixed(4)})
                </span>
              </div>
              <div className="text-slate-400">
                {displayedFrame.observation.release} {displayedFrame.version ?? ''} · FWHM{' '}
                {(displayedFrame.psfFwhmArcsec ?? 7.5).toFixed(2)}" ·{' '}
                {displayedFrame.flagSummary
                  ? `${(displayedFrame.flagSummary.cleanFraction * 100).toFixed(0)}% unflagged`
                  : displayedFrame.l2DqaFlag}
              </div>
            </div>
          )}

          {!embedMode && (
            <section className="rounded-xl border border-slate-700 bg-[#101827] p-3 space-y-2" aria-label={lang === 'pt' ? 'Marcar fonte luminosa' : 'Mark a light source'}>
              <div className="flex flex-wrap items-center gap-3 justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-slate-100">{lang === 'pt' ? 'Marque um objeto na imagem' : 'Mark an object in the image'}</h3>
                  <p className="text-xs text-slate-400 mt-0.5">{lang === 'pt' ? 'Dê um nome, escolha uma cor e clique na fonte luminosa. A posição celeste e o quadro serão salvos no seu caderno.' : 'Name it, pick a color and click a light source. Its sky coordinates and frame will be saved in your notebook.'}</p>
                </div>
                <span className="text-xs text-slate-400">{manualMarks.length} {lang === 'pt' ? 'marcações' : 'marks'}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input type="text" value={markLabel} onChange={e => setMarkLabel(e.target.value)} maxLength={60} aria-label={lang === 'pt' ? 'Nome do objeto' : 'Object name'} placeholder={lang === 'pt' ? 'Nome do objeto (ex.: Candidato 1)' : 'Object name (e.g. Candidate 1)'} className="flex-1 min-w-[180px] rounded-md border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white" />
                <input type="color" value={markColor} onChange={e => setMarkColor(e.target.value)} aria-label={lang === 'pt' ? 'Cor da marcação' : 'Mark color'} className="w-11 h-9 rounded cursor-pointer" />
                <select aria-label={lang === 'pt' ? 'Formato da marcação' : 'Marker shape'} value={markShape} onChange={e => setMarkShape(e.target.value as 'circle' | 'cross')} className="rounded-md border border-slate-600 bg-slate-950 px-2 py-2 text-sm text-slate-200"><option value="circle">{lang === 'pt' ? 'Círculo' : 'Circle'}</option><option value="cross">{lang === 'pt' ? 'Cruz' : 'Cross'}</option></select>
                <button type="button" aria-pressed={markMode} disabled={!displayedFrame?.astrometryWcs && !displayedFrame?.wcs && !reprojectedByFrame[displayedFrame?.frameId ?? '']} onClick={() => setMarkMode(v => !v)} className={markMode ? 'rounded-md bg-amber-400 text-slate-950 px-4 py-2 text-sm font-bold' : 'rounded-md bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 px-4 py-2 text-sm font-semibold text-slate-950'}>{markMode ? (lang === 'pt' ? 'Clique na imagem…' : 'Click the image…') : (lang === 'pt' ? 'Marcar objeto' : 'Mark object')}</button>
              </div>
              {manualMarks.length > 0 && <div className="flex flex-wrap gap-2" aria-label={lang === 'pt' ? 'Marcações salvas' : 'Saved marks'}>{manualMarks.slice(-8).map(mark => <span key={mark.id} className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 flex items-center gap-1"><span aria-hidden="true" className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: mark.color }} />{mark.label} <button type="button" onClick={() => onRemoveManualMark(mark.id)} aria-label={`Remove ${mark.label}`} className="ml-1 text-slate-400 hover:text-rose-300">×</button></span>)}</div>}
              <p className="text-[11px] text-slate-500">{lang === 'pt' ? 'Uma marcação manual não é uma descoberta cientificamente confirmada.' : 'A manual mark is not a scientifically confirmed discovery.'}</p>
            </section>
          )}

          {/* Canvas Viewport(s) */}
          <div className={`grid gap-3 ${compareMode ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1'}`}>
            <div className="relative bg-[#05070c] border border-slate-800 rounded-md overflow-hidden h-[430px]">
              <canvas
                ref={mainCanvasRef}
                data-testid="temporal-viewer-canvas"
                onMouseDown={(e) =>
                  setDragOrigin({ mx: e.clientX, my: e.clientY, px: pan.x, py: pan.y })
                }
                onMouseMove={handleCanvasMouseMove}
                onMouseUp={() => setDragOrigin(null)}
                onMouseLeave={() => {
                  setDragOrigin(null);
                  setProbe(null);
                }}
                onClick={handleCanvasClick}
                onWheel={(e) => {
                  e.preventDefault();
                  setZoom((z) => Math.max(0.5, Math.min(8, z * (e.deltaY > 0 ? 0.9 : 1.12))));
                }}
                className="w-full h-full cursor-crosshair block"
              />
              <div className="absolute top-2.5 left-2.5 bg-[#07090E]/90 border border-slate-800 rounded px-2 py-1 text-[10px] font-mono text-cyan-300 pointer-events-none">
                N ↑ · E ← · {useSkyGrid && reprojectedByFrame[displayedFrame?.frameId ?? ''] ? 'Sky-Aligned Grid' : 'Native Detector Frame'}
                {blinkMode ? (blinkToggle ? ' · BLINK B' : ' · BLINK A') : ''}
              </div>
              {probe && (
                <div className="absolute bottom-2.5 left-2.5 bg-[#07090E]/90 border border-slate-800 rounded px-2.5 py-1.5 text-[11px] font-mono text-slate-200 pointer-events-none space-y-0.5 tabular-nums">
                  <div>
                    px ({probe.x}, {probe.y}) · Flux: {Number.isFinite(probe.val) ? probe.val.toFixed(4) : 'NaN / Masked'}
                    {probe.sigma !== undefined ? ` ± ${probe.sigma.toFixed(4)}` : ''} MJy/sr
                  </div>
                  {probe.ra !== undefined && probe.dec !== undefined && (
                    <div className="text-cyan-300">
                      ICRS {degToHms(probe.ra, 3)} {degToDms(probe.dec, 2)}
                      {probe.waveUm ? ` · λ ${probe.waveUm.toFixed(3)} µm` : ''}
                    </div>
                  )}
                  {(probe.zodi !== undefined || probe.flagVal !== undefined) && (
                    <div className="text-slate-400">
                      {probe.zodi !== undefined ? `Zodi: ${probe.zodi.toFixed(4)} MJy/sr` : ''}
                      {probe.flagVal !== undefined ? ` · Flag: 0x${probe.flagVal.toString(16)}` : ''}
                    </div>
                  )}
                </div>
              )}
            </div>

            {compareMode && compareFrame && (
              <div className="relative bg-[#05070c] border border-slate-800 rounded-md overflow-hidden h-[430px]">
                <canvas ref={compareCanvasRef} className="w-full h-full block" />
                <div className="absolute top-2.5 left-2.5 bg-[#07090E]/90 border border-slate-800 rounded px-2.5 py-1 text-[11px] font-mono text-amber-300">
                  B: {compareFrame.observation.obsId} · D{compareFrame.observation.detector} · {compareFrame.observation.dateObs.slice(0, 19)}
                </div>
              </div>
            )}
          </div>

          {/* Playback & Timeline Scrubber */}
          <div className="bg-[#0B0E17] border border-slate-800 rounded-md p-3 flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  const pos = visibleIndices.indexOf(activeIndex);
                  const prevPos = pos >= 0 ? (pos - 1 + visibleIndices.length) % visibleIndices.length : 0;
                  onChangeIndex(visibleIndices[prevPos]);
                }}
                aria-label={t.prevFrame}
                className="p-2 rounded bg-[#07090E] border border-slate-700 text-slate-200 hover:border-slate-500 cursor-pointer"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setIsPlaying((p) => !p)}
                className="px-3 py-2 rounded bg-cyan-600 hover:bg-cyan-500 text-slate-950 text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
              >
                {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                {isPlaying ? t.pause : t.play}
              </button>
              <button
                type="button"
                onClick={() => {
                  const pos = visibleIndices.indexOf(activeIndex);
                  const nextPos = pos >= 0 ? (pos + 1) % visibleIndices.length : 0;
                  onChangeIndex(visibleIndices[nextPos]);
                }}
                aria-label={t.nextFrame}
                className="p-2 rounded bg-[#07090E] border border-slate-700 text-slate-200 hover:border-slate-500 cursor-pointer"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 min-w-[180px] flex items-center gap-3">
              <input
                type="range"
                aria-label="Timeline Frame"
                min={0}
                max={Math.max(0, visibleIndices.length - 1)}
                value={Math.max(0, visibleIndices.indexOf(activeIndex))}
                onChange={(e) => {
                  const nextIdx = visibleIndices[Number(e.target.value)] ?? 0;
                  onChangeIndex(nextIdx);
                }}
                className="w-full accent-cyan-500 cursor-pointer"
              />
              <span className="text-xs font-mono text-slate-300 tabular-nums shrink-0">
                {Math.max(1, visibleIndices.indexOf(activeIndex) + 1)} / {visibleIndices.length}
              </span>
            </div>

            <label className="text-xs text-slate-400 flex items-center gap-2 shrink-0">
              {t.speed}
              <select
                value={fps}
                onChange={(e) => setFps(Number(e.target.value))}
                className="bg-[#07090E] border border-slate-700 rounded px-2 py-1 text-xs font-mono text-slate-200"
              >
                <option value={0.5}>0.5 fps</option>
                <option value={1}>1 fps</option>
                <option value={2}>2 fps</option>
                <option value={4}>4 fps</option>
                <option value={6}>6 fps</option>
              </select>
            </label>

            {activeFrame?.flagSummary && (
              <button
                type="button"
                onClick={() => setShowFlagTable((v) => !v)}
                className="px-2.5 py-1 rounded bg-[#07090E] border border-slate-700 text-[11px] font-mono text-slate-300 hover:text-white cursor-pointer"
              >
                FLAGS HDU ({Object.keys(activeFrame.flagSummary.countsByFlag).length})
              </button>
            )}
          </div>

          {/* Runtime MSKN/MSKD FLAGS Bit Definitions Inspector */}
          {showFlagTable && activeFrame?.flagSummary && (
            <div className="bg-[#0B0E17] border border-slate-800 rounded-md p-3 space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-slate-200">
                  FLAGS Bitmask Summary ({activeFrame.observation.obsId})
                </span>
                <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                  {activeFrame.flagSummary.flaggedPixels}/{activeFrame.flagSummary.totalPixels} pixels with any bit · SOURCE (bit 21) never rejected
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5 max-h-40 overflow-y-auto text-[11px] font-mono">
                {Object.entries(activeFrame.flagSummary.countsByFlag)
                  .filter(([, count]) => count > 0)
                  .map(([name, count]) => {
                    const def = activeFrame.flagDefinitions?.find((d) => d.name === name);
                    return (
                      <div
                        key={name}
                        title={def?.description || name}
                        className="bg-[#07090E] border border-slate-800 rounded px-2 py-1 flex items-center justify-between gap-2"
                      >
                        <span className="text-slate-300 truncate">{name}</span>
                        <span className="text-cyan-300 tabular-nums">{count}</span>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}

          {/* Quick Frame Annotation */}
          {!embedMode && activeFrame && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!noteInput.trim()) return;
                onAddEpochNote(activeFrame, noteInput.trim());
                setNoteInput('');
              }}
              className="bg-[#0B0E17] border border-slate-800 rounded-md p-3 flex flex-wrap gap-2"
            >
              <input
                type="text"
                value={noteInput}
                onChange={(e) => setNoteInput(e.target.value)}
                placeholder={`Add note for epoch ${activeFrame.observation.obsId}...`}
                className="flex-1 min-w-[220px] bg-[#07090E] border border-slate-700 rounded px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
              />
              <button
                type="submit"
                className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-100 cursor-pointer"
              >
                {t.saveFrameNoteBtn}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
