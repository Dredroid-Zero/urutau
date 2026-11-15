import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProcessedFitsBuffer,
  extractFlagDefinitions,
  extractWcsFromHeader,
  parseFitsBuffer,
  pixelToWorld,
  summarizeFlags,
  toAstrometryWcs,
  worldToPixel,
} from './fits';

function buildMinimalFitsImage(width: number, height: number, pixels: number[]): ArrayBuffer {
  const cards = [
    "SIMPLE  =                    T / conforms to FITS standard",
    "BITPIX  =                  -32 / IEEE single precision",
    "NAXIS   =                    2 / number of axes",
    `NAXIS1  = ${String(width).padStart(20)}`,
    `NAXIS2  = ${String(height).padStart(20)}`,
    "CRVAL1  =                180.0",
    "CRVAL2  =                 10.0",
    "CRPIX1  =                  5.0",
    "CRPIX2  =                  5.0",
    "CD1_1   =           -0.0017222",
    "CD1_2   =                  0.0",
    "CD2_1   =                  0.0",
    "CD2_2   =            0.0017222",
    "CTYPE1  = 'RA---TAN-SIP'",
    "CTYPE2  = 'DEC--TAN-SIP'",
    "END",
  ];
  const headerBlocks = Math.ceil((cards.length * 80) / 2880);
  const headerBytes = headerBlocks * 2880;
  const rawDataBytes = pixels.length * 4;
  const dataBlocks = Math.ceil(rawDataBytes / 2880);
  const totalBytes = headerBytes + dataBlocks * 2880;
  const buf = new ArrayBuffer(totalBytes);
  const bytes = new Uint8Array(buf);
  bytes.fill(32, 0, headerBytes); // ASCII spaces

  cards.forEach((c, idx) => {
    const padded = c.padEnd(80, ' ');
    for (let i = 0; i < 80; i++) {
      bytes[idx * 80 + i] = padded.charCodeAt(i);
    }
  });

  const view = new DataView(buf);
  pixels.forEach((val, idx) => {
    view.setFloat32(headerBytes + idx * 4, val, false);
  });
  return buf;
}

test('parseFitsBuffer decodes IEEE float32 image and TAN-SIP WCS roundtrip', () => {
  const pixels = Array.from({ length: 64 }, (_, i) => i * 0.5);
  const buf = buildMinimalFitsImage(8, 8, pixels);
  const hdus = parseFitsBuffer(buf);

  assert.equal(hdus.length, 1);
  assert.equal(hdus[0].naxes[0], 8);
  assert.equal(hdus[0].naxes[1], 8);
  assert.ok(hdus[0].imageData);
  assert.equal(hdus[0].imageData[10], 5.0);

  const wcs = extractWcsFromHeader(hdus[0].headers);
  assert.ok(wcs);
  // Reference pixel CRPIX=(5,5) 1-based -> (4,4) 0-based maps exactly to CRVAL=(180, 10)
  const worldRef = pixelToWorld(4, 4, wcs);
  assert.ok(Math.abs(worldRef.ra - 180.0) < 1e-6);
  assert.ok(Math.abs(worldRef.dec - 10.0) < 1e-6);

  const back = worldToPixel(180.02, 10.01, wcs);
  assert.ok(back);
  const forward = pixelToWorld(back.x, back.y, wcs);
  assert.ok(Math.abs(forward.ra - 180.02) < 1e-5);
  assert.ok(Math.abs(forward.dec - 10.01) < 1e-5);
});

test('summarizeFlags decodes SPHEREx MSKN/MSKM bitmasks', () => {
  const flags = new Uint32Array([0, 1, 64, 65, 0]);
  const summary = summarizeFlags(flags, {
    MSKN0000: 'TRANSIENT',
    MSKM0000: 1,
    MSKN0006: 'NONFUNC',
    MSKM0006: 64,
  });
  assert.equal(summary.totalPixels, 5);
  assert.equal(summary.flaggedPixels, 3);
  assert.equal(summary.countsByFlag.TRANSIENT, 2);
  assert.equal(summary.countsByFlag.NONFUNC, 2);
});

test('extractFlagDefinitions reads runtime MSKN and MSKD descriptions', () => {
  const defs = extractFlagDefinitions({
    MSKN0000: 'TRANSIENT',
    MSKD0000: 'Transient detected during SUR',
    MSKN0021: 'SOURCE',
    MSKD0021: 'Known source pixel',
  });
  assert.equal(defs.length, 2);
  assert.equal(defs[0].bit, 0);
  assert.equal(defs[0].description, 'Transient detected during SUR');
  assert.equal(defs[1].bit, 21);
  assert.equal(defs[1].mask, 1 << 21);
});

test('toAstrometryWcs converts CD matrix and buildProcessedFitsBuffer preserves headers & HISTORY', () => {
  const buf = buildMinimalFitsImage(6, 6, Array.from({ length: 36 }, (_, i) => i + 1));
  const [hdu] = parseFitsBuffer(buf);
  const wcs = toAstrometryWcs(hdu.headers);
  assert.ok(wcs);

  const outBuf = buildProcessedFitsBuffer({
    width: 6,
    height: 6,
    data: hdu.imageData!,
    wcs,
    preservedHeaders: { OBSID: 'TEST_001', DETECTOR: 1, BUNIT: 'MJy/sr' },
    historyEntries: ['URUTAU median stack of 3 frames', 'Reject mask 0x28647'],
  });
  const [outHdu] = parseFitsBuffer(outBuf);
  assert.equal(outHdu.headers.OBSID, 'TEST_001');
  assert.equal(outHdu.headers.DETECTOR, 1);
  assert.ok(outHdu.history && outHdu.history.length >= 2);
  assert.ok(outHdu.history[0].includes('URUTAU median stack'));
  assert.equal(outHdu.imageData![5], 6);
});

