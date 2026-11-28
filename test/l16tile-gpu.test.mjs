// The finish of a processed photo's tile on the graphics card (gpu/l16tile.js, as worker.js tilePixelsOnGpu and tileTexOnGpu use it) gives the processor's: the glow and flare
// light added at the tile's place (core/bokehfx.js addFxLight), the 8 bit pixels read back top row first, and the whole finish (detail, Texture, Clarity and Dehaze, the
// spots, the lens and the color pass) against worker.js toPixels's steps. Made-up pictures with sharp edges; tiles inside the whole picture and at its far corner.
// Skipped where Playwright or its browser is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gpuPage } from './helpers/gpupage.mjs';

test('the glow and flare light added on the graphics card matches the processor’s', async (t) => {
  const page = await gpuPage(t);
  if (!page) return;
  const res = await page.evaluate(async () => {
    const gpu = await globalThis.makeGpu();
    if (!gpu) return null;
    const gl = gpu.gl;
    const { l16TileGpu } = await import('/js/gpu/l16tile.js');
    const { addFxLight } = await import('/js/core/bokehfx.js');
    let s = 5;
    const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 8) / 16777216;
    const steps = l16TileGpu(gpu);
    // the light for a whole picture of 150 x 110 (half size, rounded up: 75 x 55), with a bright streak and soft fog
    const hw = 75;
    const hh = 55;
    const lightData = new Float32Array(3 * hw * hh);
    for (let y = 0; y < hh; y++) {
      for (let x = 0; x < hw; x++) {
        const i = 3 * (y * hw + x);
        const streak = Math.abs(y - 20) < 2 ? 2 : 0;
        for (let c = 0; c < 3; c++) lightData[i + c] = 0.05 * rnd() + streak * (0.5 + 0.2 * c) + 0.1 * Math.sin(0.2 * x + c);
      }
    }
    const light = { light: lightData, hw, hh };
    const cases = [
      { name: 'the whole picture', w: 150, h: 110, frame: null },
      { name: 'a tile inside', w: 64, h: 48, frame: { x: 37, y: 21, width: 150, height: 110 } },
      { name: 'a tile at the far corner', w: 40, h: 30, frame: { x: 110, y: 80, width: 150, height: 110 } },
      { name: 'a tile of a picture made bigger than the light', w: 90, h: 70, frame: { x: 133, y: 57, width: 300, height: 220 } },
    ];
    const out = [];
    for (const c of cases) {
      const { w, h, frame } = c;
      const rgb = new Float32Array(3 * w * h);
      for (let i = 0; i < w * h; i++) for (let k = 0; k < 3; k++) rgb[3 * i + k] = (i % w < w / 2 ? 0.2 : 0.7) * rnd();
      const cpu = addFxLight(rgb, w, h, light, frame);
      const rgba = new Float32Array(4 * w * h);
      for (let i = 0; i < w * h; i++) rgba.set([rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2], 1], 4 * i);
      const src = gpu.texture(w, h, gl.RGBA32F);
      gl.bindTexture(gl.TEXTURE_2D, src);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, rgba);
      const lit = steps.addLight(src, w, h, light, frame);
      const ch = gpu.readChannels(lit, w, h, 3);
      let worst = 0;
      for (let i = 0; i < w * h; i++) for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(ch[k][i] - cpu[3 * i + k]));
      gl.deleteTexture(src);
      gl.deleteTexture(lit);
      out.push({ name: c.name, worst, err: gl.getError() });
    }
    steps.release();
    return out;
  });
  if (!res) return t.skip('No float render targets');
  for (const c of res) {
    assert.equal(c.err, 0, c.name);
    // (bilinear weights in single precision on values up to about 3: a few float steps)
    assert.ok(c.worst < 1e-5, `${c.name}: the card differs from the processor by up to ${c.worst}`);
  }
});

