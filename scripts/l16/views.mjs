#!/usr/bin/env node
// Moved viewpoints of an L16 capture: node scripts/l16/views.mjs FILE OUTDIR [TX_MM ...]  (default -40 0 40). Writes one PNG per viewpoint (half size, simple color) and a
// picture of the depth. Uses the reference module's picture and the depth measured between the modules (core/l16depth.js).
import fs from 'node:fs';
import path from 'node:path';
import { parseLri } from '../../app/js/core/lri.js';
import { measureDepth } from '../../app/js/core/l16depth.js';
import { superpixelColor, depthAtSize, synthesize, fillFromBackground, backgroundDepth, fillFromDonors } from '../../app/js/core/l16view.js';
import { cameraModel } from '../../app/js/core/l16geometry.js';
import { relativePose } from '../../app/js/core/l16depth.js';
import { encodePng } from '../png.mjs';

const [file, outDir, ...rest] = process.argv.slice(2);
const txs = rest.length ? rest.map(Number) : [-40, 0, 40];
fs.mkdirSync(outDir, { recursive: true });
const bytes = new Uint8Array(fs.readFileSync(file));
const parsed = parseLri(bytes);
const t0 = Date.now();
const depth = measureDepth(bytes, parsed, { ref: process.env.REF });
console.log('depth', Date.now() - t0, 'ms; reference', depth.ref, 'with', depth.modules.join(','));
const awb = (parsed.header.view_preferences && parsed.header.view_preferences.awb_gains) || { r: 1, gr: 1, b: 1 };
const sd = parsed.header.sensor_data[0].data;
const color = superpixelColor(bytes, parsed.modules[depth.ref][0], { black: sd.black_level, white: sd.white_level, gains: [awb.r || 1, awb.gr || 1, awb.b || 1] });
const z = depthAtSize(depth.invZ, depth.width, depth.height, color.width, color.height);
const sorted = Float32Array.from(z).sort();
const pivot = sorted[Math.floor(sorted.length * 0.5)];
const focal = depth.K[0] / 2; // the color picture is half the sensor size
console.log('picture', color.width + 'x' + color.height, 'pivot mm', pivot.toFixed(0), 'focal px', focal.toFixed(0));
// exposure: bring the 99th percentile of the green channel to 0.9
const greens = new Float32Array(color.width * color.height);
for (let i = 0; i < greens.length; i++) greens[i] = color.rgb[3 * i + 1];
greens.sort();
const gain = 0.9 / Math.max(1e-4, greens[Math.floor(greens.length * 0.99)]);
const toPng = (rgb, w, h) => {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) out[4 * i + c] = Math.round(255 * Math.pow(Math.min(1, rgb[3 * i + c] * gain), 1 / 2.2));
    out[4 * i + 3] = 255;
  }
  return encodePng(w, h, out);
};
// donors: the other colour cameras of the group
const refCam = cameraModel(parsed.header, parsed.modules[depth.ref][0]);
const donors = depth.modules
  .filter((id) => ((parsed.modules[id][0].module.sensor_bayer_red_override || { x: 0 }).x >= 0))
  .map((id) => {
    const cam = cameraModel(parsed.header, parsed.modules[id][0]);
    return { id, cam, rel: relativePose(refCam, cam), color: superpixelColor(bytes, parsed.modules[id][0], { black: sd.black_level, white: sd.white_level, gains: [awb.r || 1, awb.gr || 1, awb.b || 1] }) };
  });
console.log('donors', donors.map((d) => d.id).join(','));
const refInfo = { rgb: color.rgb, width: color.width, height: color.height, z, K: depth.K, scale: 2 };
const useDonors = process.env.NODONORS !== '1';
for (const tx of txs) {
  const t1 = Date.now();
  const view = synthesize({ rgb: color.rgb, width: color.width, height: color.height, z }, focal, tx, 0, pivot);
  const holes = view.hole.reduce((a, b) => a + b, 0);
  let donorFilled = 0;
  if (useDonors) donorFilled = fillFromDonors(view, refInfo, donors, tx, 0, backgroundDepth(view.z, view.hole, color.width, color.height));
  const left = view.hole.reduce((a, b) => a + b, 0);
  fillFromBackground(view, color.width, color.height);
  fs.writeFileSync(path.join(outDir, `view_${tx}.png`), toPng(view.rgb, color.width, color.height));
  console.log(`tx ${tx} mm: ${holes} hole pixels (${((100 * holes) / (color.width * color.height)).toFixed(2)}%), ${donorFilled} filled from the other cameras, ${left} left to inpaint, ${Date.now() - t1} ms`);
}
