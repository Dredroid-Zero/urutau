export interface SkyPosition {
  ra: number; // ICRS decimal degrees [0, 360)
  dec: number; // ICRS decimal degrees [-90, +90]
}

export interface SpherexBandInfo {
  detector: 1 | 2 | 3 | 4 | 5 | 6;
  bandpassName: string;
  fpa: 'SWIR' | 'MWIR';
  lambdaMinUm: number;
  lambdaMaxUm: number;
  resolvingPower: number;
  pixelScaleArcsec: number;
}

export const SPHEREX_BANDS: SpherexBandInfo[] = [
  { detector: 1, bandpassName: 'SPHEREx-D1', fpa: 'SWIR', lambdaMinUm: 0.75, lambdaMaxUm: 1.09, resolvingPower: 39, pixelScaleArcsec: 6.2 },
  { detector: 2, bandpassName: 'SPHEREx-D2', fpa: 'SWIR', lambdaMinUm: 1.10, lambdaMaxUm: 1.62, resolvingPower: 41, pixelScaleArcsec: 6.2 },
  { detector: 3, bandpassName: 'SPHEREx-D3', fpa: 'SWIR', lambdaMinUm: 1.63, lambdaMaxUm: 2.41, resolvingPower: 41, pixelScaleArcsec: 6.2 },
  { detector: 4, bandpassName: 'SPHEREx-D4', fpa: 'MWIR', lambdaMinUm: 2.42, lambdaMaxUm: 3.82, resolvingPower: 35, pixelScaleArcsec: 6.2 },
  { detector: 5, bandpassName: 'SPHEREx-D5', fpa: 'MWIR', lambdaMinUm: 3.83, lambdaMaxUm: 4.41, resolvingPower: 112, pixelScaleArcsec: 6.2 },
  { detector: 6, bandpassName: 'SPHEREx-D6', fpa: 'MWIR', lambdaMinUm: 4.42, lambdaMaxUm: 5.00, resolvingPower: 128, pixelScaleArcsec: 6.2 },
];

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export function normalizeRa(raDeg: number): number {
  const mod = raDeg % 360;
  return mod < 0 ? mod + 360 : mod;
}

export function clampDec(decDeg: number): number {
  return Math.max(-90, Math.min(90, decDeg));
}

export function hmsToDeg(hours: number, minutes: number, seconds: number): number {
  return normalizeRa((hours + minutes / 60 + seconds / 3600) * 15);
}

export function dmsToDeg(sign: 1 | -1, degrees: number, arcminutes: number, arcseconds: number): number {
  const absVal = Math.abs(degrees) + arcminutes / 60 + arcseconds / 3600;
  return clampDec(sign * absVal);
}

export function degToHms(raDeg: number, decimals = 3): string {
  const norm = normalizeRa(raDeg);
  const totalHours = norm / 15;
  let h = Math.floor(totalHours);
  const remMin = (totalHours - h) * 60;
  let m = Math.floor(remMin);
  let s = (remMin - m) * 60;
  const factor = Math.pow(10, decimals);
  s = Math.round(s * factor) / factor;
  if (s >= 60) {
    s -= 60;
    m += 1;
  }
  if (m >= 60) {
    m -= 60;
    h = (h + 1) % 24;
  }
  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  const ss = s.toFixed(decimals).padStart(decimals > 0 ? decimals + 3 : 2, '0');
  return `${hh}h${mm}m${ss}s`;
}

export function degToDms(decDeg: number, decimals = 2): string {
  const clamped = clampDec(decDeg);
  const sign = clamped < 0 ? '-' : '+';
  const absDeg = Math.abs(clamped);
  let d = Math.floor(absDeg);
  const remMin = (absDeg - d) * 60;
  let m = Math.floor(remMin);
  let s = (remMin - m) * 60;
  const factor = Math.pow(10, decimals);
  s = Math.round(s * factor) / factor;
  if (s >= 60) {
    s -= 60;
    m += 1;
  }
  if (m >= 60) {
    m -= 60;
    d += 1;
  }
  const dd = String(d).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  const ss = s.toFixed(decimals).padStart(decimals > 0 ? decimals + 3 : 2, '0');
  return `${sign}${dd}°${mm}'${ss}"`;
}

