// Two pieces of the Lytro sensor engine on the GPU (gpu/lytroengine.js) against what the CPU does (core/lytroedof.js), in a headless browser:
// the luma smoothing's recursion must not read the band texture's rows past the band, and the depth views' splat must not spill into the neighbor view's rows.
// Skipped where Playwright or its browser is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './helpers/playwright.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const types = { '.js': 'text/javascript', '.html': 'text/html' };

async function inPage(t, fn) {
  const browser = await launchBrowser(t);
  if (!browser) return undefined;
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
    await page.goto(`http://localhost:${server.address().port}/t.html`);
    return await page.evaluate(fn);
  } finally {
    await browser.close();
    server.close();
  }
}

test('the luma recursion step ignores the band texture rows past the band', async (t) => {
  const res = await inPage(t, async () => {
    const { VERTEX, IIR_STEP } = await import('/js/gpu/lytroengine.js');
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
    if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
    const W = 6, TEX = 16, ROWS = 10;
    const mk = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, IIR_STEP));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    gl.useProgram(p);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const tex = (data) => {
      const x = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, x);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, W, TEX);
      if (data) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, TEX, gl.RED, gl.FLOAT, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      return x;
    };
    // the band's rows hold 1, the rows past it the previous band's data (100)
    const src = new Float32Array(W * TEX).map((_, i) => (Math.floor(i / W) < ROWS ? 1 : 100));
    const a = tex(src);
    const b = tex(null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, b, 0);
    gl.viewport(0, 0, W, ROWS);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, a);
    gl.uniform1i(gl.getUniformLocation(p, 'uSrc'), 0);
    gl.uniform2i(gl.getUniformLocation(p, 'uStep'), 0, 1); // the backward vertical pass looks one row down
    gl.uniform1f(gl.getUniformLocation(p, 'uCoef'), 0.7);
    gl.uniform1i(gl.getUniformLocation(p, 'uRows'), ROWS);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const out = new Float32Array(W * TEX * 4);
    gl.readPixels(0, 0, W, TEX, gl.RGBA, gl.FLOAT, out);
    return { last: out[4 * ((ROWS - 1) * W)], inner: out[4 * ((ROWS - 2) * W)], error: gl.getError() };
  });
  if (res === undefined) return;
  if (!res) return t.skip('No WebGL2 with float targets');
  assert.equal(res.error, 0);
  // the CPU has nothing below the picture's last row
  assert.ok(Math.abs(res.last - 1) < 1e-6, `last row ${res.last}`);
  assert.ok(Math.abs(res.inner - 1.7) < 1e-6, `inner row ${res.inner}`);
});

test('a depth view tap on the first or last row stays out of the stacked neighbor view', async (t) => {
  const res = await inPage(t, async () => {
    const { SPLAT_FRAGMENT } = await import('/js/gpu/lytroengine.js');
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
    if (!gl || !gl.getExtension('EXT_color_buffer_float') || !gl.getExtension('EXT_float_blend')) return null;
    const W = 4, H = 4, N = 2;
    const vs = `#version 300 es
precision highp float;
uniform vec4 uPt; // x, y of the tap's first texel in the stack, then the view's first row and the fraction row
flat out vec2 vQ;
flat out vec4 vRgb;
flat out float vW;
flat out float vLam;
flat out float vRow0;
void main() {
  gl_PointSize = 2.0;
  gl_Position = vec4(((uPt.xy + 1.0) / vec2(${W}.0, ${H * N}.0)) * 2.0 - 1.0, 0.0, 1.0);
  vQ = uPt.xy + vec2(0.5, 0.5);
  vRgb = vec4(1.0);
  vW = 1.0;
  vLam = 0.0;
  vRow0 = uPt.z;
}`;
    const mk = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, SPLAT_FRAGMENT));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    gl.useProgram(p);
    const x = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, x);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, W, H * N);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, x, 0);
    gl.viewport(0, 0, W, H * N);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.uniform1i(gl.getUniformLocation(p, 'uViewN'), 1);
    gl.uniform1f(gl.getUniformLocation(p, 'uViewH'), H);
    gl.uniform1f(gl.getUniformLocation(p, 'uTolerance'), 2);
    gl.uniform1i(gl.getUniformLocation(p, 'uZ'), 0);
    const u = gl.getUniformLocation(p, 'uPt');
    // view 0's tap covers rows 3 and 4 (4 is view 1's first), view 1's covers rows 3 (view 0's last) and 4
    gl.uniform4f(u, 1, 3, 0, 0);
    gl.drawArrays(gl.POINTS, 0, 1);
    gl.uniform4f(u, 1, 3, H, 0);
    gl.drawArrays(gl.POINTS, 0, 1);
    const out = new Float32Array(W * H * N * 4);
    gl.readPixels(0, 0, W, H * N, gl.RGBA, gl.FLOAT, out);
    const rows = [];
    for (let y = 0; y < H * N; y++) rows.push(out[4 * (y * W + 1) + 3]);
    return { rows, error: gl.getError() };
  });
  if (res === undefined) return;
  if (!res) return t.skip('No WebGL2 with float targets');
  assert.equal(res.error, 0);
  // each tap keeps only the row inside its view (3 for view 0, 4 for view 1), a quarter of the weight; spilling over would give 0.25 to each of the two rows from both taps
  assert.deepEqual(res.rows.map((v) => Math.round(v * 100) / 100), [0, 0, 0, 0.25, 0.25, 0, 0, 0]);
});
