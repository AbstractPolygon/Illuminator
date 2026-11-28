// The picture filters of the Light L16 telephoto detail on the graphics card (gpu/l16filters.js: l16FiltersGpu, the hook core/l16hires.js setL16FiltersGpu takes, and
// l16FilterTextures, which gpu/l16region.js uses) give the processor's: the Gaussian blur of a three channel picture, the box blur (twice) of a one channel one, and the
// per channel minimum and maximum in a square window, on a textured picture with a flat area, single bright and dark pixels and borders; and renderRegion's result with only
// the filters on the card (on the made-up capture of helpers/l16scene.mjs).
//
// The processor's filters are not exported from core/l16hires.js, so the page loads a copy of that file with an export line added (its imports pointed at the real files);
// the code that runs is the processor's as it stands. Skipped where Playwright or its browser is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gpuPage } from './helpers/gpupage.mjs';
import { makeL16Scene } from './helpers/l16scene.mjs';

test('the L16 detail filters on the graphics card match the processor’s', async (t) => {
  const page = await gpuPage(t);
  if (!page) return;
  const res = await page.evaluate(async (src) => {
    const gpu = await globalThis.makeGpu();
    if (!gpu) return null;
    const gl = gpu.gl;
    const hires = await import('/js/core/l16hires.js');
    const { l16FiltersGpu, l16FilterTextures } = await import('/js/gpu/l16filters.js');
    // the processor's filters, from a copy of core/l16hires.js that exports them
    const code = (await (await fetch('/js/core/l16hires.js')).text()).replace(/from '\.\/([^']+)'/g, (m, f) => `from '${globalThis.location.origin}/js/core/${f}'`);
    const names = ['gaussCpu', 'boxBlur1Cpu', 'localBoundsCpu'];
    const missing = names.filter((n) => !new RegExp(`(function |const )${n}\\b`).test(code));
    if (missing.length) return { missing };
    const url = URL.createObjectURL(new Blob([`${code}\nexport { ${names.join(', ')} };`], { type: 'text/javascript' }));
    const cpu = await import(url);
    URL.revokeObjectURL(url);

    const w = 151;
    const h = 109;
    let seed = 7;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8) / 16777216;
    const rgb = new Float32Array(3 * w * h);
    const one = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const flat = x > 100 && y > 60;
        for (let c = 0; c < 3; c++) rgb[3 * i + c] = flat ? 0.25 + 0.1 * c : 0.4 + 0.25 * Math.sin(0.3 * x + 0.7 * c) * Math.cos(0.23 * y - 0.4 * c) + 0.2 * (rnd() - 0.5);
        one[i] = flat ? 0.6 : 0.5 + 0.3 * Math.sin(0.19 * x - 0.31 * y) + 0.3 * (rnd() - 0.5);
      }
    }
    // single bright and dark pixels, two of them on the border
    for (const [x, y, v] of [[20, 30, 3], [0, 0, 2.5], [w - 1, 50, -1], [60, h - 1, 0], [120, 80, 1.5]]) {
      const i = y * w + x;
      rgb[3 * i] = rgb[3 * i + 1] = rgb[3 * i + 2] = v;
      one[i] = v;
    }
    const diff = (a, b) => {
      if (a.length !== b.length) return Infinity;
      let m = 0;
      for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
      return m;
    };
    // (every call to the card's functions counted, and any failure kept: the processor's code falls back to itself when one fails, which would compare it with itself)
    const log = { calls: 0, errors: [] };
    const watch = (v) => {
      if (typeof v === 'function') {
        return (...a) => {
          log.calls++;
          try {
            return watch(v(...a));
          } catch (e) {
            log.errors.push(String((e && e.message) || e));
            throw e;
          }
        };
      }
      if (v && typeof v === 'object' && !ArrayBuffer.isView(v) && Object.values(v).some((x) => typeof x === 'function')) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, watch(x)]));
      return v;
    };
    const card = watch(l16FiltersGpu(gpu));
    const out = { gauss: {}, box: {}, bounds: {}, tex: {} };
    for (const sigma of [0.4, 0.9, 1.8, 4.5]) out.gauss[sigma] = diff(cpu.gaussCpu(rgb, w, h, sigma), card.gauss(rgb, w, h, sigma));
    for (const r of [1, 2, 5]) out.box[r] = diff(cpu.boxBlur1Cpu(one, w, h, r), card.boxBlur1(one, w, h, r));
    for (const r of [1, 3, 6]) {
      const a = cpu.localBoundsCpu(rgb, w, h, r);
      const b = card.localBounds(rgb, w, h, r);
      out.bounds[r] = Math.max(diff(a.min, b.min), diff(a.max, b.max));
    }
    // the texture filters region rendering uses (RGBA32F in, RGBA32F out), on the same pictures
    const made = [];
    const up = (data, ch) => {
      const buf = new Float32Array(4 * w * h);
      for (let i = 0; i < w * h; i++) for (let c = 0; c < ch; c++) buf[4 * i + c] = data[ch * i + c];
      const tx = gpu.texture(w, h, gl.RGBA32F);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, buf);
      made.push(tx);
      return tx;
    };
    const read = (tx, ch) => {
      gpu.target(tx, w, h);
      const buf = new Float32Array(4 * w * h);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, buf);
      const o = new Float32Array(ch * w * h);
      for (let i = 0; i < w * h; i++) for (let c = 0; c < ch; c++) o[ch * i + c] = buf[4 * i + c];
      return o;
    };
    const ft = l16FilterTextures(gpu);
    const rgbT = up(rgb, 3);
    const oneT = up(one, 1);
    out.tex.gauss = diff(cpu.gaussCpu(rgb, w, h, 1.8), read(ft.gauss(made, rgbT, w, h, 1.8), 3));
    out.tex.box = diff(cpu.boxBlur1Cpu(one, w, h, 2), read(ft.box(made, oneT, w, h, 2), 1));
    const tb = ft.bounds(made, rgbT, w, h, 3);
    const cb = cpu.localBoundsCpu(rgb, w, h, 3);
    out.tex.bounds = Math.max(diff(cb.min, read(tb.min, 3)), diff(cb.max, read(tb.max, 3)));
    for (const tx of made) gl.deleteTexture(tx);

    // renderRegion with only the filters on the card
    const s = (0, eval)(`(${src})`)();
    hires.setL16FiltersGpu(null);
    const a = hires.renderRegion(s.bytes, s.parsed, s.depth, s.wide, s.region, s.modules, s.opts, () => {}, s.rawCache);
    hires.setL16FiltersGpu(card);
    const b = hires.renderRegion(s.bytes, s.parsed, s.depth, s.wide, s.region, s.modules, s.opts, () => {}, s.rawCache);
    hires.setL16FiltersGpu(null);
    out.whole = { worst: diff(a.rgb, b.rgb), covered: [a.covered, b.covered] };
    out.err = gl.getError();
    out.log = log;
    return out;
  }, makeL16Scene.toString());
  if (!res) return t.skip('No float render targets');
  assert.ok(!res.missing, `core/l16hires.js no longer has ${res.missing}: point this test at the processor's filters`);
  assert.equal(res.err, 0);
  assert.deepEqual(res.log.errors, [], 'a step on the graphics card failed');
  assert.ok(res.log.calls > 0, 'the graphics card was not used');
  // The blurs: the same weights (single precision) summed in single precision on the card, in double on the processor and stored in single after each pass. With values up to
  // 3 (a unit in the last place is 2.4e-7 there) and at most 25 terms a pass, a few units at most (measured up to 4.8e-7).
  for (const [sigma, d] of Object.entries(res.gauss)) assert.ok(d < 4e-6, `Gaussian blur, sigma ${sigma}: differs by up to ${d}`);
  for (const [r, d] of Object.entries(res.box)) assert.ok(d < 4e-6, `box blur, radius ${r}: differs by up to ${d}`);
  // the minimum and maximum pick one of the input values: exact
  for (const [r, d] of Object.entries(res.bounds)) assert.equal(d, 0, `minimum and maximum, radius ${r}`);
  assert.ok(res.tex.gauss < 4e-6, `Gaussian blur on textures: differs by up to ${res.tex.gauss}`);
  assert.ok(res.tex.box < 4e-6, `box blur on textures: differs by up to ${res.tex.box}`);
  assert.equal(res.tex.bounds, 0, 'minimum and maximum on textures');
  // (renderRegion: a pixel on the other side of one of its thresholds would differ by far more, see l16region-gpu.test.mjs; measured 3e-7)
  assert.ok(res.whole.worst < 2e-5, `renderRegion differs by up to ${res.whole.worst} with the filters on the card`);
  assert.equal(res.whole.covered[1], res.whole.covered[0]);
});
