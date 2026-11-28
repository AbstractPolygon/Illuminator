// The last steps of developing a Light L16 photo on the graphics card (gpu/l16develop.js, set with core/l16photo.js setL16DevelopGpu) give the processor's: the color
// matrix (colorCopy: highlights taken toward gray, colors the matrix puts below zero moved toward gray) and the picture shown (encodePicture: the exposure gain, cut at 1,
// sRGB, 8 bits), with and without a matrix, and the whole of developL16 from a merged picture (its color matrix from a made-up calibration, its exposure from the
// greens). The made-up picture has black, the sRGB curve's straight part, saturated colors, values past the white level and a ramp through the highlights. Skipped where
// Playwright or its browser is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gpuPage } from './helpers/gpupage.mjs';

test('the L16 picture developed on the graphics card matches the processor’s', async (t) => {
  const page = await gpuPage(t);
  if (!page) return;
  const res = await page.evaluate(async () => {
    const gpu = await globalThis.makeGpu();
    if (!gpu) return null;
    const { colorCopy, encodePicture, developL16, setL16DevelopGpu, colorMatrixOf } = await import('/js/core/l16photo.js');
    const { l16DevelopGpu } = await import('/js/gpu/l16develop.js');
    // (counted, and the processor's fallback watched for: a card that failed would leave the processor's result on both sides)
    const card = l16DevelopGpu(gpu);
    let calls = 0;
    const counted = { encode: (...a) => (calls++, card.encode(...a)), color: (...a) => (calls++, card.color(...a)) };
    const warnings = [];
    const warn = console.warn;
    console.warn = (...a) => warnings.push(a.map(String).join(' '));
    let s = 9;
    const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 8) / 16777216;
    const w = 150;
    const h = 100;
    const rgb = new Float32Array(3 * w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = 3 * (y * w + x);
        let v;
        if (y < 10) v = [0, 0, 0]; // black
        else if (y < 25) v = [0.004 * rnd(), 0.004 * rnd(), 0.004 * rnd()]; // the sRGB curve's straight part
        else if (y < 45) v = [rnd() * rnd(), rnd() * 0.05, rnd()]; // saturated colors (the matrix puts some below zero)
        else if (y < 60) v = [1 + rnd(), 0.95 + 0.2 * rnd(), 1.5 * rnd()]; // past the white level
        else if (y < 80) v = [x / w, (x / w) * (0.8 + 0.2 * rnd()), (x / w) * 0.9]; // a ramp through the highlights
        else v = [rnd() * 0.6, rnd() * 0.6, rnd() * 0.6];
        rgb.set(v, i);
      }
    }
    // a camera to sRGB matrix (row-major) of the usual shape
    const matrix = [1.82, -0.61, -0.21, -0.27, 1.53, -0.26, 0.04, -0.57, 1.53];
    const both = (fn) => {
      setL16DevelopGpu(null);
      const cpu = fn();
      setL16DevelopGpu(counted);
      try {
        return { cpu, card: fn() };
      } finally {
        setL16DevelopGpu(null);
      }
    };
    const floatDiff = (a, b) => {
      let worst = 0;
      for (let i = 0; i < a.length; i++) {
        const d = Math.abs(a[i] - b[i]);
        if (!(d <= worst)) worst = d;
      }
      return { worst, size: a.length === b.length };
    };
    // 8 bit values: the largest difference, and how many differ
    const byteDiff = (a, b) => {
      let worst = 0;
      let off = 0;
      for (let i = 0; i < a.length; i++) {
        const d = Math.abs(a[i] - b[i]);
        if (d > worst) worst = d;
        if (d) off++;
      }
      return { worst, off, n: a.length, size: a.length === b.length };
    };
    const out = {};
    const input = Float32Array.from(rgb);
    const color = both(() => colorCopy(rgb, w, h, matrix));
    out.color = floatDiff(color.cpu, color.card);
    for (const [name, gain, m] of [['encode', 1.3, null], ['encodeMatrix', 0.85, matrix], ['encodeBright', 4, matrix]]) {
      const r = both(() => encodePicture(rgb, w, h, gain, m));
      out[name] = byteDiff(r.cpu, r.card);
    }
    out.unchanged = rgb.every((v, i) => v === input[i]);
    // developL16 from a merged picture: the matrix from the reference camera's calibration (two lights), the exposure from the greens
    const fm = (k) => ({ x00: 0.6 * k, x01: 0.3, x02: 0.1, x10: 0.25, x11: 0.7 * k, x12: 0.05, x20: 0.02, x21: 0.1, x22: 0.7 + 0.1 * k });
    const parsed = { header: { view_preferences: { awb_gains: { r: 1.9, b: 1.6 } }, module_calibration: [{ camera_id: 'A1', color: [{ forward_matrix: fm(1), rg_ratio: 0.55, bg_ratio: 0.6 }, { forward_matrix: fm(1.1), rg_ratio: 0.8, bg_ratio: 0.35 }] }] } };
    const merged = { width: w, height: h, rgb, used: 5 };
    const dev = both(() => developL16(null, parsed, null, 'A1', {}, () => {}, merged));
    out.develop = { ...byteDiff(dev.cpu.picture.data, dev.card.picture.data), gain: [dev.cpu.gain, dev.card.gain], hasMatrix: !!colorMatrixOf(parsed, 'A1') };
    console.warn = warn;
    return { out, calls, warnings, err: gpu.gl.getError() };
  });
  if (!res) return t.skip('No float render targets');
  assert.equal(res.err, 0);
  assert.deepEqual(res.warnings, [], 'the card failed and the processor made the picture');
  assert.equal(res.calls, 6, 'every step of the card side was made on the card');
  const { out } = res;
  assert.ok(out.unchanged, 'encodePicture changed the picture it was given');
  // the color matrix: single precision on both sides (the processor's results are kept in a Float32Array), so a few units in the last place of values up to about 2
  assert.ok(out.color.size);
  assert.ok(out.color.worst < 2e-6, `the color matrix on the card differs from the processor's by up to ${out.color.worst}`);
  // The picture shown: the card works out sRGB in single precision and the processor in double, so a value within about 1e-6 of halfway between two 8 bit levels can
  // round the other way: one level at most, and only for a handful of values (here 0.1% at most).
  for (const name of ['encode', 'encodeMatrix', 'encodeBright', 'develop']) {
    const r = out[name];
    assert.ok(r.size, `${name}: the card's picture is not the processor's size`);
    assert.ok(r.worst <= 1, `${name}: the card's picture differs from the processor's by up to ${r.worst} levels`);
    assert.ok(r.off <= r.n / 1000, `${name}: ${r.off} of ${r.n} values differ`);
  }
  assert.ok(out.develop.hasMatrix, 'the made-up calibration gave no color matrix');
  assert.ok(Math.abs(out.develop.gain[0] - out.develop.gain[1]) < 1e-5 * out.develop.gain[0], `the exposure differs: ${out.develop.gain}`);
});
