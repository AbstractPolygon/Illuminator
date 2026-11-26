// The microlens grid's fit (core/lenslet.js calibrateGrid) with the graphics card's scores (gpu/lenslet.js) chooses the processor's grid. Skipped where Playwright or its
// browser is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './helpers/playwright.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const types = { '.js': 'text/javascript', '.html': 'text/html' };

test('the microlens grid’s fit with the graphics card’s scores chooses the processor’s grid', async (t) => {
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
      const L = await import('/js/core/lenslet.js');
      const { lensletGpu } = await import('/js/gpu/lenslet.js');
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const gpu = new GpuRenderer(gl);
      // a sensor of hexagonal lenses (bright centers, dark between) on a grid a little off the one the search starts from, with a textured scene and noise
      const width = 900;
      const height = 700;
      const truth = { pitch: 14.1, rowStep: 14.1 * Math.sqrt(3) / 2, rotation: 0.0021, ox: 451.3, oy: 349.6 };
      let seed = 3;
      const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
      const raw = new Uint16Array(width * height);
      const co = Math.cos(truth.rotation);
      const si = Math.sin(truth.rotation);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const dx = x - truth.ox;
        const dy = y - truth.oy;
        const lx = co * dx + si * dy;
        const ly = -si * dx + co * dy;
        const r = Math.round(ly / truth.rowStep);
        let best = 1e9;
        for (const rr of [r - 1, r, r + 1]) {
          const c = Math.round((lx - (rr & 1) * truth.pitch * 0.5) / truth.pitch);
          for (const cc of [c - 1, c, c + 1]) best = Math.min(best, Math.hypot(lx - cc * truth.pitch - (rr & 1) * truth.pitch * 0.5, ly - rr * truth.rowStep));
        }
        const scene = 0.6 + 0.4 * Math.sin(x * 0.01) * Math.cos(y * 0.013);
        raw[y * width + x] = Math.round(64 + 800 * scene * Math.max(0.05, 1 - (best / (truth.pitch / 2)) ** 2) + 10 * rnd());
      }
      const cam = { width, height };
      const start = { pitch: 14.0, rowStep: 14.0 * Math.sqrt(3) / 2, rotation: 0, ox: 449, oy: 352 };
      L.setLensletGpu(null);
      const cpu = L.calibrateGrid(raw, cam, start);
      L.setLensletGpu((r, w, h) => lensletGpu(gpu, r, w, h));
      let used = 0;
      const card = L.calibrateGrid(raw, cam, start);
      L.setLensletGpu((r, w, h) => {
        const s = lensletGpu(gpu, r, w, h);
        return { ...s, scores: (...a) => (used++, s.scores(...a)) };
      });
      L.calibrateGrid(raw, cam, start);
      L.setLensletGpu(null);
      return { cpu, card, used, err: gl.getError() };
    });
    if (!res) return t.skip('No float render targets');
    assert.equal(res.err, 0);
    assert.ok(res.used >= 10, `the card scored only ${res.used} searches`);
    assert.deepEqual(res.card, res.cpu);
    assert.ok(Math.abs(res.cpu.grid.ox - 451.3) < 1 && Math.abs(res.cpu.grid.oy - 349.6) < 1, `the fit found ${JSON.stringify(res.cpu.grid)}`);
  } finally {
    await browser.close();
    server.close();
  }
});
