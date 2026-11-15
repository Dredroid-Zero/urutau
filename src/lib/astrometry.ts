/**
 * URUTAU astrometry module (dependency-free TypeScript, runs in Node and browsers).
 *
 * Scope: WCS (TAN + SIP), flag handling, background, matched-filter detection,
 * windowed centroids with uncertainties, aperture photometry, linear-motion fits
 * and cross-epoch association.
 *
 * Scientific caveats (also surfaced in every result via `notes`):
 *  - Uncertainties are STATISTICAL ONLY (from the VARIANCE plane). Per-exposure WCS
 *    systematics and PSF/colour effects are not modelled; pass `systematicArcsec`
 *    from documented values when you have them. This module does not invent one.
 *  - Aperture photometry applies NO aperture correction (ePSF is not used here).
 *  - Different detectors/bands have different PSFs and wavelengths. Motion fits are
 *    done per detector group by default so band differences are never read as motion.
 *  - A significant motion fit is a CANDIDATE, never a confirmed proper motion.
 */

// ---------------------------------------------------------------- types

export type Header = Record<string, number | string | boolean | undefined>;

export interface WcsModel {
  crpix: [number, number]; // FITS 1-based
  crval: [number, number]; // degrees
  pc: [[number, number], [number, number]];
  cdelt: [number, number];
  sipA: Record<string, number>; // keys "p_q"
  sipB: Record<string, number>;
  sipOrderA: number;
  sipOrderB: number;
}

export interface Frame {
  id: string; // e.g. OBSID + detector
  width: number;
  height: number;
  data: Float32Array | Float64Array; // IMAGE, row-major, y*width + x (0-based)
  variance?: Float32Array | Float64Array; // (MJy/sr)^2
  flags?: Int32Array | Uint32Array; // FLAGS bitmap
  wcs: WcsModel;
  mjd: number; // observation epoch (NOT the processing DATE keyword)
  detector: number; // 1..6
  psfFwhmArcsec?: number; // header PSF_FWHM if present
}

export type SourceStatus = "automatic-detection" | "candidate-association" | "user-confirmed";

export interface Detection {
  frameId: string;
  detector: number;
  mjd: number;
  x: number; // 0-based pixel, centre of first pixel = 0
  y: number;
  xErr: number;
  yErr: number;
  ra: number; // deg ICRS
  dec: number;
  raErrArcsec: number; // on-sky, i.e. already multiplied by cos(dec)
  decErrArcsec: number;
  snr: number;
  fluxJy: number;
  fluxErrJy: number;
  nValidAperturepx: number;
  flagBitsInAperture: number; // OR of all flag bits within the aperture
  cautionFlagged: boolean;
  rejectFlagged: boolean;
  status: SourceStatus;
  notes: string[];
}

export interface DetectOptions {
  snrThreshold?: number; // default 5
  fwhmPix?: number; // default from frame.psfFwhmArcsec / pixel scale, else 1.5
  bkgMesh?: number; // mesh size in pixels, default 32
  apertureRadiusFwhm?: number; // default 1.5 x FWHM
  annulusInnerFwhm?: number; // default 2.5
  annulusOuterFwhm?: number; // default 4.0
  /** Bits that make a pixel unusable. PROVISIONAL: confirm against Table 16 of the Explanatory Supplement. */
  rejectMask?: number;
  /** Bits that are carried through and reported but do not remove the pixel. */
  cautionMask?: number;
  systematicArcsec?: number; // added in quadrature to each coordinate if provided
  minSeparationFwhm?: number; // peak non-maximum suppression, default 2
}

// Bit numbers from the FLAGS header of a DR1/QR3 spectral image (MSKNnnnn keywords).
// SOURCE (21) marks pixels mapped to a known source and is set on most pixels, so it
// must NOT be used for rejection.
export const FLAG_BITS = {
  TRANSIENT: 0, OVERFLOW: 1, SUR_ERROR: 2, NONFUNC: 6, DICHROIC: 7, MISSING_DATA: 9,
  HOT: 10, COLD: 11, FULLSAMPLE: 12, PHANMISS: 14, NONLINEAR: 15, PERSIST: 17,
  OUTLIER: 19, CROSSTALK: 20, SOURCE: 21, GHOST: 22, GHOST_FPA: 23, GHOST_EXT: 24,
  STREAK: 25, BLOOM: 26, SNOWBALL: 27, HALO: 28,
} as const;

const bits = (...b: number[]) => b.reduce((m, n) => m | (1 << n), 0);
export const DEFAULT_REJECT_MASK = bits(0, 1, 2, 6, 9, 10, 15, 17); // provisional
export const DEFAULT_CAUTION_MASK = bits(7, 11, 14, 19, 20, 22, 23, 24, 25, 26, 27, 28); // provisional

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

