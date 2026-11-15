// The focus mask shaders (and the depth of field step that reads them) compile and run in a headless browser. Skipped where Playwright or its browser is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './helpers/playwright.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const types = { '.js': 'text/javascript', '.html': 'text/html' };

test('the focus mask shaders compile and the depth of field step takes a mask', async (t) => {
  const browser = await launchBrowser(t);
  if (!browser) return;
  const server = http.createServer((q, r) => {
    const u = decodeURIComponent(q.url.split('?')[0]);
    if (u === '/t.html') {
      r.writeHead(200, { 'content-type': 'text/html' });
      return r.end('<!doctype html><meta charset=utf8>');
    }
    fs.readFile(path.join(root, u), (e, d) => {
      r.writeHead(e ? 404 : 200, { 'content-type': types[path.extname(u)] || 'application/octet-stream' });
      r.end(e ? undefined : d);
    });
  }).listen(0);
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(240000);
    await page.goto(`http://localhost:${server.address().port}/t.html`);
    const res = await page.evaluate(async () => {
      const { GpuRenderer } = await import('/js/gpu/renderer.js');
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const gpu = new GpuRenderer(gl);
      // every program is linked when first used: the three mask shaders and the depth of field prep
      for (const name of ['focusScore', 'focusMask', 'focusSupport', 'focusSpread', 'dofPrep']) void gpu.programs[name].p;
      // the depth of field with a mask: a picture, a depth map and a mask of its size
      const w = 64;
      const h = 48;
      const src = gpu.texture(w, h, gl.RGBA32F);
      gl.bindTexture(gl.TEXTURE_2D, src);
      const rgba = new Float32Array(w * h * 4).fill(0.5);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, rgba);
      gpu.setDepth(new Float32Array(w * h).fill(1), w, h);
      const mask = gpu.scratch(w, h, 'testMask');
      const out = gpu.depthOfField(src, w, h, { focus: 0, strength: 8, sharp: mask });
      return { ok: !!out, err: gl.getError() };
    });
    if (!res) return t.skip('No float render targets');
    assert.equal(res.ok, true);
    assert.equal(res.err, 0);
  } finally {
    await browser.close();
    server.close();
  }
});

test('the Blur under Focus Spread feathers the blur map on the GPU', async (t) => {
  const browser = await launchBrowser(t);
  if (!browser) return;
  const server = http.createServer((q, r) => {
    const u = decodeURIComponent(q.url.split('?')[0]);
    if (u === '/t.html') {
      r.writeHead(200, { 'content-type': 'text/html' });
      return r.end('<!doctype html><meta charset=utf8>');
    }
    fs.readFile(path.join(root, u), (e, d) => {
      r.writeHead(e ? 404 : 200, { 'content-type': types[path.extname(u)] || 'application/octet-stream' });
      r.end(e ? undefined : d);
    });
  }).listen(0);
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(240000);
    await page.goto(`http://localhost:${server.address().port}/t.html`);
    const res = await page.evaluate(async () => {
      const { GpuRenderer } = await import('/js/gpu/renderer.js');
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const gpu = new GpuRenderer(gl);
      const w = 64;
      const h = 16;
      const src = gpu.texture(w, h, gl.RGBA32F);
      gl.bindTexture(gl.TEXTURE_2D, src);
      const rgba = new Float32Array(w * h * 4);
      for (let i = 0; i < w * h; i++) rgba.fill(0.1 + 0.8 * (((i % w) >> 1) % 2), i * 4, i * 4 + 3);   // stripes two pixels wide (one pixel stripes vanish under any blur)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, rgba);
      const depth = new Float32Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 32; x < w; x++) depth[y * w + x] = 1.2;   // right half far behind the focus
      gpu.setDepth(depth, w, h);
      const read = (tex) => {
        gpu.target(tex, w, h);
        const buf = new Float32Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, buf);
        return buf;
      };
      const contrast = (buf, x) => { let m = 0; for (let y = 0; y < h; y++) for (let k = 0; k < 4; k++) m += (buf[(y * w + x + k) * 4] - buf[(y * w + x + k + 1) * 4]) ** 2; return Math.sqrt(m / (4 * h)); };   // the energy of the steps over four pixels: blurring an edge splits it into smaller steps, which lowers it
      const hard = read(gpu.depthOfField(src, w, h, { focus: 0, strength: 4, spread: 0.5 }));
      const hardC = [2, 27, 34, 58].map((x) => contrast(hard, x));
      const soft = read(gpu.depthOfField(src, w, h, { focus: 0, strength: 4, spread: 0.5, feather: 10 }));
      const softC = [2, 27, 34, 58].map((x) => contrast(soft, x));
      return { hardC, softC, err: gl.getError() };
    });
    if (!res) return t.skip('No float render targets');
    assert.equal(res.err, 0);
    // far from the boundary nothing changes
    assert.ok(Math.abs(res.hardC[0] - res.softC[0]) < 1e-3, JSON.stringify(res));
    assert.ok(Math.abs(res.hardC[3] - res.softC[3]) < 0.05, JSON.stringify(res));
    // beside it (a few pixels from the boundary, where the blur radius has built up to a pixel or two) the sharp side starts to blur (less contrast) and the blurred side is less blurred
    assert.ok(res.softC[1] < res.hardC[1] - 0.02, `blur does not reach into the sharp side: ${JSON.stringify(res)}`);
    assert.ok(res.softC[2] > res.hardC[2] + 0.02, `blur does not ease on the blurred side: ${JSON.stringify(res)}`);
  } finally {
    await browser.close();
    server.close();
  }
});

