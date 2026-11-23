import fs from 'node:fs';
import { parseLri } from '../../app/js/core/lri.js';
import { measureDepth } from '../../app/js/core/l16depth.js';
import { encodePng } from '../png.mjs';
const [file, out, scale = '4', steps = '48'] = process.argv.slice(2);
const bytes = new Uint8Array(fs.readFileSync(file));
const parsed = parseLri(bytes);
const t0 = Date.now();
const d = measureDepth(bytes, parsed, { scale: +scale, steps: +steps, ref: process.env.REF }, (s, p) => { if (Math.round(p * 100) % 20 === 0) console.log(s, Math.round(p * 100) + '%', Date.now() - t0, 'ms'); });
console.log('ref', d.ref, 'modules', d.modules.join(','), d.width + 'x' + d.height, 'near', d.near, 'far', d.far, 'total', Date.now() - t0, 'ms');
const rgba = new Uint8Array(d.width * d.height * 4);
const sorted = Float32Array.from(d.invZ).sort(); const lo = sorted[Math.floor(sorted.length*0.02)], hi = sorted[Math.floor(sorted.length*0.98)]; console.log('percentile range 1/mm', lo, hi, '=> Z mm', (1/lo).toFixed(0), (1/hi).toFixed(0));
for (let i = 0; i < d.invZ.length; i++) {
  const t = Math.min(1, Math.max(0, (d.invZ[i] - lo) / (hi - lo)));
  const ramp = (c) => Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - c))));
  rgba[4 * i] = ramp(3); rgba[4 * i + 1] = ramp(2); rgba[4 * i + 2] = ramp(1); rgba[4 * i + 3] = 255;
}
fs.writeFileSync(out, encodePng(d.width, d.height, rgba));
const conf = new Uint8Array(d.width * d.height * 4);
for (let i = 0; i < d.confidence.length; i++) { const v = Math.round(255 * d.confidence[i]); conf[4*i]=conf[4*i+1]=conf[4*i+2]=v; conf[4*i+3]=255; }
fs.writeFileSync(out.replace('.png', '-conf.png'), encodePng(d.width, d.height, conf));
