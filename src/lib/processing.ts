import {
  DEFAULT_REJECT_MASK,
  detectSources,
  gridWcs,
  localPixelGeometry,
  reprojectFrame,
  type DetectOptions,
  type Detection,
  type Frame,
  type GridSpec,
  type WcsModel,
} from './astrometry';
import { toAstrometryWcs } from './fits';
import type { LoadedSpherexFrame } from '../types/spherex';

export function frameToAstrometryFrame(loaded: LoadedSpherexFrame): Frame | null {
  const wcs: WcsModel | null =
    loaded.astrometryWcs ??
    (loaded.wcs
      ? toAstrometryWcs({
          CTYPE1: loaded.wcs.ctype1,
          CTYPE2: loaded.wcs.ctype2,
          CRVAL1: loaded.wcs.crval1,
          CRVAL2: loaded.wcs.crval2,
          CRPIX1: loaded.wcs.crpix1,
          CRPIX2: loaded.wcs.crpix2,
          CD1_1: loaded.wcs.cd1_1,
          CD1_2: loaded.wcs.cd1_2,
          CD2_1: loaded.wcs.cd2_1,
          CD2_2: loaded.wcs.cd2_2,
          A_ORDER: loaded.wcs.aOrder,
          B_ORDER: loaded.wcs.bOrder,
          ...loaded.wcs.a,
          ...loaded.wcs.b,
        })
      : null);

  if (!wcs) return null;
  return {
    id: loaded.frameId,
    width: loaded.width,
    height: loaded.height,
    data: loaded.image,
    variance: loaded.variance,
    flags: loaded.flags,
    wcs,
    mjd: loaded.observation.mjdObs,
    detector: loaded.observation.detector,
    psfFwhmArcsec: loaded.psfFwhmArcsec,
  };
}

export function buildCommonSkyGrid(
  frames: LoadedSpherexFrame[],
  centerRa: number,
  centerDec: number,
): GridSpec {
  let maxSide = 29;
  let scaleArcsec = 6.15;
  for (const f of frames) {
    maxSide = Math.max(maxSide, f.width, f.height);
    const af = frameToAstrometryFrame(f);
    if (af) {
      const g = localPixelGeometry(af.wcs, Math.floor(f.width / 2), Math.floor(f.height / 2));
      if (Number.isFinite(g.scaleX) && g.scaleX > 0.5 && g.scaleX < 60) {
        scaleArcsec = 0.5 * (g.scaleX + g.scaleY);
      }
    }
  }
  const side = Math.min(240, Math.max(29, maxSide));
  return {
    centerRa,
    centerDec,
    scaleArcsec,
    width: side,
    height: side,
  };
}

export interface ReprojectedResult {
  frameId: string;
  grid: GridSpec;
  wcs: WcsModel;
  data: Float32Array;
  variance?: Float32Array;
  insideFootprint: Uint8Array;
}

export function reprojectLoadedFrame(
  loaded: LoadedSpherexFrame,
  grid: GridSpec,
  rejectMask = DEFAULT_REJECT_MASK,
): ReprojectedResult | null {
  const af = frameToAstrometryFrame(loaded);
  if (!af) return null;
  const rep = reprojectFrame(af, grid, rejectMask);
  return {
    frameId: loaded.frameId,
    grid: rep.grid,
    wcs: rep.wcs,
    data: rep.data,
    variance: rep.variance,
    insideFootprint: rep.insideFootprint,
  };
}

/**
 * Per-detector median or mean stack over already-reprojected sky-aligned frames.
 * Pixels with no valid input samples remain NaN (never filled in).
 */
export function stackReprojectedFrames(
  items: Array<{ data: Float32Array; variance?: Float32Array }>,
  width: number,
  height: number,
  method: 'median' | 'mean' = 'median',
): { data: Float32Array; variance: Float32Array; countMap: Uint16Array } {
  const n = width * height;
  const out = new Float32Array(n).fill(NaN);
  const outVar = new Float32Array(n).fill(NaN);
  const countMap = new Uint16Array(n);

  const vals: number[] = [];
  const vars: number[] = [];
  for (let i = 0; i < n; i++) {
    vals.length = 0;
    vars.length = 0;
    for (const item of items) {
      const v = item.data[i];
      if (Number.isFinite(v)) {
        vals.push(v);
        if (item.variance && Number.isFinite(item.variance[i]) && item.variance[i] > 0) {
          vars.push(item.variance[i]);
        }
      }
    }
    countMap[i] = vals.length;
    if (vals.length === 0) continue;

    if (method === 'mean') {
      let s = 0;
      for (const v of vals) s += v;
      out[i] = s / vals.length;
      if (vars.length > 0) {
        let vs = 0;
        for (const vv of vars) vs += vv;
        outVar[i] = vs / (vars.length * vars.length);
      }
    } else {
      vals.sort((a, b) => a - b);
      const mid = vals.length >> 1;
      out[i] = vals.length % 2 ? vals[mid] : 0.5 * (vals[mid - 1] + vals[mid]);
      if (vars.length > 0) {
        let vs = 0;
        for (const vv of vars) vs += vv;
        // Approximate variance of sample median (~ pi/2 * var(mean))
        outVar[i] = (Math.PI / 2) * (vs / (vars.length * vars.length));
      }
    }
  }

  return { data: out, variance: outVar, countMap };
}

export function computeDifferenceImage(
  dataA: Float32Array,
  dataB: Float32Array,
): Float32Array {
  const n = Math.min(dataA.length, dataB.length);
  const diff = new Float32Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const a = dataA[i];
    const b = dataB[i];
    if (Number.isFinite(a) && Number.isFinite(b)) {
      diff[i] = a - b;
    }
  }
  return diff;
}

export function detectInSerializableFrame(
  frame: Frame,
  options: DetectOptions,
): Detection[] {
  return detectSources(frame, options);
}

export function buildGridWcs(grid: GridSpec): WcsModel {
  return gridWcs(grid);
}
