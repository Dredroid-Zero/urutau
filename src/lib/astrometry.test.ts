// Run: npx tsx --test src/lib/astrometry.test.ts
// These use SYNTHETIC fixtures to verify the maths. They are not SPHEREx data.
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseWcs, pixelToSky, skyToPixel, localPixelGeometry, detectSources, fitLinearMotion,
  associateDetections, groupByDetector, reprojectFrame, gridWcs, angularSeparationArcsec, FLAG_BITS, type Frame, type Header, type WcsModel,
} from "./astrometry.ts";

// Linear terms taken from the IRSA "Introduction to SPHEREx Spectral Images" tutorial header (detector 2).
const header: Header = {
  CTYPE1: "RA---TAN-SIP", CTYPE2: "DEC--TAN-SIP", CRVAL1: 303.877766184, CRVAL2: 40.5489585415,
  CRPIX1: 1020.5, CRPIX2: 1020.5, PC1_1: -0.00161399858549, PC1_2: -0.000503359988208,
  PC2_1: -0.000566313443671, PC2_2: 0.00163301103545, CDELT1: 1, CDELT2: 1,
  A_ORDER: 2, A_2_0: 1e-6, A_1_1: -2e-6, B_ORDER: 2, B_0_2: 1.5e-6, B_1_1: 1e-6, // synthetic SIP terms for the round-trip test
};

test("WCS: pixel scale is about 6.15 arcsec and round trip is exact", () => {
  const w = parseWcs(header);
  const g = localPixelGeometry(w, 1019.5, 1019.5);
  assert.ok(Math.abs(g.scaleX - 6.15) < 0.15, `scaleX ${g.scaleX}`);
  assert.ok(Math.abs(g.scaleY - 6.15) < 0.15, `scaleY ${g.scaleY}`);
  for (const [x, y] of [[10, 20], [1019.5, 1019.5], [2000, 300], [123.4, 1888.8]]) {
    const [ra, dec] = pixelToSky(w, x, y);
    const [xb, yb] = skyToPixel(w, ra, dec);
    assert.ok(Math.hypot(xb - x, yb - y) < 1e-6, `round trip (${x},${y}) -> (${xb},${yb})`);
  }
  const [ra, dec] = pixelToSky(w, 1019.5, 1019.5); // CRPIX-1 with zero SIP at u=v=0
  assert.ok(Math.abs(ra - Number(header.CRVAL1)) < 1e-9 && Math.abs(dec - Number(header.CRVAL2)) < 1e-9);
});

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
function gauss(rnd: () => number) {
  return Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
}

function makeFrame(id: string, wcs: WcsModel, mjd: number, detector: number, src: Array<{ x: number; y: number; peak: number }>, seed: number, sigmaNoise = 1, W = 64, H = 64, flagsAll = 0): Frame {
  const rnd = lcg(seed);
  const fwhm = 1.8, s = fwhm / 2.3548;
  const data = new Float32Array(W * H), variance = new Float32Array(W * H), flags = new Int32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let v = 50 + sigmaNoise * gauss(rnd); // large pedestal like unsubtracted zodi
      for (const o of src) v += o.peak * Math.exp(-((x - o.x) ** 2 + (y - o.y) ** 2) / (2 * s * s));
      data[y * W + x] = v; variance[y * W + x] = sigmaNoise ** 2; flags[y * W + x] = flagsAll;
    }
  return { id, width: W, height: H, data, variance, flags, wcs, mjd, detector, psfFwhmArcsec: fwhm * 6.15 };
}

test("detection: recovers injected source position, ignores SOURCE flag", () => {
  const w = parseWcs({ ...header, A_ORDER: 0, B_ORDER: 0, CRPIX1: 32.5, CRPIX2: 32.5 });
  const f = makeFrame("t1", w, 60800, 2, [{ x: 30.3, y: 35.7, peak: 40 }], 7, 1, 64, 64, 1 << FLAG_BITS.SOURCE);
  const d = detectSources(f, { snrThreshold: 6 });
  assert.equal(d.length, 1, `found ${d.length}`);
  assert.ok(Math.abs(d[0].x - 30.3) < 0.1 && Math.abs(d[0].y - 35.7) < 0.1, `centroid (${d[0].x}, ${d[0].y})`);
  assert.ok(d[0].xErr > 0 && d[0].xErr < 0.2);
  assert.ok(d[0].snr > 10);
  assert.equal(d[0].rejectFlagged, false); // SOURCE bit alone must not reject
  assert.ok(d[0].fluxJy > 0 && d[0].fluxErrJy > 0);
});

test("detection: reject-level flags are reported, not hidden", () => {
  const w = parseWcs({ ...header, A_ORDER: 0, B_ORDER: 0, CRPIX1: 32.5, CRPIX2: 32.5 });
  const f = makeFrame("t2", w, 60800, 2, [{ x: 20, y: 20, peak: 60 }], 9);
  // flag the peak pixel as PERSIST
  f.flags![20 * 64 + 20] = 1 << FLAG_BITS.PERSIST;
  const d = detectSources(f, { snrThreshold: 6 });
  assert.equal(d.length, 1);
  assert.equal(d[0].rejectFlagged, true);
  assert.ok(d[0].notes.some((n) => n.includes("unreliable")));
});

