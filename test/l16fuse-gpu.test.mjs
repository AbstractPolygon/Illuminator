// The merge of a Light L16 photo's cameras on the graphics card (gpu/l16fuse.js, set with core/l16fusion.js setL16FuseGpu) gives the processor's (core/l16fusion.js fuse)
// on a small made-up photo: a reference and three cameras (one of them the monochrome camera) with their poses, focal lengths and lens distortion, a capture correction
// for one, a depth map with a near box, cameras that see the scene a little differently in color and miss parts of it at the borders. Compared: the half size merge kept
// on the card (as the app makes it), the same made in bands read back one at a time, the full size merge, and the half size merge with the camera pictures prepared on the
// card too (gpu/l16prep.js), so the color gains are taken there. Skipped where Playwright or its browser is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gpuPage } from './helpers/gpupage.mjs';

test('the L16 merge on the graphics card matches the processor’s', async (t) => {
  const page = await gpuPage(t);
  if (!page) return;
  const res = await page.evaluate(async () => {
    const gpu = await globalThis.makeGpu();
    if (!gpu) return null;
    const { fuse, setL16FuseGpu, setL16PrepGpu, setL16SpecksGpu } = await import('/js/core/l16fusion.js');
    const { l16FuseGpu } = await import('/js/gpu/l16fuse.js');
    const { l16PrepGpu } = await import('/js/gpu/l16prep.js');
    // (counted, and the processor's fallback watched for: a card that failed would leave the processor's merge on both sides)
    const card = l16FuseGpu(gpu);
    const calls = { reference: 0, begin: 0, camera: 0, end: 0 };
    const counted = { drop: card.drop };
    for (const k of Object.keys(calls)) counted[k] = (...a) => (calls[k]++, card[k](...a));
    const banded = { ...counted, begin: undefined };
    const prep = l16PrepGpu(gpu);
    const warnings = [];
    const warn = console.warn;
    console.warn = (...a) => warnings.push(a.map(String).join(' '));
    let s = 13;
    const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 8) / 16777216;
    const SW = 192;
    const SH = 144;
    // The scene on the reference's undistorted grid (full size pixels), in linear color: a pattern, a near box with an edge of its own, a highlight past the white level.
    const inBox = (u, v) => u > 70 && u < 120 && v > 45 && v < 95;
    const scene = (u, v) => {
      const a = 0.3 + 0.15 * Math.sin(0.23 * u + 0.11 * v) + 0.1 * Math.cos(0.17 * v - 0.05 * u);
      if (inBox(u, v)) return [0.55 + 0.2 * Math.sin(0.5 * u), 0.35, 0.2 + 0.1 * Math.cos(0.4 * v)];
      if ((u - 40) ** 2 + (v - 110) ** 2 < 120) return [1.4, 1.3, 1.2];
      return [a * 0.8, a, a * (0.7 + 0.3 * Math.sin(0.02 * u))];
    };
    const Z_FAR = 800;
    const Z_NEAR = 500;
    const rotation = (a, b, c) => {
      const [ca, sa, cb, sb, cc, sc] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b), Math.cos(c), Math.sin(c)];
      return [cb * cc, sa * sb * cc - ca * sc, ca * sb * cc + sa * sc, cb * sc, sa * sb * sc + ca * cc, ca * sb * sc - sa * cc, -sb, sa * cb, ca * cb];
    };
    const KREF = [200, 0, 96, 0, 200, 72, 0, 0, 1];
    // The cameras: id, the red site's phase ({ x: -1 }: monochrome), focal length, center, pose (scene to camera), lens distortion, its color as it sees it.
    const specs = [
      { id: 'A1', red: { x: 0, y: 0 }, f: 200, c: [96, 72], R: rotation(0, 0, 0), T: [0, 0, 0], k: [0.03, -0.01, 2e-4, -1e-4, 0.002], dc: [97, 71], tint: [1, 1, 1] },
      { id: 'A2', red: { x: 1, y: 0 }, f: 203, c: [94, 73], R: rotation(0.004, -0.006, 0.01), T: [-12, 0, 0.5], k: [0.025, 0.004, -1e-4, 2e-4, 0], dc: [95, 74], tint: [1.08, 1, 0.93] },
      { id: 'A3', red: { x: 0, y: 1 }, f: 198, c: [97, 70], R: rotation(-0.005, 0.003, -0.004), T: [0, 10, -0.3], k: [0.035, -0.012, 0, 0, 0.001], dc: [96, 70], tint: [0.94, 1.02, 1.06] },
      { id: 'A4', red: { x: -1, y: -1 }, f: 201, c: [95, 72], R: rotation(0.002, 0.007, 0.003), T: [8, -8, 0], k: [0.02, 0, 1e-4, 0, 0], dc: [96, 72], tint: [1, 1.1, 1] },
    ];
    const distort = (sp, x, y) => {
      const [k1, k2, p1, p2, k3] = sp.k;
      const u = (x - sp.dc[0]) / 200;
      const v = (y - sp.dc[1]) / 200;
      const r2 = u * u + v * v;
      const g = 1 + ((k3 * r2 + k2) * r2 + k1) * r2;
      return [sp.dc[0] + 200 * (p1 * 2 * u * v + p2 * (r2 + 2 * u * u) + g * u), sp.dc[1] + 200 * (p2 * 2 * u * v + p1 * (r2 + 2 * v * v) + g * v)];
    };
    // What a camera's sensor pixel sees: its undistorted point (a few fixed point rounds), the ray met with the far plane or the box, and the scene there.
    const sees = (sp, sx, sy) => {
      let [ix, iy] = [sx, sy];
      for (let k = 0; k < 4; k++) {
        const [dx, dy] = distort(sp, ix, iy);
        ix += sx - dx;
        iy += sy - dy;
      }
      const d = [(ix - sp.c[0]) / sp.f, (iy - sp.c[1]) / sp.f, 1];
      const R = sp.R;
      // (the point at depth Z along the ray, in the reference's frame: R^T (lambda d - T), with lambda so that its z is Z)
      const at = (Z) => {
        const q = (l) => [0, 1, 2].map((r) => R[r] * (l * d[0] - sp.T[0]) + R[3 + r] * (l * d[1] - sp.T[1]) + R[6 + r] * (l * d[2] - sp.T[2]));
        const z0 = q(0)[2];
        const z1 = q(1)[2] - z0;
        const P = q((Z - z0) / z1);
        return [(KREF[0] * P[0]) / P[2] + KREF[2], (KREF[4] * P[1]) / P[2] + KREF[5]];
      };
      let [u, v] = at(Z_NEAR);
      if (!inBox(u, v)) [u, v] = at(Z_FAR);
      return scene(u, v);
    };
    // The frames, one after another in one file: packed 10 bit rows, as the camera writes them.
    const stride = (SW / 4) * 5;
    const frameBytes = SH * stride;
    const bytes = new Uint8Array(specs.length * frameBytes + 64);
    const parsed = { header: { module_calibration: [] }, modules: {} };
    const mat = (m) => ({ x00: m[0], x01: m[1], x02: m[2], x10: m[3], x11: m[4], x12: m[5], x20: m[6], x21: m[7], x22: m[8] });
    specs.forEach((sp, n) => {
      const blockStart = 32 + n * frameBytes;
      const mono = sp.red.x < 0;
      const dn = new Uint16Array(SW * SH);
      for (let y = 0; y < SH; y++) {
        for (let x = 0; x < SW; x++) {
          const c = sees(sp, x + 0.5, y + 0.5);
          const isR = (x & 1) === sp.red.x && (y & 1) === sp.red.y;
          const isB = (x & 1) !== sp.red.x && (y & 1) !== sp.red.y;
          // (the camera's shading: a little darker toward the corners; its color as the white balance sees it)
          const shade = 1 - 0.15 * (((x - SW / 2) / SW) ** 2 + ((y - SH / 2) / SH) ** 2);
          const v = mono ? 0.3 * c[0] + 0.55 * c[1] + 0.15 * c[2] : isR ? (c[0] * sp.tint[0]) / 1.9 : isB ? (c[2] * sp.tint[2]) / 1.6 : c[1] * sp.tint[1];
          dn[y * SW + x] = Math.max(0, Math.min(1023, Math.round(42 + v * shade * sp.tint[1] * 981 + 8 * (rnd() - 0.5))));
        }
      }
      for (let y = 0; y < SH; y++) {
        for (let g = 0; g < SW / 4; g++) {
          const o = blockStart + y * stride + 5 * g;
          const [a, b, c, d] = dn.subarray(y * SW + 4 * g, y * SW + 4 * g + 4);
          bytes[o] = a & 0xff;
          bytes[o + 1] = (a >> 8) | ((b & 0x3f) << 2);
          bytes[o + 2] = (b >> 6) | ((c & 0xf) << 4);
          bytes[o + 3] = (c >> 4) | ((d & 0x3) << 6);
          bytes[o + 4] = d >> 2;
        }
      }
      parsed.modules[sp.id] = [{ blockStart, module: { id: sp.id, sensor_bayer_red_override: sp.red, sensor_exposure: 1e7, lens_position: 0, sensor_data_surface: { size: { x: SW, y: SH }, format: 'RAW_PACKED_10BPP', data_offset: 0, row_stride: stride } } }];
      parsed.header.module_calibration.push({
        camera_id: sp.id,
        geometry: {
          mirror_type: 'NONE',
          per_focus_calibration: [{ intrinsics: { k_mat: mat([sp.f, 0, sp.c[0], 0, sp.f, sp.c[1], 0, 0, 1]) }, extrinsics: { canonical: { rotation: mat(sp.R), translation: { x: sp.T[0], y: sp.T[1], z: sp.T[2] } } } }],
          distortion: { polynomial: { coeffs: sp.k, normalization: { x: 200, y: 200 }, distortion_center: { x: sp.dc[0], y: sp.dc[1] } } },
        },
      });
    });
    // the depth (1 / mm on a 24 x 18 grid over the reference's picture): the far plane and the near box
    const dw = 24;
    const dh = 18;
    const invZ = new Float32Array(dw * dh);
    for (let j = 0; j < dh; j++) for (let i = 0; i < dw; i++) invZ[j * dw + i] = inBox(((i + 0.5) * SW) / dw, ((j + 0.5) * SH) / dh) ? 1 / Z_NEAR : 1 / Z_FAR;
    const depth = { ref: 'A1', modules: ['A2', 'A3', 'A4'], invZ, width: dw, height: dh };
    const corrections = { A2: { ax: [0.4, -0.3, 0.2], ay: [-0.2, 0.1, 0.3] } };
    const opts = { black: 42, white: 1023, gains: [1.9, 1, 1.6], hot: true };
    const merge = (fuseHook, prepHook, grid) => {
      setL16FuseGpu(fuseHook);
      setL16PrepGpu(prepHook);
      setL16SpecksGpu(null);
      try {
        return fuse(bytes, parsed, depth, opts, () => {}, { grid, corrections });
      } finally {
        setL16FuseGpu(null);
        setL16PrepGpu(null);
      }
    };
    const compare = (a, b) => {
      let worst = 0;
      let sum = 0;
      let over = 0;
      for (let i = 0; i < a.rgb.length; i++) {
        const d = Math.abs(a.rgb[i] - b.rgb[i]);
        if (!(d <= worst)) worst = d;
        sum += d;
        if (d > 1e-4) over++;
      }
      const merged = Object.keys(a.merged).map((id) => [a.merged[id], b.merged[id]]);
      return { worst, mean: sum / a.rgb.length, over, n: a.rgb.length, size: [a.width, a.height, b.width, b.height].join(), used: [a.used, b.used], merged };
    };
    // (the processor's half size merge first: it measures each camera's color fringes, which every merge after it then uses)
    const cpu2 = merge(null, null, 2);
    const out = {};
    const before = { ...calls };
    out.kept = compare(cpu2, merge(counted, null, 2));
    out.keptCalls = Object.fromEntries(Object.keys(calls).map((k) => [k, calls[k] - before[k]]));
    out.bands = compare(cpu2, merge(banded, null, 2));
    out.full = compare(merge(null, null, 1), merge(counted, null, 1));
    out.withPrep = compare(cpu2, merge(counted, prep, 2));
    // (how much the cameras add: the merge against the reference alone, so the comparison is not of a merge that took nothing)
    let refOnly = 0;
    const solo = fuse(bytes, parsed, { ...depth, modules: [] }, opts, () => {}, { grid: 2, corrections });
    for (let i = 0; i < solo.rgb.length; i++) refOnly = Math.max(refOnly, Math.abs(solo.rgb[i] - cpu2.rgb[i]));
    console.warn = warn;
    return { out, refOnly, calls, warnings, err: gpu.gl.getError() };
  });
  if (!res) return t.skip('No float render targets');
  assert.equal(res.err, 0);
  assert.deepEqual(res.warnings, [], 'the card failed and the processor made the merge');
  // (the merge kept on the card: the reference laid on its grid, the sums begun, each camera's share added and the sums read back, all on the card)
  assert.deepEqual(res.out.keptCalls, { reference: 1, begin: 1, camera: 3, end: 1 });
  assert.deepEqual(res.calls, { reference: 4, begin: 3, camera: 12, end: 3 }, 'not every merge of the card side was made on the card');
  assert.ok(res.refOnly > 0.01, `the cameras changed the merge by only ${res.refOnly}: the comparison is of a merge that took nothing from them`);
  // The card places each camera's lookup in single precision (about 1e-5 of a pixel at these coordinates, after the pose and the lens distortion) where the processor works
  // in double, which on the pattern's slopes moves a value by a few 1e-6, and up to about 1e-5 at full size, where the camera pictures' color fringes are taken out on
  // the way too; the rest (blurs, ratios, weights) differs by units in the last place. A weight cut at 0.02 or a lookup that falls off a picture's edge on one side only
  // would show as a difference of 1e-3 or more: none may.
  for (const [name, r] of Object.entries(res.out)) {
    if (name === 'keptCalls') continue;
    const [w1, h1, w2, h2] = r.size.split(',');
    assert.ok(w1 === w2 && h1 === h2, `${name}: the card's merge is not the processor's size (${r.size})`);
    assert.equal(r.used[0], r.used[1]);
    assert.ok(r.worst < 5e-5, `${name}: the card's merge differs from the processor's by up to ${r.worst}`);
    assert.ok(r.mean < 1e-6, `${name}: the card's merge differs from the processor's by ${r.mean} on average`);
    assert.equal(r.over, 0, `${name}: ${r.over} values differ by more than 1e-4`);
    // (the share of each camera's pixels that agreed, weight over 0.5: a pixel whose weight is within single precision of 0.5 can count on one side only, so a few may differ)
    for (const [a, b] of r.merged) {
      assert.ok(a > 0.5, `${name}: a camera agreed with the reference on only ${a} of the pixels`);
      assert.ok(Math.abs(a - b) * (r.n / 3) <= 10, `${name}: the share of pixels that agreed differs: ${a} and ${b}`);
    }
  }
});
