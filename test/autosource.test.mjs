import test from 'node:test';
import assert from 'node:assert/strict';
import { bestSource } from '../app/js/core/autosource.js';

// vertical stripes with a period of 40 pixels and a smooth change down the picture
function picture(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = 4 * (y * w + x);
    data[i] = 128 + 100 * Math.sin((2 * Math.PI * x) / 40);
    data[i + 1] = 128 + 80 * Math.cos((2 * Math.PI * x) / 40);
    data[i + 2] = 90 + (y / h) * 60;
    data[i + 3] = 255;
  }
  return { w, h, data };
}

test('the source is one stripe period away from a blemish', () => {
  const img = picture(200, 80);
  const found = bestSource(img, [[100, 40]], 6);
  assert.ok(found);
  assert.ok(Math.abs(Math.abs(found.dx) - 40) <= 2 || Math.abs(Math.abs(found.dx) - 80) <= 2, `dx ${found.dx}`);
  assert.ok(Math.abs(found.dy) <= 8, `dy ${found.dy}`);
});

test('a stroke finds a source for the whole stroke', () => {
  const found = bestSource(picture(200, 80), [[90, 40], [100, 40], [110, 40]], 5);
  assert.ok(found && found.score < 0.01);
});

test('nothing fits a picture too small for the area', () => {
  assert.equal(bestSource(picture(20, 20), [[10, 10]], 15), null);
});
