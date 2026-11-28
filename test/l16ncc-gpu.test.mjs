// The camera alignment search of the Light L16 telephoto detail on the graphics card (gpu/l16ncc.js, through core/l16hires.js setL16NccGpu) gives the processor's: the
// normalized correlation of every patch at every shift tried (samples that land outside the camera's picture left out, -2 where fewer than 90% land or the camera's samples
// are flat), and estimateCorrections' fitted correction for each camera on a made-up capture: a textured plane seen by the wide reference and two longer lens cameras whose
// pictures are off by a known shift that changes over the frame, a flat area and patches that fall off the cameras' pictures. Skipped where Playwright or its browser is not
// installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gpuPage } from './helpers/gpupage.mjs';

test('the L16 camera alignment search on the graphics card matches the processor’s', async (t) => {
  const page = await gpuPage(t);
  if (!page) return;
  const res = await page.evaluate(async () => {
    const gpu = await globalThis.makeGpu();
    if (!gpu) return null;
    const hires = await import('/js/core/l16hires.js');
    const { l16NccGpu } = await import('/js/gpu/l16ncc.js');
    // (every call to the card's functions counted, and any failure kept: the processor's code falls back to itself when one fails, which would compare it with itself)
    const log = { calls: 0, errors: [] };
    const watch = (v) => {
      if (typeof v === 'function') {
        return (...a) => {
          log.calls++;
          try {
            return watch(v(...a));
          } catch (e) {
            log.errors.push(String((e && e.message) || e));
            throw e;
          }
        };
      }
      if (v && typeof v === 'object' && !ArrayBuffer.isView(v) && Object.values(v).some((x) => typeof x === 'function')) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, watch(x)]));
      return v;
    };
    const ncc = watch(l16NccGpu(gpu));
    let seed = 11;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8) / 16777216;
    // a texture with no repeat within the search (waves of 15 to 60 pixels in many directions), and a flat square
    const waves = [];
    for (let k = 0; k < 14; k++) {
      const a = rnd() * Math.PI;
      const f = (2 * Math.PI) / (15 + 45 * rnd());
      waves.push([f * Math.cos(a), f * Math.sin(a), rnd() * 6.3, 0.03 + 0.05 * rnd()]);
    }
    const texture = (x, y) => {
      if (x > 60 && x < 140 && y > -120 && y < -40) return 0.4;
      let v = 0.45;
      for (const [fx, fy, p, a] of waves) v += a * Math.sin(fx * x + fy * y + p);
      return Math.min(0.95, Math.max(0.02, v));
    };

    // 1. The search itself: patches of a camera's picture (part of it made, at pox, poy of the half size picture) at a set of shifts, against the processor's nccAt
    // (core/l16hires.js estimateCorrections, step for step: it is inside that function).
    const pw = 120;
    const ph = 90;
    const pox = 7;
    const poy = 5;
    const lum = new Float32Array(pw * ph);
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) lum[y * pw + x] = x >= 80 && y >= 50 ? 0.3 : texture(3 * x, 3 * y + 200);
    const k = 144;
    const patches = [];
    const place = [[40, 40], [100, 60], [-6, 50], [2 * (pox + pw) - 30, 40], [200, 2 * (poy + ph) - 28], [2 * (pox + 91), 2 * (poy + 61)], [150, 120], [60, 140]];
    for (const [cx, cy] of place) {
      const sx = new Float32Array(k);
      const sy = new Float32Array(k);
      const a = new Float32Array(k);
      let m = 0;
      for (let j = 0; j < 12; j++) {
        for (let i = 0; i < 12; i++) {
          const n = j * 12 + i;
          sx[n] = cx + 2 * pox + 4 * i + 0.37 * j;
          sy[n] = cy + 2 * poy + 4 * j - 0.21 * i;
          a[n] = texture(sx[n] * 1.5, sy[n] * 1.5 + 200) + 0.02 * (rnd() - 0.5);
          m += a[n];
        }
      }
      m /= k;
      let va = 0;
      for (let n = 0; n < k; n++) va += (a[n] -= m) ** 2;
      patches.push({ k, a, va, sx, sy, bx: Math.round(6 * (rnd() - 0.5)), by: Math.round(6 * (rnd() - 0.5)) });
    }
    const shifts = [];
    for (let dy = -9; dy <= 9; dy += 3) for (let dx = -9; dx <= 9; dx += 3) shifts.push(dx + 0.25, dy - 0.5);
    const sample = (x0, y0) => {
      const x = x0 / 2 - 0.5 - pox;
      const y = y0 / 2 - 0.5 - poy;
      if (x < 0 || y < 0 || x >= pw - 1 || y >= ph - 1) return NaN;
      const ix = x | 0;
      const iy = y | 0;
      const fx = x - ix;
      const fy = y - iy;
      const i = iy * pw + ix;
      return (lum[i] * (1 - fx) + lum[i + 1] * fx) * (1 - fy) + (lum[i + pw] * (1 - fx) + lum[i + pw + 1] * fx) * fy;
    };
    const nccAt = (q, dx, dy) => {
      let sb = 0;
      let sbb = 0;
      let sab = 0;
      let m = 0;
      for (let i = 0; i < q.k; i++) {
        const v = sample(q.sx[i] + dx, q.sy[i] + dy);
        if (v !== v) continue;
        sb += v;
        sbb += v * v;
        sab += q.a[i] * v;
        m++;
      }
      if (m <= q.k * 0.9) return -2;
      const vb = sbb - (sb * sb) / m;
      return vb > 1e-12 ? sab / Math.sqrt(q.va * vb) : -2;
    };
    const card = ncc.open({ lum, pw, ph, pox, poy });
    const vals = card.search(patches, shifts);
    card.close();
    const S = shifts.length / 2;
    let worst = 0;
    let flagMismatch = 0;
    let flagged = 0;
    let bestMismatch = 0;
    const flaggedOf = [];
    patches.forEach((q, p) => {
      flaggedOf[p] = 0;
      let bc = -3;
      let bg = -3;
      let ic = -1;
      let ig = -1;
      for (let s = 0; s < S; s++) {
        const c = nccAt(q, q.bx + shifts[2 * s], q.by + shifts[2 * s + 1]);
        const g = vals[p * S + s];
        if ((c === -2) !== (g === -2)) flagMismatch++;
        else if (c === -2) {
          flagged++;
          flaggedOf[p]++;
        }
        else worst = Math.max(worst, Math.abs(c - g));
        if (c > bc) [bc, ic] = [c, s];
        if (g > bg) [bg, ig] = [g, s];
      }
      if (ic !== ig) bestMismatch++;
    });
    const direct = { worst, flagMismatch, flagged, flaggedOf, S, n: patches.length * S, bestMismatch, length: vals.length };

    // 2. estimateCorrections on a made-up capture, the search on the processor and then on the card. The reference A1 (fixed, the wide grid at grid 2, so sensor pixels
    // are twice its pixels) and two cameras with mono 10 bit sensors packed as the file has them: B1 (1.3 times the focal length, a baseline) and C1 (the same focal
    // length, turned a little), each picture off by a shift that changes over the frame.
    const grid = 2;
    const f0 = 1200;
    const W = 288;
    const H = 240;
    const Z0 = 3000;
    const mat = (m) => ({ x00: m[0], x01: m[1], x02: m[2], x10: m[3], x11: m[4], x12: m[5], x20: m[6], x21: m[7], x22: m[8] });
    const rotZ = (a) => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];
    const cams = {
      A1: { f: f0, cx: W, cy: H, R: rotZ(0), T: [0, 0, 0], size: [2 * W, 2 * H] },
      B1: { f: 1.3 * f0, cx: 360, cy: 300, R: rotZ(0), T: [12, -4, 0], size: [700, 560], off: [3.5, 40, -25, -2, -10, 30] },
      C1: { f: f0, cx: 300, cy: 250, R: rotZ(0.02), T: [-8, 6, 0], size: [560, 460], off: [-6, 0, 50, 4.5, 35, 0] },
    };
    const header = { module_calibration: [] };
    const modules = {};
    const blocks = [];
    let at = 0;
    for (const [id, c] of Object.entries(cams)) {
      header.module_calibration.push({
        camera_id: id,
        geometry: { mirror_type: 'NONE', per_focus_calibration: [{ intrinsics: { k_mat: mat([c.f, 0, c.cx, 0, c.f, c.cy, 0, 0, 1]) }, extrinsics: { canonical: { rotation: mat(c.R), translation: { x: c.T[0], y: c.T[1], z: c.T[2] } } } }] },
      });
      const [w, h] = c.size;
      const stride = (w / 4) * 5;
      modules[id] = [{ blockStart: at, module: { id, lens_position: 0, sensor_data_surface: { format: 'RAW_PACKED_10BPP', data_offset: 0, row_stride: stride, size: { x: w, y: h }, data_scale: { x: 1, y: 1 } }, sensor_bayer_red_override: { x: -1, y: -1 } } }];
      if (!c.off) continue;
      // the sensor: the plane where each pixel looks, from where it would look without the camera's misregistration (sensor point s shows what the calibration puts at s - d(s))
      const raw = new Uint16Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const u = (x + 0.5) / 4160;
          const v = (y + 0.5) / 3120;
          const ix = x + 0.5 - (c.off[0] + c.off[1] * u + c.off[2] * v);
          const iy = y + 0.5 - (c.off[3] + c.off[4] * u + c.off[5] * v);
          const d = [(ix - c.cx) / c.f, (iy - c.cy) / c.f, 1];
          const R = c.R;
          const rt = (p) => [R[0] * p[0] + R[3] * p[1] + R[6] * p[2], R[1] * p[0] + R[4] * p[1] + R[7] * p[2], R[2] * p[0] + R[5] * p[1] + R[8] * p[2]];
          const Rd = rt(d);
          const RT = rt(c.T);
          const l = (Z0 + RT[2]) / Rd[2];
          raw[y * w + x] = Math.round(42 + 981 * texture(((l * Rd[0] - RT[0]) / Z0) * f0, ((l * Rd[1] - RT[1]) / Z0) * f0));
        }
      }
      const bytes = new Uint8Array(stride * h);
      for (let y = 0; y < h; y++) {
        for (let g = 0; g < w / 4; g++) {
          const [p0, p1, p2, p3] = raw.subarray(y * w + 4 * g, y * w + 4 * g + 4);
          const o = y * stride + 5 * g;
          bytes[o] = p0 & 0xff;
          bytes[o + 1] = (p0 >> 8) | ((p1 & 0x3f) << 2);
          bytes[o + 2] = (p1 >> 6) | ((p2 & 0xf) << 4);
          bytes[o + 3] = (p2 >> 4) | ((p3 & 0x3) << 6);
          bytes[o + 4] = p3 >> 2;
        }
      }
      blocks.push(bytes);
      at += bytes.length;
    }
    const file = new Uint8Array(at);
    let o = 0;
    for (const b of blocks) {
      file.set(b, o);
      o += b.length;
    }
    const wide = { width: W, height: H, rgb: new Float32Array(3 * W * H) };
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = texture((x + 0.5) * grid - W, (y + 0.5) * grid - H);
        wide.rgb.set([v, v, v], 3 * (y * W + x));
      }
    }
    const depth = { ref: 'A1', width: 8, height: 6, invZ: new Float32Array(48).fill(1 / Z0) };
    const parsed = { header, modules };
    const opts = { black: 42, white: 1023, gains: [1, 1, 1], hot: false };
    hires.setL16NccGpu(null);
    const cpu = hires.estimateCorrections(file, parsed, depth, wide, grid, ['B1', 'C1'], opts);
    hires.setL16NccGpu(ncc);
    const onCard = hires.estimateCorrections(file, parsed, depth, wide, grid, ['B1', 'C1'], opts);
    hires.setL16NccGpu(null);
    // each fit compared where it is used: the shift it gives over the cameras' sensors
    const fits = {};
    for (const id of ['B1', 'C1']) {
      const a = cpu[id];
      const b = onCard[id];
      if (!a || !b) {
        fits[id] = { missing: [!a, !b] };
        continue;
      }
      const c = cams[id];
      let worstShift = 0;
      let truthWorst = 0;
      for (let y = 0; y <= c.size[1]; y += c.size[1] / 8) {
        for (let x = 0; x <= c.size[0]; x += c.size[0] / 8) {
          const u = x / 4160;
          const v = y / 3120;
          const at2 = (f) => [f.ax[0] + f.ax[1] * u + f.ax[2] * v, f.ay[0] + f.ay[1] * u + f.ay[2] * v];
          const [ax, ay] = at2(a);
          const [bx, by] = at2(b);
          worstShift = Math.max(worstShift, Math.abs(ax - bx), Math.abs(ay - by));
          truthWorst = Math.max(truthWorst, Math.abs(ax - (c.off[0] + c.off[1] * u + c.off[2] * v)), Math.abs(ay - (c.off[3] + c.off[4] * u + c.off[5] * v)));
        }
      }
      fits[id] = { n: [a.n, b.n], rms: [a.rms, b.rms], worstShift, truthWorst };
    }
    return { direct, fits, err: gpu.gl.getError(), log };
  });
  if (!res) return t.skip('No float render targets');
  assert.equal(res.err, 0);
  assert.deepEqual(res.log.errors, [], 'a step on the graphics card failed');
  assert.ok(res.log.calls > 0, 'the graphics card was not used');
  const d = res.direct;
  assert.equal(d.length, d.n);
  // -2 (too few samples on the picture, or the camera's samples flat) on the same patches and shifts: the flat patch (5) everywhere, a patch inside the picture (0) nowhere,
  // the ones at its edges at some shifts
  assert.equal(d.flagMismatch, 0, `${d.flagMismatch} correlations are -2 on one side only`);
  assert.equal(d.flaggedOf[5], d.S, 'the flat patch');
  assert.equal(d.flaggedOf[0], 0, 'the patch inside the picture');
  assert.ok(d.flaggedOf.some((f) => f > 0 && f < d.S), `no patch at the picture's edge: ${d.flaggedOf}`);
  // A correlation (at most 1) from sums over 144 samples, in single precision on the card (about the first sample, so the variance keeps its precision) and double on the
  // processor: about 144 units in the last place at worst, 1e-5 (measured 6.4e-7 on SwiftShader).
  assert.ok(d.worst < 2e-5, `the correlations differ by up to ${d.worst}`);
  // (no near ties here: every patch's best shift is the same one)
  assert.equal(d.bestMismatch, 0, `${d.bestMismatch} patches pick a different best shift`);
  for (const [id, f] of Object.entries(res.fits)) {
    assert.ok(!f.missing, `${id}: no correction on the ${f.missing && f.missing[0] ? 'processor' : 'card'}`);
    // the same patches kept, and the fitted shift the same over the sensor: the patches' best shifts are the same, and their between-step parts move by the
    // correlations' difference over the peak's curvature (measured 1.2e-4 pixels), held to 5e-3 of a sensor pixel
    assert.equal(f.n[1], f.n[0], `${id}: patches used`);
    assert.ok(f.worstShift < 5e-3, `${id}: the fitted shifts differ by up to ${f.worstShift} pixels`);
    assert.ok(Math.abs(f.rms[0] - f.rms[1]) < 5e-3, `${id}: rms ${f.rms}`);
    // (and the search found the misregistration the pictures were made with, to within the half size picture's precision)
    assert.ok(f.truthWorst < 1, `${id}: the fit is off the made-up shift by up to ${f.truthWorst} pixels`);
  }
});
