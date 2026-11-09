// The Lytro sensor-side ray splat on the GPU (gpu/lytroengine.js lytroSplatGpu) against the CPU's (core/lytroedof.js lytroSplat), in a headless browser, on one small synthetic
// sensor: hexagonal lenses with disc shading, a colored texture, a white image (modulation), a camera ray table that moves the rays, and a depth map with a step. The CPU run
// (no opts.gpu) and the GPU run (opts.gpu = lytroSplatGpu, as worker.js wires it) each fill the output's accumulation; they must agree, including the march (step, dispScale)
// and the depth views. Skipped where Playwright or its browser is not installed.
//
// Gate conditions of lytroSplat (core/lytroedof.js, the `if (opts.gpu && ...)` line) this scene meets: opts.gpu, step >= 1, rayWarp and modulation given (so no picture warp),
// demosaic 'engine', shape 'hex', nearest, none of inner / geoSign / vScale / persp / apFall / apCone / plainMarch / posX / posY / posUScale / marchDu / marchDv / alphaPow / noFar,
// gctFirst and apShift on, duScale 1. The views case adds the two it needs: an exact ray model with a geometry table (viewHits) and opts.sensorRaster.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './helpers/playwright.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const types = { '.js': 'text/javascript', '.html': 'text/html' };

