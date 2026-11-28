// Classic Depth's smoothing along eight directions and each pixel's least plane on the graphics card (gpu/l16classicsgm.js) give the processor's (core/l16classic.js
// runLayer), on a tiny made-up L16 photo (helpers/l16photo.mjs) through all five layers: once with the costs made on the processor and sent, once with the costs made
// and kept on the card (gpu/l16classic.js costsTex, read in both orders there). The app smooths on the card only on a real graphics card (SwiftShader runs its thousands
// of small steps slowly), so the photo is kept small. Skipped where Playwright or its browser is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gpuPage } from './helpers/gpupage.mjs';
import { makeL16Photo } from './helpers/l16photo.mjs';

const photo = makeL16Photo();

test('Classic Depth smoothing on the graphics card matches the processor’s', async (t) => {
  const page = await gpuPage(t);
  if (!page) return;
  const res = await page.evaluate(async ({ bytes, parsed }) => {
    const gpu = await globalThis.makeGpu();
    if (!gpu) return null;
    const gl = gpu.gl;
    const core = await import('/js/core/l16classic.js');
    const { l16ClassicGpu } = await import('/js/gpu/l16classic.js');
    const { l16ClassicSgmGpu } = await import('/js/gpu/l16classicsgm.js');
    const data = Uint8Array.from(bytes);
    const run = (onProgress = () => {}) => core.classicDepth(data, JSON.parse(JSON.stringify(parsed)), { ref: 'A1', modules: ['A2', 'A3'] }, onProgress);
    const rangesOf = (a) => ({ start: Array.from(a.start), count: Array.from(a.count) });
    // The processor's, all of it. Each layer's search ranges are kept by a smoothing hook that then fails, so the processor smooths (the failure turns the hook off;
    // the progress calls of the next layer's costs turn it back on).
    const cpuLayers = [];
    const keep = (a) => {
      cpuLayers.push(rangesOf(a));
      throw new Error('kept (the test)');
    };
    core.setL16ClassicGpu(null);
    core.setL16ClassicSmoothGpu(keep);
    const warn = console.warn;
    console.warn = () => {};
    let cpu;
    try {
      cpu = run(() => core.setL16ClassicSmoothGpu(keep));
    } finally {
      console.warn = warn;
      core.setL16ClassicSmoothGpu(null);
    }
    const smooth = l16ClassicSgmGpu(gpu);
    const card = l16ClassicGpu(gpu);
    const compare = (onCard, layers, ms) => {
      let depthDiff = 0;
      let confDiff = 0;
      for (let i = 0; i < cpu.invZ.length; i++) {
        if (cpu.invZ[i] !== onCard.invZ[i]) depthDiff++;
        if (cpu.confidence[i] !== onCard.confidence[i]) confDiff++;
      }
      const sameRanges = layers.map((g, i) => !!cpuLayers[i] && g.start.every((v, k) => v === cpuLayers[i].start[k]) && g.count.every((v, k) => v === cpuLayers[i].count[k]));
      return { depthDiff, confDiff, sameRanges, layers: layers.length, fromCard: layers.map((g) => g.fromCard), ms };
    };
    // The card's smoothing on the processor's costs (sent to the card each layer).
    const sentLayers = [];
    core.setL16ClassicSmoothGpu((a) => {
      sentLayers.push({ ...rangesOf(a), fromCard: !!a.rawTex });
      return smooth(a);
    });
    let sent;
    let t0 = performance.now();
    try {
      sent = run();
    } finally {
      core.setL16ClassicSmoothGpu(null);
    }
    const sentRes = compare(sent, sentLayers, performance.now() - t0);
    // The card's smoothing on the card's costs, left there (the pictures made on the processor: no views here).
    const keptLayers = [];
    core.setL16ClassicGpu({ open: (a) => card.open(a) });
    core.setL16ClassicSmoothGpu((a) => {
      keptLayers.push({ ...rangesOf(a), fromCard: !!a.rawTex });
      return smooth(a);
    });
    let kept;
    t0 = performance.now();
    try {
      kept = run();
    } finally {
      core.setL16ClassicGpu(null);
      core.setL16ClassicSmoothGpu(null);
    }
    const keptRes = compare(kept, keptLayers, performance.now() - t0);
    let confident = 0;
    for (let i = 0; i < cpu.confidence.length; i++) if (cpu.confidence[i] > 0 && cpu.confidence[i] < 1) confident++;
    return { cpuLayers: cpuLayers.length, n: cpu.invZ.length, confident, sent: sentRes, kept: keptRes, err: gl.getError() };
  }, photo);
  if (!res) return t.skip('No float render targets');
  assert.equal(res.err, 0);
  t.diagnostic(`smoothing on the card: ${Math.round(res.sent.ms)} ms (costs sent), ${Math.round(res.kept.ms)} ms (costs kept there)`);
  assert.equal(res.cpuLayers, 5);
  // (the confidences compared are mostly between 0 and 1, not the 1 of a pixel with no second choice)
  assert.ok(res.confident > res.n / 2);
  for (const [name, r] of [['costs sent', res.sent], ['costs kept on the card', res.kept]]) {
    assert.equal(r.layers, 5, `${name}: the card smoothed ${r.layers} of 5 layers`);
    assert.deepEqual(r.fromCard, Array(5).fill(name !== 'costs sent'), `${name}: where the costs came from`);
    r.sameRanges.forEach((same, i) => assert.ok(same, `${name}, layer ${i}: the search ranges differ (the layer before chose differently)`));
    // (whole numbers on both sides, the same integer steps and the same first-of-ties rule: exactly equal)
    assert.equal(r.depthDiff, 0, `${name}: the depth differs at ${r.depthDiff} of ${res.n} pixels`);
    assert.equal(r.confDiff, 0, `${name}: the confidence differs at ${r.confDiff} of ${res.n} pixels`);
  }
});
