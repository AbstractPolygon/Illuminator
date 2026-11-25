// The smoothing of the depth at the objects' outlines (core/segments.js softenObjectEdges) on the graphics card (gpu/softedges.js) gives the processor's. Skipped where
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

test('the object edges’ smoothing on the graphics card matches the processor’s', async (t) => {
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
      const { softenObjectEdges } = await import('/js/core/segments.js');
      const { softEdgesGpu } = await import('/js/gpu/softedges.js');
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const gpu = new GpuRenderer(gl);
      const w = 120;
      const h = 90;
      // three objects (a disc, a band, the rest) with their own depths and a little texture
      const labels = new Int32Array(w * h);
      const depth = new Float32Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        labels[i] = Math.hypot(x - 40, y - 40) < 22 ? 1 : x > 80 && y > 20 && y < 70 ? 2 : 0;
        depth[i] = [0.2, 0.8, -0.5][labels[i]] + 0.05 * Math.sin(x * 0.3) * Math.cos(y * 0.2);
      }
      let worst = 0;
      for (const sigma of [1.5, 4, 8]) {
        const cpu = softenObjectEdges(depth, labels, w, h, sigma);
        const card = softEdgesGpu(gpu)(depth, labels, w, h, sigma);
        for (let i = 0; i < w * h; i++) worst = Math.max(worst, Math.abs(cpu[i] - card[i]));
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