// Runs the same scene on the CPU and on the GPU for each variant of the options; returns the comparison per variant (null where there is no float rendering here).
async function compare(t, variants) {
  const browser = await launchBrowser(t);
  if (!browser) return undefined;
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
    page.setDefaultTimeout(600000);
    await page.goto(`http://localhost:${server.address().port}/t.html`);
    return await page.evaluate(async (variants) => {
      const { GpuRenderer } = await import('/js/gpu/renderer.js');
      const { lytroSplatGpu } = await import('/js/gpu/lytroengine.js');
      const { lytroSplat, SPLAT } = await import('/js/core/lytroedof.js');
      const { makeDevelopParams } = await import('/js/core/render.js');
      const { parseRayWarp } = await import('/js/core/raywarp.js');
      const { LAMBDA_TO_ALPHA } = await import('/js/core/recipe.js');
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float') || !gl.getExtension('EXT_float_blend')) return null;
      const gpu = new GpuRenderer(gl);
      if (!gpu.floatBlend) return null;

      let seed = 21;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      const width = 192;
      const height = 168;
      const cam = { width, height, white: [1023, 1023, 1023], black: [64, 64, 64], wb: [1.6, 1, 1.4], cfa: [[0, 1], [1, 2]] };
      const dev = makeDevelopParams(cam);
      const pitch = 13.4;
      const grid = { pitch, rowStep: pitch * 0.8660254037844386, ox: 6.2, oy: 5.1, rotation: 0.002 };
      // the lens lattice's disc profile: 1 at a lens center, falling to the rim
      const cs = Math.cos(grid.rotation);
      const sn = Math.sin(grid.rotation);
      const rim = (x, y) => {
        const dx = x - grid.ox;
        const dy = y - grid.oy;
        const u = cs * dx + sn * dy;
        const v = -sn * dx + cs * dy;
        const row = Math.round(v / grid.rowStep);
        let best = 1e9;
        for (let r = row - 1; r <= row + 1; r++) {
          const off = (r & 1) * pitch * 0.5;
          const col = Math.round((u - off) / pitch);
          const du = u - (col * pitch + off);
          const dv = v - r * grid.rowStep;
          best = Math.min(best, du * du + dv * dv);
        }
        return Math.sqrt(best) / (pitch * 0.5);
      };
      const raw = new Uint16Array(width * height);
      const modulation = new Uint16Array(width * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const q = rim(x, y);
          const disc = Math.max(0.03, 1 - 0.85 * q ** 2.2);
          const ch = cam.cfa[y & 1][x & 1];
          // a colored texture the rays see (varies along both axes, differently per color) under the disc shading
          const tex = [0.55 + 0.4 * Math.sin(x * 0.21 + y * 0.05), 0.55 + 0.4 * Math.sin(y * 0.17 - x * 0.04), 0.55 + 0.4 * Math.sin((x + y) * 0.13)][ch];
          const m = 64 + 850 * disc * [0.9, 1, 0.85][ch];
          modulation[y * width + x] = Math.round(m);
          raw[y * width + x] = Math.round(64 + (m - 64) * tex + (rnd() - 0.5) * 0);
        }
      }
            // a camera ray table that shifts the rays along the image radius (core/raywarp.js layout, as test/raywarp.test.mjs builds it)
      const table = (radial) => {
        const r = Math.fround;
        const [aMax, bMax, stepA, stepB, stepC] = [0.58, 0.58, 0.008, 0.03, 0.05].map(r);
        const na = Math.ceil(r(r(r(1) / stepA) * aMax)) + 2;
        const nb = Math.ceil(r(r(r(1) / stepB) * bMax)) + 2;
        const nc = Math.ceil(r(r(r(1) / stepC) * 2)) + 2;
        const nodes = na * nb * nc;
        const bytes = new Uint8Array(104 + 18 * nodes);
        const v = new DataView(bytes.buffer);
        v.setUint32(0, 0xaf0990fa, true);
        v.setInt32(4, 3, true);
        v.setInt32(16, bytes.length, true);
        [-0.5, -0.5, -0.5, -0.5].forEach((m, k) => v.setFloat32(28 + 4 * k, m, true));
        [1, 1, 1, 1].forEach((e, k) => v.setFloat32(44 + 4 * k, e, true));
        [0.125, 0.125, 0.125, 0.125].forEach((s, k) => v.setFloat32(60 + 4 * k, s, true));
        v.setInt32(76, 2, true);
        v.setInt32(80, 0, true);
        [aMax, bMax, stepA, stepB, stepC].forEach((p, k) => v.setFloat32(84 + 4 * k, p, true));
        for (let ic = 0; ic < nc; ic++) for (let ib = 0; ib < nb; ib++) for (let ia = 0; ia < na; ia++) v.setFloat32(104 + 4 * (2 * (ia + na * (ic + nc * ib))), radial(ia), true);
        bytes.fill(1, 104 + 16 * nodes);
        return bytes;
      };
      const rayWarp = parseRayWarp(table((ia) => 0.0006 * ia), width, height, { tilt: false, chief: true });
      if (!rayWarp) throw new Error('ray table');

      // the picture's frame: one picture pixel per lens row step on the sensor, `scale` output pixels to a picture pixel
      const unit = grid.rowStep;
      const sampler = { xMin: 0, yMin: 0, outW: Math.ceil(width / unit), outH: Math.ceil(height / unit) };
      const lw = sampler.outW;
      const lh = sampler.outH;
      const scale = 4;
      // depth (in alpha units): a tilted plane with a near step across the middle
      const depth = new Float32Array(lw * lh);
      for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) depth[y * lw + x] = LAMBDA_TO_ALPHA * (-1.5 + 0.1831 * x + 0.0537 * y + (x > lw * 0.55 ? 2.4137 : 0));
      const vg = { tilesX: 1, tilesY: 1, width, height, bins: 4, rMax: pitch, gain: new Float32Array(4 * 4 * 3).fill(1) };
      // a geometry table (the exact ray model): a smooth, small shift per cell
      const gw = 5;
      const gh = 4;
      const geoTable = { w: gw, h: gh, data: new Float32Array(gw * gh * 2).map((_, i) => 0.01 * Math.sin(i * 1.3)) };
      gpu.setRaw(raw, cam, dev);

      // An aperture of 0.8 makes the plane radius (hex corner + 2 = 8.2 px) exceed half a pitch (6.7), so the lenses at the lens range's edge are the case where a pixel's nearest lens is not
      // one the CPU visits. A smaller one (below about 0.55) hides that, so the other apertures below are not enough alone.
      const run = (opts, extra, gpuOn, W, H) => {
        const o = { ...SPLAT, aperture: 0.8, ...opts };
        let gpuUsed = false;
        if (gpuOn) {
          o.gpu = (input) => {
            const a = lytroSplatGpu(gpu, input);
            gpuUsed = !!a;
            return a;
          };
        }
        const r = lytroSplat({ raw, cam, dev, grid, sampleGrid: { ...grid, ox: 0, oy: 0, rotation: 0 }, sampler, vignetting: vg, depth, scale, lens: null, W, H, rayWarp, modulation, ...extra }, o);
        return { r, gpuUsed };
      };
      const maxAbs = (a, b) => {
        let worst = 0;
        for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
        return worst;
      };
      const out = [];
      for (const v of variants) {
        const extra = v.exact ? { geoTable } : {};
        const opts = { ...v.opts };
        if (v.exact) opts.exact = true;
        if (v.views) opts.views = v.views;
        // the views are on the engine's raster: one texel per lens pitch over the sensor
        const W = v.views ? Math.round(width / pitch) : lw * scale;
        const H = v.views ? Math.round(height / pitch) : lh * scale;
        const cpu = run(opts, extra, false, W, H);
        const gp = run(opts, extra, true, W, H);
        const res = { name: v.name, gpuUsed: gp.gpuUsed };
        const planes = v.views ? v.views.length : 1;
        const cpuAcc = v.views ? cpu.r.views : [cpu.r.acc];
        const gpuAcc = v.views ? gp.r.views : [gp.r.acc];
        let alphaSum = 0;
        let worst = 0;
        let worstAlpha = 0;
        let off = 0;
        let covered = 0;
        let colorWorst = 0;
        for (let k = 0; k < planes; k++) {
          const a = cpuAcc[k];
          const b = gpuAcc[k];
          worst = Math.max(worst, maxAbs(a, b));
          for (let p = 0; p < W * H; p++) {
            alphaSum += a[4 * p + 3];
            worstAlpha = Math.max(worstAlpha, Math.abs(a[4 * p + 3] - b[4 * p + 3]));
            if (a[4 * p + 3] > 1e-3) covered++;
            if (Math.abs(a[4 * p + 3] - b[4 * p + 3]) > 1e-3 * Math.max(1, a[4 * p + 3])) off++;
            if (a[4 * p + 3] > 0.05 && b[4 * p + 3] > 0.05) for (let c = 0; c < 3; c++) colorWorst = Math.max(colorWorst, Math.abs(a[4 * p + c] / a[4 * p + 3] - b[4 * p + c] / b[4 * p + 3]));
          }
        }
        out.push({ ...res, worst, worstAlpha, off, covered, pixels: planes * W * H, alphaSum, colorWorst });
      }
      return { out, err: gl.getError() };
    }, variants);
  } finally {
    await browser.close();
    server.close();
  }
}