test("motion: moving source gives significant fit, static source does not", () => {
  const w = parseWcs({ ...header, A_ORDER: 0, B_ORDER: 0, CRPIX1: 100, CRPIX2: 100 });
  const rateEastArcsecYr = 8, years = 1.0, n = 8;
  const g = localPixelGeometry(w, 50, 50);
  const movingDets = [], staticDets = [];
  for (let i = 0; i < n; i++) {
    const mjd = 60800 + (i * years * 365.25) / (n - 1);
    const shiftPix = (rateEastArcsecYr * (i * years) / (n - 1)) / g.scaleX; // along x for the test
    const fm = makeFrame(`m${i}`, w, mjd, 2, [{ x: 30 + shiftPix, y: 32, peak: 60 }], 100 + i, 1);
    const fs = makeFrame(`s${i}`, w, mjd, 2, [{ x: 30, y: 32, peak: 60 }], 200 + i, 1);
    movingDets.push(...detectSources(fm, { snrThreshold: 6 }));
    staticDets.push(...detectSources(fs, { snrThreshold: 6 }));
  }
  assert.equal(movingDets.length, n); assert.equal(staticDets.length, n);
  const fitM = fitLinearMotion(movingDets, 0.2);
  const fitS = fitLinearMotion(staticDets, 0.2);
  assert.ok(fitM.totalRateArcsecYr > 6.5 && fitM.totalRateArcsecYr < 9.5, `rate ${fitM.totalRateArcsecYr}`);
  assert.ok(fitM.pValueStaticHypothesis < 1e-6, `p ${fitM.pValueStaticHypothesis}`);
  assert.ok(fitS.totalRateArcsecYr < 1.0, `static rate ${fitS.totalRateArcsecYr}`);
  assert.ok(fitS.pValueStaticHypothesis > 0.01, `static p ${fitS.pValueStaticHypothesis}`);
  assert.equal(fitM.status, "candidate-association"); // never auto-promoted to confirmed
});

test("association: chains a moving source and keeps a static neighbour separate", () => {
  const w = parseWcs({ ...header, A_ORDER: 0, B_ORDER: 0, CRPIX1: 100, CRPIX2: 100 });
  const g = localPixelGeometry(w, 50, 50);
  const dets = [];
  for (let i = 0; i < 6; i++) {
    const mjd = 60800 + i * 60;
    const shift = (8 * (i * 60) / 365.25) / g.scaleX;
    const f = makeFrame(`a${i}`, w, mjd, 4, [{ x: 20 + shift, y: 20, peak: 60 }, { x: 45, y: 45, peak: 60 }], 300 + i, 1);
    dets.push(...detectSources(f, { snrThreshold: 6 }));
  }
  const tracks = associateDetections(dets, 12, 3, 0.2).filter((t) => t.detections.length >= 3);
  assert.equal(tracks.length, 2, `tracks ${tracks.length}`);
  const rates = tracks.map((t) => t.fit!.totalRateArcsecYr).sort((a, b) => a - b);
  assert.ok(rates[0] < 1.5, `static ${rates[0]}`);
  assert.ok(rates[1] > 6.5 && rates[1] < 9.5, `moving ${rates[1]}`);
});

test("grouping by detector separates bands; separation helper", () => {
  const w = parseWcs({ ...header, A_ORDER: 0, B_ORDER: 0, CRPIX1: 32.5, CRPIX2: 32.5 });
  const a = detectSources(makeFrame("g1", w, 60800, 2, [{ x: 30, y: 30, peak: 50 }], 1), { snrThreshold: 6 });
  const b = detectSources(makeFrame("g2", w, 60810, 5, [{ x: 30, y: 30, peak: 50 }], 2), { snrThreshold: 6 });
  const groups = groupByDetector([...a, ...b]);
  assert.equal(groups.size, 2);
  assert.ok(Math.abs(angularSeparationArcsec(10, 0, 10, 1 / 3600) - 1) < 1e-6);
});

test("reprojection: two frames with different pointings land a static star on the same grid position", () => {
  const base = parseWcs({ ...header, A_ORDER: 0, B_ORDER: 0, CRPIX1: 32.5, CRPIX2: 32.5 });
  // second frame: same sky, pointing offset by 7.3 pixels in x and a 4-degree roll
  const roll = (4 * Math.PI) / 180;
  const c = Math.cos(roll), s = Math.sin(roll);
  const p = base.pc;
  const wcs2: WcsModel = { ...base, crpix: [base.crpix[0] - 7.3, base.crpix[1] + 2.1],
    pc: [[c * p[0][0] - s * p[1][0], c * p[0][1] - s * p[1][1]], [s * p[0][0] + c * p[1][0], s * p[0][1] + c * p[1][1]]] };
  const [raS, decS] = pixelToSky(base, 33.2, 30.4); // star position on the sky
  const [x2, y2] = skyToPixel(wcs2, raS, decS);
  const f1 = makeFrame("r1", base, 60800, 2, [{ x: 33.2, y: 30.4, peak: 50 }], 11);
  const f2 = makeFrame("r2", wcs2, 60900, 2, [{ x: x2, y: y2, peak: 50 }], 12);
  const grid = { centerRa: raS, centerDec: decS, scaleArcsec: 6.15, width: 40, height: 40 };
  const g = gridWcs(grid);
  const detect = (fr: typeof f1) => {
    const r = reprojectFrame(fr, grid);
    const fake: Frame = { id: fr.id, width: 40, height: 40, data: r.data.map((v) => (Number.isFinite(v) ? v : 50)) as Float32Array,
      variance: r.variance!.map((v) => (Number.isFinite(v) ? v : 1)) as Float32Array, wcs: g, mjd: fr.mjd, detector: 2, psfFwhmArcsec: 11 };
    return detectSources(fake, { snrThreshold: 5 });
  };
  const d1 = detect(f1), d2 = detect(f2);
  assert.equal(d1.length, 1); assert.equal(d2.length, 1);
  assert.ok(angularSeparationArcsec(d1[0].ra, d1[0].dec, d2[0].ra, d2[0].dec) < 1.0, "static star must not move after celestial alignment");
});
