import test from 'node:test';
import assert from 'node:assert/strict';
import { associateSourcesAcrossEpochs, detectSourcesInFrame } from './photometry';
import type { LoadedSpherexFrame, SpherexObservation } from '../types/spherex';

function makeSyntheticFrame(
  obsId: string,
  mjdObs: number,
  bandpassName: string,
  starX: number,
  starY: number,
): LoadedSpherexFrame {
  const width = 32;
  const height = 32;
  const image = new Float32Array(width * height).fill(1.0);
  const variance = new Float32Array(width * height).fill(0.01);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const r2 = (x - starX) ** 2 + (y - starY) ** 2;
      image[y * width + x] += 50 * Math.exp(-r2 / (2 * 1.2 * 1.2));
    }
  }

  const obs: SpherexObservation = {
    id: obsId,
    obsId,
    productId: obsId,
    collection: 'spherex_qr3',
    release: 'QR3',
    surveyMode: 'Wide',
    detector: 1,
    bandpassName,
    lambdaMinUm: 0.75,
    lambdaMaxUm: 1.09,
    dateObs: '2026-05-21T12:00:00Z',
    mjdObs,
    ra: 133.8,
    dec: -7.25,
    qualityStatus: 'Pass',
    accessUrl: 'https://example.org',
    cutoutPath: 'qr3/level2/test.fits',
    provenanceSource: 'IRSA-CUTOUT-VERIFIED',
  };

  return {
    frameId: obsId,
    observation: obs,
    width,
    height,
    image,
    variance,
    wcs: {
      crval1: 133.8,
      crval2: -7.25,
      crpix1: 16,
      crpix2: 16,
      cd1_1: -6.2 / 3600,
      cd1_2: 0,
      cd2_1: 0,
      cd2_2: 6.2 / 3600,
      aOrder: 0,
      bOrder: 0,
      a: {},
      b: {},
      apOrder: 0,
      bpOrder: 0,
      ap: {},
      bp: {},
      ctype1: 'RA---TAN-SIP',
      ctype2: 'DEC--TAN-SIP',
    },
    isSpectralCubeSlice: false,
    contaminationFlags: { heAirglow: false, aurora: false, shuttleGlow: false },
    headersSummary: {},
    cutoutCenterRa: 133.8,
    cutoutCenterDec: -7.25,
    cutoutSizeDeg: 0.05,
  };
}

test('detectSourcesInFrame finds Gaussian source centroid and associates cross-epoch displacement', () => {
  const frameA = makeSyntheticFrame('OBS_A', 61000.0, 'SPHEREx-D1', 15.2, 15.4);
  const frameB = makeSyntheticFrame('OBS_B', 61180.0, 'SPHEREx-D1', 16.0, 15.4); // 0.8 px = 4.96 arcsec over 180 d

  const detA = detectSourcesInFrame(frameA, { snrThreshold: 5, apertureRadiusPx: 3 });
  const detB = detectSourcesInFrame(frameB, { snrThreshold: 5, apertureRadiusPx: 3 });

  assert.equal(detA.length, 1);
  assert.equal(detB.length, 1);
  assert.ok(Math.abs(detA[0].x - 15.2) < 0.15);
  assert.ok(Math.abs(detB[0].x - 16.0) < 0.15);

  const matches = associateSourcesAcrossEpochs(detA, detB, 15.0);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].classification, 'candidate_motion');
  assert.ok(Math.abs(matches[0].deltaArcsec - 4.96) < 0.5);
});

test('associateSourcesAcrossEpochs flags bandpass difference caution instead of motion', () => {
  const frameA = makeSyntheticFrame('OBS_A', 61000.0, 'SPHEREx-D1', 15.0, 15.0);
  const frameB = makeSyntheticFrame('OBS_B', 61180.0, 'SPHEREx-D4', 15.6, 15.0);

  const detA = detectSourcesInFrame(frameA, { snrThreshold: 5, apertureRadiusPx: 3 });
  const detB = detectSourcesInFrame(frameB, { snrThreshold: 5, apertureRadiusPx: 3 });
  const matches = associateSourcesAcrossEpochs(detA, detB, 15.0);

  assert.equal(matches.length, 1);
  assert.equal(matches[0].classification, 'bandpass_shift_caution');
  assert.equal(matches[0].sameBand, false);
});