test('the blur pass leaves what is exactly in focus as it was (it softened everything once any blur was on)', async (t) => {
  const browser = await launchBrowser(t);
  if (!browser) return;
  const server = http.createServer((q, r) => {
    const u = decodeURIComponent(q.url.split('?')[0]);
    if (u === '/t.html') {
      r.writeHead(200, { 'content-type': 'text/html' });
      return r.end('<!doctype html><meta charset=utf8>');
    }
    fs.readFile(path.join(root, u), (e, d) => {
      r.writeHead(e ? 404 : 200, { 'content-type': types[path.extname(u)] || 'application/octet-stream' });
      r.end(e ? undefined : d);
    });
  }).listen(0);
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(240000);
    await page.goto(`http://localhost:${server.address().port}/t.html`);
    const res = await page.evaluate(async () => {
      const { GpuRenderer } = await import('/js/gpu/renderer.js');
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const gpu = new GpuRenderer(gl);
      const w = 64;
      const h = 16;
      const src = gpu.texture(w, h, gl.RGBA32F);
      gl.bindTexture(gl.TEXTURE_2D, src);
      const rgba = new Float32Array(w * h * 4);
      for (let i = 0; i < w * h; i++) rgba.fill(0.1 + 0.8 * ((i % w) % 2), i * 4, i * 4 + 3);   // one pixel stripes: the harshest picture for any softening
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, rgba);
      // the left half exactly at the focus depth, the right half far behind it (strongly blurred)
      const depth = new Float32Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 40; x < w; x++) depth[y * w + x] = 1.2;
      gpu.setDepth(depth, w, h);
      gpu.target(gpu.depthOfField(src, w, h, { focus: 0, strength: 4 }), w, h);
      const out = new Float32Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, out);
      let worst = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < 30; x++) worst = Math.max(worst, Math.abs(out[(y * w + x) * 4] - rgba[(y * w + x) * 4]));
      return { worst, err: gl.getError() };
    });
    if (!res) return t.skip('No float render targets');
    assert.equal(res.err, 0);
    assert.ok(res.worst < 0.01, `pixels at the focus depth changed by up to ${res.worst}`);
  } finally {
    await browser.close();
    server.close();
  }
});

