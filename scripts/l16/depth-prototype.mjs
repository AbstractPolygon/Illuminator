import fs from 'node:fs';
import { parseLri, decodeFrame } from '../../app/js/core/lri.js';
import { encodePng } from '../png.mjs';
const [file, outPng, scaleArg = '4'] = process.argv.slice(2);
const S = +scaleArg;
const bytes = new Uint8Array(fs.readFileSync(file));
const r = parseLri(bytes);
const m3 = (o) => [o.x00, o.x01, o.x02, o.x10, o.x11, o.x12, o.x20, o.x21, o.x22];
function cam(id) {
  const mod = r.modules[id][0].module;
  const cal = r.header.module_calibration.find((c) => c.camera_id === id);
  const g = cal.geometry;
  const ks = g.per_focus_calibration.filter((b) => b.intrinsics).map((b) => ({ k: m3(b.intrinsics.k_mat), hall: b.focus_hall_code })).sort((a, b) => a.hall - b.hall);
  // interpolate fx, cx, cy by the lens position (hall code)
  const x = mod.lens_position;
  let K = ks[0].k.slice();
  if (ks.length >= 2) {
    const [a, b] = x >= ks[1].hall && ks.length > 2 ? [ks[1], ks[2]] : [ks[0], ks[1]];
    const t = (x - a.hall) / (b.hall - a.hall);
    for (const j of [0, 4, 2, 5]) K[j] = a.k[j] + t * (b.k[j] - a.k[j]);
  }
  const e = g.per_focus_calibration.find((b) => b.extrinsics && b.extrinsics.canonical).extrinsics.canonical;
  const poly = g.distortion.polynomial;
  return { id, mod, K, R: m3(e.rotation), T: [e.translation.x, e.translation.y, e.translation.z], poly, frame: r.modules[id][0] };
}
function mapDist(poly, x, y) {
  const [k1, k2, p1, p2, k3] = [poly.coeffs[0], poly.coeffs[1], poly.coeffs[2], poly.coeffs[3], poly.coeffs[4] || 0];
  const nx = poly.normalization.x, ny = poly.normalization.y, cx = poly.distortion_center.x, cy = poly.distortion_center.y;
  const u = (x - cx) / nx, v = (y - cy) / ny, r2 = u * u + v * v, uv2 = 2 * u * v;
  const s = 1 + (((k3 * r2 + k2) * r2 + k1) * r2);
  return [cx + nx * (p1 * uv2 + p2 * (r2 + 2 * u * u) + s * u), cy + ny * (p2 * uv2 + p1 * (r2 + 2 * v * v) + s * v)];
}
const ids = ['A1', 'A3', 'A4', 'A5'];
const cams = ids.map(cam);
const W = 4160, H = 3120, w = W / S, h = H / S;
function gray(c) {
  const { data } = decodeFrame(bytes, c.frame);
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) sum += data[(S * y + dy) * W + S * x + dx];
    g[y * w + x] = sum / (S * S);
  }
  // remove the per-image brightness: scale to a common mean
  let mean = 0; for (const v of g) mean += v; mean /= g.length;
  for (let i = 0; i < g.length; i++) g[i] /= mean;
  return g;
}
const t0 = Date.now();
for (const c of cams) c.gray = gray(c);
console.log('gray', Date.now() - t0, 'ms');
const bil = (g, x, y) => {
  x -= 0.5; y -= 0.5;
  if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return NaN;
  const xi = x | 0, yi = y | 0, fx = x - xi, fy = y - yi, o = yi * w + xi;
  return (g[o] * (1 - fx) + g[o + 1] * fx) * (1 - fy) + (g[o + w] * (1 - fx) + g[o + w + 1] * fx) * fy;
};
const ref = cams[0];
const Kr = ref.K;
const NZ = 48, invMin = 1 / 25000, invMax = 1 / 500;
const cost = new Float32Array(w * h * NZ).fill(1e9);
const R0 = 3; // aggregation radius (pixels at this scale)
for (let zi = 0; zi < NZ; zi++) {
  const inv = invMin + (invMax - invMin) * (zi / (NZ - 1));
  const z = 1 / inv;
  const diff = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    // reference pixel in full-resolution ideal coordinates, then its ray
    const px = (x + 0.5) * S, py = (y + 0.5) * S;
    const X = ((px - Kr[2]) / Kr[0]) * z, Y = ((py - Kr[5]) / Kr[4]) * z;
    let sum = 0, n = 0;
    const [dx0, dy0] = mapDist(ref.poly, px, py);
    const rv = bil(ref.gray, dx0 / S, dy0 / S);
    for (let k = 1; k < cams.length; k++) {
      const c = cams[k];
      const Pz = c.R[6] * X + c.R[7] * Y + c.R[8] * z + c.T[2];
      const Px = c.R[0] * X + c.R[1] * Y + c.R[2] * z + c.T[0];
      const Py = c.R[3] * X + c.R[4] * Y + c.R[5] * z + c.T[1];
      const ix = c.K[0] * (Px / Pz) + c.K[2], iy = c.K[4] * (Py / Pz) + c.K[5];
      const [sx, sy] = mapDist(c.poly, ix, iy);
      const v = bil(c.gray, sx / S, sy / S);
      if (v === v && rv === rv) { sum += Math.abs(v - rv); n++; }
    }
    diff[y * w + x] = n ? sum / n : 1;
  }
  // box aggregate
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) { let acc = 0; for (let x = -R0; x <= R0; x++) acc += diff[y * w + Math.min(w - 1, Math.max(0, x))]; for (let x = 0; x < w; x++) { tmp[y * w + x] = acc; acc += diff[y * w + Math.min(w - 1, x + R0 + 1)] - diff[y * w + Math.max(0, x - R0)]; } }
  for (let x = 0; x < w; x++) { let acc = 0; for (let y = -R0; y <= R0; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]; for (let y = 0; y < h; y++) { cost[(y * w + x) * NZ + zi] = acc / ((2 * R0 + 1) ** 2); acc += tmp[Math.min(h - 1, y + R0 + 1) * w + x] - tmp[Math.max(0, y - R0) * w + x]; } }
  if (zi % 8 === 0) console.log('depth step', zi, Date.now() - t0, 'ms');
}
const out = new Uint8Array(w * h * 4);
const dmap = new Float32Array(w * h);
for (let i = 0; i < w * h; i++) {
  let best = 0, bc = 1e9;
  for (let zi = 0; zi < NZ; zi++) { const c = cost[i * NZ + zi]; if (c < bc) { bc = c; best = zi; } }
  dmap[i] = best / (NZ - 1);
}
for (let i = 0; i < w * h; i++) { const t = dmap[i]; const rr = Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - 3)))), gg = Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - 2)))), bb = Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - 1)))); out[4*i]=rr; out[4*i+1]=gg; out[4*i+2]=bb; out[4*i+3]=255; }
fs.writeFileSync(outPng, encodePng(w, h, out));
console.log('wrote', outPng, 'total', Date.now() - t0, 'ms');
