import fs from 'node:fs';
import { parseLri, decodeFrame } from '../../app/js/core/lri.js';
import { encodePng } from '../png.mjs';
const [file, id, out] = process.argv.slice(2);
const bytes = new Uint8Array(fs.readFileSync(file));
const r = parseLri(bytes);
const fr = r.modules[id][0];
const t0 = Date.now();
const { width: W, height: H, data } = decodeFrame(bytes, fr);
console.log('decoded', id, W, H, 'in', Date.now() - t0, 'ms');
const sd = r.header.sensor_data[0].data;
const black = sd.black_level ?? 42, white = sd.white_level ?? 1023;
console.log('levels', black, white, 'awb', JSON.stringify(r.header.view_preferences && r.header.view_preferences.awb_gains), 'sensor type', r.header.sensor_data[0].type);
const ov = fr.module.sensor_bayer_red_override || { x: 0, y: 0 };
const mono = ov.x < 0;
const w2 = W >> 1, h2 = H >> 1;
const rgb = new Uint8Array(w2 * h2 * 3);
const awb = (r.header.view_preferences && r.header.view_preferences.awb_gains) || { r: 1, gr: 1, b: 1 };
const gain = [awb.r || 1, awb.gr || 1, awb.b || 1];
const lin = (v) => Math.max(0, (v - black) / (white - black));
const gam = (v) => Math.round(255 * Math.pow(Math.min(1, v), 1 / 2.2));
for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
  const px = (dx, dy) => lin(data[(2 * y + dy) * W + 2 * x + dx]);
  const o = (y * w2 + x) * 3;
  if (mono) { const v = (px(0,0)+px(1,0)+px(0,1)+px(1,1))/4; rgb[o]=rgb[o+1]=rgb[o+2]=gam(v*1.5); continue; }
  const rx = ov.x, ry = ov.y;
  const R = px(rx, ry), B = px(1 - rx, 1 - ry), G = (px(1 - rx, ry) + px(rx, 1 - ry)) / 2;
  const k = 1.6;
  rgb[o] = gam(R * gain[0] * k); rgb[o+1] = gam(G * gain[1] * k); rgb[o+2] = gam(B * gain[2] * k);
}
const rgba = new Uint8Array(w2*h2*4); for (let i=0;i<w2*h2;i++){rgba[4*i]=rgb[3*i];rgba[4*i+1]=rgb[3*i+1];rgba[4*i+2]=rgb[3*i+2];rgba[4*i+3]=255;}
fs.writeFileSync(out, encodePng(w2, h2, rgba));
console.log('wrote', out);