// ---------------------------------------------------------------- WCS

function num(h: Header, k: string, d?: number): number {
  const v = h[k];
  if (typeof v === "number") return v;
  if (d !== undefined) return d;
  throw new Error(`Missing numeric WCS keyword ${k}`);
}

export function parseWcs(h: Header): WcsModel {
  const ctype1 = String(h["CTYPE1"] ?? "");
  if (!ctype1.startsWith("RA---TAN")) throw new Error(`Unsupported projection: ${ctype1}`);
  const pc: WcsModel["pc"] = [
    [num(h, "PC1_1", 1), num(h, "PC1_2", 0)],
    [num(h, "PC2_1", 0), num(h, "PC2_2", 1)],
  ];
  const readSip = (prefix: string) => {
    const order = num(h, `${prefix}_ORDER`, 0);
    const out: Record<string, number> = {};
    for (let p = 0; p <= order; p++)
      for (let q = 0; q <= order - p; q++) {
        const v = h[`${prefix}_${p}_${q}`];
        if (typeof v === "number") out[`${p}_${q}`] = v;
      }
    return { order, out };
  };
  const a = readSip("A");
  const b = readSip("B");
  return {
    crpix: [num(h, "CRPIX1"), num(h, "CRPIX2")],
    crval: [num(h, "CRVAL1"), num(h, "CRVAL2")],
    pc,
    cdelt: [num(h, "CDELT1", 1), num(h, "CDELT2", 1)],
    sipA: a.out, sipB: b.out, sipOrderA: a.order, sipOrderB: b.order,
  };
}

function sipPoly(coef: Record<string, number>, u: number, v: number): number {
  let s = 0;
  for (const key in coef) {
    const [p, q] = key.split("_").map(Number);
    s += coef[key] * Math.pow(u, p) * Math.pow(v, q);
  }
  return s;
}

/** 0-based pixel (centre of first pixel = 0) -> ICRS degrees. */
export function pixelToSky(w: WcsModel, x0: number, y0: number): [number, number] {
  const u = x0 + 1 - w.crpix[0];
  const v = y0 + 1 - w.crpix[1];
  const up = u + sipPoly(w.sipA, u, v);
  const vp = v + sipPoly(w.sipB, u, v);
  const xi = (w.cdelt[0] * (w.pc[0][0] * up + w.pc[0][1] * vp)) * D2R;
  const eta = (w.cdelt[1] * (w.pc[1][0] * up + w.pc[1][1] * vp)) * D2R;
  const a0 = w.crval[0] * D2R;
  const d0 = w.crval[1] * D2R;
  const rho = Math.hypot(xi, eta);
  if (rho === 0) return [w.crval[0], w.crval[1]];
  const c = Math.atan(rho);
  const dec = Math.asin(Math.cos(c) * Math.sin(d0) + (eta * Math.sin(c) * Math.cos(d0)) / rho);
  const ra = a0 + Math.atan2(xi * Math.sin(c), rho * Math.cos(d0) * Math.cos(c) - eta * Math.sin(d0) * Math.sin(c));
  return [((ra * R2D) % 360 + 360) % 360, dec * R2D];
}

/** ICRS degrees -> 0-based pixel. SIP is inverted iteratively with the forward polynomial. */
export function skyToPixel(w: WcsModel, raDeg: number, decDeg: number): [number, number] {
  const a = raDeg * D2R, d = decDeg * D2R;
  const a0 = w.crval[0] * D2R, d0 = w.crval[1] * D2R;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
  if (cosc <= 0) throw new Error("Position is on the far hemisphere of the tangent point");
  const xi = (Math.cos(d) * Math.sin(a - a0)) / cosc * R2D;
  const eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) / cosc * R2D;
  const sx = xi / w.cdelt[0], sy = eta / w.cdelt[1];
  const det = w.pc[0][0] * w.pc[1][1] - w.pc[0][1] * w.pc[1][0];
  const up = (w.pc[1][1] * sx - w.pc[0][1] * sy) / det;
  const vp = (-w.pc[1][0] * sx + w.pc[0][0] * sy) / det;
  let u = up, v = vp;
  for (let i = 0; i < 20; i++) {
    const nu = up - sipPoly(w.sipA, u, v);
    const nv = vp - sipPoly(w.sipB, u, v);
    const done = Math.abs(nu - u) < 1e-9 && Math.abs(nv - v) < 1e-9;
    u = nu; v = nv;
    if (done) break;
  }
  return [u + w.crpix[0] - 1, v + w.crpix[1] - 1];
}