test('the tile’s 8 bit pixels come back top row first and opaque', async (t) => {
  const page = await gpuPage(t);
  if (!page) return;
  const res = await page.evaluate(async () => {
    const gpu = await globalThis.makeGpu();
    if (!gpu) return null;
    const gl = gpu.gl;
    const { l16TileGpu } = await import('/js/gpu/l16tile.js');
    const w = 37;
    const h = 23;
    // an 8 bit texture as the color pass writes it (bottom row first), with alpha that is not 255
    const bytes = new Uint8Array(4 * w * h);
    for (let i = 0; i < w * h; i++) bytes.set([i % 251, (7 * i) % 253, (i >> 3) % 255, i % 200], 4 * i);
    const tex = gpu.texture(w, h, gl.RGBA8);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    const px = l16TileGpu(gpu).pixels(tex, w, h);
    let wrong = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = 4 * (y * w + x);
        const i = 4 * ((h - 1 - y) * w + x);
        if (px[o] !== bytes[i] || px[o + 1] !== bytes[i + 1] || px[o + 2] !== bytes[i + 2] || px[o + 3] !== 255) wrong++;
      }
    }
    gl.deleteTexture(tex);
    return { wrong, kind: px.constructor.name, length: px.length, err: gl.getError() };
  });
  if (!res) return t.skip('No float render targets');
  assert.equal(res.err, 0);
  assert.equal(res.kind, 'Uint8ClampedArray');
  assert.equal(res.length, 4 * 37 * 23);
  assert.equal(res.wrong, 0, `${res.wrong} pixels are not the texture's, flipped and opaque`);
});

