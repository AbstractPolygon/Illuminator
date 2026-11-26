// Remove hot pixels (core/raw.js fixHotPixels) on the graphics card (gpu/hotpixels.js) gives the processor's pixels and count. Skipped where Playwright or its browser is
// not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './helpers/playwright.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const types = { '.js': 'text/javascript', '.html': 'text/html' };

test('Remove hot pixels on the graphics card matches the processor’s', async (t) => {
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
      const { fixHotPixels } = await import('/js/core/raw.js');
      const { fixHotPixelsGpu } = await import('/js/gpu/hotpixels.js');
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl) return null;
      const gpu = new GpuRenderer(gl);
      const w = 640;
      const h = 480;
      // a textured scene with hot, warm and dead pixels, some side by side, and pixels on the tests' edges (v = 0.4 s4 + 20, v = a + 30, 20 v = 3 a)
      let seed = 7;
      const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
      const raw = new Uint16Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * w + x] = Math.round(300 + 200 * Math.sin(x * 0.05) * Math.cos(y * 0.03) + 40 * rnd());
      for (let k = 0; k < 3000; k++) {
        const i = Math.floor(rnd() * w * h);
        const r = rnd();
        raw[i] = r < 0.4 ? 1023 : r < 0.6 ? 0 : r < 0.8 ? Math.min(1023, raw[i] * 2 + Math.floor(rnd() * 80)) : raw[i] + Math.floor(rnd() * 60);
        if (rnd() < 0.2 && i + 2 < w * h) raw[i + 2] = raw[i];
      }
      for (let y = 10; y < h - 10; y += 37) {
        for (let x = 10; x < w - 10; x += 41) {
          const i = y * w + x;
          const s4 = raw[i - 2] + raw[i + 2] + raw[i - 2 * w] + raw[i + 2 * w];
          if ((2 * s4 + 100) % 5 === 0) raw[i] = (2 * s4 + 100) / 5;
        }
      }
      const cpu = fixHotPixels(raw, w, h, null);
      const card = fixHotPixelsGpu(gpu, raw, w, h);
      let diff = 0;
      for (let i = 0; i < w * h; i++) if (cpu.raw[i] !== card.raw[i]) diff++;
      return { diff, count: [cpu.count, card.count], err: gl.getError() };
    });
    if (!res) return t.skip('No WebGL 2');
    assert.equal(res.err, 0);
    assert.equal(res.diff, 0, `${res.diff} pixels differ`);
    assert.ok(res.count[0] > 1000, `only ${res.count[0]} pixels fixed`);
    assert.equal(res.count[1], res.count[0]);
  } finally {
    await browser.close();
    server.close();
  }
});