/** Pixel scale (arcsec/pixel along x and y) and pixel area (arcsec^2) at a position, via finite differences. */
export function localPixelGeometry(w: WcsModel, x: number, y: number) {
  const [ra0, de0] = pixelToSky(w, x, y);
  const [rax, dex] = pixelToSky(w, x + 1, y);
  const [ray, dey] = pixelToSky(w, x, y + 1);
  const cd = Math.cos(de0 * D2R);
  const ex = [dRa(rax, ra0) * cd * 3600, (dex - de0) * 3600];
  const ey = [dRa(ray, ra0) * cd * 3600, (dey - de0) * 3600];
  return {
    scaleX: Math.hypot(ex[0], ex[1]),
    scaleY: Math.hypot(ey[0], ey[1]),
    areaArcsec2: Math.abs(ex[0] * ey[1] - ex[1] * ey[0]),
    jac: [[ex[0], ey[0]], [ex[1], ey[1]]] as [[number, number], [number, number]], // d(east,north)/d(x,y) in arcsec
  };
}

function dRa(a: number, b: number): number {
  let d = a - b;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

// ---------------------------------------------------------------- sky geometry

export function angularSeparationArcsec(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const p1 = dec1 * D2R, p2 = dec2 * D2R, dl = (ra2 - ra1) * D2R;
  const s = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(s))) * R2D * 3600;
}

/** Position angle of point 2 from point 1, degrees east of north. */
export function positionAngleDeg(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const p1 = dec1 * D2R, p2 = dec2 * D2R, dl = (ra2 - ra1) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) * R2D) % 360 + 360) % 360;
}

export const mjdToYear = (mjd: number) => 2000 + (mjd - 51544.5) / 365.25;

/**
 * Linear proper-motion propagation in the tangent plane. pmRaMasYr INCLUDES cos(dec) (Gaia/SIMBAD convention).
 * Ignores parallax and radial motion; fine for spans of a few years, not for precision work.
 */
export function propagateLinear(ra: number, dec: number, pmRaMasYr: number, pmDecMasYr: number, fromYear: number, toYear: number): [number, number] {
  const dt = toYear - fromYear;
  const dDec = (pmDecMasYr * dt) / 3.6e6;
  const dRaDeg = (pmRaMasYr * dt) / 3.6e6 / Math.cos(dec * D2R);
  return [(((ra + dRaDeg) % 360) + 360) % 360, dec + dDec];
}

// ---------------------------------------------------------------- statistics helpers

function median(a: number[]): number {
  if (a.length === 0) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

function clippedStats(vals: number[], nsig = 3, iters = 5): { med: number; sigma: number } {
  let v = vals.filter(Number.isFinite);
  let med = median(v), sigma = 1.4826 * median(v.map((x) => Math.abs(x - med)));
  for (let i = 0; i < iters && v.length > 4; i++) {
    const keep = v.filter((x) => Math.abs(x - med) <= nsig * sigma);
    if (keep.length === v.length || keep.length < 4) break;
    v = keep;
    med = median(v);
    sigma = 1.4826 * median(v.map((x) => Math.abs(x - med)));
  }
  return { med, sigma };
}

// ---------------------------------------------------------------- masks and background

export function buildValidMask(f: Frame, rejectMask = DEFAULT_REJECT_MASK): Uint8Array {
  const n = f.width * f.height;
  const m = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const ok = Number.isFinite(f.data[i]) && (!f.variance || (Number.isFinite(f.variance[i]) && f.variance[i] > 0));
    const bad = f.flags ? (f.flags[i] & rejectMask) !== 0 : false;
    m[i] = ok && !bad ? 1 : 0;
  }
  return m;
}

