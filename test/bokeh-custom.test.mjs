// Custom bokeh shapes (Camera > Bokeh > Custom image): an image's white is the shape. A single bright point far out of focus spreads into that shape on the
// processor (core/dof.js) and on the graphics card (DOF_GATHER); the preview ball has it too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { starRgba } from './helpers/bokeh.mjs';
import { BOKEH_IMAGE_SIZE, encodeBokehImage, decodeBokehImage, bokehKernel, bokehBall, applyDepthOfField } from '../app/js/core/dof.js';

test('a custom shape is kept as text and read back', () => {
  const text = encodeBokehImage(starRgba());
  assert.ok(text.length > 1000);
  const d = decodeBokehImage(text);
  assert.equal(d.mask.length, BOKEH_IMAGE_SIZE * BOKEH_IMAGE_SIZE);
  // the star covers well under the circle's area
  assert.ok(d.area > 0.2 && d.area < 0.6, `area ${d.area}`);
  assert.equal(encodeBokehImage(new Uint8ClampedArray(BOKEH_IMAGE_SIZE * BOKEH_IMAGE_SIZE * 4)), '', 'all black is no shape');
  const k = bokehKernel({ shape: 'custom', image: text });
  assert.equal(k.kind, 3);
  // without an image Custom is a circle
  assert.equal(bokehKernel({ shape: 'custom', image: '' }).kind, 1);
});

// Light at a tip (up, 0.8 of the radius) and in the gap beside it (36 degrees round, 0.8 of the radius).
function tipAndGap(at, cx, cy, r) {
  const tip = at(cx, Math.round(cy - 0.8 * r));
  const a = Math.PI / 5;
  const gap = at(Math.round(cx + Math.sin(a) * 0.8 * r), Math.round(cy - Math.cos(a) * 0.8 * r));
  return { tip, gap };
}

test('the preview ball and the processor blur take the custom shape', () => {
  const k = bokehKernel({ shape: 'custom', image: encodeBokehImage(starRgba()) });
  const size = 81;
  const ball = bokehBall(k, size, 30);
  const p = tipAndGap((x, y) => ball[y * size + x], 40, 40, 30);
  assert.ok(p.tip > 0.5 && p.gap < 0.05, JSON.stringify(p));

  const w = 96;
  const h = 96;
  const rgb = new Float32Array(w * h * 3);
  const c = 48;
  rgb.fill(50, 3 * (c * w + c), 3 * (c * w + c) + 3);
  const depth = new Float32Array(w * h).fill(1);
  const out = applyDepthOfField(rgb, w, h, depth, w, h, 0, 1, 24, { shape: 'custom', image: encodeBokehImage(starRgba()) });
  const q = tipAndGap((x, y) => out[3 * (y * w + x)], c, c, 24);
  assert.ok(q.tip > 10 * q.gap && q.tip > 0, JSON.stringify(q));
});
