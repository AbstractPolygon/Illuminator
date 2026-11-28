// The map of places a moved viewpoint uncovers (core/viewextend.js uncoveredMask) on the graphics card (gpu/uncovered.js, through setUncoveredGpu) gives the processor's map:
// a made-up depth with a near box, a slope and noise, the depth map the picture's size and half of it, moved along each axis, on a slant and past the picture's edge.
// Skipped where Playwright or its browser is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gpuPage } from './helpers/gpupage.mjs';

test('the uncovered places on the graphics card match the processor’s', async (t) => {
  const page = await gpuPage(t);
  if (!page) return;
  const res = await page.evaluate(async () => {
    const gpu = await globalThis.makeGpu();
    if (!gpu) return null;
    const { uncoveredMask, setUncoveredGpu } = await import('/js/core/viewextend.js');
    const { uncoveredGpu } = await import('/js/gpu/uncovered.js');
    let s = 11;
    const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 8) / 16777216;
    // a depth map (near is smaller): a far wall with a little noise, a slope on the left, a near box and a nearer post
    const makeDepth = (dw, dh) => {
      const d = new Float32Array(dw * dh);
      for (let y = 0; y < dh; y++) {
        for (let x = 0; x < dw; x++) {
          let v = 1 + 0.02 * rnd();
          if (x < dw * 0.25) v = 0.4 + (0.6 * x) / (dw * 0.25);
          if (x > dw * 0.45 && x < dw * 0.7 && y > dh * 0.3 && y < dh * 0.65) v = 0.1 + 0.01 * rnd();
          if (x > dw * 0.8 && x < dw * 0.85 && y > dh * 0.1) v = -0.2;
          d[y * dw + x] = v;
        }
      }
      return d;
    };
    const W = 120;
    const H = 90;
    const cases = [
      { name: 'full size, to the right', dw: W, dh: H, edge: [0.5, 0], total: [1.2, 0], ref: 0.5, detail: 6 },
      { name: 'full size, up and left', dw: W, dh: H, edge: [-0.3, -0.4], total: [-0.8, -1.1], ref: 0.2, detail: 5 },
      { name: 'half size depth, down', dw: W / 2, dh: H / 2, edge: [0, 0.5], total: [0, 1.4], ref: 0.8, detail: 4 },
      { name: 'half size depth, far past the edge', dw: W / 2, dh: H / 2, edge: [0.6, 0.6], total: [3, 2.5], ref: 0, detail: 5 },
    ];
    const onCard = uncoveredGpu(gpu);
    // (uncoveredMask falls back to the processor when the card throws: count the card's runs and keep its error, so a fallback cannot pass for a match)
    let runs = 0;
    let failed = null;
    const card = (job) => {
      try {
        const m = onCard(job);
        runs++;
        return m;
      } catch (e) {
        failed = String(e && e.message);
        throw e;
      }
    };
    const out = [];
    for (const c of cases) {
      const depth = makeDepth(c.dw, c.dh);
      setUncoveredGpu(null);
      const cpu = uncoveredMask(W, H, depth, c.dw, c.dh, c.edge, c.total, c.ref, c.detail);
      setUncoveredGpu(card);
      const gpuMask = uncoveredMask(W, H, depth, c.dw, c.dh, c.edge, c.total, c.ref, c.detail);
      setUncoveredGpu(null);
      let differ = 0;
      let set = 0;
      for (let i = 0; i < W * H; i++) {
        if (cpu[i] !== gpuMask[i]) differ++;
        set += cpu[i];
      }
      out.push({ name: c.name, differ, set, runs, failed, err: gpu.gl.getError() });
      runs = 0;
    }
    return { W, H, out };
  });
  if (!res) return t.skip('No float render targets');
  for (const c of res.out) {
    assert.equal(c.err, 0, c.name);
    assert.equal(c.failed, null, `${c.name}: the card failed`);
    assert.equal(c.runs, 1, `${c.name}: the card did not make the map`);
    // (the map is not empty nor all set, so the comparison means something)
    assert.ok(c.set > 20 && c.set < res.W * res.H - 20, `${c.name}: ${c.set} uncovered pixels`);
    // The card works the same search in single precision (the processor in double): a pixel whose surface crossing or jump test sits on a step's boundary can come out
    // the other way. None did on these inputs on SwiftShader; a few such pixels (one in 2000) are allowed for other drivers.
    assert.ok(c.differ <= (res.W * res.H) / 2000, `${c.name}: ${c.differ} of ${res.W * res.H} pixels differ from the processor’s map`);
  }
  console.log(JSON.stringify(res.out));
});
