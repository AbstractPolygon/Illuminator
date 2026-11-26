// The depth's 5 x 5 median (core/depth.js median5) on the graphics card (gpu/regions.js) gives the processor's values. Skipped where Playwright or its browser is not
// installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './helpers/playwright.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const types = { '.js': 'text/javascript', '.html': 'text/html' };

test('the depth’s 5 x 5 median on the graphics card matches the processor’s', async (t) => {
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
      const D = await import('/js/core/depth.js');
      const { regionsGpu } = await import('/js/gpu/regions.js');
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const gpu = new GpuRenderer(gl);
      const card = regionsGpu(gpu);
      if (!card) return null;
      // a depth with steps, a ramp, speckles and repeated values (ties)
      const w = 157;
      const h = 113;
      let seed = 11;
      const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
      const depth = new Float32Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) depth[y * w + x] = (x > 60 ? 0.8 : -0.3) + 0.004 * y + (rnd() < 0.05 ? rnd() * 3 - 1.5 : 0) + (rnd() < 0.2 ? 0 : 0.01 * Math.round(rnd() * 3));
      const cpu = D.median5ForTests(depth, w, h);
      const out = card.median5(depth, w, h);
      let diff = 0;
      for (let i = 0; i < w * h; i++) if (cpu[i] !== out[i]) diff++;
      return { diff, err: gl.getError() };
    });
    if (!res) return t.skip('No float render targets');
    assert.equal(res.err, 0);
    assert.equal(res.diff, 0, `${res.diff} values differ`);
  } finally {
    await browser.close();
    server.close();
  }
});
