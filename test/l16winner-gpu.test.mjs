// The Illuminator depth method's winners for an L16 photo (core/l16depth.js depthFinishIlluminator's winners) on the graphics card (gpu/l16winner.js) gives the processor's. Skipped where
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

test('the L16 depth winners on the graphics card match the processor’s', async (t) => {
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
      const { l16WinnerGpu } = await import('/js/gpu/l16winner.js');
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const gpu = new GpuRenderer(gl);
      const w = 97;
      const h = 61;
      const NZ = 48;
      // costs with a valley at a different step for each pixel, noise, and ties (whole numbers 0..255, as the cost steps make)
      let s = 3;
      const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 8) / 16777216;
      const cost = new Uint8Array(w * h * NZ);
      for (let i = 0; i < w * h; i++) {
        const v = Math.floor(rnd() * NZ);
        for (let k = 0; k < NZ; k++) cost[i * NZ + k] = Math.min(255, Math.round(Math.abs(k - v) * (2 + 10 * rnd()) + 20 * rnd() + (i % 7 === 0 ? 0 : 3)));
        if (i % 11 === 0) cost.fill(40, i * NZ, i * NZ + NZ);
      }
      // the processor's, as depthFinishIlluminator works them out
      const cpuPos = new Float32Array(w * h);
      const cpuConf = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) {
        const base = i * NZ;
        let best = 0;
        let bc = Infinity;
        for (let k = 0; k < NZ; k++) if (cost[base + k] < bc) { bc = cost[base + k]; best = k; }
        let second = Infinity;
        for (let k = 0; k < NZ; k++) if ((k < best - 1 || k > best + 1) && cost[base + k] < second) second = cost[base + k];
        let pos = best;
        if (best > 0 && best < NZ - 1) {
          const a = cost[base + best - 1];
          const c = cost[base + best + 1];
          const den = a - 2 * bc + c;
          if (den > 0) pos += Math.max(-0.5, Math.min(0.5, (a - c) / (2 * den)));
        }
        cpuPos[i] = pos / (NZ - 1);
        cpuConf[i] = second > 0 && second < Infinity ? Math.max(0, Math.min(1, 1 - bc / second)) : 0;
      }
      const card = l16WinnerGpu(gpu)(cost, w, h, NZ);
      let worst = 0;
      for (let i = 0; i < w * h; i++) worst = Math.max(worst, Math.abs(cpuPos[i] - card.pos01[i]), Math.abs(cpuConf[i] - card.confidence[i]));
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
