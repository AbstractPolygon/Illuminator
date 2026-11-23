import test from 'node:test';
import assert from 'node:assert/strict';
import { synthesize, fillFromBackground, depthAtSize } from '../app/js/core/l16view.js';

// a w x h picture whose red channel counts the columns, so a shift can be read off
function ramp(w, h, zOf) {
  const rgb = new Float32Array(3 * w * h);
  const z = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    rgb[3 * i] = x / 1000;
    rgb[3 * i + 1] = 0.5;
    rgb[3 * i + 2] = 0.5;
    z[i] = zOf(x, y);
  }
  return { rgb, width: w, height: h, z };
}

test('l16 view: no move leaves the picture as it is, with no holes', () => {
  const src = ramp(20, 6, () => 1000);
  const v = synthesize(src, 500, 0, 0, 0);
  assert.equal(v.hole.reduce((a, b) => a + b, 0), 0);
  assert.deepEqual(Array.from(v.rgb), Array.from(src.rgb));
});

test('l16 view: a flat surface moves by f * t / Z pixels, the other way from the camera, and leaves a hole at the edge it uncovers', () => {
  const src = ramp(40, 4, () => 1000); // f * t / Z = 500 * 10 / 1000 = 5 pixels
  const v = synthesize(src, 500, 10, 0, 0);
  // a camera moved to +x sees the scene shift to -x: pixel x lands at x - 5
  const col = (x) => Math.round(v.rgb[3 * (1 * 40 + x)] * 1000);
  assert.equal(col(10), 15);
  assert.equal(col(30), 35);
  // the right edge is uncovered: the last 5 columns (35 to 39) are holes
  assert.equal(v.hole[1 * 40 + 39], 1);
  assert.equal(v.hole[1 * 40 + 35], 1);
  assert.equal(v.hole[1 * 40 + 34], 0);
  assert.equal(v.hole[1 * 40 + 20], 0);
});

test('l16 view: the pivot depth stays put, near things move one way and far things the other', () => {
  const src = ramp(60, 4, (x) => (x < 30 ? 500 : 2000)); // near on the left half, far on the right
  const v = synthesize(src, 500, 10, 0, 1000);
  const where = (value) => {
    for (let x = 0; x < 60; x++) if (Math.round(v.rgb[3 * (1 * 60 + x)] * 1000) === value && !v.hole[1 * 60 + x]) return x;
    return -1;
  };
  // near (500 mm): shift -f t (1/500 - 1/1000) = -5 ; far (2000 mm): -f t (1/2000 - 1/1000) = +2.5
  assert.equal(where(10), 5);
  assert.equal(where(50), 52); // 50 + 2.5 rounds to 52 or 53 depending on the footprint; both are within one pixel
});

test('l16 view: a nearer surface covers a farther one where they land on the same pixel', () => {
  const w = 30;
  const src = ramp(w, 3, (x) => (x >= 12 && x < 18 ? 500 : 2000)); // a near strip in front of a far wall
  const v = synthesize(src, 500, 10, 0, 0);
  // the strip (red 12..17) is in the output and not overwritten by the wall pixels that land beside it
  const reds = new Set();
  for (let x = 0; x < w; x++) if (!v.hole[w + x]) reds.add(Math.round(v.rgb[3 * (w + x)] * 1000));
  for (let r = 12; r < 18; r++) assert.ok(reds.has(r), `strip pixel ${r} is visible`);
});

test('l16 view: holes fill from the far side, not the near one', () => {
  const w = 12;
  const rgb = new Float32Array(3 * w);
  const z = new Float32Array(w).fill(Infinity);
  const hole = new Uint8Array(w).fill(1);
  // near (red 1.0) at x = 2, far (red 0.2) at x = 9, a hole between
  for (const [x, r, depth] of [[2, 1, 500], [9, 0.2, 5000]]) {
    rgb[3 * x] = r;
    z[x] = depth;
    hole[x] = 0;
  }
  const view = fillFromBackground({ rgb, z, hole }, w, 1);
  assert.ok(view.hole.every((h) => h === 0));
  // the pixel next to the near one takes the near color only when it has no choice; pixels on the far side of the gap take the far color
  assert.ok(Math.abs(view.rgb[3 * 8] - 0.2) < 1e-6);
  assert.ok(Math.abs(view.rgb[3 * 1] - 1) < 1e-6);
});

test('l16 view: depth resampling keeps a constant depth and goes through the middle of two', () => {
  const inv = new Float32Array([0.001, 0.001, 0.001, 0.001]);
  assert.ok(depthAtSize(inv, 2, 2, 6, 6).every((z) => Math.abs(z - 1000) < 1e-2));
  const ramp2 = new Float32Array([0.001, 0.002, 0.001, 0.002]);
  const out = depthAtSize(ramp2, 2, 2, 5, 1);
  assert.ok(out[2] > 600 && out[2] < 700);
});
