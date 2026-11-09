// The fixed limits inside the GPU shaders (a loop's trip count, a search window, a float32 counter) must refuse an input that
// would exceed them, so the caller falls back to the CPU path, rather than quietly give a wrong result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkArmLength } from '../app/js/gpu/depthmatch.js';
import { checkSlicFix, checkSlicDrift, slicDriftLimit } from '../app/js/gpu/regions.js';
import { histChunks } from '../app/js/gpu/enginemod.js';

test('the GPU depth arms refuse a reach beyond the shader loop', () => {
  checkArmLength(24);
  checkArmLength(34); // the engine's arm
  checkArmLength(129); // reach 128: the loop's last step
  assert.throws(() => checkArmLength(130), /at most 128/);
  assert.throws(() => checkArmLength(Infinity), /at most 128/);
  assert.throws(() => checkArmLength(NaN), /at most 128/);
});

test('the SLIC fix refuses a run of unreached pixels longer than its look-back', () => {
  checkSlicFix(0);
  checkSlicFix(2499);
  assert.throws(() => checkSlicFix(-1), /4095 pixels/);
});

test('the SLIC assignment refuses centers that moved beyond the cells it searches', () => {
  const step = 40;
  const S = 40;
  const limit = slicDriftLimit(step, S);
  assert.equal(limit, 100); // 3.5 cells less the window
  const seeds = Float32Array.from([20, 20, 0, 0, 60, 20, 0, 0]);
  const at = (dx, dy) => Float32Array.from([20 + dx, 20 + dy, 0, 0, 60, 20, 0, 0]);
  checkSlicDrift(at(0, 0), seeds, 2, step, S);
  checkSlicDrift(at(100, -100), seeds, 2, step, S);
  assert.throws(() => checkSlicDrift(at(101, 0), seeds, 2, step, S), /moved 101\.0 pixels/);
  assert.throws(() => checkSlicDrift(at(0, -150), seeds, 2, step, S), /moved 150\.0 pixels/);
});

test('the modulation histogram is drawn in chunks that a float32 counter holds exactly', () => {
  const EXACT = 2 ** 24;
  assert.deepEqual(histChunks(0), []);
  assert.deepEqual(histChunks(1000), [[0, 1000]]);
  assert.deepEqual(histChunks(EXACT), [[0, EXACT]]);
  assert.deepEqual(histChunks(EXACT + 1), [[0, EXACT], [EXACT, 1]]);
  // An ILLUM's 41 million pixels and a 100 MP sensor: every chunk fits, together they cover every point once.
  for (const total of [41_000_000, 100_000_000]) {
    const chunks = histChunks(total);
    let next = 0;
    for (const [first, count] of chunks) {
      assert.equal(first, next);
      assert.ok(count > 0 && count <= EXACT);
      next += count;
    }
    assert.equal(next, total);
  }
});

