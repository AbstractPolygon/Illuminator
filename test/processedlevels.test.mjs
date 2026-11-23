import test from 'node:test';
import assert from 'node:assert/strict';
import { ProcessedPicture } from '../app/js/core/processed.js';

// a w x h picture with a depth map half its size: the pictures of a Light L16 photo at several sizes
function level(w, h, scale) {
  const data = new Uint8ClampedArray(w * h * 4).fill(128);
  const dw = 8;
  const dh = 6;
  const lambda = new Float32Array(dw * dh);
  for (let i = 0; i < lambda.length; i++) lambda[i] = ((i % dw) - 4) / scale;
  return new ProcessedPicture({ kind: 'single', source: 'l16', images: [{ width: w, height: h, data }], depth: { width: dw, height: dh, lambda }, pitchRatio: { x: 1, y: 1 } });
}

test('processed levels: the smallest picture that is wide enough is chosen, and the full size one when none is', () => {
  const levels = [level(64, 48, 1), level(32, 24, 2), level(16, 12, 4)];
  levels[0].levels = levels;
  const top = levels[0];
  assert.equal(top.levelFor(10).width, 16);
  assert.equal(top.levelFor(16).width, 16);
  assert.equal(top.levelFor(17).width, 32);
  assert.equal(top.levelFor(33).width, 64);
  assert.equal(top.levelFor(5000).width, 64);
  assert.equal(top.levelFor(0).width, 64);
  assert.equal(top.levelFor(undefined).width, 64);
  // a photo without levels is its own level
  const single = level(10, 8, 1);
  assert.equal(single.levelFor(3), single);
});

test('processed levels: the depth smoothing reaches every level', () => {
  const levels = [level(64, 48, 1), level(32, 24, 2), level(16, 12, 4)];
  levels[0].levels = levels;
  levels[0].setSmoothing(0.5);
  for (const l of levels) assert.equal(l.smoothing, 0.5);
});

test('processed levels: a view of a smaller level is the same picture, moved by the depth scaled to its size', () => {
  const levels = [level(64, 48, 1), level(32, 24, 2)];
  levels[0].levels = levels;
  const a = levels[0].render({ u: 0.3, v: 0, alpha: 0, blur: 0 });
  const b = levels[1].render({ u: 0.3, v: 0, alpha: 0, blur: 0 });
  assert.equal(a.length, 64 * 48 * 3);
  assert.equal(b.length, 32 * 24 * 3);
});
