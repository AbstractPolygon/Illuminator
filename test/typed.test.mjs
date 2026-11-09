import test from 'node:test';
import assert from 'node:assert/strict';
import { mapF32 } from '../app/js/core/typed.js';

test('mapF32 gives what Float32Array.from(source, fn) gives, for typed arrays and plain arrays', () => {
  const typed = Float32Array.from([1, -2, 3.5, NaN, 0]);
  const fn = (x, i) => x * 2 + i;
  assert.deepEqual(mapF32(typed, fn), Float32Array.from(typed, fn));
  assert.deepEqual(mapF32([1, 2, 3], (x) => x / 3), Float32Array.from([1, 2, 3], (x) => x / 3));
  assert.equal(mapF32(new Float32Array(0), (x) => x).length, 0);
});