/** Mesh background (sigma-clipped medians, bilinear interpolation). Falls back to a global value on small cutouts. */
export function estimateBackground(f: Frame, valid: Uint8Array, mesh = 32): { bkg: Float32Array; sigma: number } {
  const { width: W, height: H } = f;
  const bkg = new Float32Array(W * H);
  const all: number[] = [];
  for (let i = 0; i < W * H; i++) if (valid[i]) all.push(f.data[i]);
  const g = clippedStats(all);
  if (W < 2 * mesh || H < 2 * mesh) {
    bkg.fill(g.med);
    return { bkg, sigma: g.sigma };
  }
  const nx = Math.floor(W / mesh), ny = Math.floor(H / mesh);
  const grid = new Float64Array(nx * ny);
  for (let by = 0; by < ny; by++)
    for (let bx = 0; bx < nx; bx++) {
      const vals: number[] = [];
      for (let y = by * mesh; y < Math.min(H, (by + 1) * mesh); y++)
        for (let x = bx * mesh; x < Math.min(W, (bx + 1) * mesh); x++) {
          const i = y * W + x;
          if (valid[i]) vals.push(f.data[i]);
        }
      grid[by * nx + bx] = vals.length >= 10 ? clippedStats(vals).med : g.med;
    }
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const gx = Math.min(nx - 1, Math.max(0, (x + 0.5) / mesh - 0.5));
      const gy = Math.min(ny - 1, Math.max(0, (y + 0.5) / mesh - 0.5));
      const x0 = Math.floor(gx), y0 = Math.floor(gy);
      const x1 = Math.min(nx - 1, x0 + 1), y1 = Math.min(ny - 1, y0 + 1);
      const tx = gx - x0, ty = gy - y0;
      bkg[y * W + x] =
        (1 - tx) * (1 - ty) * grid[y0 * nx + x0] + tx * (1 - ty) * grid[y0 * nx + x1] +
        (1 - tx) * ty * grid[y1 * nx + x0] + tx * ty * grid[y1 * nx + x1];
    }
  return { bkg, sigma: g.sigma };
}

// ---------------------------------------------------------------- detection

interface Peak { x: number; y: number; snr: number }

/** Matched-filter SNR map with a Gaussian PSF model. Invalid pixels contribute zero weight. */
function matchedFilterSnr(f: Frame, valid: Uint8Array, bkg: Float32Array, sigmaPix: number, fallbackVar: number): Float32Array {
  const { width: W, height: H } = f;
  const R = Math.max(2, Math.ceil(3 * sigmaPix));
  const k: number[] = [], offs: Array<[number, number]> = [];
  for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++) {
      k.push(Math.exp(-(dx * dx + dy * dy) / (2 * sigmaPix * sigmaPix)));
      offs.push([dx, dy]);
    }
  const snr = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let num = 0, den = 0;
      for (let j = 0; j < k.length; j++) {
        const xx = x + offs[j][0], yy = y + offs[j][1];
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const i = yy * W + xx;
        if (!valid[i]) continue;
        const v = f.variance ? f.variance[i] : fallbackVar;
        num += k[j] * (f.data[i] - bkg[i]);
        den += k[j] * k[j] * v;
      }
      snr[y * W + x] = den > 0 ? num / Math.sqrt(den) : 0;
    }
  return snr;
}

function findPeaks(snr: Float32Array, W: number, H: number, thr: number, minSep: number): Peak[] {
  const cand: Peak[] = [];
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const v = snr[y * W + x];
      if (v < thr) continue;
      let isMax = true;
      for (let dy = -1; dy <= 1 && isMax; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (snr[(y + dy) * W + x + dx] > v) { isMax = false; break; }
        }
      if (isMax) cand.push({ x, y, snr: v });
    }
  cand.sort((a, b) => b.snr - a.snr);
  const out: Peak[] = [];
  for (const c of cand) if (out.every((o) => Math.hypot(o.x - c.x, o.y - c.y) >= minSep)) out.push(c);
  return out;
}

/** Iterative Gaussian-windowed centroid with propagated statistical error. */
function windowedCentroid(f: Frame, valid: Uint8Array, bkg: Float32Array, x0: number, y0: number, sigmaPix: number, fallbackVar: number) {
  const { width: W, height: H } = f;
  const R = Math.ceil(3 * sigmaPix);
  let cx = x0, cy = y0, errX = NaN, errY = NaN;
  for (let it = 0; it < 12; it++) {
    let sw = 0, sx = 0, sy = 0;
    for (let y = Math.max(0, Math.round(cy) - R); y <= Math.min(H - 1, Math.round(cy) + R); y++)
      for (let x = Math.max(0, Math.round(cx) - R); x <= Math.min(W - 1, Math.round(cx) + R); x++) {
        const i = y * W + x;
        if (!valid[i]) continue;
        const w = Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * sigmaPix * sigmaPix));
        const d = f.data[i] - bkg[i];
        sw += w * d; sx += w * d * x; sy += w * d * y;
      }
    if (!(sw > 0)) break;
    const nx = sx / sw, ny = sy / sw;
    const moved = Math.hypot(nx - cx, ny - cy);
    cx = nx; cy = ny;
    if (moved < 1e-4) break;
  }
  let sw = 0, vx = 0, vy = 0;
  for (let y = Math.max(0, Math.round(cy) - R); y <= Math.min(H - 1, Math.round(cy) + R); y++)
    for (let x = Math.max(0, Math.round(cx) - R); x <= Math.min(W - 1, Math.round(cx) + R); x++) {
      const i = y * W + x;
      if (!valid[i]) continue;
      const w = Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * sigmaPix * sigmaPix));
      const v = f.variance ? f.variance[i] : fallbackVar;
      sw += w * (f.data[i] - bkg[i]);
      vx += (w * (x - cx)) ** 2 * v;
      vy += (w * (y - cy)) ** 2 * v;
    }
  if (sw > 0) { errX = Math.sqrt(vx) / sw; errY = Math.sqrt(vy) / sw; }
  return { cx, cy, errX, errY };
}