/**
 * Parses decimal degrees ("133.795, -7.245") or sexagesimal ("08h55m10.831s -07d14m42.53s" or "08:55:10.831 -07:14:42.53").
 */
export function parseCoordinateInput(raRaw: string, decRaw?: string): SkyPosition | null {
  let raStr = raRaw.trim();
  let decStr = decRaw?.trim() ?? '';

  if (!decStr) {
    // Try splitting single combined string on comma or whitespace between two groups
    if (raStr.includes(',')) {
      const parts = raStr.split(',').map((s) => s.trim());
      if (parts.length !== 2) return null;
      [raStr, decStr] = parts;
    } else {
      const tokens = raStr.split(/\s+/);
      if (tokens.length === 2) {
        [raStr, decStr] = tokens;
      } else if (tokens.length === 6) {
        raStr = tokens.slice(0, 3).join(':');
        decStr = tokens.slice(3, 6).join(':');
      } else {
        return null;
      }
    }
  }

  const ra = parseRaSingle(raStr);
  const dec = parseDecSingle(decStr);
  if (ra === null || dec === null || Number.isNaN(ra) || Number.isNaN(dec)) return null;
  return { ra, dec };
}

function parseRaSingle(input: string): number | null {
  const clean = input.trim();
  if (/^[+-]?\d+(\.\d+)?$/.test(clean)) {
    const val = Number(clean);
    return Number.isFinite(val) ? normalizeRa(val) : null;
  }
  const match = clean.match(/^(\d{1,2})[h:\s]+(\d{1,2})[m:\s]+(\d{1,2}(?:\.\d+)?)s?$/i);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  const s = Number(match[3]);
  if (h >= 24 || m >= 60 || s >= 60) return null;
  return hmsToDeg(h, m, s);
}

