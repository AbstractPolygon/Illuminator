// A Light L16 view with the viewpoint moved far, its holes filled on the graphics card (gpu/l16holes.js, as worker.js l16Holes calls it), against the processor's path the
// worker takes without the card (core/l16view.js synthesize, backgroundDepth, superpixelColor, fillFromDonors, fillFromBackground). A made-up scene: a far wall, a slope and
// a near box, three donor cameras with their packed 10 bit rows (one with lens distortion, one off to the side that sees only part of the holes, each with its color order).
// Compared: the splat's holes, the depth and the colors of the finished view. Skipped where Playwright or its browser is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gpuPage } from './helpers/gpupage.mjs';

test('the L16 holes filled on the graphics card match the processor’s', async (t) => {
  const page = await gpuPage(t);
  if (!page) return;
  const res = await page.evaluate(async () => {
    const gpu = await globalThis.makeGpu();
    if (!gpu) return null;
    const gl = gpu.gl;
    const { l16HolesGpu } = await import('/js/gpu/l16holes.js');
    const { synthesize, backgroundDepth, superpixelColor, fillFromDonors, fillFromBackground } = await import('/js/core/l16view.js');
    const { makeDistortion } = await import('/js/core/l16geometry.js');
    let s = 31;
    const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 8) / 16777216;
    // the reference: 96 x 72 picture pixels, 2 sensor pixels each
    const w = 96;
    const h = 72;
    const S = 2;
    const K = [256, 0, 96, 0, 256, 72, 0, 0, 1];
    const focal = K[0] / 2;
    const rgb = new Float32Array(3 * w * h);
    for (let i = 0; i < w * h; i++) {
      const x = i % w;
      const y = (i - x) / w;
      for (let c = 0; c < 3; c++) rgb[3 * i + c] = 0.3 + 0.2 * Math.sin(0.21 * x + 0.13 * y + c) + 0.05 * rnd();
    }
    // depth (mm): a far wall, a near box and a nearer post; `slope` adds a wall turning away on the left (footprints stretched by a fraction of a pixel)
    const depthOf = (slope) => {
      const z = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let v = 4096;
          if (slope && x < 30) v = 2048 + (2048 * x) / 30;
          if (x >= 40 && x < 64 && y >= 20 && y < 50) v = 1024;
          if (x >= 72 && x < 78 && y >= 8) v = 768;
          z[y * w + x] = v;
        }
      }
      return z;
    };
    // the donors (each sees the left two thirds of the reference's view, so the post's holes on the right are left to the background fill): their sensors' 10 bit values in one file, packed as the L16 does (4 values in 5 bytes, rows padded)
    const specs = [
      { size: { x: 136, y: 152 }, K: [256, 0, 96, 0, 256, 76, 0, 0, 1], R: [1, 0, 0, 0, 1, 0, 0, 0, 1], T: [-20, 0, 0], red: { x: 0, y: 0 }, poly: null },
      { size: { x: 140, y: 160 }, K: [250, 0, 98, 0, 252, 80, 0, 0, 1], R: [0.9998, -0.02, 0, 0.02, 0.9998, 0, 0, 0, 1], T: [8, 18, 2], red: { x: 1, y: 0 }, poly: { coeffs: [0.04, -0.01, 0.001, -0.002, 0.003], normalization: { x: 100, y: 80 }, distortion_center: { x: 97, y: 81 } } },
      { size: { x: 132, y: 136 }, K: [240, 0, 92, 0, 240, 68, 0, 0, 1], R: [1, 0, 0, 0, 1, 0, 0, 0, 1], T: [70, -45, 0], red: { x: 0, y: 1 }, poly: null },
    ];
    const opts = { black: 42, white: 1023, gains: [1.8, 1, 1.5] };
    let total = 16;
    const layout = specs.map((sp) => {
      const stride = (sp.size.x / 4) * 5 + 8;
      const at = total;
      total += stride * sp.size.y + 32;
      return { stride, at };
    });
    const bytes = new Uint8Array(total);
    specs.forEach((sp, k) => {
      const { stride, at } = layout[k];
      for (let y = 0; y < sp.size.y; y++) {
        for (let g = 0; g < sp.size.x / 4; g++) {
          const v = [0, 1, 2, 3].map((j) => {
            const x = 4 * g + j;
            return Math.min(1023, Math.max(0, Math.round(300 + 250 * Math.sin(0.05 * x + 0.07 * y + k) + 120 * ((x + y) & 1) + 40 * rnd())));
          });
          const o = at + y * stride + 5 * g;
          bytes[o] = v[0] & 255;
          bytes[o + 1] = (v[0] >> 8) | ((v[1] & 63) << 2);
          bytes[o + 2] = (v[1] >> 6) | ((v[2] & 15) << 4);
          bytes[o + 3] = (v[2] >> 4) | ((v[3] & 3) << 6);
          bytes[o + 4] = v[3] >> 2;
        }
      }
    });
    const donorsFor = (tx, ty) =>
      specs.map((sp, k) => {
        const cam = { K: sp.K, distort: makeDistortion(sp.poly ? { distortion: { polynomial: sp.poly } } : {}) };
        const rel = { R: sp.R, T: sp.T };
        const frame = { blockStart: layout[k].at, module: { sensor_data_surface: { size: sp.size, row_stride: layout[k].stride, data_offset: 0, format: 'RAW_PACKED_10BPP' }, sensor_bayer_red_override: sp.red } };
        const c = [-(rel.R[0] * rel.T[0] + rel.R[3] * rel.T[1] + rel.R[6] * rel.T[2]), -(rel.R[1] * rel.T[0] + rel.R[4] * rel.T[1] + rel.R[7] * rel.T[2])];
        return { cam, rel, frame, dist: Math.hypot(c[0] - tx, c[1] - ty), packed: { bytes, start: layout[k].at, stride: layout[k].stride }, size: sp.size, red: sp.red, mono: false, opts };
      });
    const cases = [
      // (whole pixel moves: every footprint lands on pixel edges, so the splat is exact in single precision too)
      { name: 'whole pixel moves', slope: false, tx: 32, ty: -32, pivotZ: 0 },
      { name: 'a slope, the scene turned about a pivot', slope: true, tx: -27, ty: 13, pivotZ: 2500 },
      // (toward the camera with lens distortion, which is then asked first)
      { name: 'toward the distorted camera', slope: true, tx: -12, ty: 24, pivotZ: 0 },
    ];
    const fill = l16HolesGpu(gpu);
    const out = [];
    for (const c of cases) {
      const z = depthOf(c.slope);
      // the processor, as worker.js l16Holes does it without the card
      const view = synthesize({ rgb, width: w, height: h, z }, focal, c.tx, c.ty, c.pivotZ);
      const gapCpu = Uint8Array.from(view.hole);
      const cpuDonors = donorsFor(c.tx, c.ty).map((d) => ({ cam: d.cam, rel: d.rel, color: superpixelColor(bytes, d.frame, opts) }));
      const fromDonors = fillFromDonors(view, { rgb, width: w, height: h, z, K, scale: S }, cpuDonors, c.tx, c.ty, backgroundDepth(view.z, view.hole, w, h));
      fillFromBackground(view, w, h);
      // the card, with the donors sorted nearest the new viewpoint first as the worker sorts them
      const r = fill({ rgb, z, w, h, focal, tx: c.tx, ty: c.ty, pivotZ: c.pivotZ, K, S, donors: donorsFor(c.tx, c.ty).sort((a, b) => a.dist - b.dist) });
      let holes = 0;
      let gapDiffer = 0;
      let zDiffer = 0;
      let rgbDiffer = 0;
      let worst = 0;
      for (let i = 0; i < w * h; i++) {
        holes += gapCpu[i];
        if (gapCpu[i] !== r.gap[i]) gapDiffer++;
        const zc = view.z[i];
        const zg = r.z[i];
        const zSame = zc === zg || Math.abs(zc - zg) <= 1e-6 * zc;
        if (!zSame) zDiffer++;
        let d = 0;
        for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(view.rgb[3 * i + k] - r.rgb[3 * i + k]));
        worst = Math.max(worst, d);
        if (d > 1e-5) rgbDiffer++;
      }
      out.push({ name: c.name, holes, fromDonors, gapDiffer, zDiffer, rgbDiffer, worst, err: gl.getError() });
    }
    return { n: w * h, out };
  });
  if (!res) return t.skip('No float render targets');
  console.log(JSON.stringify(res.out));
  for (const c of res.out) {
    assert.equal(c.err, 0, c.name);
    // (the move opens holes, and the donors fill a good part but not all of them: both fills are in the comparison)
    assert.ok(c.holes > 100, `${c.name}: only ${c.holes} holes`);
    assert.ok(c.fromDonors > c.holes / 5 && c.fromDonors < c.holes, `${c.name}: ${c.fromDonors} of ${c.holes} holes filled from the donors`);
    // The splat and the sweeps compare depths and pixel edges: the same in single precision on these inputs.
    assert.equal(c.gapDiffer, 0, `${c.name}: ${c.gapDiffer} pixels differ in the splat's holes`);
    assert.equal(c.zDiffer, 0, `${c.name}: ${c.zDiffer} pixels differ in depth`);
    // Colors are copied, or bilinear lookups in the donors with gains from sums: single precision, a few float steps on values up to about 2.
    assert.ok(c.worst < 1e-5, `${c.name}: the colors differ by up to ${c.worst} (${c.rgbDiffer} pixels over 1e-5)`);
  }
});
