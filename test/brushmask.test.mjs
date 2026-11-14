import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultMask, parseMasks, resolveMasks, maskWeight, packMasks, brushRaster, MAX_BRUSH_MASKS } from '../app/js/core/local.js';

const brush = (extra = {}) => ({ ...defaultMask('brush'), aspect: 1, size: 0.1, feather: 0.5, strokes: [{ erase: false, size: 0.1, feather: 0.5, points: [[0.5, 0.5], [0.5001, 0.5]] }], fx: { ...defaultMask('brush').fx, exposure: 1 }, ...extra });

test('a painted dab covers its spot and nothing far from it', () => {
  const [m] = resolveMasks([brush()]);
  assert.ok(maskWeight(m, 0.5, 0.5, 1, null) > 0.95);
  assert.equal(maskWeight(m, 0.9, 0.9, 1, null), 0);
});

test('erasing removes what was painted', () => {
  const m = brush();
  m.strokes.push({ erase: true, size: 0.2, feather: 0, points: [[0.5, 0.5], [0.5001, 0.5]] });
  const [r] = resolveMasks([m]);
  assert.ok(maskWeight(r, 0.5, 0.5, 1, null) < 0.05);
});

test('the paint moves with the scene: by depth, viewpoint and focus', () => {
  const m = brush({ depth: 1, u0: 0, v0: 0, focus0: 0 });
  const [still] = resolveMasks([m], { anchor: { u: 0, v: 0, focus: 0, k: 0.01 } });
  const [moved] = resolveMasks([m], { anchor: { u: 2, v: 0, focus: 0, k: 0.01 } });
  assert.equal(still.dx, 0);
  assert.ok(Math.abs(moved.dx - 0.02) < 1e-9);
  assert.ok(maskWeight(moved, 0.52, 0.5, 1, null) > 0.9);
  assert.ok(maskWeight(moved, 0.5, 0.5, 1, null) > 0.9 && maskWeight(moved, 0.5, 0.5, 1, null) <= 1);
});

test('limiting to a depth keeps the effect off other depths', () => {
  const [m] = resolveMasks([brush({ depth: 0.5, limit: true, tol: 0.1 })]);
  assert.ok(maskWeight(m, 0.5, 0.5, 1, 0.5) > 0.9);
  assert.equal(maskWeight(m, 0.5, 0.5, 1, 1.5), 0);
});

test('a circle is round on a wide picture', () => {
  const m = brush({ aspect: 2 });
  const [r] = resolveMasks([m]);
  // 0.05 of the long side to the right (0.05 across) and the same distance down (0.1 of the height)
  const side = maskWeight(r, 0.5 + 0.05, 0.5, 2, null);
  const down = maskWeight(r, 0.5, 0.5 + 0.1, 2, null);
  assert.ok(Math.abs(side - down) < 0.1, `${side} vs ${down}`);
});

test('saved files are sanitized and packing makes one channel per brush', () => {
  const [m] = parseMasks(JSON.stringify([{ ...brush(), strokes: [{ points: [[0.5, 0.5], 'x', [NaN, 1]], size: 'big' }, 'junk'] }]));
  assert.equal(m.strokes.length, 1);
  assert.equal(m.strokes[0].points.length, 1);
  const list = resolveMasks([brush(), brush(), brush(), brush(), brush()]);
  const packed = packMasks(list);
  assert.equal(packed.brush.data.length, 512 * 512 * 4);
  assert.equal(packed.kinds.filter((k) => k === 3).length, MAX_BRUSH_MASKS);
  assert.ok(packed.brush.data[(256 * 512 + 256) * 4] > 240);
  assert.equal(brushRaster(list[0]), brushRaster(list[1]));
});

test('noise reduction smooths noise but keeps an edge', async () => {
  const { applySpatial, hasSpatial } = await import('../app/js/core/local.js');
  const w = 24, h = 8;
  const rgb = new Float32Array(w * h * 3);
  let seed = 1;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) rgb[3 * (y * w + x) + c] = (x < 12 ? 0.1 : 0.6) + 0.02 * rnd();
  const m = { ...defaultMask('radial'), x: 0.5, y: 0.5, w: 2, h: 2, feather: 0, fx: { ...defaultMask('radial').fx, denoise: 0.8 } };
  assert.ok(hasSpatial([m]));
  const out = applySpatial(rgb, w, h, { masks: [m] });
  const spread = (a, x0, x1) => { let lo = 9, hi = -9; for (let y = 2; y < 6; y++) for (let x = x0; x < x1; x++) { lo = Math.min(lo, a[3 * (y * w + x)]); hi = Math.max(hi, a[3 * (y * w + x)]); } return hi - lo; };
  assert.ok(spread(out, 3, 9) < 0.5 * spread(rgb, 3, 9));
  assert.ok(out[3 * (4 * w + 15)] - out[3 * (4 * w + 8)] > 0.4);
});
