import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultMask, parseMasks, activeMasks, maskWeight, applyLocal } from '../app/js/core/local.js';

test('masks parse with defaults filled in and junk dropped', () => {
  const m = parseMasks(JSON.stringify([{ kind: 'radial', x: 0.2 }, { kind: 'nope' }, null]));
  assert.equal(m.length, 1);
  assert.equal(m[0].x, 0.2);
  assert.equal(m[0].fx.exposure, 0);
  assert.deepEqual(parseMasks('not json'), []);
  assert.equal(activeMasks(m).length, 0);
});

test('radial, linear and depth masks weigh where they should', () => {
  const r = defaultMask('radial');
  assert.equal(maskWeight(r, 0.5, 0.5, 1.5, null), 1);
  assert.equal(maskWeight(r, 0.95, 0.5, 1.5, null), 0);
  assert.equal(maskWeight({ ...r, invert: true }, 0.95, 0.5, 1.5, null), 1);
  const l = defaultMask('linear'); // angle 90: full effect above, none below
  assert.ok(maskWeight(l, 0.5, 0.1, 1.5, null) > 0.99);
  assert.ok(maskWeight(l, 0.5, 0.9, 1.5, null) < 0.01);
  const d = defaultMask('depth');
  assert.equal(maskWeight(d, 0, 0, 1, 0), 1);
  assert.equal(maskWeight(d, 0, 0, 1, 1.2), 0);
  assert.equal(maskWeight(d, 0, 0, 1, null), 0);
});

test('effects apply by the mask weight', () => {
  const m = { ...defaultMask('radial'), fx: { exposure: 1, contrast: 0, saturation: 0, temperature: 0, tint: 0 } };
  const inside = [0.2, 0.2, 0.2];
  applyLocal(inside, [m], 0.5, 0.5, 1.5, null);
  assert.ok(Math.abs(inside[0] - 0.4) < 1e-9);
  const outside = [0.2, 0.2, 0.2];
  applyLocal(outside, [m], 0.99, 0.99, 1.5, null);
  assert.equal(outside[0], 0.2);
});

test('animated settings, strength and follow focus resolve per picture', async () => {
  const { resolveMasks } = await import('../app/js/core/local.js');
  const m = { ...defaultMask('depth'), id: 'a', near: -0.2, far: 0.2, follow: true, anchor: 0.1, strength: 0.5, fx: { exposure: 1, contrast: 0, saturation: -1, temperature: 0, tint: 0 } };
  const [r] = resolveMasks([m], { focus: 0.6 });
  assert.ok(Math.abs(r.near - 0.3) < 1e-9 && Math.abs(r.far - 0.7) < 1e-9);
  assert.equal(r.fx.exposure, 0.5);
  assert.equal(r.fx.saturation, -0.5);
  const [o] = resolveMasks([m], { focus: 0.1, overrides: { a: { strength: 1, exposure: 2, feather: 0.4 } } });
  assert.equal(o.fx.exposure, 2);
  assert.equal(o.feather, 0.4);
  assert.equal(m.fx.exposure, 1); // the mask itself is left alone
  assert.ok(parseMasks(JSON.stringify([{ kind: 'radial' }, { kind: 'depth' }])).map((x) => x.id).join() === 'm0,m1');
});

test('blur and pixelate change only what the mask covers', async () => {
  const { applySpatial } = await import('../app/js/core/local.js');
  const w = 40;
  const h = 20;
  const rgb = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgb.fill((x + y) % 2 ? 1 : 0, 3 * (y * w + x), 3 * (y * w + x) + 3);
  // Left half only (a gradient mask at angle 0: full effect to the left).
  const m = { ...defaultMask('linear'), angle: 0, width: 0.01, fx: { ...defaultMask('linear').fx, blur: 1 } };
  const out = applySpatial(rgb, w, h, { masks: [m] });
  const i = 3 * (10 * w + 5);
  assert.ok(Math.abs(out[i] - 0.5) < 0.15, `blurred ${out[i]}`);
  assert.equal(out[3 * (10 * w + 35)], rgb[3 * (10 * w + 35)]);
  const px = applySpatial(rgb, w, h, { masks: [{ ...m, fx: { ...m.fx, blur: 0, pixelate: 1 } }] });
  assert.equal(px[0], px[3]);
});

test('haze fogs toward the airlight, dehaze takes it back out, and the GPU gets it', async () => {
  const { AIRLIGHT, packMasks } = await import('../app/js/core/local.js');
  const fx = (haze) => ({ ...defaultMask('radial').fx, haze });
  const dark = [0.02, 0.02, 0.02];
  const fogged = [...dark];
  const { applyEffects } = await import('../app/js/core/local.js');
  applyEffects(fogged, fx(1), 1);
  for (let c = 0; c < 3; c++) assert.ok(fogged[c] > dark[c] && fogged[c] < AIRLIGHT[c]);
  // Half the weight, half the way.
  const half = [...dark];
  applyEffects(half, fx(1), 0.5);
  assert.ok(half[0] < fogged[0]);
  // Dehaze darkens a hazy pixel and keeps values from going negative.
  const hazy = [0.3, 0.33, 0.4];
  const clear = [...hazy];
  applyEffects(clear, fx(-1), 1);
  for (let c = 0; c < 3; c++) assert.ok(clear[c] >= 0 && clear[c] < hazy[c]);
  const black = [0, 0, 0];
  applyEffects(black, fx(-1), 1);
  assert.deepEqual(black, [0, 0, 0]);
  // A mask with only haze counts as active and reaches the shader in extra.y.
  const m = { ...defaultMask('depth'), fx: fx(0.6) };
  assert.equal(activeMasks([m]).length, 1);
  assert.ok(Math.abs(packMasks([m]).extra[1] - 0.6) < 1e-6);
});
