// What opening a Light L16 photo measures is kept next to the photo (core/l16-cache.js) and read back the same.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeL16Cache, decodeL16Cache, l16CacheKey } from '../app/js/core/l16-cache.js';

test('L16 cache round trip', () => {
  const depth = { width: 4, height: 3, scale: 4, ref: 'A1', modules: ['A1', 'A3'], focalPx: 3000, K: new Float64Array([3000, 0, 2080, 0, 3000, 1560, 0, 0, 1]), steps: 64, near: 500, far: 9000,
    invZ: Float32Array.from({ length: 12 }, (_, i) => 0.001 * (i + 1)), confidence: Float32Array.from({ length: 12 }, (_, i) => i / 12) };
  const wide = { width: 5, height: 2, rgb: Float32Array.from({ length: 30 }, (_, i) => (i * 0.07) % 2.5), used: ['A1', 'A3'] };
  const key = l16CacheKey('abc', true);
  const back = decodeL16Cache(encodeL16Cache({ key, depth, wide }));
  assert.equal(back.key, key);
  assert.deepEqual(Array.from(back.depth.invZ), Array.from(depth.invZ));
  assert.deepEqual(Array.from(back.depth.confidence), Array.from(depth.confidence));
  assert.deepEqual(back.depth.K, Array.from(depth.K));
  assert.deepEqual(back.depth.modules, depth.modules);
  assert.equal(back.depth.near, 500);
  for (let i = 0; i < 30; i++) assert.ok(Math.abs(back.wide.rgb[i] - wide.rgb[i]) < 1e-3 * Math.max(0.05, wide.rgb[i]) + 1e-6, `${i}`);
  assert.deepEqual(back.wide.used, wide.used);
  assert.notEqual(l16CacheKey('abc', false), key);
});

test('not an L16 cache: null', () => {
  assert.equal(decodeL16Cache(new Uint8Array(40)), null);
  assert.equal(decodeL16Cache(null), null);
});
