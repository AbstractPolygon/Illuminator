// A viewpoint past the lens edge on the CPU (core/viewextend.js; the GPU's EXTEND matches it, and the whole path was checked on a real photo: a view rendered at half the
// opening and moved on to the edge is about twice as close to the real edge view as the half view itself). Here, on a synthetic scene of known depth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withExtension, reachProfile, reachToward, uncoveredMask, depthRange } from '../app/js/core/viewextend.js';

// A scene: a background with a gradient at depth 0 and a square nearer, at depth -1 (near is the smaller depth), seen from viewpoint u (k = 1 pixel per unit of depth per unit of u).
function scene(w, h, u, k = 1) {
  const rgb = new Float32Array(w * h * 3);
  const depth = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      rgb[i * 3] = x / w;
      rgb[i * 3 + 1] = y / h;
      // the square, in the center view's coordinates 20..30, shows moved by its depth times u
      const sx = x + 1 * k * u;
      const inSquare = sx >= 20 && sx < 30 && y >= 20 && y < 30;
      rgb[i * 3 + 2] = inSquare ? 1 : 0;
      // (the depth map is the center view's)
      depth[i] = x >= 20 && x < 30 && y >= 20 && y < 30 ? -1 : 0;
    }
  }
  return { rgb, depth };
}

test('a view moved on by the depth puts a near object where a real view farther out would', () => {
  const w = 50;
  const h = 50;
  const edge = scene(w, h, 3);
  const far = scene(w, h, 8);
  const out = withExtension(edge.rgb, w, h, edge.depth, w, h, [3, 0], [8, 0], 0, 1);
  // (the square: 20..30 in the center view, 17..27 from viewpoint 3, 12..22 from 8)
  // The square's blue: where the real view at 8 has it.
  let wrong = 0;
  for (let i = 0; i < w * h; i++) if (Math.abs(out[i * 3 + 2] - far.rgb[i * 3 + 2]) > 0.5) wrong++;
  // (the edge pixels of the uncovered strip may differ by one column)
  assert.ok(wrong <= 20, `pixels with the square wrong: ${wrong}`);
  // The background (depth 0) stays put.
  assert.ok(Math.abs(out[(5 * w + 5) * 3] - 5 / w) < 1e-6);
});

test('the reference depth stays still, and no move past the edge changes nothing', () => {
  const w = 40;
  const h = 40;
  const s = scene(w, h, 2);
  const same = withExtension(s.rgb, w, h, s.depth, w, h, [2, 0], [2, 0], 0, 1);
  // (the same picture, but for the strip the square uncovers in this view next to its border: the depth map is the center view's, so there the background beside it is
  // stretched one or two pixels)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const border = y >= 20 && y < 30 && x >= 26 && x < 30;
      if (!border) assert.ok(Math.abs(same[i] - s.rgb[i]) < 1e-6 && Math.abs(same[i + 2] - s.rgb[i + 2]) < 1e-6, `${x},${y}`);
    }
  }
  // With the square's depth as the reference, the square stays still: it is taken from the edge picture at its center-view place (20..30), and the background moves.
  const out = withExtension(s.rgb, w, h, s.depth, w, h, [2, 0], [6, 0], -1, 1);
  for (const x of [20, 24, 27]) assert.equal(out[(25 * w + x) * 3 + 2], 1, `square still at ${x}`);
  // The background (depth 0, one unit farther than the reference) comes from 4 pixels to the left: red x / w.
  assert.ok(Math.abs(out[(5 * w + 10) * 3] - 6 / w) < 1e-6);
});

test('reach: as far as the lens images stay bright enough in each direction, less a margin, never short of the aperture radius', () => {
  const bins = 17;
  const rMax = 7;
  const gain = new Float32Array(bins * bins * 3);
  // Bright (half as bright as the center, gain 2) out to radius 5 to the right, 3 elsewhere; dark (gain 0) beyond.
  for (let bv = 0; bv < bins; bv++) {
    for (let bu = 0; bu < bins; bu++) {
      const x = ((bu + 0.5) / bins) * 2 * rMax - rMax;
      const y = ((bv + 0.5) / bins) * 2 * rMax - rMax;
      const lim = x > 0 && Math.abs(y) < 1 ? 5 : 3;
      for (let c = 0; c < 3; c++) gain[(bv * bins + bu) * 3 + c] = Math.hypot(x, y) < lim ? 2 : 0;
    }
  }
  const p = reachProfile({ bins, rMax, gain }, 2, 0);
  const right = reachToward(p, 1, 0);
  const up = reachToward(p, 0, 1);
  assert.ok(right > 4 && right < 5, `right ${right}`);
  assert.ok(up > 2 && up < 3, `up ${up}`);
  // A dimmer lens edge than the level counts as too dark; the floor is the base radius.
  const dim = reachProfile({ bins, rMax, gain: gain.map((g) => (g ? 4 : 0)) }, 2, 0);
  assert.equal(reachToward(dim, 1, 0), 2);
});

test('the uncovered mask: background no view saw beside a near object, and the scene brought in at the border', () => {
  const w = 50;
  const h = 50;
  const edge = scene(w, h, 3);
  const mask = uncoveredMask(w, h, edge.depth, w, h, [3, 0], [8, 0], 0, 1, depthRange(edge.depth));
  // The square goes from 17..27 (viewpoint 3) to 12..22 (viewpoint 8): 22..27 on its rows was behind it in every view.
  const row = (y) => Array.from({ length: w }, (_, x) => mask[y * w + x]);
  const r = row(25);
  for (let x = 23; x < 27; x++) assert.equal(r[x], 1, `uncovered at ${x}`);
  for (const x of [5, 15, 35, 45]) assert.equal(r[x], 0, `seen at ${x}`);
  // Away from the square nothing is uncovered (the background does not move: its depth is the reference).
  assert.equal(row(5).reduce((a, b) => a + b, 0), 0);
  // Moving the background (reference at the square's depth): the far side of the picture brings in what was outside it.
  const moved = uncoveredMask(w, h, edge.depth, w, h, [3, 0], [8, 0], -1, 1, depthRange(edge.depth));
  assert.equal(moved[5 * w + 0], 1, 'left border brought in');
  assert.equal(moved[5 * w + 25], 0);
});
