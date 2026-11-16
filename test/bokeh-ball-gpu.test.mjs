// The ball's character on the graphics card (DOF_GATHER): a point of light far out of focus, blurred, has a bright rim, a hole, a cat's-eye lens near the corner, and a
// color fringe, as core/dof.js says. Skipped where Playwright or its browser is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './helpers/playwright.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');

test('the ball character settings on the graphics card', async (t) => {
  const browser = await launchBrowser(t);
  if (!browser) return;
  const server = http.createServer((q, r) => {
    const u = decodeURIComponent(q.url.split('?')[0]);
    if (u === '/t.html') {
      r.writeHead(200, { 'content-type': 'text/html' });
      return r.end('<!doctype html><meta charset=utf8>');
    }
    fs.readFile(path.join(root, u), (e, d) => {
      r.writeHead(e ? 404 : 200, { 'content-type': 'text/javascript' });
      r.end(e ? undefined : d);
    });
  }).listen(0);
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(300000);
    await page.goto(`http://localhost:${server.address().port}/t.html`);
    const res = await page.evaluate(async () => {
      const { GpuRenderer } = await import('/js/gpu/renderer.js');
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const g = new GpuRenderer(gl);
      const W = 200;
      const run = (point, opt, depthValue = 1) => {
        const src = g.texture(W, W, gl.RGBA32F);
        gl.bindTexture(gl.TEXTURE_2D, src);
        const rgba = new Float32Array(W * W * 4);
        for (let i = 0; i < W * W; i++) rgba[4 * i + 3] = 1;
        rgba.set([60, 60, 60, 1], 4 * (point[1] * W + point[0]));
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, W, gl.RGBA, gl.FLOAT, rgba);
        g.setDepth(new Float32Array(W * W).fill(depthValue), W, W);
        g.depthRange = [-1, 1];
        const out = g.depthOfField(src, W, W, { focus: 0, strength: 40, shape: 'circle', ...opt });
        const [r, gg, b] = g.readChannels(out, W, W, 3);
        return { r, g: gg, b, at: (x, y) => gg[y * W + x] };
      };
      const c = 100;
      const plain = run([c, c], {});
      const rim = run([c, c], { edge: 0.8 });
      const hole = run([c, c], { hole: 0.5 });
      const dark = run([c, c], { edge: -0.8 });
      // near the top right corner: the lens is narrow along the direction to the center (the diagonal) and long across it
      const p = [160, 160];
      const cat = run(p, { catEye: 1 });
      const along = (dx, dy) => cat.at(p[0] + Math.round(dx), p[1] + Math.round(dy));
      const s = Math.SQRT1_2;
      const fringe = run([c, c], { fringe: 1 });
      const fringeFront = run([c, c], { fringe: 1 }, -1);
      const at = (img, rr, ch = 'g') => img[ch][c * W + c + rr];
      return {
        err: gl.getError(),
        plainRim: plain.at(c + 32, c) / plain.at(c + 15, c), edgeRim: rim.at(c + 36, c) / rim.at(c + 15, c), darkRim: dark.at(c + 36, c) / dark.at(c + 15, c),
        holeCenter: hole.at(c + 4, c), holeRing: hole.at(c + 25, c),
        catAlong: along(30 * s, 30 * s), catAcross: along(30 * s, -30 * s),
        fringeBehind: [at(fringe, 39, 'r'), at(fringe, 39, 'g'), at(fringe, 39, 'b')],
        fringeFront: [at(fringeFront, 42, 'r'), at(fringeFront, 42, 'g'), at(fringeFront, 42, 'b')],
      };
    });
    if (!res) return t.skip('No float render targets');
    assert.equal(res.err, 0);
    assert.ok(res.edgeRim > 1.3 * res.plainRim && res.darkRim < 0.8 * res.plainRim, JSON.stringify(res));
    assert.ok(res.holeCenter < 0.05 * res.holeRing, JSON.stringify(res));
    assert.ok(res.catAcross > 3 * res.catAlong, `${res.catAlong} ${res.catAcross}`);
    // behind the focus the green ball is the larger one (green rim); in front the red and blue are (magenta)
    const behind = res.fringeBehind[0] / res.fringeBehind[1];
    const front = res.fringeFront[0] / res.fringeFront[1];
    assert.ok(res.fringeBehind[1] > 1.5 * res.fringeBehind[0] && front > 1.4 * behind, JSON.stringify(res));
  } finally {
    await browser.close();
    server.close();
  }
});
