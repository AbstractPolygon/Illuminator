import test from 'node:test';
import assert from 'node:assert/strict';
import { nthSmallest } from '../app/js/core/depth.js';
import { helperCount } from '../app/js/viewpool.js';

// A small deterministic generator, so a failure can be repeated.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test('nthSmallest gives what sorting gives, for every position', () => {
  const r = rng(7);
  for (const n of [1, 2, 3, 10, 101, 1000]) {
    const values = Float32Array.from({ length: n }, () => Math.round(r() * 20 - 10) / 4); // many repeats
    const sorted = Float32Array.from(values).sort();
    // (compared as numbers: a sort puts -0 before 0, a selection may not, and they are equal)
    const same = (a, b, what) => assert.ok(a === b, `${what}: ${a} against ${b}`);
    for (let k = 0; k < n; k += Math.max(1, n >> 4)) same(nthSmallest(values, k), sorted[k], `n=${n} k=${k}`);
    same(nthSmallest(values, n >> 1), sorted[n >> 1], 'median');
    same(nthSmallest(values, n - 1), sorted[n - 1], 'largest');
  }
});

test('nthSmallest puts NaN last, as a sort does, and does not change its input', () => {
  const values = Float32Array.from([3, NaN, 1, 2, NaN]);
  const copy = Float32Array.from(values);
  assert.equal(nthSmallest(values, 0), 1);
  assert.equal(nthSmallest(values, 2), 3);
  assert.ok(Number.isNaN(nthSmallest(values, 3)));
  assert.deepEqual(Array.from(values).map(String), Array.from(copy).map(String));
});

test('helper workers: none for a small job or a computer with few cores, at most three, fewer when the sensor is large', () => {
  const MB = 1024 * 1024;
  assert.equal(helperCount(2, 29, 20 * MB), 0);
  assert.equal(helperCount(8, 3, 20 * MB), 0);
  assert.equal(helperCount(4, 29, 20 * MB), 3);
  assert.equal(helperCount(16, 29, 20 * MB), 3);
  assert.equal(helperCount(3, 29, 20 * MB), 2);
  assert.equal(helperCount(8, 29, 83 * MB), 1); // an ILLUM sensor: 256 MB allows one helper
  assert.equal(helperCount(8, 29, 200 * MB), 0);
});
