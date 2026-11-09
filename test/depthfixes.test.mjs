// Regression tests for edge handling and state leaks in the depth measure (core/depth.js) and the super-resolution masks (core/superres.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreStep, lytroCostPrepare, lytroCost, searchPlanner, finishDepth, smoothDepth, setDepthStyle, DEPTH_LCOST, DEPTH_CBCA, DEPTH_TRWS, DEPTH_SEARCH, DEPTH_EDGE, DEPTH_DIRECT, DEPTH_COARSE } from '../app/js/core/depth.js';
import { depthEdgeMask, edgeArtifactDepth } from '../app/js/core/superres.js';

const rng = (seed) => {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
};
const grid3 = (make) => {
  const views = [];
  for (const v of [-1, 0, 1]) for (const u of [-1, 0, 1]) views.push(make(u, v));
  return views;
};

test('scoreStep: the last column and row are scored like the rest (no empty half aperture winning)', () => {
  const w = 16, h = 16, n = w * h;
  const r = rng(1);
  const base = new Float32Array(n).map(() => r());
  const views = grid3((u, v) => ({ u, v, detail: 1 }));
  const level = new Float32Array(n).fill(0.5);
  const sc = scoreStep({ lums: views.map(() => base), views, w, h, alpha: 0.7, minLevel: 0.01, level, occl: true, guide: level, win: 0, guided: false });
  for (let i = 0; i < w; i++) {
    assert.ok(sc[(h - 1) * w + i] < 0, `last row, x=${i}: ${sc[(h - 1) * w + i]}`);
    assert.ok(sc[i * w + w - 1] < 0, `last column, y=${i}: ${sc[i * w + w - 1]}`);
  }
});

test('lytroCost: identical views at alpha 0 match perfectly up to the last column and row', () => {
  const w = 8, h = 8, n = w * h;
  const r = rng(3);
  const img = new Float32Array(n * 3).map(() => r());
  const views = grid3((u, v) => ({ u, v, detail: 1, gain: 1, rgb: img }));
  const c = lytroCost(lytroCostPrepare(views, w, h), views, w, h, 0, { tc: 0.2, tg: 0.06, weight: 1 });
  assert.ok(c.every((v) => v === 0), Array.from(c).join(' '));
});

test('depthEdgeMask softens with a plain 3 x 3 mean', () => {
  const w = 21, h = 21;
  const d = new Float32Array(w * h).map((_, i) => (i % w >= 10 ? 5 : 0));
  const m = depthEdgeMask(d, w, h, { step: 0.3, radius: 1 });
  const row = Array.from(m.slice(10 * w + 7, 10 * w + 14));
  const want = [1 / 3, 2 / 3, 1, 2 / 3, 1 / 3, 0, 0];
  row.forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 1e-6, `${row.join(' ')}`));
  // at the border the mean divides by the pixels that exist: an edge in the first column stays fully marked
  const e = new Float32Array(9).fill(0);
  e[1] = e[4] = e[7] = 5;
  const b = depthEdgeMask(e, 3, 3, { step: 0.3, radius: 1 });
  assert.ok(b[3] > 0.99, `border ${Array.from(b).join(' ')}`);
});

test('edgeArtifactDepth: a step between base pixels 4 and 5 lands between output pixels 14 and 15 at scale 3', () => {
  const bw = 10, bh = 3;
  const depth = new Float32Array(bw * bh).map((_, i) => (i % bw >= 5 ? 1 : 0));
  const D = edgeArtifactDepth(depth, bw, bh, 30, 9, 3, 1);
  const row = Array.from(D.slice(4 * 30, 5 * 30));
  const jump = row.findIndex((v, i) => i > 0 && v !== row[i - 1]);
  assert.equal(jump, 15);
});

test('setDepthStyle: classic restores every tuning value the match style wrote', () => {
  const snap = () => JSON.stringify([DEPTH_LCOST, DEPTH_CBCA, DEPTH_TRWS, DEPTH_SEARCH, DEPTH_EDGE, DEPTH_DIRECT, DEPTH_COARSE]);
  setDepthStyle('classic');
  const classic = snap();
  setDepthStyle('match');
  assert.notEqual(snap(), classic);
  setDepthStyle('classic');
  assert.equal(snap(), classic);
  assert.equal(DEPTH_LCOST.tc, 0.12);
  assert.equal(DEPTH_CBCA.arm, 24);
});

test('finishDepth does not change the measured depth it is given, and smoothDepth always returns a new array', () => {
  setDepthStyle('classic');
  const w = 12, h = 12, n = w * h;
  const alpha = new Float32Array(n).map((_, i) => (i % w) * 0.01);
  const before = Float32Array.from(alpha);
  const color = new Float32Array(n * 3).fill(0.5);
  const out = finishDepth({ alpha, cost: new Float32Array(n).fill(0.5), meanCost: new Float32Array(n).fill(1) }, w, h, new Float32Array(n * 3).fill(0.5), { color, refine: true });
  assert.deepEqual(alpha, before);
  assert.notEqual(out.alpha, alpha);
  const a = new Float32Array(4);
  assert.notEqual(smoothDepth(a, 2, 2, new Float32Array(12), { amount: 0 }), a);
});

test('searchPlanner: flat pixels (all scores 0) do not spoil the range the textured ones show', () => {
  const n = 200, steps = 33;
  const planner = searchPlanner(steps, n);
  const scores = new Array(steps);
  for (const k of planner.first()) {
    scores[k] = new Float32Array(n);
    // a quarter of the pixels has its best match at step 16 only; the rest is black and flat (so the median cost is 0)
    for (let i = 150; i < n; i++) scores[k][i] = k === 16 ? 0 : -1;
  }
  const added = planner.next(scores);
  assert.ok(added.length < 24, `${added.length} extra steps`);
});
