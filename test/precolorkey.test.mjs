import test from 'node:test';
import assert from 'node:assert/strict';
import { preColorKey, baseKept, COLOR_PASS_SETTINGS } from '../app/js/core/precolorkey.js';
import { COLOR_SETTINGS } from '../app/js/settingsmap.js';

const base = {
  ev: 0, saturation: 1, wb: { kelvin: 5000, tint: 0 }, tone: { contrast: 0 }, lens: { auto: true, distortion: 0, vignetting: 0 }, defringe: { on: false },
  curve: { points: [] }, ccm: null, local: { masks: [] }, details: { amount: 25 }, mvDenoise: { on: true, blend: 0.5 }, depthSmoothing: 0.3, latticeOn: true, detail: 2,
};

test('a change to a color setting keeps the picture before the color pass', () => {
  const key = preColorKey(base, [1, 2], ['edof', 3], ['details']);
  for (const changed of [
    { ...base, ev: 1 }, { ...base, saturation: 1.4 }, { ...base, wb: { kelvin: 6500, tint: 5 } }, { ...base, tone: { contrast: 0.3 } }, { ...base, lens: { auto: false, distortion: 20, vignetting: 10 } },
    { ...base, defringe: { on: true } }, { ...base, curve: { points: [[0, 0], [1, 1]] } }, { ...base, local: { masks: [{ kind: 'depth' }] } }, { ...base, details: { amount: 80 } },
  ]) assert.equal(preColorKey(changed, [1, 2], ['edof', 3], ['details']), key);
});

test('a change to anything that shapes the picture makes a new key', () => {
  const key = preColorKey(base, [1, 2], ['edof', 3], ['details']);
  for (const changed of [
    { ...base, mvDenoise: { on: false, blend: 0.5 } }, { ...base, depthSmoothing: 0.6 }, { ...base, latticeOn: false }, { ...base, detail: 1 }, { ...base, lensCentres: 'off' },
    { ...base, someNewSetting: 1 },
  ]) assert.notEqual(preColorKey(changed, [1, 2], ['edof', 3], ['details']), key);
  assert.notEqual(preColorKey(base, [1, 3], ['edof', 3], ['details']), key);
  assert.notEqual(preColorKey(base, [1, 2], ['edof', 4], ['details']), key);
  // where the sharpening and noise reduction run before the color pass (the graphics card's picture), they count
  assert.notEqual(preColorKey({ ...base, details: { amount: 80 } }, [1, 2], ['sr']), preColorKey(base, [1, 2], ['sr']));
});

test('every row of the color table is a color pass setting', () => {
  for (const [path] of COLOR_SETTINGS) assert.ok(COLOR_PASS_SETTINGS.has(path.split('.')[0]), path);
});

test('the all in focus picture is kept for a changed focus, blur or color, not for a changed scale or viewpoint', () => {
  const photo = ['gen1', 7];
  const settings = { detail: 1, ev: 0, local: {}, depthSmoothing: 0.3 };
  const base = (s, scale, u = 0) => preColorKey(s, photo, ['srbase', scale, 0, u, 0, 1, null]);
  const kept = { key: base(settings, 2) };
  // A color change (ev, local) leaves the key as it was; the request's focus and blur are not part of it at all.
  assert.equal(baseKept(kept, base({ ...settings, ev: 1, local: { masks: [1] } }, 2)), true);
  // A different scale, viewpoint or a non-color setting needs the picture made again.
  assert.equal(baseKept(kept, base(settings, 3)), false);
  assert.equal(baseKept(kept, base(settings, 2, 0.5)), false);
  assert.equal(baseKept(kept, base({ ...settings, depthSmoothing: 0.6 }, 2)), false);
  // Nothing kept, or no key: not kept.
  assert.equal(baseKept(null, base(settings, 2)), false);
  assert.equal(baseKept(kept, null), false);
});