test('a slight blur (up to four pixels) is the exact blur of its disc, not a grainy approximation', async (t) => {
  const browser = await launchBrowser(t);
  if (!browser) return;
  const server = http.createServer((q, r) => {
    const u = decodeURIComponent(q.url.split('?')[0]);
    if (u === '/t.html') {
      r.writeHead(200, { 'content-type': 'text/html' });
      return r.end('<!doctype html><meta charset=utf8>');
    }
    fs.readFile(path.join(root, u), (e, d) => {
      r.writeHead(e ? 404 : 200, { 'content-type': types[path.extname(u)] || 'application/octet-stream' });
      r.end(e ? undefined : d);
    });
  }).listen(0);
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(240000);
    await page.goto(`http://localhost:${server.address().port}/t.html`);
    const res = await page.evaluate(async () => {
      const { GpuRenderer } = await import('/js/gpu/renderer.js');
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const gpu = new GpuRenderer(gl);
      const w = 64;
      const h = 64;
      let seed = 99;
      const noise = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
      const img = new Float32Array(w * h).map(noise);   // white noise: the harshest picture for an uneven blur
      const rgba = new Float32Array(w * h * 4);
      for (let i = 0; i < w * h; i++) rgba.fill(img[i], i * 4, i * 4 + 3);
      const worst = {};
      for (const r of [1, 2, 3]) {
        const src = gpu.texture(w, h, gl.RGBA32F);
        gl.bindTexture(gl.TEXTURE_2D, src);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, rgba);
        gpu.setDepth(new Float32Array(w * h).fill(r), w, h);   // a blur radius of r pixels everywhere
        gpu.target(gpu.depthOfField(src, w, h, { focus: 0, strength: 1 }), w, h);
        const out = new Float32Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, out);
        let se = 0;
        let n = 0;
        for (let y = 12; y < h - 12; y++) {
          for (let x = 12; x < w - 12; x++) {
            let sum = 0;
            let ws = 0;
            for (let j = -4; j <= 4; j++) for (let i = -4; i <= 4; i++) {
              const d = Math.hypot(i, j);
              if (d > r + 0.5) continue;
              const wt = Math.exp(-2 * (d / Math.max(r, 0.5)) ** 2);
              sum += wt * img[(y + j) * w + x + i];
              ws += wt;
            }
            se += (out[(y * w + x) * 4] - sum / ws) ** 2;
            n++;
          }
        }
        worst[r] = Math.sqrt(se / n);
      }
      return { worst, err: gl.getError() };
    });
    if (!res) return t.skip('No float render targets');
    assert.equal(res.err, 0);
    for (const [r, e] of Object.entries(res.worst)) assert.ok(e < 0.005, `a blur of ${r} pixels is off from the exact blur by ${e}`);
  } finally {
    await browser.close();
    server.close();
  }
});