/** Aperture photometry in MJy/sr -> Jy using the local pixel solid angle. No aperture correction. */
function aperturePhotometry(f: Frame, valid: Uint8Array, bkg: Float32Array, cx: number, cy: number, rAp: number, rIn: number, rOut: number, sigmaBkg: number, fallbackVar: number, cautionMask: number, rejectMask: number) {
  const { width: W, height: H } = f;
  const geom = localPixelGeometry(f.wcs, cx, cy);
  const omegaSr = geom.areaArcsec2 * (D2R / 3600) ** 2;
  const annulus: number[] = [];
  let sum = 0, varSum = 0, nAp = 0, flagBits = 0, rejectInAp = false;
  const R = Math.ceil(rOut) + 1;
  for (let y = Math.max(0, Math.round(cy) - R); y <= Math.min(H - 1, Math.round(cy) + R); y++)
    for (let x = Math.max(0, Math.round(cx) - R); x <= Math.min(W - 1, Math.round(cx) + R); x++) {
      const r = Math.hypot(x - cx, y - cy);
      const i = y * W + x;
      if (r <= rAp) {
        if (f.flags) { flagBits |= f.flags[i]; if (f.flags[i] & rejectMask) rejectInAp = true; }
        if (!valid[i]) continue;
        nAp++;
        sum += f.data[i];
        varSum += f.variance ? f.variance[i] : fallbackVar;
      } else if (r >= rIn && r <= rOut && valid[i]) {
        annulus.push(f.data[i]);
      }
    }
  const st = annulus.length >= 8 ? clippedStats(annulus) : { med: median(Array.from(bkg).slice(0, 1)), sigma: sigmaBkg };
  const localBkg = annulus.length >= 8 ? st.med : bkg[Math.round(cy) * W + Math.round(cx)];
  const bkgErr = annulus.length >= 8 ? st.sigma / Math.sqrt(annulus.length) : sigmaBkg;
  const netSb = sum - nAp * localBkg; // MJy/sr summed over pixels
  const errSb = Math.sqrt(varSum + (nAp * bkgErr) ** 2);
  return {
    fluxJy: netSb * omegaSr * 1e6,
    fluxErrJy: errSb * omegaSr * 1e6,
    nValid: nAp,
    flagBits,
    caution: (flagBits & cautionMask) !== 0,
    reject: rejectInAp,
  };
}