function parseDecSingle(input: string): number | null {
  const clean = input.trim();
  if (/^[+-]?\d+(\.\d+)?$/.test(clean)) {
    const val = Number(clean);
    if (!Number.isFinite(val) || val < -90 || val > 90) return null;
    return val;
  }
  const match = clean.match(/^([+-]?)\s*(\d{1,2})[d°:\s]+(\d{1,2})[m'′:\s]+(\d{1,2}(?:\.\d+)?)[s"″]?$/i);
  if (!match) return null;
  const sign: 1 | -1 = match[1] === '-' ? -1 : 1;
  const d = Number(match[2]);
  const m = Number(match[3]);
  const s = Number(match[4]);
  if (d > 90 || m >= 60 || s >= 60) return null;
  return dmsToDeg(sign, d, m, s);
}

/**
 * Vincenty angular separation on the celestial sphere in arcseconds.
 */
export function angularSeparationArcsec(a: SkyPosition, b: SkyPosition): number {
  const ra1 = a.ra * DEG2RAD;
  const dec1 = a.dec * DEG2RAD;
  const ra2 = b.ra * DEG2RAD;
  const dec2 = b.dec * DEG2RAD;
  const dRa = ra2 - ra1;
  const cosDec1 = Math.cos(dec1);
  const sinDec1 = Math.sin(dec1);
  const cosDec2 = Math.cos(dec2);
  const sinDec2 = Math.sin(dec2);
  const num = Math.hypot(
    cosDec2 * Math.sin(dRa),
    cosDec1 * sinDec2 - sinDec1 * cosDec2 * Math.cos(dRa),
  );
  const den = sinDec1 * sinDec2 + cosDec1 * cosDec2 * Math.cos(dRa);
  const rad = Math.atan2(num, den);
  return rad * RAD2DEG * 3600;
}

/**
 * Position angle from position `a` to `b`, measured East of North in degrees [0, 360).
 */
export function positionAngleDeg(a: SkyPosition, b: SkyPosition): number {
  const ra1 = a.ra * DEG2RAD;
  const dec1 = a.dec * DEG2RAD;
  const ra2 = b.ra * DEG2RAD;
  const dec2 = b.dec * DEG2RAD;
  const dRa = ra2 - ra1;
  const y = Math.sin(dRa);
  const x = Math.cos(dec1) * Math.tan(dec2) - Math.sin(dec1) * Math.cos(dRa);
  const pa = Math.atan2(y, x) * RAD2DEG;
  return (pa + 360) % 360;
}

/**
 * Propagate ICRS position with proper motion (pmRa = mu_alpha * cos(delta) in mas/yr, pmDec in mas/yr).
 */
export function propagatePosition(
  raDeg: number,
  decDeg: number,
  pmRaMasYr: number,
  pmDecMasYr: number,
  fromEpochYear: number,
  toEpochYear: number,
): SkyPosition {
  const dt = toEpochYear - fromEpochYear;
  const cosDec = Math.max(1e-6, Math.cos(decDeg * DEG2RAD));
  const dDecDeg = (pmDecMasYr * dt) / 3600000;
  const dRaDeg = (pmRaMasYr * dt) / (3600000 * cosDec);
  return {
    ra: normalizeRa(raDeg + dRaDeg),
    dec: clampDec(decDeg + dDecDeg),
  };
}

/**
 * Compute HEALPix NESTED pixel index for nside = 2^order (default order = 5 => nside = 32, 12,288 pixels).
 * Follows Górski et al. (2005) ApJ 622, 759 exact equatorial/polar cap scheme.
 */
export function ang2pixNest(order: number, raDeg: number, decDeg: number): number {
  const nside = 1 << order;
  const theta = (90 - clampDec(decDeg)) * DEG2RAD;
  const phi = normalizeRa(raDeg) * DEG2RAD;

  const z = Math.cos(theta);
  const za = Math.abs(z);
  const tt = (phi / (Math.PI / 2)) % 4; // in [0, 4)

  let faceNum: number;
  let ix: number;
  let iy: number;

  if (za <= 2 / 3) {
    // Equatorial belt
    const temp1 = nside * (0.5 + tt);
    const temp2 = nside * (z * 0.75);
    const jp = Math.floor(temp1 - temp2);
    const jm = Math.floor(temp1 + temp2);
    const ifp = jp >> order;
    const ifm = jm >> order;
    if (ifp === ifm) {
      faceNum = (ifp | 4) & 11;
      if (ifp === 4) faceNum = 4;
    } else if (ifp < ifm) {
      faceNum = ifp & 3;
    } else {
      faceNum = (ifm & 3) + 8;
    }
    ix = jm & (nside - 1);
    iy = nside - (jp & (nside - 1)) - 1;
  } else {
    // Polar caps
    const ntt = Math.min(3, Math.floor(tt));
    const tp = tt - ntt;
    const tmp = nside * Math.sqrt(3 * (1 - za));
    const jp = Math.min(nside - 1, Math.floor(tp * tmp));
    const jm = Math.min(nside - 1, Math.floor((1 - tp) * tmp));
    if (z >= 0) {
      faceNum = ntt;
      ix = nside - jm - 1;
      iy = nside - jp - 1;
    } else {
      faceNum = ntt + 8;
      ix = jp;
      iy = jm;
    }
  }

  return (faceNum * nside * nside) + xy2pixNest(ix, iy);
}

function xy2pixNest(ix: number, iy: number): number {
  let pix = 0;
  let bit = 1;
  let x = ix;
  let y = iy;
  for (let i = 0; i < 16; i++) {
    if (x & 1) pix += bit;
    bit <<= 1;
    if (y & 1) pix += bit;
    bit <<= 1;
    x >>= 1;
    y >>= 1;
    if (x === 0 && y === 0) break;
  }
  return pix;
}

export function getSpherexHipsCubeTileInfo(raDeg: number, decDeg: number): {
  order: number;
  ipix: number;
  dirId: number;
  cubeUrl: string;
  s3CubeUrl: string;
} {
  const order = 5;
  const ipix = ang2pixNest(order, raDeg, decDeg);
  const dirId = Math.floor(ipix / 10000) * 10000;
  return {
    order,
    ipix,
    dirId,
    cubeUrl: `https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/hips5_cube/hips_20261026/Norder5/Dir${dirId}/Npix${ipix}_cube.fits`,
    s3CubeUrl: `https://nasa-irsa-spherex.s3.amazonaws.com/dr1/hips5_cube/hips_20261026/Norder5/Dir${dirId}/Npix${ipix}_cube.fits`,
  };
}

export function mjdToIso(mjd: number): string {
  // MJD 40587 = 1970-01-01T00:00:00Z
  const unixMs = (mjd - 40587) * 86400 * 1000;
  return new Date(unixMs).toISOString();
}
