// The depth steps of a Light L16 photo's depth on the graphics card (gpu/l16cost.js, run as the worker runs it) give the processor's (core/l16depth.js depthCostStep) on a
// small made-up job: three modules with their poses and lens distortion, pictures with unmeasured (NaN) pixels and a bright patch whose differences are capped, depths
// near enough that the border pixels fall outside some modules' pictures. Skipped where Playwright or its browser is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gpuPage } from './helpers/gpupage.mjs';

test('the L16 depth steps on the graphics card match the processor’s', async (t) => {
  const page = await gpuPage(t);
  if (!page) return;
  const res = await page.evaluate(async () => {
    const gpu = await globalThis.makeGpu();
    if (!gpu) return null;
    const { depthCostStep } = await import('/js/core/l16depth.js');
    const { l16CostGpu } = await import('/js/gpu/l16cost.js');
    let s = 11;
    const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 8) / 16777216;
    const S = 4;
    const w = 48;
    const h = 36;
    const NZ = 8;
    // the reference: 220 px focal length, its center in the middle of its 192 x 144 sensor
    const K = [220, 0, 96, 0, 220, 72, 0, 0, 1];
    const texture = (pw, ph, phase) => {
      const g = new Float32Array(pw * ph);
      for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) g[y * pw + x] = 0.25 * Math.sin(0.37 * x + 0.21 * y + phase) + 0.15 * Math.cos(0.011 * x * y + phase) + 0.1 * (rnd() - 0.5);
      return g;
    };
    const refSample = texture(w, h, 0);
    for (let i = 0; i < 12; i++) refSample[Math.floor(rnd() * w * h)] = NaN;
    // (a small rotation about each axis, row-major)
    const rotation = (a, b, c) => {
      const [ca, sa, cb, sb, cc, sc] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b), Math.cos(c), Math.sin(c)];
      return [cb * cc, sa * sb * cc - ca * sc, ca * sb * cc + sa * sc, cb * sc, sa * sb * sc + ca * cc, ca * sb * sc - sa * cc, -sb, sa * cb, ca * cb];
    };
    const module = (T, angles, phase) => {
      const pw = 50;
      const ph = 38;
      const R = rotation(...angles);
      const g = texture(pw, ph, phase);
      for (let i = 0; i < 8; i++) g[Math.floor(rnd() * pw * ph)] = NaN;
      // (a bright patch: its differences reach the cap)
      for (let y = 10; y < 16; y++) for (let x = 20; x < 28; x++) g[y * pw + x] += 6;
      const m = { t0: T[0], t1: T[1], t2: T[2], f0: 230, c0: 100, f1: 228, c1: 76, dist: true, k1: 0.02, k2: -0.005, k3: 0.001, p1: 1e-4, p2: -2e-4, nx: 200, ny: 200, dcx: 101, dcy: 75, g, pw, ph };
      R.forEach((v, k) => (m[`r${k}`] = v));
      return m;
    };
    const mods = [module([40, 0, 0], [0.004, -0.006, 0.01], 0.7), module([0, -30, 0], [-0.008, 0.003, -0.005], 1.9), module([-25, 20, 2], [0.002, 0.009, 0.003], 3.1)];
    const job = { mods, refSample, w, h, S, K, invMin: 1 / 25000, invMax: 1 / 500, NZ };
    const cpu = [];
    for (let zi = 0; zi < NZ; zi++) cpu.push(depthCostStep(job, zi));
    const runner = l16CostGpu(gpu, job);
    const card = [];
    try {
      await runner.run(job, NZ, (zi, slice) => (card[zi] = slice));
    } finally {
      runner.close();
    }
    let worst = 0;
    let off = 0;
    let capped = 0;
    for (let zi = 0; zi < NZ; zi++) {
      for (let i = 0; i < w * h; i++) {
        const d = Math.abs(cpu[zi][i] - card[zi][i]);
        worst = Math.max(worst, d);
        if (d) off++;
        if (cpu[zi][i] === 255) capped++;
      }
    }
    // (a module without the polynomial distortion stays on the processor)
    const noPoly = l16CostGpu(gpu, { ...job, mods: [{ ...mods[0], dist: false }] });
    return { worst, off, n: NZ * w * h, capped, steps: card.filter(Boolean).length, noPoly, err: gpu.gl.getError() };
  });
  if (!res) return t.skip('No float render targets');
  assert.equal(res.err, 0);
  assert.equal(res.steps, 8);
  assert.equal(res.noPoly, null);
  // (the made-up job reaches the cap at the bright patch only)
  assert.ok(res.capped > 0 && res.capped < res.n / 10, `${res.capped} of ${res.n} costs at the cap`);
  // The card works the projection, the lens distortion and the lookup in single precision, the processor in double: a lookup can move by about 1e-4 of a pixel, which
  // changes a cost (0..255, rounded) by a few hundredths, so at a few pixels it rounds the other way. Never by more than 1.
  assert.ok(res.worst <= 1, `a cost differs from the processor's by ${res.worst}`);
  assert.ok(res.off <= res.n * 0.01, `${res.off} of ${res.n} costs differ from the processor's by 1`);
});