export function detectSources(f: Frame, opt: DetectOptions = {}): Detection[] {
  const rejectMask = opt.rejectMask ?? DEFAULT_REJECT_MASK;
  const cautionMask = opt.cautionMask ?? DEFAULT_CAUTION_MASK;
  const thr = opt.snrThreshold ?? 5;
  const geomC = localPixelGeometry(f.wcs, f.width / 2, f.height / 2);
  const scale = 0.5 * (geomC.scaleX + geomC.scaleY);
  const fwhmPix = opt.fwhmPix ?? (f.psfFwhmArcsec ? f.psfFwhmArcsec / scale : 1.5);
  const sigmaPix = Math.max(0.6, fwhmPix / 2.3548);

  const valid = buildValidMask(f, rejectMask);
  const { bkg, sigma } = estimateBackground(f, valid, opt.bkgMesh ?? 32);
  const fallbackVar = sigma * sigma;
  const snrMap = matchedFilterSnr(f, valid, bkg, sigmaPix, fallbackVar);
  const peaks = findPeaks(snrMap, f.width, f.height, thr, (opt.minSeparationFwhm ?? 2) * fwhmPix);

  const out: Detection[] = [];
  for (const p of peaks) {
    const c = windowedCentroid(f, valid, bkg, p.x, p.y, sigmaPix, fallbackVar);
    if (!Number.isFinite(c.errX) || !Number.isFinite(c.errY)) continue;
    const [ra, dec] = pixelToSky(f.wcs, c.cx, c.cy);
    const g = localPixelGeometry(f.wcs, c.cx, c.cy);
    // propagate pixel errors to (east, north) arcsec using the local Jacobian
    let eE = Math.hypot(g.jac[0][0] * c.errX, g.jac[0][1] * c.errY);
    let eN = Math.hypot(g.jac[1][0] * c.errX, g.jac[1][1] * c.errY);
    const notes = ["Statistical uncertainty only (VARIANCE plane)."];
    if (opt.systematicArcsec !== undefined) {
      eE = Math.hypot(eE, opt.systematicArcsec);
      eN = Math.hypot(eN, opt.systematicArcsec);
      notes[0] = `Statistical + systematic floor of ${opt.systematicArcsec} arcsec in quadrature.`;
    } else {
      notes.push("No WCS systematic floor applied.");
    }
    const ph = aperturePhotometry(f, valid, bkg, c.cx, c.cy,
      (opt.apertureRadiusFwhm ?? 1.5) * fwhmPix, (opt.annulusInnerFwhm ?? 2.5) * fwhmPix, (opt.annulusOuterFwhm ?? 4) * fwhmPix,
      sigma, fallbackVar, cautionMask, rejectMask);
    notes.push("No aperture correction applied.");
    if (ph.caution) notes.push("Caution-level flags present inside the aperture.");
    if (ph.reject) notes.push("Reject-level flags present inside the aperture: measurement unreliable.");
    out.push({
      frameId: f.id, detector: f.detector, mjd: f.mjd,
      x: c.cx, y: c.cy, xErr: c.errX, yErr: c.errY,
      ra, dec, raErrArcsec: eE, decErrArcsec: eN,
      snr: p.snr, fluxJy: ph.fluxJy, fluxErrJy: ph.fluxErrJy,
      nValidAperturepx: ph.nValid, flagBitsInAperture: ph.flagBits,
      cautionFlagged: ph.caution, rejectFlagged: ph.reject,
      status: "automatic-detection", notes,
    });
  }
  return out;
}

// ---------------------------------------------------------------- motion fitting

export interface MotionFit {
  n: number;
  t0Year: number;
  /** Position at t0 relative to the reference (arcsec east / north). */
  offsetEastArcsec: number;
  offsetNorthArcsec: number;
  pmEastArcsecYr: number; // includes cos(dec): true on-sky rate
  pmNorthArcsecYr: number;
  pmEastErr: number;
  pmNorthErr: number;
  totalRateArcsecYr: number;
  chi2Motion: number;
  chi2Static: number;
  dofMotion: number;
  deltaChi2: number; // static - motion, 2 dof
  pValueStaticHypothesis: number; // exp(-deltaChi2/2), exact for 2 dof
  reducedChi2Motion: number;
  spanYears: number;
  status: SourceStatus;
  notes: string[];
}

interface Pt { eastArcsec: number; northArcsec: number; sigE: number; sigN: number; year: number }

function toTangent(refRa: number, refDec: number, ra: number, dec: number): [number, number] {
  const dEast = dRa(ra, refRa) * Math.cos(refDec * D2R) * 3600;
  const dNorth = (dec - refDec) * 3600;
  return [dEast, dNorth];
}

function wls(t: number[], y: number[], s: number[]) {
  // y = a + b t
  let S = 0, St = 0, Stt = 0, Sy = 0, Sty = 0;
  for (let i = 0; i < t.length; i++) {
    const w = 1 / (s[i] * s[i]);
    S += w; St += w * t[i]; Stt += w * t[i] * t[i]; Sy += w * y[i]; Sty += w * t[i] * y[i];
  }
  const d = S * Stt - St * St;
  const b = (S * Sty - St * Sy) / d, a = (Stt * Sy - St * Sty) / d;
  let chi2 = 0;
  for (let i = 0; i < t.length; i++) chi2 += ((y[i] - a - b * t[i]) / s[i]) ** 2;
  return { a, b, errA: Math.sqrt(Stt / d), errB: Math.sqrt(S / d), chi2 };
}

/**
 * Fit a linear motion model to detections of ONE detector/band group.
 * `extraScatterArcsec` inflates errors in quadrature to reflect per-exposure WCS/PSF scatter you have measured.
 */
