// The dots' cleanup after an L16 merge (core/l16fusion.js removeMergedSpecks) on the graphics card (gpu/l16specks.js) gives what the processor's does: one and two pixel
// dots of one or two colors, soft colored spots, and a white highlight left alone. Skipped where Playwright or its browser is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './helpers/playwright.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const types = { '.js': 'text/javascript', '.html': 'text/html' };

test('the dots’ cleanup on the graphics card matches the processor’s', async (t) => {
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
      const { removeMergedSpecks, setL16SpecksGpu } = await import('/js/core/l16fusion.js');
      const { l16SpecksGpu } = await import('/js/gpu/l16specks.js');
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const gpu = new GpuRenderer(gl);
      const W = 160;
      const H = 120;
      // a dark textured picture (noise from a fixed generator)
      let s = 7;
      const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 8) / 16777216;
      const rgb = new Float32Array(3 * W * H);
      for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) rgb[3 * i + c] = 0.02 + 0.01 * rnd() + 0.01 * Math.sin(i * 0.37 + c);
      const put = (x, y, v) => rgb.set(v, 3 * (y * W + x));
      put(20, 20, [0.02, 0.2, 0.03]);                       // a green dot
      put(40, 30, [0.2, 0.02, 0.2]);                        // a magenta dot
      put(41, 30, [0.18, 0.02, 0.19]);                      // and its partner
      put(70, 60, [0.03, 0.15, 0.16]);                      // a cyan dot
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const k = dx === 0 && dy === 0 ? 1 : 0.5;
        put(100 + dx, 80 + dy, [0.02, 0.02 + 0.03 * k, 0.03 + 0.15 * k]);   // a soft blue spot
        put(120 + dx, 40 + dy, [0.03 + 0.12 * k, 0.03 + 0.11 * k, 0.02]);   // a soft yellow one
        put(60 + dx, 100 + dy, [0.5 * k, 0.5 * k, 0.5 * k]);                // a white highlight (stays)
      }
      const cpu = Float32Array.from(rgb);
      setL16SpecksGpu(null);
      removeMergedSpecks(cpu, W, H, 1);
      const card = Float32Array.from(rgb);
      setL16SpecksGpu(l16SpecksGpu(gpu));
      removeMergedSpecks(card, W, H, 1);
      setL16SpecksGpu(null);
      let worst = 0;
      for (let i = 0; i < cpu.length; i++) worst = Math.max(worst, Math.abs(cpu[i] - card[i]));
      const at = (a, x, y) => Array.from(a.subarray(3 * (y * W + x), 3 * (y * W + x) + 3));
      return { worst, green: at(cpu, 20, 20), blue: at(cpu, 100, 80), white: at(cpu, 60, 100), err: gl.getError() };
    });
    if (!res) return t.skip('No float render targets');
    assert.equal(res.err, 0);
    assert.ok(res.green[1] < 0.05, `the green dot stayed: ${res.green}`);
    assert.ok(res.blue[2] < 0.06, `the blue spot stayed: ${res.blue}`);
    assert.ok(res.white[0] > 0.4, `the white highlight was taken: ${res.white}`);
    assert.ok(res.worst < 1e-5, `the card differs from the processor by up to ${res.worst}`);
  } finally {
    await browser.close();
    server.close();
  }
});
