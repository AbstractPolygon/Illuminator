// The engine's modulation plane on the GPU (gpu/enginemod.js) against the CPU version (core/enginemod.js), in a headless browser, on a synthetic white image with lens discs, a vignette and hot pixels. Skipped where Playwright or its browser is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './helpers/playwright.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const types = { '.js': 'text/javascript', '.html': 'text/html' };

// sizes: histogram chunk sizes to run in addition to the default one (each result is compared with the CPU twin and with the single-chunk run).
async function runScene(t, W, H, sizes) {
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
    page.setDefaultTimeout(300000);
    await page.goto(`http://localhost:${server.address().port}/t.html`);
    const res = await page.evaluate(async ({ W, H, sizes }) => {
      const { GpuRenderer } = await import('/js/gpu/renderer.js');
      const { engineModulation } = await import('/js/core/enginemod.js');
      const { engineModulationGpu, engineModulationGpuAvailable, setHistChunkSizeForTests } = await import('/js/gpu/enginemod.js');
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const gpu = new GpuRenderer(gl);
      const cam = { width: W, height: H };
      const dev = { cfa: [[0, 1], [1, 2]], black: [64, 64, 64] };
      const grid = { pitch: 13.4, rowStep: 13.4 * 0.8660254, ox: 6.2, oy: 5.1, rotation: 0.002 };
      let seed = 11;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      const mod = new Uint16Array(W * H);
      const cs = Math.cos(grid.rotation);
      const sn = Math.sin(grid.rotation);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          // distance to the nearest lens centre of the hexagonal lattice (found in the lattice's own frame)
          const dx = x - grid.ox;
          const dy = y - grid.oy;
          const u = cs * dx + sn * dy;
          const v = -sn * dx + cs * dy;
          const row = Math.round(v / grid.rowStep);
          let best = 1e9;
          for (let r = row - 1; r <= row + 1; r++) {
            const off = (r & 1) * grid.pitch * 0.5;
            const col = Math.round((u - off) / grid.pitch);
            const du = u - (col * grid.pitch + off);
            const dv = v - r * grid.rowStep;
            best = Math.min(best, du * du + dv * dv);
          }
          const rim = Math.sqrt(best) / (grid.pitch * 0.5);
          const global = 1 - 0.35 * (((x - W / 2) / W) ** 2 + ((y - H / 2) / H) ** 2) * 4;
          const phase = [0.8, 1, 1, 0.55][(y & 1) * 2 + (x & 1)];
          const val = 64 + 900 * phase * global * Math.max(0.02, 1 - 0.9 * rim ** 2.2) + (rnd() - 0.5) * 6;
          mod[y * W + x] = Math.max(0, Math.min(1023, Math.round(val)));
        }
      }
      const hot = [];
      for (let k = 0; k < 300; k++) {
        const x = 4 + Math.floor(rnd() * (W - 8));
        const y = 4 + Math.floor(rnd() * (H - 8));
        mod[y * W + x] = 1023;
        hot.push(y * W + x);
      }
      if (!engineModulationGpuAvailable(gpu, cam)) return { skip: 'GPU not usable' };
      const t0 = performance.now();
      const cpu = engineModulation(mod, cam, dev, grid, hot);
      const t1 = performance.now();
      const out = engineModulationGpu(gpu, mod, cam, dev, grid, hot);
      const t2 = performance.now();
      let worst = 0;
      let over = 0;
      let sum = 0;
      for (let i = 0; i < cpu.length; i++) {
        const d = Math.abs(cpu[i] - out[i]);
        if (d > worst) worst = d;
        if (d > 2) over++;
        sum += d;
      }
      const chunked = [];
      for (const size of sizes) {
        setHistChunkSizeForTests(size);
        const o = engineModulationGpu(gpu, mod, cam, dev, grid, hot);
        setHistChunkSizeForTests();
        let vsSingle = 0;
        let vsCpu = 0;
        for (let i = 0; i < cpu.length; i++) {
          vsSingle = Math.max(vsSingle, Math.abs(o[i] - out[i]));
          vsCpu = Math.max(vsCpu, Math.abs(o[i] - cpu[i]));
        }
        chunked.push({ size, vsSingle, vsCpu });
      }
      return { worst, over, mean: sum / cpu.length, n: cpu.length, cpuMs: t1 - t0, gpuMs: t2 - t1, unit: out.eUnit, err: gl.getError(), chunked };
    }, { W, H, sizes });
    if (!res) return t.skip('No float render targets');
    if (res.skip) return t.skip(res.skip);
    return res;
  } finally {
    await browser.close();
    server.close();
  }
}

test('the GPU modulation plane matches the CPU version', async (t) => {
  const res = await runScene(t, 1280, 960, []);
  if (res) {
    console.log(JSON.stringify(res));
    assert.equal(res.err, 0);
    assert.equal(res.unit, 30000);
    // Measured on SwiftShader: mean 0.0025, 83 of 1.2M values over 2 units, worst 48 (of 30000). The limits leave about 2x for other GPUs' float rounding.
    assert.ok(res.mean < 0.006, `mean difference ${res.mean} units of 30000`);
    assert.ok(res.over / res.n < 2e-4, `${res.over} values differ by more than 2 units`);
    assert.ok(res.worst <= 80, `worst difference ${res.worst}`);
  }
});

// The histogram is drawn in chunks so no float32 bin passes 2^24 (a sensor above about 67 MP). A tiny chunk size makes that path run here: the result must not depend on where the chunks split.
test('the GPU modulation histogram gives the same plane for any chunk size', async (t) => {
  const W = 480;
  const H = 360;
  const N = W * H;
  // 1000: 173 chunks; N / 2: two exact halves; N: exactly one full chunk; N - 1: total = chunk + 1 (a last chunk of one point).
  const res = await runScene(t, W, H, [1000, N / 2, N, N - 1]);
  if (!res) return;
  assert.equal(res.err, 0);
  assert.equal(res.chunked.length, 4);
  for (const c of res.chunked) {
    // The chunks add exact integer counts, so the quantile bins (hence the plane) are identical; the CPU tolerance is the one above.
    assert.equal(c.vsSingle, 0, `chunk size ${c.size} differs from the single-chunk plane by ${c.vsSingle}`);
    assert.ok(c.vsCpu <= 80, `chunk size ${c.size} differs from the CPU by ${c.vsCpu}`);
  }
  assert.ok(res.worst <= 80, `single-chunk worst difference ${res.worst}`);
});