test('the GPU ray splat matches the CPU (default options, march step and displacement scale, depth views)', async (t) => {
  // as the app's views: discs on a ring around the center of the aperture (disjoint, so a ray belongs to at most one: the GPU takes the first view that holds it)
  const views = [0, 120, 240].map((deg) => ({ u: 0.25 * Math.cos((deg * Math.PI) / 180), v: 0.25 * Math.sin((deg * Math.PI) / 180), r2: 0.12 * 0.12 }));
  const res = await compare(t, [
    { name: 'defaults', opts: {} },
    { name: 'no ray weight', opts: { modPow: 0 } },
    { name: 'dispScale 1.25', opts: { dispScale: 1.25 } },
    { name: 'dispScale 0.8', opts: { dispScale: 0.8 } },
    { name: 'step 1.5', opts: { step: 1.5 } },
    { name: 'step 1.7 dispScale 1.1', opts: { step: 1.7, dispScale: 1.1 } },
    { name: 'step 4 dispScale 0.9', opts: { step: 4, dispScale: 0.9 } },
    { name: 'step 2', opts: { step: 2 } },
    { name: 'step 3, aperture 0.6', opts: { step: 3, aperture: 0.6 } },
    { name: 'exact', exact: true, opts: {} },
    { name: 'views', exact: true, opts: { sensorRaster: true }, views },
  ]);
  if (res === undefined) return;
  if (!res) return t.skip('No WebGL2 with float targets');
  assert.equal(res.err, 0);
  for (const r of res.out) {
    assert.ok(r.gpuUsed, `${r.name}: the GPU path was not taken (the gate refused)`);
    assert.ok(r.covered > 0.25 * r.pixels, `${r.name}: only ${r.covered} of ${r.pixels} output pixels hold rays`);
    // Measured on SwiftShader (float32 against the CPU's doubles): the largest difference of any accumulated value 4.7e-4 (values up to about 15), of a pixel's mean color 6e-5. The limits leave 4x or more.
    assert.ok(r.worst < 2e-3, `${r.name}: largest accumulation difference ${r.worst}`);
    assert.ok(r.worstAlpha < 2e-3, `${r.name}: largest weight difference ${r.worstAlpha}`);
    assert.ok(r.colorWorst < 5e-4, `${r.name}: largest mean color difference ${r.colorWorst}`);
    assert.equal(r.off, 0, `${r.name}: ${r.off} pixels differ in weight by more than 1e-3 (relative)`);
  }
});
