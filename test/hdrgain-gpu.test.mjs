/* global OffscreenCanvas, createImageBitmap, ImageData -- used inside page.evaluate, which runs in the browser */
// The HDR gain map from the GPU (renderer.presentBits16 with gain) in a headless browser: a picture with values up to 6 times white comes out clipped at white, and the gain map holds
// how far above white each channel was (log2 over 3 stops, 0 up to white). Then a whole HDR JPEG is made from it with the browser's own JPEG encoder and read back: the ordinary
// picture must still be a valid JPEG the browser decodes. Skipped where Playwright or its browser is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './helpers/playwright.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const types = { '.js': 'text/javascript', '.html': 'text/html' };

test('values above white are clipped in the picture and kept in the gain map, and the file built from them is a valid JPEG', async (t) => {
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
      const { buildUltraHdr, readUltraHdr } = await import('/js/core/ultrahdr.js');
      const canvas = new OffscreenCanvas(1, 1);
      const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const gpu = new GpuRenderer(gl);
      const w = 64;
      const h = 32;
      // red rises from 0 to 6 across the picture, green holds 0.5, blue 2: so the red channel passes white a third of the way over
      const rgba = new Float32Array(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          rgba[i] = (x / (w - 1)) * 6;
          rgba[i + 1] = 0.5;
          rgba[i + 2] = 2;
          rgba[i + 3] = 1;
        }
      }
      const src = gpu.texture(w, h, gl.RGBA32F);
      gl.bindTexture(gl.TEXTURE_2D, src);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, rgba);
      const opts = { matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1], exposure: 1 };
      const plain = gpu.presentBits16(src, w, h, opts);
      const withGain = gpu.presentBits16(src, w, h, { ...opts, gain: true });
      const out = { plainHasGain: !!plain.gain, sameRgb: plain.every((v, i) => v === withGain[i]), gainSize: withGain.gain ? withGain.gain.length : 0 };
      const row = (x) => ({ rgb: [...withGain.subarray(3 * x, 3 * x + 3)], gain: [...withGain.gain.subarray(3 * x, 3 * x + 3)] });
      out.first = row(0);
      out.mid = row(Math.round((w - 1) / 2)); // red 3.0
      out.last = row(w - 1); // red 6.0
      out.lastRow = [...withGain.gain.subarray(3 * (h - 1) * w + 3 * (w - 1), 3 * (h - 1) * w + 3 * w)];
      out.error = gl.getError();
      // The whole file with the browser's JPEG encoder
      const base = new ImageData(w, h);
      for (let i = 0, j = 0; i < withGain.length; i += 3, j += 4) {
        base.data[j] = (withGain[i] + 128) >> 8;
        base.data[j + 1] = (withGain[i + 1] + 128) >> 8;
        base.data[j + 2] = (withGain[i + 2] + 128) >> 8;
        base.data[j + 3] = 255;
      }
      const map = new ImageData(w, h);
      for (let i = 0, j = 0; i < withGain.gain.length; i += 3, j += 4) {
        map.data[j] = withGain.gain[i];
        map.data[j + 1] = withGain.gain[i + 1];
        map.data[j + 2] = withGain.gain[i + 2];
        map.data[j + 3] = 255;
      }
      const jpeg = async (data) => {
        const c = new OffscreenCanvas(w, h);
        c.getContext('2d').putImageData(data, 0, 0);
        return new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.95 })).arrayBuffer());
      };
      const file = buildUltraHdr(await jpeg(base), await jpeg(map));
      const parts = readUltraHdr(file);
      const decode = async (bytes) => {
        const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
        return [bmp.width, bmp.height];
      };
      out.fileDecodes = { whole: await decode(file), primary: await decode(parts.primary), gain: await decode(parts.gain) };
      out.fileLength = file.length;
      return out;
    });
    if (!res) return t.skip('No float render targets');
    assert.equal(res.error, 0);
    assert.equal(res.plainHasGain, false, 'no gain map unless asked');
    assert.ok(res.sameRgb, 'asking for the gain map does not change the picture');
    assert.equal(res.gainSize, 64 * 32 * 3);
    // red 0: nothing above white; green 0.5: nothing; blue 2: one stop of three
    assert.deepEqual(res.first.gain, [0, 0, Math.round((255 * 1) / 3)]);
    // red 3.0 is log2(3)/3 of the range; the picture itself is clipped at white for red and blue
    assert.ok(Math.abs(res.mid.gain[0] - (255 * Math.log2(3)) / 3) <= 3, `red gain ${res.mid.gain[0]}`);
    assert.equal(res.mid.rgb[0], 65535);
    assert.equal(res.mid.rgb[2], 65535);
    assert.ok(res.mid.rgb[1] < 65535 && res.mid.rgb[1] > 30000, 'green 0.5 is mid gray, not clipped');
    assert.equal(res.mid.gain[1], 0);
    // red 6.0: log2(6)/3
    assert.ok(Math.abs(res.last.gain[0] - (255 * Math.log2(6)) / 3) <= 3, `red gain ${res.last.gain[0]}`);
    assert.deepEqual(res.lastRow, res.last.gain, 'rows are in the same order as the picture');
    // the file: the browser decodes it as an ordinary picture, and each part as a picture of 64 x 32
    assert.deepEqual(res.fileDecodes, { whole: [64, 32], primary: [64, 32], gain: [64, 32] });
  } finally {
    await browser.close();
    server.close();
  }
});
