import test from 'node:test';
import assert from 'node:assert/strict';
import { fillNonFinite, smoothDepth } from '../app/js/core/depth.js';

test('depth with no bad values is returned as it is', () => {
  const a = Float32Array.from([0.1, 0.2, 0.3, 0.4]);
  assert.equal(fillNonFinite(a, 2, 2), a);
});

test('NaN and infinite depth values are filled from their neighbors', () => {
  const w = 5;
  const h = 4;
  const a = new Float32Array(w * h).fill(0.5);
  a[7] = NaN;
  a[8] = Infinity;
  a[12] = -Infinity;
  const out = fillNonFinite(a, w, h);
  assert.notEqual(out, a);
  for (const v of out) assert.ok(Number.isFinite(v));
  assert.ok(Math.abs(out[7] - 0.5) < 1e-6 && Math.abs(out[8] - 0.5) < 1e-6 && Math.abs(out[12] - 0.5) < 1e-6);
  assert.ok(Number.isNaN(a[7]), 'the input is left as it was');
});

test('a gap is filled from its edges inward, a slope stays a slope', () => {
  const w = 9;
  const h = 1;
  const a = Float32Array.from({ length: w }, (_, i) => i / 8);
  for (let i = 3; i <= 5; i++) a[i] = NaN;
  const out = fillNonFinite(a, w, h);
  assert.ok(out[3] > out[2] - 1e-6 && out[5] < out[6] + 1e-6, `${out}`);
});

test('all bad: zeros', () => {
  assert.deepEqual([...fillNonFinite(Float32Array.from([NaN, NaN, NaN]), 3, 1)], [0, 0, 0]);
});

test('why it matters: one NaN, smoothed, becomes a square of NaN; filled first, it does not', () => {
  const w = 21;
  const h = 21;
  const a = new Float32Array(w * h).fill(0.2);
  a[10 * w + 10] = NaN;
  const guide = new Float32Array(w * h * 3).fill(0.3);
  const spread = smoothDepth(a, w, h, guide, { amount: 0.3 });
  const nan = spread.filter((v) => Number.isNaN(v)).length;
  assert.ok(nan >= 25, `one NaN spread to ${nan} pixels`);
  const clean = smoothDepth(fillNonFinite(a, w, h), w, h, guide, { amount: 0.3 });
  assert.equal(clean.filter((v) => !Number.isFinite(v)).length, 0);
});

test('depth statistics for the speed report count values that are not numbers and spikes', async () => {
  const { depthStats } = await import('../app/js/core/depth.js');
  const w = 10;
  const h = 8;
  const a = new Float32Array(w * h).fill(0.1);
  a[3 * w + 4] = 0.9; // a spike
  a[5 * w + 6] = NaN;
  const s = depthStats(a, w, h);
  assert.equal(s.pixels, 80);
  assert.equal(s.nonFinite, 1);
  assert.equal(s.spikes, 1);
  assert.ok(Math.abs(s.min - 0.1) < 1e-6 && Math.abs(s.max - 0.9) < 1e-6);
});

test('the speed report lists the depth map stages', async () => {
  const { reportText } = await import('../app/js/core/speedreport.js');
  const text = reportText({ version: '0.7.5', facts: { renderer: 'GPU (test)', hardware: true, depth: { style: 'match', quality: 'normal', smoothing: 'graphics card', stages: [{ stage: 'measured', pixels: 100, nonFinite: 2, min: -0.5, max: 0.7, spikes: 3 }] } } });
  assert.match(text, /Depth map \(match, normal quality, smoothed on the graphics card\):/);
  assert.match(text, /measured: 100 pixels, 2 not numbers, range -0\.500 to 0\.700, 3 spikes/);
});
