// The Lytro-style depth on the GPU (gpu/depthmatch.js) against the CPU
// version (core/depthmatch.js), in a headless browser. Skipped where
// Playwright or its browser is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './helpers/playwright.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const types = { '.js': 'text/javascript', '.html': 'text/html' };

test('GPU Lytro-style depth matches the CPU result', async (t) => {
  const browser = await launchBrowser(t);
  if (!browser) return;
  const server = http.createServer((q, r) => {
    const u = decodeURIComponent(q.url.split('?')[0]);
    if (u === '/t.html') {
      r.writeHead(200, { 'content-type': 'text/html' });
      return r.end('<!doctype html><meta charset=utf8>');
    }
    fs.readFile(path.join(root, u), (e, d) => {
      r.writeHead(e ? 404 : 200, { 'content-type': types[path.extname(u)] || 'application/octet-stream' });
      r.end(e ? undefined : d);
    });
  }).listen(0);
  try {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${server.address().port}/t.html`);
    const res = await page.evaluate(async () => {
      const W = 40, H = 30, G = 3;
      const depth = await import('/js/core/depth.js');
      const dm = await import('/js/core/depthmatch.js');
      const { GpuRenderer } = await import('/js/gpu/renderer.js');
      const { measureMatchGpu } = await import('/js/gpu/depthmatch.js');
      depth.setDepthStyle('match');
      Object.assign(dm.DEPTH_PASSES, { first: -8, top: 8, lambda: 0.1, adapt: { on: true, fine: 12, lowQ: 0.005, highQ: 0.995, pad: 1 } });
      const f = (x, y, c) => 0.5 + 0.25 * Math.sin(0.31 * x + 1.7 * c) * Math.cos(0.23 * y - c) + 0.2 * Math.sin(0.113 * (x + 2 * y) + c);
      const views = [];
      for (let j = 0; j < G; j++) {
        for (let i = 0; i < G; i++) {
          const u = i - 1, v = j - 1;
          const rgb = new Float32Array(W * H * 3);
          for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
              const a = x < W / 2 ? -0.5 : 0.4;
              for (let c = 0; c < 3; c++) rgb[3 * (y * W + x) + c] = f(x + a * u * 4, y + a * v * 4, c);
            }
          }
          views.push({ u, v, rgb, gain: 1, detail: 1 });
        }
      }
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const cpu = dm.measureMatch(views, W, H);
      const gpu = measureMatchGpu(new GpuRenderer(gl), views, W, H);
      let worst = 0;
      for (const key of ['alpha', 'cost', 'meanCost']) for (let i = 0; i < cpu[key].length; i++) worst = Math.max(worst, Math.abs(cpu[key][i] - gpu[key][i]));
      return { worst, error: gl.getError() };
    });
    if (!res) return t.skip('No WebGL2 with float targets');
    assert.equal(res.error, 0);
    t.diagnostic(`largest difference ${res.worst}`);
    // Measured on SwiftShader: 4.8e-7. The limit leaves headroom for other GPUs' float rounding.
    assert.ok(res.worst < 1e-5, `largest difference ${res.worst}`);
  } finally {
    await browser.close();
    server.close();
  }
});

test('GPU match depth with sub-labels equals the CPU and leaves the module refs alone', async (t) => {
  const browser = await launchBrowser(t);
  if (!browser) return;
  const server = http.createServer((q, r) => {
    const u = decodeURIComponent(q.url.split('?')[0]);
    if (u === '/t.html') {
      r.writeHead(200, { 'content-type': 'text/html' });
      return r.end('<!doctype html><meta charset=utf8>');
    }
    fs.readFile(path.join(root, u), (e, d) => {
      r.writeHead(e ? 404 : 200, { 'content-type': types[path.extname(u)] || 'application/octet-stream' });
      r.end(e ? undefined : d);
    });
  }).listen(0);
  try {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${server.address().port}/t.html`);
    const res = await page.evaluate(async () => {
      const W = 40, H = 30, G = 3;
      const depth = await import('/js/core/depth.js');
      const dm = await import('/js/core/depthmatch.js');
      const { GpuRenderer } = await import('/js/gpu/renderer.js');
      const { measureMatchGpu } = await import('/js/gpu/depthmatch.js');
      const f = (x, y, c) => 0.5 + 0.25 * Math.sin(0.31 * x + 1.7 * c) * Math.cos(0.23 * y - c) + 0.2 * Math.sin(0.113 * (x + 2 * y) + c);
      const views = [];
      for (let j = 0; j < G; j++) {
        for (let i = 0; i < G; i++) {
          const u = i - 1, v = j - 1;
          const rgb = new Float32Array(W * H * 3);
          for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
              const a = x < W / 2 ? -0.5 : 0.4;
              for (let c = 0; c < 3; c++) rgb[3 * (y * W + x) + c] = f(x + a * u * 4, y + a * v * 4, c);
            }
          }
          views.push({ u, v, rgb, gain: 1, detail: 1 });
        }
      }
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      gl.getExtension('EXT_float_blend');
      depth.DEPTH_MATCH.subLabel = true;
      depth.setDepthStyle('match');
      Object.assign(dm.DEPTH_PASSES, { first: -8, top: 8, lambda: 0.1, adapt: { on: true, fine: 12, lowQ: 0.005, highQ: 0.995, pad: 1 }, refs: [0, 1, 2] });
      const cpu = dm.measureMatch(views, W, H);
      const refsCpu = dm.DEPTH_PASSES.refs.length;
      const gpu = measureMatchGpu(new GpuRenderer(gl), views, W, H);
      const refsGpu = dm.DEPTH_PASSES.refs.length;
      depth.DEPTH_MATCH.subLabel = false;
      depth.setDepthStyle('classic');
      let worst = 0;
      for (let i = 0; i < cpu.alpha.length; i++) worst = Math.max(worst, Math.abs(cpu.alpha[i] - gpu.alpha[i]));
      return { worst, refsCpu, refsGpu, error: gl.getError() };
    });
    if (!res) return t.skip('No WebGL2 with float targets');
    assert.equal(res.error, 0);
    assert.equal(res.refsCpu, 3);
    assert.equal(res.refsGpu, 3);
    assert.ok(res.worst < 1e-3, `largest difference ${res.worst}`);
  } finally {
    await browser.close();
    server.close();
  }
});