export function fitLinearMotion(dets: Detection[], extraScatterArcsec = 0): MotionFit {
  if (dets.length < 3) throw new Error("Need at least 3 detections for a motion fit with a meaningful chi-square");
  const detectors = new Set(dets.map((d) => d.detector));
  const notes: string[] = [];
  if (detectors.size > 1) notes.push("WARNING: detections span several detectors/bands; band-dependent PSF and colour effects can mimic motion.");
  const ref = dets[0];
  const pts: Pt[] = dets.map((d) => {
    const [e, n] = toTangent(ref.ra, ref.dec, d.ra, d.dec);
    return {
      eastArcsec: e, northArcsec: n,
      sigE: Math.hypot(d.raErrArcsec, extraScatterArcsec), sigN: Math.hypot(d.decErrArcsec, extraScatterArcsec),
      year: mjdToYear(d.mjd),
    };
  });
  const t0 = pts.reduce((s, p) => s + p.year, 0) / pts.length;
  const t = pts.map((p) => p.year - t0);
  const fe = wls(t, pts.map((p) => p.eastArcsec), pts.map((p) => p.sigE));
  const fn = wls(t, pts.map((p) => p.northArcsec), pts.map((p) => p.sigN));
  // static hypothesis: weighted mean position
  const mean = (v: number[], s: number[]) => {
    let w = 0, a = 0;
    v.forEach((x, i) => { const ww = 1 / (s[i] * s[i]); w += ww; a += ww * x; });
    const m = a / w;
    return v.reduce((c, x, i) => c + ((x - m) / s[i]) ** 2, 0);
  };
  const chi2Static = mean(pts.map((p) => p.eastArcsec), pts.map((p) => p.sigE)) + mean(pts.map((p) => p.northArcsec), pts.map((p) => p.sigN));
  const chi2Motion = fe.chi2 + fn.chi2;
  const dof = 2 * pts.length - 4;
  const span = Math.max(...pts.map((p) => p.year)) - Math.min(...pts.map((p) => p.year));
  const dchi = chi2Static - chi2Motion;
  if (!extraScatterArcsec) notes.push("No extra per-exposure scatter included: significance may be overstated.");
  if (span < 0.1) notes.push("Time baseline under ~1 month: motion is poorly constrained.");
  notes.push("Candidate only. Requires visual inspection, band-consistency checks and external catalogue comparison.");
  return {
    n: pts.length, t0Year: t0,
    offsetEastArcsec: fe.a, offsetNorthArcsec: fn.a,
    pmEastArcsecYr: fe.b, pmNorthArcsecYr: fn.b, pmEastErr: fe.errB, pmNorthErr: fn.errB,
    totalRateArcsecYr: Math.hypot(fe.b, fn.b),
    chi2Motion, chi2Static, dofMotion: dof, deltaChi2: dchi,
    pValueStaticHypothesis: Math.exp(-Math.max(0, dchi) / 2),
    reducedChi2Motion: dof > 0 ? chi2Motion / dof : NaN,
    spanYears: span, status: "candidate-association", notes,
  };
}

/** Group detections by detector so band differences are never treated as temporal change. */
export function groupByDetector(dets: Detection[]): Map<number, Detection[]> {
  const m = new Map<number, Detection[]>();
  for (const d of dets) {
    if (!m.has(d.detector)) m.set(d.detector, []);
    m.get(d.detector)!.push(d);
  }
  return m;
}

// ---------------------------------------------------------------- association

export interface Track { detections: Detection[]; fit?: MotionFit; status: SourceStatus }

/**
 * Greedy cross-epoch association within ONE detector group.
 * `maxRateArcsecYr` bounds how far a source may move between exposures; gate = maxRate*|dt| + nSigma*sigma.
 * Returns tracks (>=1 detection). Tracks of length >= 3 get a motion fit.
 */
export function associateDetections(dets: Detection[], maxRateArcsecYr: number, nSigma = 3, extraScatterArcsec = 0): Track[] {
  const sorted = [...dets].sort((a, b) => a.mjd - b.mjd);
  const tracks: Track[] = [];
  for (const d of sorted) {
    let best: { tr: Track; sep: number } | null = null;
    for (const tr of tracks) {
      const last = tr.detections[tr.detections.length - 1];
      if (Math.abs(last.mjd - d.mjd) < 1e-6 && last.frameId === d.frameId) continue;
      const dtYr = Math.abs(d.mjd - last.mjd) / 365.25;
      let pr = [last.ra, last.dec] as [number, number];
      if (tr.detections.length >= 3) {
        const fit = fitLinearMotion(tr.detections, extraScatterArcsec);
        const ref = tr.detections[0];
        const e = fit.offsetEastArcsec + fit.pmEastArcsecYr * (mjdToYear(d.mjd) - fit.t0Year);
        const n = fit.offsetNorthArcsec + fit.pmNorthArcsecYr * (mjdToYear(d.mjd) - fit.t0Year);
        pr = [ref.ra + e / 3600 / Math.cos(ref.dec * D2R), ref.dec + n / 3600];
      }
      const sep = angularSeparationArcsec(pr[0], pr[1], d.ra, d.dec);
      const sig = Math.hypot(last.raErrArcsec, d.raErrArcsec, extraScatterArcsec);
      const gate = tr.detections.length >= 3 ? nSigma * Math.max(sig, 0.5 * maxRateArcsecYr * dtYr) : maxRateArcsecYr * dtYr + nSigma * sig;
      if (sep <= gate && (!best || sep < best.sep)) best = { tr, sep };
    }
    if (best) best.tr.detections.push(d);
    else tracks.push({ detections: [d], status: "automatic-detection" });
  }
  for (const tr of tracks) {
    if (tr.detections.length >= 3) {
      tr.fit = fitLinearMotion(tr.detections, extraScatterArcsec);
      tr.status = "candidate-association";
    }
  }
  return tracks;
}

