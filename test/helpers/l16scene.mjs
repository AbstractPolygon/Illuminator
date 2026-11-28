// A made-up Light L16 capture for the telephoto detail tests (core/l16hires.js renderRegion and its graphics card steps): a wide reference camera (A1) and two telephoto
// cameras (B1, 2.5 times its focal length, slightly turned and a little out of register; C1, 5.4 times, with lens distortion), all looking at a textured plane, with a depth
// map that puts a nearer patch where the plane is (so the cameras disagree there), a flat area, and a bright patch at the white level. The cameras' sensors cover only part
// of the region, so its borders are exercised too.
//
// makeL16Scene runs in the page (page.evaluate), so it uses nothing from outside itself: pass `makeL16Scene.toString()` in and rebuild it there with
// `(0, eval)('(' + src + ')')`. It returns renderRegion's arguments: { bytes, parsed, depth, wide, region, modules, opts, rawCache }, the camera pictures already decoded in
// rawCache (so no file bytes are needed).
export function makeL16Scene() {
  const f0 = 400;
  const cx0 = 32;
  const cy0 = 24;
  const Z0 = 3000;
  const W0 = 64;
  const H0 = 48;
  // the plane's brightness at (u, v), wide pixels from the reference's center: smooth color, detail finer than a wide pixel, a flat area and a bright patch
  const scene = (u, v) => {
    if (u > 10 && u < 20 && v < -6 && v > -16) return 0.3;
    if ((u + 12) ** 2 + (v - 8) ** 2 < 9) return 0.97;
    return 0.38 + 0.12 * Math.sin(0.9 * u + 0.3 * v) + 0.08 * Math.sin(0.37 * v - 0.5 * u + 1) + 0.06 * Math.sin(3.1 * u + 0.4) * Math.sin(2.7 * v) + 0.04 * Math.sin(5.3 * u - 4.1 * v);
  };
  const mat = (m) => ({ x00: m[0], x01: m[1], x02: m[2], x10: m[3], x11: m[4], x12: m[5], x20: m[6], x21: m[7], x22: m[8] });
  const rotZ = (a) => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];
  const cams = {
    A1: { f: f0, cx: cx0, cy: cy0, R: rotZ(0), T: [0, 0, 0], size: [W0, H0] },
    B1: { f: 2.5 * f0, cx: 50, cy: 40, R: rotZ(0.01), T: [10, 0, 0], size: [100, 96], gain: 0.9, off: [1.2, -0.6] },
    C1: { f: 5.4 * f0, cx: 96, cy: 80, R: rotZ(0), T: [-15, 5, 0], size: [200, 150], gain: 1.1, off: [0, 0], dist: { coeffs: [0.02, -0.01, 0.001, -0.0005, 0], n: 1000 } },
  };
  const header = { module_calibration: [] };
  const modules = {};
  for (const [id, c] of Object.entries(cams)) {
    const geometry = {
      mirror_type: 'NONE',
      per_focus_calibration: [{ intrinsics: { k_mat: mat([c.f, 0, c.cx, 0, c.f, c.cy, 0, 0, 1]) }, extrinsics: { canonical: { rotation: mat(c.R), translation: { x: c.T[0], y: c.T[1], z: c.T[2] } } } }],
    };
    if (c.dist) geometry.distortion = { polynomial: { coeffs: c.dist.coeffs, normalization: { x: c.dist.n, y: c.dist.n }, distortion_center: { x: c.cx, y: c.cy } } };
    header.module_calibration.push({ camera_id: id, geometry });
    modules[id] = [{ module: { id, lens_position: 0, sensor_data_surface: { size: { x: c.size[0], y: c.size[1] }, data_scale: { x: 1, y: 1 } }, sensor_bayer_red_override: { x: -1, y: -1 } } }];
  }
  // the wide picture on the reference's grid (a little color)
  const wide = { width: W0, height: H0, rgb: new Float32Array(3 * W0 * H0) };
  for (let y = 0; y < H0; y++) {
    for (let x = 0; x < W0; x++) {
      const t = scene(x + 0.5 - cx0, y + 0.5 - cy0);
      wide.rgb.set([t, t * 0.92, t * 0.85], 3 * (y * W0 + x));
    }
  }
  // the depth: the plane, with a nearer patch the cameras' pictures do not show (they see the plane there)
  const depth = { ref: 'A1', width: 16, height: 12, invZ: new Float32Array(16 * 12) };
  for (let y = 0; y < 12; y++) for (let x = 0; x < 16; x++) depth.invZ[y * 16 + x] = x >= 3 && x <= 5 && y >= 7 && y <= 9 ? 1 / 2000 : 1 / Z0;
  // each telephoto camera's sensor (mono, 10 bit): the plane where its pixels look (the distortion undone by a few fixed point steps), shifted by `off`
  const rawCache = new Map();
  for (const id of ['B1', 'C1']) {
    const c = cams[id];
    const [w, h] = c.size;
    const data = new Uint16Array(w * h);
    const distort = (x, y) => {
      if (!c.dist) return [x, y];
      const [k1, k2, p1, p2, k3] = c.dist.coeffs;
      const u = (x - c.cx) / c.dist.n;
      const v = (y - c.cy) / c.dist.n;
      const r2 = u * u + v * v;
      const s = 1 + ((k3 * r2 + k2) * r2 + k1) * r2;
      return [c.cx + c.dist.n * (p1 * 2 * u * v + p2 * (r2 + 2 * u * u) + s * u), c.cy + c.dist.n * (p2 * 2 * u * v + p1 * (r2 + 2 * v * v) + s * v)];
    };
    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        let ix = sx + 0.5 - c.off[0];
        let iy = sy + 0.5 - c.off[1];
        const tx = ix;
        const ty = iy;
        for (let k = 0; k < 4; k++) {
          const [dx, dy] = distort(ix, iy);
          ix -= dx - tx;
          iy -= dy - ty;
        }
        // the ray (camera frame) to the plane Z = Z0 of the reference's frame: P_ref = R^T (l d - T)
        const d = [(ix - c.cx) / c.f, (iy - c.cy) / c.f, 1];
        const R = c.R;
        const rt = (p) => [R[0] * p[0] + R[3] * p[1] + R[6] * p[2], R[1] * p[0] + R[4] * p[1] + R[7] * p[2], R[2] * p[0] + R[5] * p[1] + R[8] * p[2]];
        const Rd = rt(d);
        const RT = rt(c.T);
        const l = (Z0 + RT[2]) / Rd[2];
        const P = [l * Rd[0] - RT[0], l * Rd[1] - RT[1], Z0];
        const t = scene((P[0] / P[2]) * f0, (P[1] / P[2]) * f0);
        data[sy * w + sx] = Math.min(1023, Math.round(42 + t * c.gain * 981));
      }
    }
    rawCache.set(id, { width: w, height: h, data });
  }
  return {
    bytes: new Uint8Array(0),
    parsed: { header, modules },
    depth,
    wide,
    region: { x0: 8, y0: 6, w: 48, h: 36, scale: 2, grid: 1, corrections: { C1: { ax: [0.5, 0.2, -0.3], ay: [-0.4, 0.1, 0.2] } } },
    modules: ['B1', 'C1'],
    opts: { black: 42, white: 1023, gains: [1, 1, 1], hot: false },
    rawCache,
  };
}
