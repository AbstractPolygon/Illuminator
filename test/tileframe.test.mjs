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

test('vignetting softness: 50 is the earlier fade, lower is sharper, higher gentler', async () => {
  const { lensGain } = await import('../app/js/core/lens.js');
  const g = (softness, r) => lensGain(lensParams({ vignetting: 100, midpoint: 50, softness }, null), 50 + r * 50, 50 + r * 50, 100, 100);
  const start = 0.45;
  const t = (0.7 - start) / (1 - start);
  assert.ok(Math.abs(g(50, 0.7) - (1 + 1.5 * t * t * (3 - 2 * t))) < 1e-9);
  assert.ok(g(10, 0.7) > g(50, 0.7) && g(50, 0.7) > g(100, 0.7));
  assert.equal(g(0, 0.3), 1);
});

test('the tilted plane of focus on a tile is the whole picture\'s', async () => {
  const { applyDepthOfField } = await import('../app/js/core/dof.js');
  const W2 = 64;
  const H2 = 48;
  const rgb = new Float32Array(W2 * H2 * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = ((i * 2654435761) % 1000) / 1000;
  const depth = new Float32Array(W2 * H2).fill(0);
  const opts = { tilt: [0, 3], point: [0.5, 0.5] };
  const whole = applyDepthOfField(rgb, W2, H2, depth, W2, H2, 0, 1, 2, opts);
  // a tile: the lower half (with the whole width, so the blur sees the same neighbors in x)
  const y0 = 24;
  const th = 24;
  const tile = rgb.slice(y0 * W2 * 3, (y0 + th) * W2 * 3);
  const out = applyDepthOfField(tile, W2, th, depth.slice(0, W2 * th), W2, th, 0, 1, 2, { ...opts, frame: { x: 0, y: y0, width: W2, height: H2 } });
  const naive = applyDepthOfField(tile, W2, th, depth.slice(0, W2 * th), W2, th, 0, 1, 2, opts);
  // (the middle rows of the tile, away from its cut edges)
  let dFrame = 0;
  let dNaive = 0;
  for (let y = 8; y < 16; y++) for (let x = 8; x < W2 - 8; x++) for (let c = 0; c < 3; c++) {
    const a = whole[((y + y0) * W2 + x) * 3 + c];
    dFrame = Math.max(dFrame, Math.abs(out[(y * W2 + x) * 3 + c] - a));
    dNaive = Math.max(dNaive, Math.abs(naive[(y * W2 + x) * 3 + c] - a));
  }
  assert.ok(dFrame < 0.02, `tile with its frame differs by ${dFrame}`);
  assert.ok(dNaive > 0.05, `the test needs a tilt that shows (${dNaive})`);
});
