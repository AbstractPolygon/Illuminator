// The semi-global smoothing of a Light L16 photo's depth on the graphics card (gpu/l16sgm.js) gives each pixel the processor's winner to the bit: its best step, that
// step's cost, the runner up and the costs either side, from the four directions' costs added up as core/l16depth.js depthFinish adds them (its scans are private there,
// so the test carries a copy of them, line for line). Small made-up volumes: an odd width and height (the two parities' textures), steps that are not a multiple of 4,
// a flat area of tied costs, a picture edge that lowers the penalty, and a volume of two bytes a step whose sums wrap past 65535 as the processor's Uint16Array does.
// Skipped where Playwright or its browser is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gpuPage } from './helpers/gpupage.mjs';

test('the L16 depth smoothing on the graphics card matches the processor’s to the bit', async (t) => {
  const page = await gpuPage(t);
  if (!page) return;
  const res = await page.evaluate(async () => {
    const gpu = await globalThis.makeGpu();
    if (!gpu) return null;
    const { l16SgmGpu } = await import('/js/gpu/l16sgm.js');
    const smooth = l16SgmGpu(gpu);
    let s = 9;
    const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 8) / 16777216;
    // depthFinish's smoothing and winners on the processor (options.p1 and options.p2 at their defaults, 2 and 14)
    const onProcessor = (cost, w, h, NZ, refG, P1) => {
      const gx = new Float32Array(w * h);
      const gy = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          gx[i] = Math.abs(refG[i] - refG[y * w + Math.min(w - 1, x + 1)]);
          gy[i] = Math.abs(refG[i] - refG[Math.min(h - 1, y + 1) * w + x]);
        }
      }
      const p2of = (grad) => Math.max(P1 + 2, 14 - Math.min(14, grad * 40));
      const total = new Uint16Array(w * h * NZ);
      const path = (startX, startY, dx, dy) => {
        const prev = new Uint16Array(NZ);
        const cur = new Uint16Array(NZ);
        const lines = dx !== 0 ? h : w;
        for (let line = 0; line < lines; line++) {
          let x = dx !== 0 ? startX : line;
          let y = dx !== 0 ? line : startY;
          let first = true;
          while (x >= 0 && x < w && y >= 0 && y < h) {
            const i = y * w + x;
            const base = i * NZ;
            if (first) {
              for (let k = 0; k < NZ; k++) cur[k] = cost[base + k];
              first = false;
            } else {
              let minPrev = 65535;
              for (let k = 0; k < NZ; k++) if (prev[k] < minPrev) minPrev = prev[k];
              const pi = (y - dy) * w + (x - dx);
              const grad = dx !== 0 ? (dx > 0 ? gx[pi] : gx[i]) : dy > 0 ? gy[pi] : gy[i];
              const P2 = p2of(grad);
              for (let k = 0; k < NZ; k++) {
                let best = prev[k];
                if (k > 0 && prev[k - 1] + P1 < best) best = prev[k - 1] + P1;
                if (k < NZ - 1 && prev[k + 1] + P1 < best) best = prev[k + 1] + P1;
                if (minPrev + P2 < best) best = minPrev + P2;
                cur[k] = cost[base + k] + best - minPrev;
              }
            }
            for (let k = 0; k < NZ; k++) {
              total[base + k] += cur[k];
              prev[k] = cur[k];
            }
            x += dx;
            y += dy;
          }
        }
      };
      path(0, 0, 1, 0);
      path(w - 1, 0, -1, 0);
      path(0, 0, 0, 1);
      path(0, h - 1, 0, -1);
      const win = new Uint32Array(4 * w * h);
      for (let i = 0; i < w * h; i++) {
        const base = i * NZ;
        let best = 0;
        let bc = 65535;
        let second = 65535;
        let a = 0;
        let c = 0;
        for (let k = 0; k < NZ; k++) {
          const v = total[base + k];
          if (v < bc) {
            bc = v;
            best = k;
          }
        }
        for (let k = 0; k < NZ; k++) if ((k < best - 1 || k > best + 1) && total[base + k] < second) second = total[base + k];
        if (best > 0) a = total[base + best - 1];
        if (best < NZ - 1) c = total[base + best + 1];
        win.set([best, bc, second, a | (c << 16)], 4 * i);
      }
      const floorP2 = (g) => Uint32Array.from(g, (v) => Math.floor(p2of(v)));
      return { win, edgeX: floorP2(gx), edgeY: floorP2(gy) };
    };
    const compare = (cost, w, h, NZ, refG, P1) => {
      const cpu = onProcessor(cost, w, h, NZ, refG, P1);
      let directions = 0;
      const card = smooth({ cost, w, h, NZ, P1, edgeX: cpu.edgeX, edgeY: cpu.edgeY, onDirection: () => directions++ });
      let differ = 0;
      let first = -1;
      for (let i = 0; i < cpu.win.length; i++) {
        if (cpu.win[i] !== card[i]) {
          differ++;
          if (first < 0) first = i;
        }
      }
      const at = (a, i) => Array.from(a.subarray(4 * (i >> 2), 4 * (i >> 2) + 4));
      const bests = new Set();
      for (let i = 0; i < w * h; i++) bests.add(cpu.win[4 * i]);
      return { differ, directions, bests: bests.size, cpuAt: first < 0 ? null : at(cpu.win, first), cardAt: first < 0 ? null : at(card, first), pixel: first >> 2 };
    };
    // one byte a step: a valley at a different step in each part of the picture, noise, a flat area of tied costs and a picture with an edge down the middle
    const w = 21;
    const h = 13;
    const NZ = 10;
    const cost8 = new Uint8Array(w * h * NZ);
    const refG = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        refG[i] = (x < 11 ? -1 : 1.2) + 0.05 * rnd();
        const v = x < 11 ? 2 + (y % 3) : 7;
        for (let k = 0; k < NZ; k++) cost8[i * NZ + k] = Math.min(255, Math.round(6 * Math.abs(k - v) + 25 * rnd()));
        if (x >= 15 && y >= 8) cost8.fill(30, i * NZ, (i + 1) * NZ);
      }
    }
    const bytes = compare(cost8, w, h, NZ, refG, 2);
    // two bytes a step, large enough that the added directions wrap past 65535 (and so may the scans)
    const w2 = 9;
    const h2 = 7;
    const NZ2 = 7;
    const cost16 = new Uint16Array(w2 * h2 * NZ2);
    for (let i = 0; i < cost16.length; i++) cost16[i] = 16000 + Math.floor(rnd() * 3000);
    const ref2 = Float32Array.from({ length: w2 * h2 }, () => rnd());
    const shorts = compare(cost16, w2, h2, NZ2, ref2, 3);
    return { bytes, shorts, err: gpu.gl.getError() };
  });
  if (!res) return t.skip('No float render targets');
  assert.equal(res.err, 0);
  for (const [name, r] of Object.entries(res)) {
    if (name === 'err') continue;
    assert.equal(r.directions, 4);
    // (the made-up volume is not one where every pixel wins at the same step)
    assert.ok(r.bests > 2, `${name}: only ${r.bests} different winning steps`);
    // The card works the same integer steps (module header: "the same to the bit"), so nothing may differ.
    assert.equal(r.differ, 0, `${name}: ${r.differ} numbers differ, first at pixel ${r.pixel}: processor ${r.cpuAt}, card ${r.cardAt}`);
  }
});
