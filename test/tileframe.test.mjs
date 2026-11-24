// A tile of a bigger picture (the Light L16 render and its zoomed-in layer) gets the whole picture's lens correction, flare veil and local adjustments.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyLens, lensParams } from '../app/js/core/lens.js';
import { subtractVeil } from '../app/js/core/flare.js';
import { toneMap } from '../app/js/core/render.js';
import { applySpatial, defaultMask, resolveMasks } from '../app/js/core/local.js';

const W = 48;
const H = 32;
function picture() {
  const rgb = new Float32Array(W * H * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = 0.2 + 0.6 * (((i * 7919) % 97) / 97);
  return rgb;
}
function tileOf(rgb, x0, y0, w, h, ch = 3, srcW = W) {
  const out = new (rgb.constructor)(w * h * ch);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < ch; c++) out[(y * w + x) * ch + c] = rgb[((y + y0) * srcW + x + x0) * ch + c];
  return out;
}
const frame = { x: 20, y: 10, width: W, height: H };
const near = (a, b, eps) => { for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) <= eps, `at ${i}: ${a[i]} vs ${b[i]}`); };

test('vignetting on a tile matches the whole picture', () => {
  const rgb = picture();
  const p = lensParams({ vignetting: 70, midpoint: 20 }, null);
  const whole = applyLens(rgb, W, H, p);
  // (the last row and column of any picture are read a hair inside, as for the whole picture's: a tile's margin covers them)
  near(tileOf(applyLens(tileOf(rgb, 20, 10, 16, 12), 16, 12, p, frame), 0, 0, 15, 11, 3, 16), tileOf(whole, 20, 10, 15, 11), 1e-4);
});

test('the flare veil on a tile matches the whole picture', () => {
  const rgb = picture();
  const veil = { tilesX: 2, tilesY: 2, data: new Float32Array([0.1, 0.1, 0.1, 0.0, 0.0, 0.0, 0.05, 0.05, 0.05, 0.2, 0.2, 0.2]) };
  const whole = subtractVeil(rgb, W, H, veil, 1);
  near(subtractVeil(tileOf(rgb, 20, 10, 16, 12), 16, 12, veil, 1, frame), tileOf(whole, 20, 10, 16, 12), 1e-6);
});

test('local adjustments on a tile match the whole picture', () => {
  const rgb = picture();
  const m = { ...defaultMask('radial'), x: 0.6, y: 0.5, w: 0.2, h: 0.3, fx: { ...defaultMask('radial').fx, exposure: 1, pixelate: 0.2 } };
  const masks = resolveMasks([m]);
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const whole = toneMap(applySpatial(rgb, W, H, { masks, w: W, h: H }), I, 1, undefined, null, { masks, w: W, h: H, show: -1 });
  const t = tileOf(rgb, 20, 10, 16, 12);
  const local = { masks, w: 16, h: 12, show: -1, frame };
  const tile = toneMap(applySpatial(t, 16, 12, local), I, 1, undefined, null, local);
  // (pixelate blocks cut by the tile's edge average fewer pixels: compare the blocks inside it)
  const s = Math.max(2, Math.floor(0.2 * 0.04 * W));
  const ref = tileOf(whole, 20, 10, 16, 12, 4);
  for (let y = 0; y < 12; y++) for (let x = 0; x < 16; x++) {
    const gx = x + 20, gy = y + 10;
    if (Math.floor(gx / s) * s < 20 || Math.floor(gy / s) * s < 10 || Math.floor(gx / s) * s + s > 36 || Math.floor(gy / s) * s + s > 22) continue;
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(tile[(y * 16 + x) * 4 + c] - ref[(y * 16 + x) * 4 + c]) <= 1, `${x},${y}`);
  }
});
