import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ang2pixNest,
  angularSeparationArcsec,
  degToDms,
  degToHms,
  getSpherexHipsCubeTileInfo,
  parseCoordinateInput,
  positionAngleDeg,
  propagatePosition,
} from './astronomy';

test('WISE 0855 sexagesimal coordinate parsing matches decimal degrees', () => {
  const parsed = parseCoordinateInput("08h55m10.831s", "-07°14'42.53\"");
  assert.ok(parsed);
  assert.ok(Math.abs(parsed.ra - 133.7951292) < 1e-5);
  assert.ok(Math.abs(parsed.dec - (-7.2451472)) < 1e-5);

  const hms = degToHms(parsed.ra, 3);
  const dms = degToDms(parsed.dec, 2);
  assert.equal(hms, '08h55m10.831s');
  assert.equal(dms, "-07°14'42.53\"");
});

test('parseCoordinateInput handles combined comma-separated and negative-zero Dec', () => {
  const parsed = parseCoordinateInput('08h55m10.831s, -00d15m00.00s');
  assert.ok(parsed);
  assert.ok(parsed.dec < 0);
  assert.ok(Math.abs(parsed.dec - (-0.25)) < 1e-6);
});

test('angularSeparationArcsec and positionAngleDeg compute spherical offsets accurately', () => {
  const a = { ra: 180, dec: 0 };
  const b = { ra: 180, dec: 1 / 3600 }; // 1 arcsec North
  assert.ok(Math.abs(angularSeparationArcsec(a, b) - 1.0) < 1e-4);
  assert.ok(Math.abs(positionAngleDeg(a, b) - 0.0) < 1e-3);

  const c = { ra: 180 + 1 / 3600, dec: 0 }; // 1 arcsec East on equator
  assert.ok(Math.abs(angularSeparationArcsec(a, c) - 1.0) < 1e-4);
  assert.ok(Math.abs(positionAngleDeg(a, c) - 90.0) < 1e-3);
});

test("Barnard's Star proper motion propagation over 26 years", () => {
  const pos2026 = propagatePosition(269.452077, 4.693365, -801.551, 10362.394, 2000, 2026);
  const sep = angularSeparationArcsec({ ra: 269.452077, dec: 4.693365 }, pos2026);
  const expectedSep = Math.hypot(0.801551, 10.362394) * 26;
  assert.ok(Math.abs(sep - expectedSep) < 0.05);
});

test('HEALPix NESTED Norder5 computes valid pixel indices [0, 12287]', () => {
  const northPole = ang2pixNest(5, 0, 89.99);
  const southPole = ang2pixNest(5, 0, -89.99);
  const eq = ang2pixNest(5, 45, 0);
  assert.ok(northPole >= 0 && northPole < 12288);
  assert.ok(southPole >= 0 && southPole < 12288);
  assert.ok(eq >= 0 && eq < 12288);

  const tile = getSpherexHipsCubeTileInfo(133.7951292, -7.2451472);
  assert.equal(tile.order, 5);
  assert.ok(tile.ipix >= 0 && tile.ipix < 12288);
  assert.ok(tile.cubeUrl.includes(`Npix${tile.ipix}_cube.fits`));
});