// A scene whose views are shifted by whole pixels (a random texture, so bilinear weights are 0 / 1 and many
// pixels have exactly equal costs). This is where the GPU and CPU twins used to part ways.
//
// Root cause of the old divergence (noisy = 0, 10 pixels differ in cost by 0.2): the message passing
// summed the five terms of a belief in another order on the GPU than on the CPU (U + right + down + left +
// up against U + left + right + up + down). Float32 addition is not associative, so labels that tie to
// within 1e-7 (flat, zeroed-cost pixels) were ordered differently and one label flipped; the flip then
// cascaded through the hidden / visible choice into pass 2. The GPU now adds in the CPU's order.
//
// Remaining, not fixable: with blur = 2 the raw match costs differ by up to 1e-6 (the GPU samples in float32,
// the CPU in float64, and a GPU may fuse multiply-adds), and a pixel whose cost spread lies within about 1e-7
// of the noisy-rule threshold (0.075) flips on one side only. On seed 7 that one pixel changes a pass-1 depth
// and cascades to 294 of 2173 final labels (up to 17 labels, 1.7 alpha); on the other seeds 0 to 1 pixel.
// Bit-identical costs would need float32 emulation in the CPU and cannot hold on GPUs with fused multiply-add.
test('GPU match depth equals the CPU on whole-pixel view shifts (no flat-pixel rule, and with blur)', async (t) => {
  const browser = await launchBrowser(t);
  if (!browser) return;
  const server = http.createServer((q, r) => {
    const u = decodeURIComponent(q.url.split('?')[0]);
    if (u === '/t.html') {
      r.writeHead(200, { 'content-type': 'text/html' });
      return r.end('<!doctype html><meta charset=utf8>');
    }
    fs.readFile(path.join(root, u), (e, d) => {
      r.writeHead(e ? 404 : 200, { 'content-type': types[path.extname(u)] || 'application/octet-stream' });
      r.end(e ? undefined : d);
    });
  }).listen(0);
  try {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${server.address().port}/t.html`);
    const res = await page.evaluate(async () => {
      const depth = await import('/js/core/depth.js');
      const dm = await import('/js/core/depthmatch.js');
      const { GpuRenderer } = await import('/js/gpu/renderer.js');
      const { measureMatchGpu } = await import('/js/gpu/depthmatch.js');
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      gl.getExtension('EXT_float_blend');
      const gpu = new GpuRenderer(gl);
      const W = 53, H = 41;
      const scene = (seed) => {
        let s = seed;
        const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
        const base = new Float32Array(W * H * 3).map(() => rnd());
        const views = [];
        for (let j = 0; j < 3; j++) {
          for (let i = 0; i < 3; i++) {
            const rgb = new Float32Array(W * H * 3);
            for (let y = 0; y < H; y++) {
              for (let x = 0; x < W; x++) {
                const sx = Math.max(0, Math.min(W - 1, x + 2 * (i - 1) * (x < W / 2 ? 1 : -1)));
                const sy = Math.max(0, Math.min(H - 1, y + 2 * (j - 1)));
                for (let c = 0; c < 3; c++) {
                  let val = base[3 * (sy * W + sx) + c] * 0.7 + 0.05 * rnd();
                  if (x > W - 10 && y < 10) val = 1.2;
                  rgb[3 * (y * W + x) + c] = val;
                }
              }
            }
            views.push({ u: i - 1, v: j - 1, rgb, gain: 1, detail: 1 });
          }
        }
        return views;
      };
      const out = {};
      depth.setDepthStyle('match');
      for (const [name, seed, settings] of [['plain7', 7, { noisy: 0, blur: 0 }], ['plain2', 2, { noisy: 0, blur: 0 }], ['blur3', 3, { noisy: 0.075, blur: 2 }], ['blur6', 6, { noisy: 0.075, blur: 2 }]]) {
        Object.assign(dm.DEPTH_PASSES, { first: -8, top: 8, lambda: 0.1, step: 1, matchColor: 'linear', refs: null, adapt: { on: true, fine: 12, lowQ: 0.005, highQ: 0.995, pad: 1 } }, settings);
        const views = scene(seed);
        const a = measureMatchGpu(gpu, views, W, H);
        const b = dm.measureMatch(views, W, H);
        let wrong = 0, worst = 0;
        for (let i = 0; i < W * H; i++) {
          const d = Math.max(Math.abs(a.alpha[i] - b.alpha[i]), Math.abs(a.cost[i] - b.cost[i]));
          if (d > 1e-3) wrong++;
          worst = Math.max(worst, d);
        }
        out[name] = { wrong, worst };
      }
      out.error = gl.getError();
      return out;
    });
    if (!res) return t.skip('No WebGL2 with float targets');
    assert.equal(res.error, 0);
    // Measured on SwiftShader: 0 pixels differ in every case (was 10 pixels, cost off by 0.2, on plain7).
    for (const name of ['plain7', 'plain2']) assert.equal(res[name].wrong, 0, `${name}: ${res[name].wrong} pixels differ, worst ${res[name].worst}`);
    // With blur a flat-pixel threshold can flip on float noise (see above): allow 1% of the pixels.
    for (const name of ['blur3', 'blur6']) assert.ok(res[name].wrong <= 22, `${name}: ${res[name].wrong} pixels differ, worst ${res[name].worst}`);
  } finally {
    await browser.close();
    server.close();
  }
});
