#!/usr/bin/env node
// The merged picture of an L16 capture: node scripts/l16/fuse.mjs FILE OUTDIR. Writes fused.png (all cameras merged, full size) and single.png (the reference camera alone, demosaiced the
// same way, on the same undistorted grid), plus crops of both for comparison.
import fs from 'node:fs';
import path from 'node:path';
import { parseLri } from '../../app/js/core/lri.js';
import { measureDepth } from '../../app/js/core/l16depth.js';
import { fuse, demosaic } from '../../app/js/core/l16fusion.js';
import { cameraModel } from '../../app/js/core/l16geometry.js';
import { encodePng } from '../png.mjs';

const [file, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const bytes = new Uint8Array(fs.readFileSync(file));
const parsed = parseLri(bytes);
let t = Date.now();
const depth = measureDepth(bytes, parsed, { ref: process.env.REF });
console.log('depth', Date.now() - t, 'ms');
const awb = (parsed.header.view_preferences && parsed.header.view_preferences.awb_gains) || {};
const sd = parsed.header.sensor_data[0].data;
const opts = { black: sd.black_level, white: sd.white_level, gains: [awb.r || 1, awb.gr || 1, awb.b || 1] };
t = Date.now();
const fused = fuse(bytes, parsed, depth, opts, (s, p) => process.stdout.write(`\r${s} ${Math.round(p * 100)}%   `));
console.log('\nfused', fused.width + 'x' + fused.height, 'from', fused.used, 'cameras in', Date.now() - t, 'ms; agreement', JSON.stringify(Object.fromEntries(Object.entries(fused.merged).map(([k, v]) => [k, +v.toFixed(2)]))));
// the reference alone, on the same grid
const refFrame = parsed.modules[depth.ref][0];
const refCam = cameraModel(parsed.header, refFrame);
const single = demosaic(bytes, refFrame, opts);
const W = fused.width, H = fused.height;
const alone = new Float32Array(3 * W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const [sx, sy] = refCam.distort(x + 0.5, y + 0.5);
  const xi = Math.min(W - 1, Math.max(0, Math.round(sx - 0.5))), yi = Math.min(H - 1, Math.max(0, Math.round(sy - 0.5)));
  for (let c = 0; c < 3; c++) alone[3 * (y * W + x) + c] = single.rgb[3 * (yi * W + xi) + c];
}
const greens = new Float32Array(W * H); for (let i = 0; i < greens.length; i++) greens[i] = fused.rgb[3 * i + 1]; greens.sort();
const gain = 0.9 / Math.max(1e-4, greens[Math.floor(greens.length * 0.99)]);
const png = (rgb, x0, y0, w, h) => {
  const o = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) { const v = Math.min(1, rgb[3 * ((y0 + y) * W + x0 + x) + c] * gain); o[4 * (y * w + x) + c] = Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)); o[4 * (y * w + x) + 3] = 255; }
  return encodePng(w, h, o);
};
fs.writeFileSync(path.join(outDir, 'fused.png'), png(fused.rgb, 0, 0, W, H));
const cx = Math.floor(W / 2) - 300, cy = Math.floor(H / 2) - 200;
fs.writeFileSync(path.join(outDir, 'crop_fused.png'), png(fused.rgb, cx, cy, 600, 400));
fs.writeFileSync(path.join(outDir, 'crop_single.png'), png(alone, cx, cy, 600, 400));
