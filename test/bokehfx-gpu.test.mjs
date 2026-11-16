// The lens effects on the graphics card (BOKEH_FX) draw what core/bokehfx.js draws on the processor, call after call without an error. Skipped where Playwright or its
// browser is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './helpers/playwright.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');

test('the lens effects agree between the graphics card and the processor', async (t) => {
  const browser = await launchBrowser(t);
  if (!browser) return;
  const server = http.createServer((q, r) => {
    const u = decodeURIComponent(q.url.split('?')[0]);
    if (u === '/t.html') {
      r.writeHead(200, { 'content-type': 'text/html' });
      return r.end('<!doctype html><meta charset=utf8>');
    }
    fs.readFile(path.join(root, u), (e, d) => {
      r.writeHead(e ? 404 : 200, { 'content-type': 'text/javascript' });
      r.end(e ? undefined : d);
    });
  }).listen(0);
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(300000);
    await page.goto(`http://localhost:${server.address().port}/t.html`);
    const res = await page.evaluate(async () => {
      const { GpuRenderer } = await import('/js/gpu/renderer.js');
      const { fxOptions, applyBokehFx } = await import('/js/core/bokehfx.js');
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const g = new GpuRenderer(gl);
      const W = 200;
      const H = 120;
      const rgb = new Float32Array(W * H * 3).fill(0.05);
      for (let y = 58; y < 62; y++) for (let x = 98; x < 102; x++) rgb.fill(1.2, 3 * (y * W + x), 3 * (y * W + x) + 3);
      for (let y = 38; y < 44; y++) for (let x = 138; x < 144; x++) rgb.fill(1.3, 3 * (y * W + x), 3 * (y * W + x) + 3);
      // (the dirty lens shows where there is a lot of light: a large bright area for it)
      const wide = new Float32Array(W * H * 3).fill(0.05);
      for (let y = 20; y < 100; y++) for (let x = 20; x < 180; x++) wide.fill(1.3, 3 * (y * W + x), 3 * (y * W + x) + 3);
      const out = { errors: [] };
      for (const [name, o] of Object.entries({ streak: { fxStreak: 1 }, star: { fxStar: 1, fxSpikes: 6 }, ghosts: { fxGhosts: 1 }, fog: { fxFog: 1 }, dirt: { fxDirt: 1 } })) {
        for (let rep = 0; rep < 2; rep++) {
          const fx = fxOptions(o);
          const inRgb = name === 'dirt' ? wide : rgb;
          // (uploaded each time: the graphics card keeps one upload texture of a size)
          const tex = g.bokehFx(g.uploadRGB(inRgb, W, H), W, H, fx, 1);
          const [r] = g.readChannels(tex, W, H, 1);
          out.errors.push(gl.getError());
          if (rep) continue;
          const cpu = applyBokehFx(inRgb, W, H, fx, 1);
          // how well the light the graphics card adds follows the processor's (Pearson correlation of the two, over the picture)
          const a = [];
          const b = [];
          for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { a.push(r[y * W + x] - inRgb[3 * (y * W + x)]); b.push(cpu[3 * (y * W + x)] - inRgb[3 * (y * W + x)]); }
          const mean = (v) => v.reduce((p, q) => p + q, 0) / v.length;
          const ma = mean(a);
          const mb = mean(b);
          let cov = 0;
          let va = 0;
          let vb = 0;
          for (let i = 0; i < a.length; i++) { cov += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; }
          out[name] = cov / Math.sqrt(Math.max(va * vb, 1e-18));
        }
      }
      return out;
    });
    if (!res) return t.skip('No float render targets');
    assert.ok(res.errors.every((e) => e === 0), `GL errors ${res.errors}`);
    // (the two are the same formulas at different sampling: they agree on where the light goes, not to the pixel)
    // (the dirt's glow is cut at a limit and read from two different mip filters: it follows the processor's less closely)
    for (const k of ['streak', 'star', 'ghosts', 'fog']) assert.ok(res[k] > 0.8, `${k}: ${res[k]}`);
    assert.ok(res.dirt > 0.65, `dirt: ${res.dirt}`);
  } finally {
    await browser.close();
    server.close();
  }
});