test('the focus mask keeps a textured surface at the focus depth, and not a dark softly textured one a little away from it (its views hardly disagree there), nor one far away', async (t) => {
  const browser = await launchBrowser(t);
  if (!browser) return;
  const server = http.createServer((q, r) => {
    const u = decodeURIComponent(q.url.split('?')[0]);
    if (u === '/t.html') {
      r.writeHead(200, { 'content-type': 'text/html' });
      return r.end('<!doctype html><meta charset=utf8>');
    }
    fs.readFile(path.join(root, u), (e, d) => {
      r.writeHead(e ? 404 : 200, { 'content-type': types[path.extname(u)] || 'application/octet-stream' });
      r.end(e ? undefined : d);
    });
  }).listen(0);
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(240000);
    await page.goto(`http://localhost:${server.address().port}/t.html`);
    const res = await page.evaluate(async () => {
      const { GpuRenderer } = await import('/js/gpu/renderer.js');
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const gpu = new GpuRenderer(gl);
      const w = 96;
      const h = 48;
      // views on a ring around the center of the lens (sensor pixels), as the refocus views are
      const samples = [{ u: 0, v: 0 }];
      for (let k = 0; k < 8; k++) samples.push({ u: 4 * Math.cos((k * Math.PI) / 4), v: 4 * Math.sin((k * Math.PI) / 4) });
      // the scene: left half a bright fine texture, right half a dark soft one (as a dim, out of focus background); all of it at depth 0.6 (each view sees it moved by 0.6 * (u, v))
      const DEPTH = 0.6;
      const scene = (x, y) => (x < w / 2 ? 0.3 + 0.25 * Math.sin(x * 1.9) * Math.cos(y * 1.3) : 0.012 + 0.006 * Math.sin(x * 0.35) * Math.cos(y * 0.3));
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA16F, w, h, samples.length);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      samples.forEach(({ u, v }, k) => {
        const px = new Float32Array(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          // the view at x shows the scene point x + DEPTH * (u, v) (focusMask looks for it there)
          const l = scene(x - DEPTH * u, y - DEPTH * v);
          px.set([l, l, l, 1], (y * w + x) * 4);
        }
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, k, w, h, 1, gl.RGBA, gl.FLOAT, px);
      });
      gpu.sampler = { outW: w, outH: h };
      gpu.views = { tex, samples, detail: 1 };
      const maskAt = (alpha) => {
        const m = gpu.focusMask(alpha);
        gpu.target(m, w, h);
        const buf = new Float32Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, buf);
        // mean of the mask in the middle of each half (away from the border and the seam)
        const mean = (x0, x1) => { let s = 0; let n = 0; for (let y = 12; y < h - 12; y++) for (let x = x0; x < x1; x++) { s += buf[(y * w + x) * 4]; n++; } return s / n; };
        return { textured: mean(12, w / 2 - 12), dark: mean(w / 2 + 12, w - 12) };
      };
      return { atDepth: maskAt(DEPTH), near: maskAt(DEPTH - 0.25), away: maskAt(DEPTH - 0.9), err: gl.getError() };
    });
    if (!res) return t.skip('No float render targets');
    assert.equal(res.err, 0);
    assert.ok(res.atDepth.textured > 0.6, `the textured surface in focus is kept: ${JSON.stringify(res)}`);
    assert.ok(res.away.textured < 0.1, `the textured surface away from the focus is not kept: ${JSON.stringify(res)}`);
    assert.ok(res.near.textured < 0.1, `the textured surface a little away from the focus is not kept: ${JSON.stringify(res)}`);
    assert.ok(res.near.dark < 0.1 && res.away.dark < 0.1, `the dark soft surface away from the focus is not kept (its views agree nearly as well at every depth): ${JSON.stringify(res)}`);
  } finally {
    await browser.close();
    server.close();
  }
});

test('the focus mask drops a lone pixel (chance, in noise) but keeps a line one pixel wide (a thin wire)', async (t) => {
  const browser = await launchBrowser(t);
  if (!browser) return;
  const server = http.createServer((q, r) => {
    const u = decodeURIComponent(q.url.split('?')[0]);
    if (u === '/t.html') {
      r.writeHead(200, { 'content-type': 'text/html' });
      return r.end('<!doctype html><meta charset=utf8>');
    }
    fs.readFile(path.join(root, u), (e, d) => {
      r.writeHead(e ? 404 : 200, { 'content-type': types[path.extname(u)] || 'application/octet-stream' });
      r.end(e ? undefined : d);
    });
  }).listen(0);
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(240000);
    await page.goto(`http://localhost:${server.address().port}/t.html`);
    const res = await page.evaluate(async () => {
      const { GpuRenderer } = await import('/js/gpu/renderer.js');
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const gpu = new GpuRenderer(gl);
      const w = 32;
      const h = 32;
      const src = gpu.texture(w, h, gl.RGBA32F);
      const px = new Float32Array(w * h * 4);
      px[(5 * w + 5) * 4] = 1; // a lone pixel
      for (let y = 10; y < 28; y++) px[(y * w + 20) * 4] = 1; // a line one pixel wide
      gl.bindTexture(gl.TEXTURE_2D, src);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, px);
      const out = gpu.scratch(w, h, 'supportTest', gl.RGBA32F);
      const P = gpu.programs.focusSupport;
      gpu.target(out, w, h);
      gl.useProgram(P.p);
      gl.uniform1i(P.u.uSrc, 1);
      gpu.bindTex(1, src);
      gpu.draw();
      const buf = new Float32Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, buf);
      return { lone: buf[(5 * w + 5) * 4], line: buf[(18 * w + 20) * 4], err: gl.getError() };
    });
    if (!res) return t.skip('No float render targets');
    assert.equal(res.err, 0);
    assert.equal(res.lone, 0, JSON.stringify(res));
    assert.equal(res.line, 1, JSON.stringify(res));
  } finally {
    await browser.close();
    server.close();
  }
});
