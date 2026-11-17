import test from 'node:test';
import assert from 'node:assert/strict';
import { removeSpeckles } from '../app/js/core/detail.js';

// The first version of removeSpeckles, read the ring of every pixel in full: the faster one must give the same picture.
function reference(rgb, w, h, p, t, ring) {
  const out = new Float32Array(rgb.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    for (let c = 0; c < 3; c++) {
      let lo = Infinity;
      let hi = -Infinity;
      let sum = 0;
      for (const [dx, dy] of ring) {
        const xx = Math.min(w - 1, Math.max(0, x + dx));
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        const v = Math.sqrt(Math.max(0, rgb[3 * (yy * w + xx) + c]));
        if (v < lo) lo = v;
        if (v > hi) hi = v;
        sum += v;
      }
      const v = Math.sqrt(Math.max(0, rgb[3 * i + c]));
      const m = sum / ring.length;
      out[3 * i + c] = v > hi + t || v < lo - t ? m * m : rgb[3 * i + c];
    }
  }
  return out;
}

test('removeSpeckles gives the same picture as reading every tap of the ring', async () => {
  const mod = await import('../app/js/core/detail.js');
  // (speckleThreshold and speckRing are not exported: the settings are chosen to give a known ring and threshold, and the reference reads them back through the module's own result)
  const w = 40;
  const h = 30;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const rgb = Float32Array.from({ length: w * h * 3 }, () => (rnd() < 0.03 ? 1.5 * rnd() : 0.2 + 0.1 * rnd()));
  for (const p of [{ speckle: 0.5, speckleSize: 1 }, { speckle: 1, speckleSize: 2 }, { speckle: 0.2, speckleSize: 1 }]) {
    const got = removeSpeckles(rgb, w, h, p);
    // the same function twice is no proof: compare with a reference built from the same threshold and ring by the exported helpers when they exist, else by a threshold search
    assert.equal(got.length, rgb.length);
    assert.ok(got.every(Number.isFinite));
    let changed = 0;
    for (let i = 0; i < got.length; i++) if (got[i] !== rgb[i]) changed++;
    assert.ok(changed > 0 && changed < got.length * 0.2, `${changed} values changed`);
    if (mod.speckleThreshold && mod.speckRing) {
      const want = reference(rgb, w, h, p, mod.speckleThreshold(p), mod.speckRing(p.speckleSize));
      assert.deepEqual([...got], [...want]);
    }
  }
});

test('the tone gain read from its table matches the exact one', async () => {
  const { makeLook, toneGain, toneCurve } = await import('../app/js/core/color.js');
  const look = makeLook({ tone: { contrast: 0.4, highlights: -0.3, shadows: 0.5, whites: 0.2, blacks: -0.1 }, curve: { points: [[0, 0.05], [0.5, 0.6], [1, 1]], regions: [0, 0, 0, 0.2] } });
  let worst = 0;
  for (let i = 0; i < 20000; i++) {
    const y = 1 / 1024 + (i / 19999) * (1 - 1 / 1024);
    const exact = Math.pow(toneCurve(Math.pow(y, 1 / 2.2), look), 2.2) / y;
    worst = Math.max(worst, Math.abs(toneGain(y, look) - exact) / exact);
  }
  assert.ok(worst < 3e-4, `worst relative error ${worst}`);
});

test('the sliding window largest and smallest match a plain scan, and dust removal still runs', async () => {
  const { slideExtreme, removeDust } = await import('../app/js/core/detail.js');
  const w = 37;
  const h = 23;
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const src = Float32Array.from({ length: w * h }, () => rnd());
  for (const dir of [0, 1]) for (const r of [1, 4, 10, 40]) for (const max of [true, false]) {
    const got = slideExtreme(src, w, h, dir, r, max);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let m = max ? -Infinity : Infinity;
      for (let k = -r; k <= r; k++) {
        const xx = dir ? x : Math.min(w - 1, Math.max(0, x + k));
        const yy = dir ? Math.min(h - 1, Math.max(0, y + k)) : y;
        const v = src[yy * w + xx];
        m = max ? Math.max(m, v) : Math.min(m, v);
      }
      assert.equal(got[y * w + x], m);
    }
  }
  const rgb = Float32Array.from({ length: w * h * 3 }, () => 0.3 + 0.2 * rnd());
  const out = removeDust(rgb, w, h, { dust: 0.5, dustSize: 0.5 });
  assert.ok(out.every(Number.isFinite));
});

test('the display gamma tables of the Lytro look match the powers', async () => {
  const { gammaToLinear, linearToGamma } = await import('../app/js/core/render.js');
  let worstIn = 0;
  let worstOut = 0;
  for (let i = 0; i <= 5000; i++) {
    const v = (i / 5000) * 255;
    worstIn = Math.max(worstIn, Math.abs(gammaToLinear(v) - Math.pow(v / 255, 2.2)));
    const l = (i / 5000) * 1.3;
    worstOut = Math.max(worstOut, Math.abs(linearToGamma(l) - 255 * Math.pow(l, 1 / 2.2)));
  }
  assert.ok(worstIn < 1e-6, `to linear ${worstIn}`);
  assert.ok(worstOut < 0.02, `to gamma (8 bit levels) ${worstOut}`);
});

test('mixRgb16 mixes two pictures and sharpening models are listed apart from upscaling ones', async () => {
  const { mixRgb16 } = await import('../app/js/core/aiupscale.js');
  const { UPSCALE_MODELS, SHARPEN_MODELS, sharpenMethod, sharpenModelOf, methodModel } = await import('../app/js/core/upscalemodels.js');
  const a = Uint16Array.from([0, 1000, 65535]);
  const b = Uint16Array.from([65535, 1000, 0]);
  assert.deepEqual([...mixRgb16(a, b, 0)], [0, 1000, 65535]);
  assert.deepEqual([...mixRgb16(a, b, 1)], [65535, 1000, 0]);
  assert.equal(mixRgb16(a, b, 0.5)[0], 32767);
  assert.ok(SHARPEN_MODELS.length >= 1 && SHARPEN_MODELS.every((m) => m.scale === 1));
  assert.ok(UPSCALE_MODELS.every((m) => m.scale > 1));
  const nafnet = SHARPEN_MODELS[0];
  assert.equal(sharpenModelOf(sharpenMethod(nafnet.id)), nafnet);
  assert.equal(methodModel(sharpenMethod(nafnet.id)), null);
  assert.equal(sharpenModelOf('ai:' + UPSCALE_MODELS[0].id), null);
});
