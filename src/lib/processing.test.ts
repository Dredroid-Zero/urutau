import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDifferenceImage, stackReprojectedFrames } from './processing';

test('stackReprojectedFrames computes median and mean while preserving NaN', () => {
  const f1 = new Float32Array([10, 20, Number.NaN, 40]);
  const f2 = new Float32Array([12, 50, Number.NaN, 44]);
  const f3 = new Float32Array([100, 22, Number.NaN, 42]);

  const med = stackReprojectedFrames(
    [{ data: f1 }, { data: f2 }, { data: f3 }],
    2,
    2,
    'median',
  );
  assert.equal(med.data[0], 12); // outlier 100 rejected by median
  assert.equal(med.data[1], 22);
  assert.ok(Number.isNaN(med.data[2])); // never filled in
  assert.equal(med.data[3], 42);
  assert.equal(med.countMap[2], 0);
  assert.equal(med.countMap[0], 3);

  const mean = stackReprojectedFrames(
    [{ data: f1 }, { data: f2 }],
    2,
    2,
    'mean',
  );
  assert.equal(mean.data[0], 11);
  assert.equal(mean.data[1], 35);
});

test('computeDifferenceImage returns A - B and preserves NaN gaps', () => {
  const a = new Float32Array([10, 5, Number.NaN]);
  const b = new Float32Array([3, 8, 2]);
  const diff = computeDifferenceImage(a, b);
  assert.equal(diff[0], 7);
  assert.equal(diff[1], -3);
  assert.ok(Number.isNaN(diff[2]));
});
