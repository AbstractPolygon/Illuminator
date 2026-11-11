// Fill with AI (core/fillmodel.js): the mask grown around each area, the model's inputs (the picture as planar RGB, as it is; mask 0 = fill) and the picture put back
// together (only the filled area changes). The model itself was checked in the browser with the vendored runtime: mask 0 marks the area to paint, and a 704 x 480 picture
// comes back the same size with the area painted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { growMask, fillInputs, fillOutput, hasHoles, FILL_MODEL } from '../app/js/core/fillmodel.js';

test('the fill model is pinned to one revision, with its size and hash', () => {
  assert.match(FILL_MODEL.url, /^https:\/\/huggingface\.co\/andraniksargsyan\/migan\/resolve\/[0-9a-f]{40}\/migan_pipeline_v2\.onnx$/);
  assert.equal(FILL_MODEL.size, 28079181);
  assert.match(FILL_MODEL.sha256, /^[0-9a-f]{64}$/);
});

test('the mask grows by the given number of pixels', () => {
  const w = 7;
  const h = 5;
  const holes = new Uint8Array(w * h);
  holes[2 * w + 3] = 1;
  const g = growMask(holes, w, h, 1);
  const on = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (g[y * w + x]) on.push(`${x},${y}`);
  assert.deepEqual(on, ['2,1', '3,1', '4,1', '2,2', '3,2', '4,2', '2,3', '3,3', '4,3']);
  assert.equal(growMask(holes, w, h, 0), holes);
  assert.equal(hasHoles(holes), true);
  assert.equal(hasHoles(new Uint8Array(4)), false);
  assert.equal(hasHoles(null), false);
});

test('inputs: the picture as planar RGB, as it is, and the mask, 0 to fill and 255 to keep; output: only the area changes', () => {
  const w = 3;
  const h = 2;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set([10 + i, 20 + i, 30 + i, 255], i * 4);
  const holes = Uint8Array.from([0, 1, 0, 0, 0, 1]);
  const { image, mask } = fillInputs(rgba, holes, w, h);
  assert.deepEqual(Array.from(mask), [255, 0, 255, 255, 255, 0]);
  assert.deepEqual(Array.from(image.subarray(0, 6)), [10, 11, 12, 13, 14, 15]);
  assert.deepEqual(Array.from(image.subarray(6, 12)), [20, 21, 22, 23, 24, 25]);
  const n = w * h;
  const result = new Uint8Array(3 * n).fill(99);
  const out = fillOutput(rgba, result, holes, w, h);
  assert.deepEqual(Array.from(out.subarray(4, 8)), [99, 99, 99, 255]);
  assert.deepEqual(Array.from(out.subarray(0, 4)), [10, 20, 30, 255]);
  assert.deepEqual(Array.from(out.subarray(20, 24)), [99, 99, 99, 255]);
});
