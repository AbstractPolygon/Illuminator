import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLocalTone, applyLocalTone, airlight, hazeMap, localToneForSize } from '../app/js/core/localtone.js';

const luma = (rgb, i) => 0.2126 * rgb[3 * i] + 0.7152 * rgb[3 * i + 1] + 0.0722 * rgb[3 * i + 2];
// a gray picture with fine stripes (two pixels) on the left half and broad steps (twenty pixels) on the right
function picture(w = 96, h = 24) {
  const rgb = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = x < w / 2 ? 0.18 * (1 + 0.3 * ((x >> 1) % 2 ? 1 : -1)) : 0.18 * (1 + 0.3 * (Math.floor(x / 20) % 2 ? 1 : -1));
    rgb.set([v, v, v], (y * w + x) * 3);
  }
  return { rgb, w, h };
}
const spread = (rgb, w, x0, x1, y = 12) => { let lo = Infinity, hi = -Infinity; for (let x = x0; x < x1; x++) { const v = luma(rgb, y * w + x); lo = Math.min(lo, v); hi = Math.max(hi, v); } return hi - lo; };

test('all at 0: nothing to do', () => {
  assert.equal(makeLocalTone({ tone: {} }), null);
  const { rgb, w, h } = picture();
  assert.equal(applyLocalTone(rgb, w, h, null), rgb);
});

test('texture strengthens the fine stripes, and below 0 smooths them, more than the broad steps', () => {
  const { rgb, w, h } = picture();
  const up = applyLocalTone(rgb, w, h, makeLocalTone({ tone: { texture: 1 } }));
  const down = applyLocalTone(rgb, w, h, makeLocalTone({ tone: { texture: -1 } }));
  const fine0 = spread(rgb, w, 8, 40);
  assert.ok(spread(up, w, 8, 40) > fine0 * 1.2, 'fine detail stronger');
  assert.ok(spread(down, w, 8, 40) < fine0 * 0.7, 'fine detail smoothed');
});

test('clarity strengthens the broad steps (the plateaus apart), which texture leaves alone', () => {
  const { rgb, w, h } = picture();
  // the middles of two neighboring 20 pixel plateaus
  const step = (arr) => luma(arr, 12 * w + 70) - luma(arr, 12 * w + 54);
  const clar = applyLocalTone(rgb, w, h, makeLocalTone({ tone: { clarity: 1 } }));
  const tex = applyLocalTone(rgb, w, h, makeLocalTone({ tone: { texture: 1 } }));
  assert.ok(step(clar) > step(rgb) * 1.1, `broad detail stronger with clarity: ${step(clar)} vs ${step(rgb)}`);
  assert.ok(Math.abs(step(tex) - step(rgb)) < 0.02 * step(rgb), 'texture does not change the plateaus');
});

test('the color is kept: a pixel only changes brightness', () => {
  const { w, h } = picture();
  const rgb = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) rgb.set([0.3 * (1 + 0.2 * Math.sin(i)), 0.15 * (1 + 0.2 * Math.sin(i)), 0.05 * (1 + 0.2 * Math.sin(i))], 3 * i);
  const out = applyLocalTone(rgb, w, h, makeLocalTone({ tone: { clarity: 0.8, texture: 0.5 } }));
  for (const i of [5, 100, 777]) assert.ok(Math.abs(out[3 * i] / out[3 * i + 1] - rgb[3 * i] / rgb[3 * i + 1]) < 1e-4);
});

test('dehaze takes haze out where it lies and leaves clear parts nearly alone; below 0 it adds haze', () => {
  const w = 64;
  const h = 16;
  const air = [0.6, 0.62, 0.66];
  // top rows: the hazy sky (the airlight itself); below, left half: a dark red object seen through thick haze; right half: the same object, clear
  const rgb = new Float32Array(w * h * 3);
  const obj = [0.2, 0.02, 0.02];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const t = y < 3 ? 0 : x < w / 2 ? 0.4 : 1;
    rgb.set(obj.map((o, c) => o * t + air[c] * (1 - t)), (y * w + x) * 3);
  }
  const a = airlight(rgb);
  assert.ok(a && a[2] > a[0] * 0.8, `airlight found: ${a}`);
  const haze = hazeMap(rgb, w, h, a);
  assert.ok(haze[8 * w + 8] > haze[8 * w + 56] + 0.3, `hazy part has more haze: ${haze[8 * w + 8]} vs ${haze[8 * w + 56]}`);
  const p = { ...makeLocalTone({ tone: { dehaze: 1 } }), air: a };
  const out = applyLocalTone(rgb, w, h, p);
  const sat = (arr, i) => arr[3 * i] - arr[3 * i + 2];
  const hazy = 8 * w + 8;
  const clear = 8 * w + 56;
  assert.ok(sat(out, hazy) > sat(rgb, hazy) * 1.5, 'the hazy part gets its color back');
  assert.ok(Math.abs(sat(out, clear) - sat(rgb, clear)) < 0.25 * sat(rgb, clear), 'the clear part changes little');
  const more = applyLocalTone(rgb, w, h, { ...makeLocalTone({ tone: { dehaze: -1 } }), air: a });
  assert.ok(sat(more, clear) < sat(rgb, clear) * 0.92, 'below 0 haze is added');
});

test('sizes grow with the pixels per lens', () => {
  const p = makeLocalTone({ tone: { clarity: 0.5 } });
  assert.equal(localToneForSize(p, 625, 625), p);
  assert.equal(localToneForSize(p, 1875, 625).scale, 3);
});
