// Lenticular prints (core/lenticular.js): the plan from the sheet and printer, where each picture's strips go under every lens (at the nominal and at a
// measured pitch), that the interleaved print holds every picture's own columns (or rows), the pitch test chart, and the resolution written into the PNG.
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { lenticularPlan, stripMap, interlaceInto, coverRect, pickFrames, viewPositions, pitchTest, pngWithDpi } from '../app/js/core/lenticular.js';
import { pngChunk } from '../app/js/core/png16.js';

test('plan: pictures per lens from the printer and the sheet, the size in printer dots', () => {
  const p = lenticularPlan({ lpi: 60, dpi: 720, width: 6, height: 4 });
  assert.equal(p.views, 12);
  assert.equal(p.width, 4320);
  assert.equal(p.height, 2880);
  assert.equal(p.pitch, 60, 'no measured pitch: the nominal one');
  assert.equal(lenticularPlan({ lpi: 40, dpi: 600, width: 1, height: 1 }).views, 15);
  // The count stays on the nominal LPI when a measured pitch is given.
  const m = lenticularPlan({ lpi: 60, dpi: 720, pitch: '59.8', width: 2, height: 2 });
  assert.equal(m.views, 12);
  assert.equal(m.pitch, 59.8);
});

test('plan: settings that cannot make a print say why', () => {
  assert.throws(() => lenticularPlan({ lpi: 0, dpi: 720, width: 6, height: 4 }), /lenses per inch/);
  assert.throws(() => lenticularPlan({ lpi: 290, dpi: 300, width: 6, height: 4 }), /only one picture/);
  assert.throws(() => lenticularPlan({ lpi: 60, dpi: 720, width: 0, height: 4 }), /width and height/);
  assert.throws(() => lenticularPlan({ lpi: 60, dpi: 720, pitch: 70, width: 6, height: 4 }), /far from/);
  assert.throws(() => lenticularPlan({ lpi: 60, dpi: 2400, width: 20, height: 16 }), /more than the app can make/);
  assert.throws(() => lenticularPlan({ lpi: 10, dpi: 1440, width: 1, height: 1 }), /more than the 96/);
});

test('strips: at the nominal pitch every lens holds each picture once, the first picture at the far end', () => {
  const n = 12;
  const map = stripMap(720, n, 720, 60);
  for (let lens = 0; lens < 60; lens++) {
    const under = [...map.subarray(lens * n, (lens + 1) * n)];
    assert.deepEqual(under, Array.from({ length: n }, (_, i) => n - 1 - i), `lens ${lens}`);
  }
  const rev = stripMap(24, n, 720, 60, true);
  assert.deepEqual([...rev.subarray(0, n)], Array.from({ length: n }, (_, i) => i));
});

test('strips: at a measured pitch the lens period follows it, and every picture still appears equally', () => {
  const dpi = 720;
  const pitch = 59.7;
  const length = 7200; // ten inches
  const map = stripMap(length, 12, dpi, pitch);
  const counts = new Array(12).fill(0);
  for (const v of map) counts[v]++;
  for (const c of counts) assert.ok(Math.abs(c - length / 12) <= 12, `picture count ${c}`);
  // Each lens starts where picture 11 begins: the starts are dpi / pitch dots apart.
  const starts = [];
  for (let x = 1; x < length; x++) if (map[x] === 11 && map[x - 1] !== 11) starts.push(x);
  const period = (starts.at(-1) - starts[0]) / (starts.length - 1);
  assert.ok(Math.abs(period - dpi / pitch) < 0.01, `period ${period}`);
});

