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
