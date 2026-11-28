// The last steps of a Light L16 photo's depth on the graphics card (gpu/l16depthfinish.js: the filling of unsure pixels, the border band and the 3 x 3 median) give
// the processor's (core/l16depth.js depthCleanup: fillUnsure, then the border and the median, which are private there, so the test carries a copy of them, line for
// line). A small made-up depth: steps, a slope and noise, scattered unsure pixels, an unsure area wider than the filling reaches (it keeps its depth), a confidence
// right at the threshold, and flat areas where the medians tie. Skipped where Playwright or its browser is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gpuPage } from './helpers/gpupage.mjs';

test('the L16 depth finish on the graphics card matches the processor’s', async (t) => {
  const page = await gpuPage(t);
  if (!page) return;
  const res = await page.evaluate(async () => {
    const gpu = await globalThis.makeGpu();
    if (!gpu) return null;
    const { fillUnsure } = await import('/js/core/l16depth.js');
    const { l16DepthFinishGpu } = await import('/js/gpu/l16depthfinish.js');
    const finish = l16DepthFinishGpu(gpu);
    let s = 21;
    const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 8) / 16777216;
    // depthCleanup after the specks, on the processor
    const onProcessor = (invZ, confidence, w, h, radius, threshold, BORDER) => {
      fillUnsure(invZ, confidence, w, h, radius, threshold);
      const filled = new Float32Array(invZ);
      const around = [];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (x >= BORDER && x < w - BORDER && y >= BORDER && y < h - BORDER) continue;
          const ix = Math.min(w - 1 - BORDER, Math.max(BORDER, x));
          const iy = Math.min(h - 1 - BORDER, Math.max(BORDER, y));
          around.length = 0;
          for (let dy = -6; dy <= 6; dy += 2) {
            for (let dx = -6; dx <= 6; dx += 2) {
              const sx = Math.min(w - 1 - BORDER, Math.max(BORDER, ix + dx));
              const sy = Math.min(h - 1 - BORDER, Math.max(BORDER, iy + dy));
              around.push(invZ[sy * w + sx]);
            }
          }
          around.sort((a, b) => a - b);
          filled[y * w + x] = around[around.length >> 1];
          confidence[y * w + x] = 0;
        }
      }
      invZ.set(filled);
      const median = new Float32Array(w * h);
      const win = new Float32Array(9);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let n = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) win[n++] = invZ[Math.min(h - 1, Math.max(0, y + dy)) * w + Math.min(w - 1, Math.max(0, x + dx))];
          win.sort();
          median[y * w + x] = win[4];
        }
      }
      invZ.set(median);
    };
    // depthCleanup's numbers for a depth of scale 4 (radius 10, border 12) and of scale 8 (radius 5, border 6), its threshold 0.05
    const invMin = 1 / 25000;
    const invMax = 1 / 500;
    const cases = [];
    for (const [w, h, S] of [[57, 43, 4], [40, 31, 8]]) {
      const radius = Math.max(3, Math.round(40 / S));
      const border = Math.max(4, Math.round(48 / S));
      const threshold = 0.05;
      const invZ = new Float32Array(w * h);
      const confidence = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          // (flat steps on the left, a slope with noise on the right)
          const step = x < w / 3 ? (y < h / 2 ? 0.2 : 0.6) : (0.3 + 0.5 * (x / w) + 0.2 * (y / h) + 0.05 * (rnd() - 0.5));
          invZ[i] = invMin + (invMax - invMin) * Math.min(1, Math.max(0, step));
          confidence[i] = rnd() < 0.3 ? 0.04 * rnd() : 0.05 + 0.9 * rnd();
          // (an unsure area wider than the filling reaches)
          if (x >= w - 2 * radius - 4 && y < 2 * radius + 4) confidence[i] = 0.01;
        }
      }
      // (a confidence right at the threshold, as single precision has it, and one just under)
      confidence[Math.floor(h / 2) * w + Math.floor(w / 2)] = Math.fround(threshold);
      confidence[Math.floor(h / 2) * w + Math.floor(w / 2) + 1] = 0.049999997;
      const cpuZ = Float32Array.from(invZ);
      const cpuC = Float32Array.from(confidence);
      onProcessor(cpuZ, cpuC, w, h, radius, threshold, border);
      const cardZ = Float32Array.from(invZ);
      const cardC = Float32Array.from(confidence);
      finish(cardZ, cardC, w, h, radius, threshold, border);
      let worst = 0;
      let confidenceDiffers = 0;
      let unfilled = 0;
      for (let i = 0; i < w * h; i++) {
        worst = Math.max(worst, Math.abs(cpuZ[i] - cardZ[i]));
        if (cpuC[i] !== cardC[i]) confidenceDiffers++;
      }
      // (the unsure area's far corner kept its depth on the processor: no sure pixel within reach before the border and the median)
      const kept = Float32Array.from(invZ);
      fillUnsure(kept, Float32Array.from(confidence), w, h, radius, threshold);
      const corner = border * w + (w - 1 - border);
      if (kept[corner] === invZ[corner]) unfilled++;
      cases.push({ w, h, S, worst: worst / (invMax - invMin), confidenceDiffers, unfilled });
    }
    return { cases, err: gpu.gl.getError() };
  });
  if (!res) return t.skip('No float render targets');
  assert.equal(res.err, 0);
  for (const c of res.cases) {
    assert.equal(c.unfilled, 1, `scale ${c.S}: the wide unsure area was filled, so the case where the filling finds nothing is not tested`);
    assert.equal(c.confidenceDiffers, 0, `scale ${c.S}: ${c.confidenceDiffers} confidences differ`);
    // The card adds up the window's sums in single precision (the processor in double): a filled depth is off by about 1e-7 of itself, which is under 1e-6 of the
    // depth range; the border and the medians only pick values, so they add nothing.
    assert.ok(c.worst < 1e-6, `scale ${c.S}: the card differs from the processor by up to ${c.worst} of the depth range`);
  }
});
