// The graphics card's blur (DOF_GATHER) takes a custom bokeh shape: a bright point far out of focus spreads into the star, the same way up as on the processor.
// Skipped where Playwright or its browser is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './helpers/playwright.mjs';
import { encodeBokehImage } from '../app/js/core/dof.js';
import { starRgba } from './helpers/bokeh.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const types = { '.js': 'text/javascript', '.html': 'text/html' };

test('a custom bokeh shape on the graphics card', async (t) => {
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
    const image = encodeBokehImage(starRgba());
    const res = await page.evaluate(async (image) => {
      const { GpuRenderer } = await import('/js/gpu/renderer.js');
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const gpu = new GpuRenderer(gl);
      const w = 96;
      const h = 96;
      const c = 48;
      const src = gpu.texture(w, h, gl.RGBA32F);
      gl.bindTexture(gl.TEXTURE_2D, src);
      const rgba = new Float32Array(w * h * 4);
      for (let i = 0; i < w * h; i++) rgba[4 * i + 3] = 1;
      rgba.set([50, 50, 50, 1], 4 * (c * w + c));
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, rgba);
      gpu.setDepth(new Float32Array(w * h).fill(1), w, h);
      gpu.depthRange = [0, 1];
      const at = (out) => {
        const [r] = gpu.readChannels(out, w, h, 1);
        const v = (x, y) => r[y * w + x];
        const R = 24;
        const a = Math.PI / 5;
        return { tip: v(c, Math.round(c - 0.8 * R)), gap: v(Math.round(c + Math.sin(a) * 0.8 * R), Math.round(c - Math.cos(a) * 0.8 * R)), down: v(c, Math.round(c + 0.8 * R)) };
      };
      const star = at(gpu.depthOfField(src, w, h, { focus: 0, strength: 24, shape: 'custom', image }));
      const circle = at(gpu.depthOfField(src, w, h, { focus: 0, strength: 24, shape: 'circle' }));
      return { star, circle, err: gl.getError() };
    }, image);
    if (!res) return t.skip('No float render targets');
    assert.equal(res.err, 0);
    // light at the star's top tip, none in the gap beside it nor straight down (where an upside down star would put a tip)
    assert.ok(res.star.tip > 10 * Math.max(res.star.gap, res.star.down, 1e-6), JSON.stringify(res));
    // a circle lights all three the same
    assert.ok(res.circle.gap > 0 && Math.abs(res.circle.tip - res.circle.down) < 0.2 * res.circle.tip, JSON.stringify(res));
  } finally {
    await browser.close();
    server.close();
  }
});
