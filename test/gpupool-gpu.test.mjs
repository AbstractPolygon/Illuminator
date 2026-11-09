// The focus mask shaders (and the depth of field step that reads them) compile and run in a headless browser. Skipped where Playwright or its browser is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './helpers/playwright.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const types = { '.js': 'text/javascript', '.html': 'text/html' };

test('the pool is trimmed, setRaw guards and resets, uploadRGB can be full float', async (t) => {
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
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const gpu = new GpuRenderer(gl);
      const out = {};
      // LRU: the oldest entries go first, kept pictures and recent ones stay
      const a = gpu.scratch(64, 64, 'a');
      gpu.scratch(32, 32, 'b');
      const kept = gpu.keep(a, 16, 16);
      for (let i = 0; i < 4; i++) gpu.trimPool(1 << 30);
      gpu.scratch(32, 32, 'b');
      gpu.trimPool(1000);
      out.keys = [...gpu.pool.keys()];
      out.keptStays = gpu.pool.get('16x16:kept') === kept;
      // setRaw: too large a sensor throws; a good one resets depth and restores the unpack alignment
      gpu.setDepth(new Float32Array(4), 2, 2);
      try {
        gpu.setRaw(new Uint16Array(1), { width: gl.getParameter(gl.MAX_TEXTURE_SIZE) + 1, height: 1 }, {});
      } catch (e) {
        out.big = e.message;
      }
      gpu.setRaw(new Uint16Array(16), { width: 4, height: 4 }, {});
      out.depthReset = gpu.depthTex === null && gpu.depthSize === null;
      out.align = gl.getParameter(gl.UNPACK_ALIGNMENT);
      // releaseRaw: the sensor texture goes (a processed light field has none), and it can be called twice
      out.hadRaw = !!gpu.rawTex;
      gpu.releaseRaw();
      gpu.releaseRaw();
      out.rawGone = gpu.rawTex === null;
      gpu.setRaw(new Uint16Array(16), { width: 4, height: 4 }, {});
      out.rawBack = !!gpu.rawTex;
      out.error = gl.getError();
      // a 16-bit export keeps more than half float precision
      const t32 = gpu.uploadRGB(new Float32Array([1 / 3, 1 / 3, 1 / 3]), 1, 1, { full: true });
      gpu.target(t32, 1, 1);
      const px = new Float32Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, px);
      out.full = px[0];
      return out;
    });
    if (!res) return t.skip('No float render targets');
    assert.ok(!res.keys.includes('64x64:a') && res.keys.includes('32x32:b'), res.keys.join());
    assert.ok(res.keptStays);
    assert.equal(res.big, 'sensor exceeds GPU texture size');
    assert.ok(res.depthReset);
    assert.equal(res.align, 4);
    assert.ok(res.hadRaw && res.rawGone && res.rawBack);
    assert.equal(res.error, 0);
    assert.equal(res.full, Math.fround(1 / 3));
  } finally {
    await browser.close();
    server.close();
  }
});
