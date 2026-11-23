#!/usr/bin/env node
// A region at higher resolution from the telephoto cameras: node scripts/l16/hires.mjs FILE OUTDIR [X0 Y0 W H SCALE]  (region in pixels of the wide picture, default the middle 1000 x 800 at 2.5).
// Writes enlarged.png (the wide picture enlarged) and hires.png (with the telephoto detail).
import fs from 'node:fs';
import path from 'node:path';
import { parseLri } from '../../app/js/core/lri.js';
import { measureDepth } from '../../app/js/core/l16depth.js';
import { fuse } from '../../app/js/core/l16fusion.js';
import { renderRegion, telephotoModules } from '../../app/js/core/l16hires.js';
import { encodePng } from '../png.mjs';

const [file, outDir, ...r] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const bytes = new Uint8Array(fs.readFileSync(file));
const parsed = parseLri(bytes);
let t = Date.now();
const depth = measureDepth(bytes, parsed, { ref: process.env.REF });
const awb = (parsed.header.view_preferences && parsed.header.view_preferences.awb_gains) || {};
const sd = parsed.header.sensor_data[0].data;
const opts = { black: sd.black_level, white: sd.white_level, gains: [awb.r || 1, awb.gr || 1, awb.b || 1] };
const wide = fuse(bytes, parsed, depth, opts);
console.log('wide picture', Date.now() - t, 'ms');
const [x0, y0, w, h, scale] = r.length ? r.map(Number) : [1580, 1160, 1000, 800, 2.5];
const mods = telephotoModules(parsed, depth.ref, [2, 3.2]);
console.log('telephoto cameras', mods.join(','));
t = Date.now();
const res = renderRegion(bytes, parsed, depth, wide, { x0, y0, w, h, scale }, mods, opts, (s, p) => process.stdout.write(`\r${s} ${Math.round(p * 100)}%   `));
console.log(`\nregion ${res.width}x${res.height} in ${Date.now() - t} ms; telephoto detail on ${(100 * res.covered).toFixed(0)}% of it`);
const greens = new Float32Array(wide.width * wide.height); for (let i = 0; i < greens.length; i += 7) greens[i] = wide.rgb[3 * i + 1]; greens.sort();
const gain = 0.9 / Math.max(1e-4, greens[Math.floor(greens.length * 0.99)]);
const png = (rgb, W, H) => {
  const o = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) { const v = Math.min(1, rgb[3 * i + c] * gain); o[4 * i + c] = Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)); o[4 * i + 3] = 255; }
  return encodePng(W, H, o);
};
fs.writeFileSync(path.join(outDir, 'enlarged.png'), png(res.wide, res.width, res.height));
fs.writeFileSync(path.join(outDir, 'hires.png'), png(res.rgb, res.width, res.height));
