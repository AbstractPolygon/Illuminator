// Depth map contrast picks the ends of the range by selection, not by sorting the whole map: the same values as the sorted version, for any data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeDepthContrast } from '../app/js/core/depth.js';

function reference(alpha, contrast) {
  const sorted = Float32Array.from(alpha).sort();
  const cut = 0.28 * Math.min(1, contrast);
  const lo = sorted[Math.floor((sorted.length - 1) * cut)];
  const hi = sorted[Math.floor((sorted.length - 1) * (1 - cut))];
  const span = Math.max(1e-6, hi - lo);
  return Float32Array.from(alpha, (a) => {
    const u = Math.max(0, Math.min(1, (a - lo) / span));
    return lo + (u + contrast * (u * u * (3 - 2 * u) - u)) * span;
  });
}

function rng(seed) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

test('depth map contrast gives the sorted version\'s values on random, repeated and flat data', () => {
  const r = rng(7);
  const cases = [
    Float32Array.from({ length: 5000 }, () => r() * 3 - 1.5),
    Float32Array.from({ length: 5000 }, () => Math.round(r() * 6) / 2),
    new Float32Array(300).fill(0.25),
    Float32Array.from({ length: 1001 }, (_, i) => i / 1000),
    Float32Array.from({ length: 1001 }, (_, i) => 1 - i / 1000),
    Float32Array.from([2, 1]),
  ];
  for (const data of cases) {
    for (const c of [0.05, 0.4, 1]) assert.deepEqual(shapeDepthContrast(data, c), reference(data, c));
  }
});

test('no contrast leaves the depth as it is, and the input is not changed', () => {
  const a = Float32Array.from([3, 1, 2]);
  assert.equal(shapeDepthContrast(a, 0), a);
  shapeDepthContrast(a, 0.5);
  assert.deepEqual([...a], [3, 1, 2]);
});