test('interleaving: the print holds each picture\'s own columns (3D) or rows (animation)', () => {
  const W = 24;
  const H = 6;
  const n = 4;
  const views = Array.from({ length: n }, (_, k) => {
    const d = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      d[i * 4] = k * 50;
      d[i * 4 + 1] = i % 256;
      d[i * 4 + 2] = 7;
      d[i * 4 + 3] = 128;
    }
    return d;
  });
  for (const axis of ['x', 'y']) {
    const map = stripMap(axis === 'x' ? W : H, n, 4, 1);
    const out = new Uint8ClampedArray(W * H * 4);
    views.forEach((v, k) => interlaceInto(out, v, W, H, map, k, axis));
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const k = map[axis === 'x' ? x : y];
        assert.equal(out[i], k * 50, `${axis} ${x},${y}`);
        assert.equal(out[i + 1], (y * W + x) % 256);
        assert.equal(out[i + 3], 255, 'opaque');
      }
    }
  }
});

test('fit, frames and viewpoints', () => {
  // A 3:2 picture on a square print: the middle two thirds of its width.
  assert.deepEqual(coverRect(300, 200, 100, 100), { sx: 50, sy: 0, sw: 200, sh: 200 });
  assert.deepEqual(coverRect(300, 200, 600, 400), { sx: 0, sy: 0, sw: 300, sh: 200 });
  assert.deepEqual(pickFrames(97, 5), [0, 24, 48, 72, 96]);
  assert.deepEqual(pickFrames(3, 6), [0, 0, 1, 1, 2, 2]);
  assert.deepEqual(viewPositions(5, 1, 2), [-1, 0, 1, 2, 3]);
});

test('pitch test: bands around the sheet\'s pitch, each half black under every lens, with a label box', () => {
  const t = pitchTest({ lpi: 60, dpi: 720, width: 2, height: 3, count: 5, step: 0.1 });
  assert.equal(t.width, 1440);
  assert.equal(t.height, 2160);
  assert.deepEqual(t.labels.map((l) => l.text), ['59.80 LPI', '59.90 LPI', '60.00 LPI', '60.10 LPI', '60.20 LPI']);
  // The middle band, past its label: half of each 12-dot lens is black.
  const band = t.labels[2];
  const y = band.y + band.h + 10;
  let black = 0;
  for (let x = 0; x < 120; x++) if (t.data[(y * t.width + x) * 4] === 0) black++;
  assert.equal(black, 60);
  // The label box is white.
  assert.equal(t.data[((band.y + 2) * t.width + 5) * 4], 255);
  // Lenses across: the bands are columns and the stripes are rows.
  const a = pitchTest({ lpi: 60, dpi: 720, width: 3, height: 1, axis: 'y', count: 3 });
  const col = a.labels[1].x + 10;
  const row = a.labels[1].h + 2;
  const at = (x, yy) => a.data[(yy * a.width + x) * 4];
  assert.equal(at(col, row), at(col + 50, row), 'a row is one color across the band');
});

test('PNG resolution: a pHYs chunk after the header, in dots per meter, replacing any old one', () => {
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 1);
  new DataView(ihdr.buffer).setUint32(4, 1);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = zlib.deflateSync(Uint8Array.of(0, 1, 2, 3, 4));
  const old = new Uint8Array(9);
  const png = Buffer.concat([Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), pngChunk('IHDR', ihdr), pngChunk('pHYs', old), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0))]);
  const out = pngWithDpi(new Uint8Array(png), 720);
  const types = [];
  const v = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let at = 8;
  let phys = null;
  while (at < out.length) {
    const len = v.getUint32(at);
    const type = String.fromCharCode(...out.subarray(at + 4, at + 8));
    types.push(type);
    if (type === 'pHYs') phys = out.subarray(at + 8, at + 8 + len);
    at += 12 + len;
  }
  assert.deepEqual(types, ['IHDR', 'pHYs', 'IDAT', 'IEND']);
  const p = new DataView(phys.buffer, phys.byteOffset, 9);
  assert.equal(p.getUint32(0), 28346); // 720 / 0.0254
  assert.equal(p.getUint32(4), 28346);
  assert.equal(phys[8], 1, 'meters');
});
