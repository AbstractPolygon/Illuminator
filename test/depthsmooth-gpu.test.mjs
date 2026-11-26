// The picture-guided depth smoothing (core/depth.js smoothDepth) on the graphics card (the renderer's smoothDepth: raw photos, and now processed photos and L16 photos too) gives the processor's. Skipped where
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

test('the depth smoothing on the graphics card matches the processor’s', async (t) => {
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
    page.setDefaultTimeout(240000);
    await page.goto(`http://localhost:${server.address().port}/t.html`);
    const res = await page.evaluate(async () => {
      const { GpuRenderer } = await import('/js/gpu/renderer.js');
      const { smoothDepth } = await import('/js/core/depth.js');
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const gpu = new GpuRenderer(gl);
      const w = 96;
      const h = 72;
      // a picture of two halves and a disc, a depth with steps on its edges (and a little off them) and noise
      let s = 9;
      const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 8) / 16777216;
      const guide = new Float32Array(3 * w * h);
      const depth = new Float32Array(w * h);
      const conf = new Float32Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const disc = Math.hypot(x - 60, y - 36) < 15;
        const v = disc ? 0.8 : x < 40 ? 0.2 : 0.45;
        for (let c = 0; c < 3; c++) guide[3 * i + c] = v + 0.02 * rnd();
        depth[i] = (disc ? 1.2 : x < 42 ? -0.6 : 0.3) + 0.1 * (rnd() - 0.5);
        conf[i] = rnd();
      }
      let worst = 0;
      for (const amount of [0.15, 0.3, 0.8]) {
        for (const confidence of [null, conf]) {
          const cpu = smoothDepth(depth, w, h, guide, { amount, confidence });
          const card = gpu.smoothDepth(depth, w, h, guide, { amount, confidence });
          for (let i = 0; i < w * h; i++) worst = Math.max(worst, Math.abs(cpu[i] - card[i]));
        }
      }
      return { worst, err: gl.getError() };
    });
    if (!res) return t.skip('No float render targets');
    assert.equal(res.err, 0);
    assert.ok(res.worst < 1e-4, `the card differs from the processor by up to ${res.worst}`);
  } finally {
    await browser.close();
    server.close();
  }
});
