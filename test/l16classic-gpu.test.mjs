// Classic Depth's matching costs and pictures on the graphics card (gpu/l16classic.js) give the processor's (core/l16classic.js), on a tiny made-up L16 photo
// (helpers/l16photo.mjs): three cameras, one monochrome, with lens distortion, a near rectangle, a sloping floor, a flat strip and noise. The depth runs through all five
// layers, so every layer's costs are compared, with the smoothing on the processor each time. Skipped where Playwright or its browser is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gpuPage } from './helpers/gpupage.mjs';
import { makeL16Photo } from './helpers/l16photo.mjs';

const photo = makeL16Photo();

test('Classic Depth costs on the graphics card match the processor’s, layer by layer', async (t) => {
  const page = await gpuPage(t);
  if (!page) return;
  const res = await page.evaluate(async ({ bytes, parsed }) => {
    const gpu = await globalThis.makeGpu();
    if (!gpu) return null;
    const gl = gpu.gl;
    const core = await import('/js/core/l16classic.js');
    const { l16ClassicGpu } = await import('/js/gpu/l16classic.js');
    const data = Uint8Array.from(bytes);
    const run = (onProgress) => core.classicDepth(data, JSON.parse(JSON.stringify(parsed)), { ref: 'A1', modules: ['A2', 'A3'] }, onProgress);
    // The processor's costs of each layer: a smoothing hook that keeps what it is given and then fails, so the processor smooths (the failure turns the hook off; the
    // progress calls of the next layer's costs turn it back on).
    const cpuLayers = [];
    const keep = (a) => {
      cpuLayers.push({ start: Array.from(a.start), count: Array.from(a.count), raw: Array.from(a.raw) });
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
    // The card's costs (the pictures made on the processor and handed to open): each layer's from costs(), and the same layer's from costsTex() read back.
    const card = l16ClassicGpu(gpu);
    const gpuLayers = [];
    let pictures = null;
    core.setL16ClassicGpu({
      open(args) {
        pictures = { ref: Array.from(args.ref), mods: args.mods.map((m) => Array.from(m.img)), W: args.W, H: args.H };
        const s = card.open(args);
        return {
          costs(a) {
            const raw = s.costs(a);
            const t = s.costsTex(a);
            const E = a.off[a.skip.length];
            const rows = Math.max(1, Math.ceil(E / 4096));
            const buf = new Uint32Array(4096 * rows);
            gpu.target(t.tex, 1024, rows);
            gl.readPixels(0, 0, 1024, rows, gl.RGBA_INTEGER, gl.UNSIGNED_INT, buf);
            t.release();
            gpuLayers.push({ start: Array.from(a.start), count: Array.from(a.count), raw: Array.from(raw), list: Array.from(buf.subarray(0, E)) });
            return raw;
          },
          close: () => s.close(),
        };
      },
    });
    let onCard;
    try {
      onCard = run(() => {});
    } finally {
      core.setL16ClassicGpu(null);
    }
    const layers = cpuLayers.map((c, i) => {
      const g = gpuLayers[i];
      if (!g) return { missing: true };
      const sameRanges = c.start.every((v, k) => v === g.start[k]) && c.count.every((v, k) => v === g.count[k]);
      let costDiff = 0;
      let worst = 0;
      let listDiff = 0;
      for (let k = 0; k < c.raw.length; k++) {
        if (c.raw[k] !== g.raw[k]) costDiff++;
        worst = Math.max(worst, Math.abs(c.raw[k] - g.raw[k]));
        if (g.list[k] !== g.raw[k]) listDiff++;
      }
      return { entries: c.raw.length, sameRanges, costDiff, worst, listDiff, rangeOf: [Math.min(...c.count), Math.max(...c.count)] };
    });
    let depthDiff = 0;
    let confDiff = 0;
    for (let i = 0; i < cpu.invZ.length; i++) {
      if (cpu.invZ[i] !== onCard.invZ[i]) depthDiff++;
      if (cpu.confidence[i] !== onCard.confidence[i]) confDiff++;
    }
    return { layers, gpuLayerCount: gpuLayers.length, steps: cpu.steps, n: cpu.invZ.length, depthDiff, confDiff, pictures, err: gl.getError() };
  }, photo);
  if (!res) return t.skip('No float render targets');
  assert.equal(res.err, 0);
  assert.equal(res.steps, 24);
  assert.equal(res.layers.length, 5);
  assert.equal(res.gpuLayerCount, 5);
  res.layers.forEach((l, i) => {
    assert.ok(l.sameRanges, `layer ${i}: the search ranges differ (the layer before chose differently)`);
    // (whole numbers on both sides, the same integer steps: exactly equal)
    assert.equal(l.costDiff, 0, `layer ${i}: ${l.costDiff} of ${l.entries} costs differ, by up to ${l.worst}`);
    assert.equal(l.listDiff, 0, `layer ${i}: the costs kept on the card differ from the ones read back at ${l.listDiff} entries`);
  });
  // (the first layer searches every plane, the later ones only a few round the depth found before)
  assert.equal(res.layers[0].rangeOf[1], 24);
  assert.ok(res.layers[4].rangeOf[0] < 24);
  assert.equal(res.depthDiff, 0, `the depth differs at ${res.depthDiff} of ${res.n} pixels`);
  assert.equal(res.confDiff, 0, `the confidence differs at ${res.confDiff} of ${res.n} pixels`);
});

test('Classic Depth pictures made on the graphics card match the processor’s', async (t) => {
  const page = await gpuPage(t);
  if (!page) return;
  const res = await page.evaluate(async ({ bytes, parsed }) => {
    const gpu = await globalThis.makeGpu();
    if (!gpu) return null;
    const gl = gpu.gl;
    const core = await import('/js/core/l16classic.js');
    const { l16ClassicGpu } = await import('/js/gpu/l16classic.js');
    const data = Uint8Array.from(bytes);
    const run = () => core.classicDepth(data, JSON.parse(JSON.stringify(parsed)), { ref: 'A1', modules: ['A2', 'A3'] });
    const warn = console.warn;
    console.warn = () => {};
    // the processor's pictures, as handed to the card's open (which then fails, so the rest is the processor's too)
    let cpuPics = null;
    core.setL16ClassicSmoothGpu(null);
    core.setL16ClassicGpu({
      open(args) {
        cpuPics = [Array.from(args.ref), ...args.mods.map((m) => Array.from(m.img))];
        throw new Error('kept (the test)');
      },
    });
    let cpu;
    try {
      cpu = run();
    } finally {
      console.warn = warn;
    }
    // the card's: the reference's comes back from filter; each camera's is read from the card as it is copied into the costs' array
    const card = l16ClassicGpu(gpu);
    const gpuPics = [];
    const copy = gl.copyTexSubImage3D.bind(gl);
    gl.copyTexSubImage3D = (target, level, x, y, layer, x0, y0, w, h) => {
      const buf = new Uint32Array(4 * w * h);
      gl.readPixels(0, 0, w, h, gl.RGBA_INTEGER, gl.UNSIGNED_INT, buf);
      gpuPics[layer + 1] = Array.from({ length: 3 * w * h }, (_, i) => buf[4 * Math.floor(i / 3) + (i % 3)]);
      return copy(target, level, x, y, layer, x0, y0, w, h);
    };
    core.setL16ClassicGpu({
      views(pics) {
        const v = card.views(pics);
        return {
          stats: v.stats,
          filter(tr) {
            const made = v.filter(tr);
            gpuPics[0] = Array.from(made.ref);
            return made;
          },
        };
      },
      open: (a) => card.open(a),
    });
    let onCard;
    try {
      onCard = run();
    } finally {
      core.setL16ClassicGpu(null);
      gl.copyTexSubImage3D = copy;
    }
    const pics = cpuPics.map((c, k) => {
      const g = gpuPics[k];
      let differ = 0;
      let worst = 0;
      for (let i = 0; i < c.length; i++) {
        const d = Math.abs(c[i] - g[i]);
        if (d) differ++;
        worst = Math.max(worst, d);
      }
      return { n: c.length, differ, worst };
    });
    // (the planes are equal steps of inverse depth: how many planes apart the two depths are)
    const step = (1 / cpu.near - 1 / cpu.far) / (cpu.steps - 1);
    let depthDiff = 0;
    let planesApart = 0;
    for (let i = 0; i < cpu.invZ.length; i++) {
      if (cpu.invZ[i] === onCard.invZ[i]) continue;
      depthDiff++;
      planesApart = Math.max(planesApart, Math.round(Math.abs(cpu.invZ[i] - onCard.invZ[i]) / step));
    }
    return { pics, n: cpu.invZ.length, depthDiff, planesApart, err: gl.getError() };
  }, photo);
  if (!res) return t.skip('No float render targets');
  assert.equal(res.err, 0);
  // The card works the views, the means and covariances (sums of float32 over 16 x 16 blocks) and the color match in float32 and its own pow, the processor in float64,
  // so a value that lands within a hair of a half rounds the other way now and then: one level, at a few values (on this photo: none in the reference's, 3 and 12 of
  // 18432 in the two cameras').
  res.pics.forEach((p, k) => {
    assert.ok(p.worst <= 1, `picture ${k}: a value differs by ${p.worst} levels`);
    assert.ok(p.differ <= p.n * 0.005, `picture ${k}: ${p.differ} of ${p.n} values differ`);
  });
  // (and a block one level off changes a cost by one capped step, which only decides a near tie: a few pixels a plane or two apart; on this photo 7 of 1536, one plane)
  assert.ok(res.depthDiff <= res.n * 0.02, `the depth differs at ${res.depthDiff} of ${res.n} pixels`);
  assert.ok(res.planesApart <= 2, `a pixel's depth is ${res.planesApart} planes off`);
});