// A one-pixel-high picture (8000 wide: within a texture limit of 8192) has no SLIC center seed (the grid starts half a step down), so every pixel is unreached: a run far longer than
// the fix looks back. The GPU must report that it cannot do it (null: the caller uses the CPU slic(), which seeds a center in the middle).
test('the GPU superpixels give up on a run of unreached pixels instead of mislabeling it', async (t) => {
  const { launchBrowser } = await import('./helpers/playwright.mjs');
  const http = await import('node:http');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
  const browser = await launchBrowser(t);
  if (!browser) return;
  const server = http.createServer((q, r) => {
    const u = decodeURIComponent(q.url.split('?')[0]);
    if (u === '/t.html') {
      r.writeHead(200, { 'content-type': 'text/html' });
      return r.end('<!doctype html><meta charset=utf8>');
    }
    fs.readFile(path.join(root, u), (e, d) => {
      r.writeHead(e ? 404 : 200, { 'content-type': u.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
      r.end(e ? undefined : d);
    });
  }).listen(0);
  try {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${server.address().port}/t.html`);
    const res = await page.evaluate(async () => {
      const { GpuRenderer } = await import('/js/gpu/renderer.js');
      const { regionsGpu } = await import('/js/gpu/regions.js');
      const S = await import('/js/core/segments.js');
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const told = [];
      const g = regionsGpu(new GpuRenderer(gl), (stage, e) => told.push(`${stage}: ${e.message}`));
      if (!g) return null;
      const w = 8000;
      const lab = new Float32Array(w * 3);
      const got = g.slicLabels(lab, w, 1, 2500, 8);
      const cpu = S.slic(lab, w, 1, 2500, 8);
      return { got, told, cpuCount: cpu.count };
    });
    if (!res) return t.skip('No WebGL2 with float targets');
    assert.equal(res.got, null);
    assert.equal(res.told.length, 1);
    assert.match(res.told[0], /unreached|moved|SLIC/);
    assert.equal(res.cpuCount, 1);
  } finally {
    await browser.close();
    server.close();
  }
});

// slicDriftLimit was derived, then measured (largest center move over the iterations, in cells, at the production settings count 2500 / compactness 8; the throw happens above
// 3.5 cells less the window, that is 2.15 to 2.5 cells at step 2 to 2.4 and about 2.4 to 2.5 from step 4 on):
//   photos (screens, rendered samples, Lytro frames) 120 px to 1250 px wide: 1.9 at most (120 px wide, step 2.4); 1.4 from 250 px wide on
//   adversarial pictures (step edges, noise, thin lines, gradients, flat, checker) 320 px to 1250 px wide: 1.6 at most; pure noise at 160 x 120 (step 2.4): 2.22 of 2.25
// so a normal photo is far inside, and only a picture about the size of a thumbnail with pure noise comes close. The tests keep the worst cases on the GPU and a real overshoot off it.
async function inBrowser(t, fn) {
  const { launchBrowser } = await import('./helpers/playwright.mjs');
  const http = await import('node:http');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
  const browser = await launchBrowser(t);
  if (!browser) return undefined;
  const server = http.createServer((q, r) => {
    const u = decodeURIComponent(q.url.split('?')[0]);
    if (u === '/t.html') {
      r.writeHead(200, { 'content-type': 'text/html' });
      return r.end('<!doctype html><meta charset=utf8>');
    }
    fs.readFile(path.join(root, u), (e, d) => {
      r.writeHead(e ? 404 : 200, { 'content-type': u.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
      r.end(e ? undefined : d);
    });
  }).listen(0);
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(300000);
    await page.goto(`http://localhost:${server.address().port}/t.html`);
    return await page.evaluate(fn);
  } finally {
    await browser.close();
    server.close();
  }
}

test('the GPU superpixels stay on the GPU for the measured worst-case pictures at the production settings', async (t) => {
  const res = await inBrowser(t, async () => {
    const { GpuRenderer } = await import('/js/gpu/renderer.js');
    const { regionsGpu } = await import('/js/gpu/regions.js');
    const S = await import('/js/core/segments.js');
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
    if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
    const told = [];
    const g = regionsGpu(new GpuRenderer(gl), (stage, e) => told.push(e.message));
    if (!g) return null;
    const make = (w, h, f) => {
      let seed = 7;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      const lab = new Float32Array(w * h * 3);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) lab.set(f(x, y, w, h, rnd), 3 * (y * w + x));
      return lab;
    };
    const pictures = [
      // the tightest measured: pure noise at thumbnail size (drift 2.22 cells of the 2.25 allowed)
      ['noise 160x120', 160, 120, (x, y, w, h, rnd) => [rnd() * 100, rnd() * 200 - 100, rnd() * 200 - 100]],
      ['noise 320x240', 320, 240, (x, y, w, h, rnd) => [rnd() * 100, rnd() * 200 - 100, rnd() * 200 - 100]],
      ['step edge 320x240', 320, 240, (x, y, w) => (x < w * 0.3 ? [5, -60, 60] : [95, 60, -60])],
      ['thin diagonal lines 320x240', 320, 240, (x, y) => [(x + y) % 9 === 0 ? 0 : 100, 0, 0]],
      ['checker 320x240', 320, 240, (x, y) => [(x + y) & 1 ? 0 : 100, 0, 0]],
      ['flat 320x240', 320, 240, () => [50, 0, 0]],
    ];
    const out = [];
    for (const [name, w, h, f] of pictures) {
      const lab = make(w, h, f);
      const gpuLabels = g.slicLabels(lab, w, h, 2500, 8);
      let off = -1;
      if (gpuLabels) {
        const cpu = S.slic(lab, w, h, 2500, 8).label;
        off = 0;
        for (let i = 0; i < w * h; i++) if (cpu[i] !== gpuLabels[i]) off++;
        off /= w * h;
      }
      out.push({ name, onGpu: !!gpuLabels, off, noise: name.startsWith('noise') });
    }
    return { out, told };
  });
  if (res === undefined) return;
  if (!res) return t.skip('No WebGL2 with float targets');
  assert.deepEqual(res.told, []);
  for (const p of res.out) {
    assert.ok(p.onGpu, `${p.name}: the GPU gave up (a center moved beyond the window the assignment searches)`);
    // Pictures with flat areas hold exact ties between centers that the two break differently (0.7% of the labels on the step edge, 2.4% on the lines); the noise has none and agrees to the pixel.
    if (p.noise) assert.equal(p.off, 0, `${p.name}: ${(p.off * 100).toFixed(3)}% of the labels differ from the CPU's`);
  }
});

test('a SLIC center forced out of the assignment window sends the cleanup down the CPU path', async (t) => {
  const res = await inBrowser(t, async () => {
    const { GpuRenderer } = await import('/js/gpu/renderer.js');
    const { regionsGpu } = await import('/js/gpu/regions.js');
    const S = await import('/js/core/segments.js');
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
    if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
    const told = [];
    const g = regionsGpu(new GpuRenderer(gl), (stage, e) => told.push(`${stage}: ${e.message}`));
    if (!g) return null;
    const w = 160;
    const h = 120;
    let seed = 7;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    // a luma-only noise picture and a compactness near zero: the centers chase the noise (the production compactness 8 keeps them within 1.9 cells; this goes to 2.66 of the 2.25 allowed)
    const lab = new Float32Array(w * h * 3);
    for (let p = 0; p < w * h; p++) lab[3 * p] = rnd() * 100;
    const rgb = new Float32Array(w * h * 3);
    // the gray whose lightness is that luma
    for (let p = 0; p < w * h; p++) {
      const Y = lab[3 * p] > 8 ? ((lab[3 * p] + 16) / 116) ** 3 : lab[3 * p] / 903.3;
      rgb.fill(Y <= 0.0031308 ? 12.92 * Y : 1.055 * Y ** (1 / 2.4) - 0.055, 3 * p, 3 * p + 3);
    }
    const alpha = new Float32Array(w * h).fill(0.3);
    const confidence = new Float32Array(w * h).fill(1);
    const calm = g.slicLabels(lab, w, h, 2500, 8);
    const forced = g.slicLabels(lab, w, h, 2500, 0.1);
    const forcedDepth = g.segmentDepth(alpha, confidence, rgb, w, h, { count: 2500, compactness: 0.1 });
    // the CPU path the caller takes then (core/segments.js segmentDepth without a gpu) still gives a map
    const cpu = S.segmentDepth(alpha, confidence, rgb, w, h, { count: 2500, compactness: 0.1 });
    return { calm: !!calm, forced, forcedDepth, cpuLength: cpu.length, told };
  });
  if (res === undefined) return;
  if (!res) return t.skip('No WebGL2 with float targets');
  assert.ok(res.calm, 'the same picture at the production compactness must stay on the GPU');
  assert.equal(res.forced, null);
  assert.equal(res.forcedDepth, null);
  assert.equal(res.cpuLength, 160 * 120);
  assert.equal(res.told.length, 2);
  for (const m of res.told) assert.match(m, /A SLIC center moved [\d.]+ pixels, more than the [\d.]+ the GPU assignment searches/);
});