/** Angular displacement between two detections with propagated uncertainty (statistical). */
export function displacement(a: Detection, b: Detection) {
  const sep = angularSeparationArcsec(a.ra, a.dec, b.ra, b.dec);
  const pa = positionAngleDeg(a.ra, a.dec, b.ra, b.dec);
  const sig = Math.hypot(a.raErrArcsec, b.raErrArcsec, a.decErrArcsec, b.decErrArcsec) / Math.SQRT2;
  const dtYr = (b.mjd - a.mjd) / 365.25;
  return {
    separationArcsec: sep, positionAngleDeg: pa, sigmaArcsec: sig,
    significance: sig > 0 ? sep / sig : Infinity,
    dtYears: dtYr, rateArcsecYr: dtYr !== 0 ? sep / Math.abs(dtYr) : NaN,
    sameDetector: a.detector === b.detector,
    note: a.detector === b.detector ? "Same detector/band." : "Different detectors/bands: not a clean temporal comparison.",
  };
}

// ---------------------------------------------------------------- reprojection to a common celestial grid

export interface GridSpec {
  centerRa: number; // deg
  centerDec: number; // deg
  scaleArcsec: number; // output pixel scale
  width: number;
  height: number;
}

export function gridWcs(g: GridSpec): WcsModel {
  const s = g.scaleArcsec / 3600;
  return {
    crpix: [(g.width + 1) / 2, (g.height + 1) / 2], crval: [g.centerRa, g.centerDec],
    pc: [[-1, 0], [0, 1]], cdelt: [s, s], sipA: {}, sipB: {}, sipOrderA: 0, sipOrderB: 0,
  };
}

/**
 * Resample a frame onto a fixed celestial grid (north up, east left) by inverse mapping + bilinear interpolation.
 * The grid is tied to the SKY, not to any source, so genuine motion is preserved. Pixels whose bilinear
 * neighbourhood includes an invalid (rejected/non-finite) pixel become NaN: nothing is filled in.
 * Variance is interpolated with squared weights (assumes uncorrelated input pixels; interpolation correlates
 * neighbours, so treat as approximate). Original data are never modified.
 */
export function reprojectFrame(f: Frame, g: GridSpec, rejectMask = DEFAULT_REJECT_MASK) {
  const out = gridWcs(g);
  const valid = buildValidMask(f, rejectMask);
  const data = new Float32Array(g.width * g.height).fill(NaN);
  const variance = new Float32Array(g.width * g.height).fill(NaN);
  const coverage = new Uint8Array(g.width * g.height);
  for (let j = 0; j < g.height; j++)
    for (let i = 0; i < g.width; i++) {
      const [ra, dec] = pixelToSky(out, i, j);
      let x: number, y: number;
      try { [x, y] = skyToPixel(f.wcs, ra, dec); } catch { continue; }
      const x0 = Math.floor(x), y0 = Math.floor(y);
      if (x0 < 0 || y0 < 0 || x0 + 1 >= f.width || y0 + 1 >= f.height) continue;
      const tx = x - x0, ty = y - y0;
      const idx = [y0 * f.width + x0, y0 * f.width + x0 + 1, (y0 + 1) * f.width + x0, (y0 + 1) * f.width + x0 + 1];
      const w = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty];
      coverage[j * g.width + i] = 1;
      if (!idx.every((k) => valid[k])) continue;
      let v = 0, vv = 0;
      for (let k = 0; k < 4; k++) {
        v += w[k] * f.data[idx[k]];
        if (f.variance) vv += w[k] * w[k] * f.variance[idx[k]];
      }
      data[j * g.width + i] = v;
      if (f.variance) variance[j * g.width + i] = vv;
    }
  return { grid: g, wcs: out, data, variance: f.variance ? variance : undefined, insideFootprint: coverage };
}
