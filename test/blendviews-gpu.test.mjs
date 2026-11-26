// A processed photo's picture for a focus or a viewpoint (core/processed.js ProcessedPicture.base: a focus stack's two pictures either side, the three nearest
// viewpoints) mixed on the graphics card (gpu/blendviews.js) gives the processor's. Skipped where
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

test('the saved pictures mixed on the graphics card match the processor’s mix', async (t) => {
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
      const { ProcessedPicture } = await import('/js/core/processed.js');
      const { blendViewsGpu } = await import('/js/gpu/blendviews.js');
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const gpu = new GpuRenderer(gl);
      const w = 64;
      const h = 48;
      const picture = (k) => {
        const data = new Uint8ClampedArray(4 * w * h);
        for (let i = 0; i < w * h; i++) {
          data[4 * i] = (i * 7 + k * 50) % 256;
          data[4 * i + 1] = (i * 3 + k * 90) % 256;
          data[4 * i + 2] = (i * 11 + k * 30) % 256;
          data[4 * i + 3] = 255;
        }
        return data;
      };
      const stack = new ProcessedPicture({ kind: 'focus', source: 'lfp', images: [0, 1, 2].map((k) => ({ width: w, height: h, data: picture(k), lambda: k * 2 - 2 })) });
      const views = new ProcessedPicture({ kind: 'perspective', source: 'lfp', images: [[0, 0], [1, 0], [0, 1], [-1, -1]].map(([u, v], k) => ({ width: w, height: h, data: picture(k + 3), u, v })) });
      const run = blendViewsGpu(gpu);
      let worst = 0;
      const cmp = (pp, u, v, lambda) => {
        const cpu = pp.base(u, v, lambda);
        const [r, g, b] = gpu.readChannels(run.base(pp, u, v, lambda), w, h, 3);
        for (let i = 0; i < w * h; i++) worst = Math.max(worst, Math.abs(cpu[3 * i] - r[i]), Math.abs(cpu[3 * i + 1] - g[i]), Math.abs(cpu[3 * i + 2] - b[i]));
      };
      for (const lambda of [-3, -1.5, 0, 0.7, 2, 3]) cmp(stack, 0, 0, lambda);
      for (const [u, v] of [[0, 0], [0.3, 0.2], [0.8, 0.1], [-0.5, -0.4], [0.5, 0.5]]) cmp(views, u, v, 0);
      run.release();
      return { worst, err: gl.getError() };
    });
    if (!res) return t.skip('No float render targets');
    assert.equal(res.err, 0);
    assert.ok(res.worst < 1e-5, `the card differs from the processor by up to ${res.worst}`);
  } finally {
    await browser.close();
    server.close();
  }
});