// The finish as worker.js tilePixelsOnGpu runs it (details, localTone, retouch, present into an 8 bit texture, then the module's pixels) against the processor's steps in
// toPixels (applyDetail, applyLocalTone, applySpots, applyLens, toneMap) on the same picture.
test('a tile finished on the graphics card matches the processor’s finish', async (t) => {
  const page = await gpuPage(t);
  if (!page) return;
  const res = await page.evaluate(async () => {
    const gpu = await globalThis.makeGpu();
    if (!gpu) return null;
    const gl = gpu.gl;
    const { l16TileGpu } = await import('/js/gpu/l16tile.js');
    const { makeDetail, applyDetail } = await import('/js/core/detail.js');
    const { makeLocalTone, applyLocalTone } = await import('/js/core/localtone.js');
    const { parseSpots, resolveSpots, packSpots, applySpots } = await import('/js/core/retouch.js');
    const { lensParams, applyLens } = await import('/js/core/lens.js');
    const { makeLook } = await import('/js/core/color.js');
    const { toneMap } = await import('/js/core/render.js');
    let s = 23;
    const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 8) / 16777216;
    const W = 128;
    const H = 96;
    // a picture with a dark and a light half, a bright square, fine noise and a small dark blemish for the spot
    const rgb = new Float32Array(3 * W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = 3 * (y * W + x);
        let base = x < W / 2 ? 0.08 : 0.35;
        if (x > 80 && x < 100 && y > 20 && y < 40) base = 0.8;
        if (Math.hypot(x - 40, y - 60) < 3) base = 0.01;
        for (let c = 0; c < 3; c++) rgb[i + c] = Math.max(0, base * (0.8 + 0.15 * c) + 0.03 * (rnd() - 0.5));
      }
    }
    const detail = makeDetail({ details: { amount: 60, radius: 1.2, detail: 40, luminance: 30, color: 25 } });
    const tone = makeLocalTone({ tone: { texture: 0.3, clarity: 0.25, dehaze: 0.15 } });
    tone.air = [0.6, 0.62, 0.65];
    // (a heal on the blemish, and a clone in the corner tile)
    const spots = resolveSpots(
      parseSpots(JSON.stringify([
        { mode: 'heal', x: 40 / W, y: 60 / H, r: 0.04, feather: 0.5, opacity: 1, sx: 20 / W, sy: 60 / H },
        { mode: 'clone', x: 100 / W, y: 70 / H, r: 0.05, feather: 0.3, opacity: 0.8, sx: 90 / W, sy: 30 / H },
      ])),
      {},
    );
    const lens = lensParams({ distortion: 10, vignetting: 30, midpoint: 40 });
    const look = makeLook({ tone: { contrast: 0.2, shadows: 0.15 }, color: { vibrance: 0.1 } });
    const matrix = [1.2, -0.15, -0.05, -0.1, 1.15, -0.05, 0, -0.2, 1.2];
    const exposure = 1.3;
    const cases = [
      { name: 'the whole picture', x: 0, y: 0, w: W, h: H, frame: null },
      { name: 'a tile at the far corner', x: 64, y: 48, w: 64, h: 48, frame: { x: 64, y: 48, width: W, height: H } },
    ];
    const steps = l16TileGpu(gpu);
    const out = [];
    for (const c of cases) {
      const { w, h, frame } = c;
      const tile = new Float32Array(3 * w * h);
      for (let y = 0; y < h; y++) tile.set(rgb.subarray(3 * ((y + c.y) * W + c.x), 3 * ((y + c.y) * W + c.x + w)), 3 * y * w);
      // (the spots, placed on the whole picture, moved into the tile's fractions as worker.js spotsFor does)
      const tileSpots = frame ? spots.map((sp) => ({ ...sp, x: (sp.x * W - frame.x) / w, y: (sp.y * H - frame.y) / h, sx: (sp.sx * W - frame.x) / w, sy: (sp.sy * H - frame.y) / h, r: (sp.r * Math.max(W, H)) / Math.max(w, h) })) : spots;
      // the processor
      let p = applyDetail(tile, w, h, detail);
      p = applyLocalTone(p, w, h, tone);
      p = applySpots(p, w, h, tileSpots);
      p = applyLens(p, w, h, lens, frame);
      const cpu = toneMap(p, matrix, exposure, undefined, look, null, null, null);
      // the card
      const rgba = new Float32Array(4 * w * h);
      for (let i = 0; i < w * h; i++) rgba.set([tile[3 * i], tile[3 * i + 1], tile[3 * i + 2], 1], 4 * i);
      let tex = gpu.texture(w, h, gl.RGBA32F);
      const src = tex;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, rgba);
      tex = gpu.details(tex, w, h, detail);
      tex = gpu.localTone(tex, w, h, tone);
      tex = gpu.retouch(tex, w, h, packSpots(tileSpots));
      const into = gpu.texture(w, h, gl.RGBA8);
      gpu.present(tex, w, h, { matrix, exposure, fringe: null, look, veilAmount: 0, lens, lutAmount: 0, local: null, lytro: false, into, frame });
      const card = steps.pixels(into, w, h);
      gl.deleteTexture(src);
      gl.deleteTexture(into);
      let worst = 0;
      let sum = 0;
      for (let i = 0; i < w * h; i++) {
        for (let k = 0; k < 3; k++) {
          const d = Math.abs(card[4 * i + k] - cpu[4 * i + k]);
          worst = Math.max(worst, d);
          sum += d;
        }
      }
      // (the spot changed the blemish, so the spot pass is in the comparison)
      const at = 4 * ((60 - c.y) * w + (40 - c.x));
      const blemish = c.x <= 40 && c.y <= 60 ? cpu[at] : null;
      out.push({ name: c.name, worst, mean: sum / (3 * w * h), blemish, err: gl.getError() });
    }
    return out;
  });
  if (!res) return t.skip('No float render targets');
  console.log(JSON.stringify(res));
  for (const c of res) {
    assert.equal(c.err, 0, c.name);
    if (c.blemish !== null) assert.ok(c.blemish > 20, `${c.name}: the spot did not heal the blemish (${c.blemish})`);
    // 8 bit output from single precision steps (blurs, the lens's resampling, the tone curve): a value next to a rounding edge lands one step off (about 7% of the values
    // on SwiftShader), never more.
    assert.ok(c.worst <= 1, `${c.name}: the card differs from the processor by up to ${c.worst} steps`);
    assert.ok(c.mean < 0.15, `${c.name}: the card differs from the processor by ${c.mean} steps on average`);
  }
});
