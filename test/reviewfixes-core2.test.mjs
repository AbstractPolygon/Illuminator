// Regression tests for the second review round of the render, depth-of-field, lattice, notch, flare, LUT, command line, mask and release-note code.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildSampler, renderView, makeDevelopParams, refocus } from '../app/js/core/render.js';
import { nominalAperture, engineAperture, applyBank, minMaxRadius, SPLAT } from '../app/js/core/lytroedof.js';
import { calibrateGrid, toLocal } from '../app/js/core/lenslet.js';
import { sampleDepth } from '../app/js/core/superres.js';
import { removeLatticeByTiles } from '../app/js/core/notch.js';
import { parseCube, decodeLut, encodeLut } from '../app/js/core/lut.js';
import { parseCli, outputPath } from '../app/js/core/cliargs.js';
import { parseMasks, defaultMask } from '../app/js/core/local.js';
import { releaseHighlights } from '../app/js/core/releasenotes.js';

test('a color with no local weight does not dilute the brightness of the others', () => {
  const W = 300;
  const H = 200;
  const p = 14.2857;
  const grid = { pitch: p, rowStep: (p * Math.sqrt(3)) / 2, rotation: 0, ox: 150, oy: 100 };
  const cam = { width: W, height: H, cfa: [[0, 1], [1, 2]], black: [0, 0, 0], white: [1000, 1000, 1000], wb: [1, 1, 1] };
  const dev = makeDevelopParams(cam);
  dev.clip = Infinity;
  const s = buildSampler(grid, cam, 1);
  const raw = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) raw[y * W + x] = cam.cfa[y & 1][x & 1] === 0 ? 500 : 0;
  const rgb = renderView(raw, cam, dev, s, 0, 0);
  const i = 3 * (Math.floor(s.outH / 2) * s.outW + Math.floor(s.outW / 2));
  assert.ok(Math.abs(rgb[i] - 0.5) < 0.01, `red ${rgb[i]}`);
  assert.ok(rgb[i + 1] < 0.01 && rgb[i + 2] < 0.01);
});

test('nominalAperture falls back when either f-number is missing', () => {
  assert.equal(nominalAperture({ mla: { fNumberMicrolens: 2 } }), SPLAT.aperture);
  assert.equal(nominalAperture({ capture: { fNumber: 2 } }), SPLAT.aperture);
  assert.equal(engineAperture({ mla: { fNumberMicrolens: 2 } }), SPLAT.aperture);
  const both = nominalAperture({ mla: { fNumberMicrolens: 2 }, capture: { fNumber: 2.8 } });
  assert.ok(Number.isFinite(both) && both > 0 && both <= 1);
  assert.ok(Number.isFinite(engineAperture({ mla: { fNumberMicrolens: 2 }, capture: { fNumber: 2.8 } })));
});

test('calibrateGrid recovers a lattice drawn at pixel-index coordinates', () => {
  const W = 400;
  const H = 300;
  const p = 14.2857;
  const rs = (p * Math.sqrt(3)) / 2;
  const truth = { pitch: p, rowStep: rs, rotation: 0, ox: 200.3, oy: 150.2 };
  const raw = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let best = 1e9;
      for (let r = -14; r <= 14; r++) {
        for (let c = -16; c <= 16; c++) {
          const d2 = (x - (truth.ox + c * p + (r & 1) * p / 2)) ** 2 + (y - (truth.oy + r * rs)) ** 2;
          if (d2 < best) best = d2;
        }
      }
      raw[y * W + x] = 1000 * Math.exp(-best / (2 * 3.5 * 3.5)) + 50;
    }
  }
  const res = calibrateGrid(raw, { width: W, height: H }, { ...truth, ox: truth.ox + 0.4, oy: truth.oy - 0.3 });
  const [lx, ly] = toLocal(truth, res.grid.ox, res.grid.oy);
  const r = Math.round(ly / rs);
  const c = Math.round((lx - (r & 1) * p / 2) / p);
  assert.ok(Math.abs(lx - (c * p + (r & 1) * p / 2)) < 0.06, `dx ${lx - (c * p + (r & 1) * p / 2)}`);
  assert.ok(Math.abs(ly - r * rs) < 0.06, `dy ${ly - r * rs}`);
});

test('refocus keeps the last column and row at alpha 0, and sigma 0 is one view', () => {
  const W = 6;
  const H = 4;
  const rgb = new Float32Array(W * H * 3).fill(1);
  const o = refocus([{ u: 0, v: 0, rgb, gain: 1, detail: 1 }], W, H, 0);
  assert.ok(o.every((v) => v === 1));
  const o2 = refocus([{ u: 0, v: 0, rgb, gain: 1, detail: 1 }, { u: 1, v: 0, rgb: new Float32Array(W * H * 3).fill(5), gain: 1, detail: 1 }], W, H, 0, { sigma: 0 });
  assert.ok(o2.every((v) => v === 1), 'only the view at the center counts');
  // a fractional shift still leaves the last column to the next pass of the loop (it needs the pixel beyond)
  const o3 = refocus([{ u: 0.5, v: 0.5, rgb, gain: 1, detail: 1 }], W, H, 1);
  assert.ok(o3.every(Number.isFinite));
});

test('sampler kernel: the default is unchanged and a kernel past the window is clamped', () => {
  const W = 200;
  const H = 150;
  const p = 14.2857;
  const grid = { pitch: p, rowStep: (p * Math.sqrt(3)) / 2, rotation: 0.01, ox: 100, oy: 75 };
  const cam = { width: W, height: H, cfa: [[0, 1], [1, 2]], black: [0, 0, 0], white: [1000, 1000, 1000], wb: [1, 1, 1] };
  const a = buildSampler(grid, cam, 1);
  const b = buildSampler(grid, cam, 1, 1.0);
  assert.deepEqual(a.idx, b.idx);
  assert.deepEqual(a.wts, b.wts);
  const big = buildSampler(grid, cam, 1, 5);
  const edge = buildSampler(grid, cam, 1, 1.5);
  assert.deepEqual(big.idx, edge.idx);
  assert.deepEqual(big.wts, edge.wts);
});

test('a NaN depth does not black out its neighbors, and does not set the window', () => {
  const img = new Float32Array(5 * 3).fill(0.5);
  const d = new Float32Array([0, 0, NaN, 0, 0]);
  const f = { row: Float64Array.from([0.25, 0.5, 0.25]), col: Float64Array.from([1]) };
  const r = applyBank(img, d, 5, 1, { filters: [f], tiles: 1, tilesX: 1, tilesY: 1, lambdas: [0] });
  for (let i = 0; i < 5; i++) assert.ok(Math.abs(r.rgb[3 * i] / r.wsum[i] - 0.5) < 1e-5, `pixel ${i}`);
  const g = { pitch: 14 };
  assert.equal(minMaxRadius(Float32Array.from([0, NaN, 2]), 16, 16, g, 1), minMaxRadius(Float32Array.from([0, 0, 2]), 16, 16, g, 1));
});

test('sampleDepth on a map one texel wide or high stays inside it', () => {
  assert.equal(sampleDepth(Float32Array.from([5, 6, 7]), 1, 3, 0, 1), 6);
  assert.equal(sampleDepth(Float32Array.from([5, 6, 7]), 3, 1, 1, 0), 6);
  assert.equal(sampleDepth(Float32Array.from([5]), 1, 1, 0.4, 0.2), 5);
  assert.equal(sampleDepth(Float32Array.from([5, 5, 5, 5]), 2, 2, 5, -3), 5);
});

test('removeLatticeByTiles with a wide neighbor window (more than 128 bins) still clips the pattern', () => {
  // with a fixed 64-entry level buffer the median of such a window was undefined, so nothing was clipped
  const W = 640;
  const H = 512;
  const rgb = new Float32Array(W * H * 3);
  const base = new Float32Array(W * H);
  let seed = 7;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const v = 0.3 + 0.2 * Math.sin(x / 90) * Math.cos(y / 70) + 0.03 * (seed / 4294967296 - 0.5);
      base[y * W + x] = v;
      const phase = 2 * Math.PI * (0.27 * y + 0.12 * x + 0.00006 * x * y);
      const q = (v + 0.015 * Math.sin(phase) + 0.008 * Math.sin(phase * 1.05 + 1)) ** 2;
      rgb.set([q, q, q], 3 * (y * W + x));
    }
  }
  const error = () => {
    let e = 0;
    for (let i = 0; i < W * H; i++) e += (Math.sqrt(rgb[3 * i]) - base[i]) ** 2;
    return e;
  };
  const before = error();
  removeLatticeByTiles(rgb, W, H, { around: 16 });
  assert.ok(error() < before * 0.4, `left ${error() / before}`);
});

test('LUT domains and saved data are validated', () => {
  const rows = '0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n';
  assert.throws(() => parseCube(`LUT_3D_SIZE 2\nDOMAIN_MAX 2 2\n${rows}`), /domain/);
  assert.throws(() => parseCube(`LUT_3D_SIZE 2\nDOMAIN_MIN 0 0\n${rows}`), /domain/);
  assert.throws(() => parseCube(`LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 0 1\n${rows}`), /domain/);
  assert.equal(parseCube(`LUT_3D_SIZE 2\nDOMAIN_MAX 2 2 2\n${rows}`).max[2], 2);
  const saved = encodeLut(parseCube(`LUT_3D_SIZE 2\n${rows}`), 'x');
  assert.equal(decodeLut(saved).size, 2);
  assert.equal(decodeLut({ ...saved, data: '***not base64***' }), null);
  assert.equal(decodeLut({ ...saved, lo: NaN }), null);
  assert.equal(decodeLut({ ...saved, hi: 'a' }), null);
  assert.equal(decodeLut({ ...saved, max: [1] }), null);
  assert.equal(decodeLut({ ...saved, min: [0, 0, 0], max: [0, 1, 1] }), null);
  assert.equal(decodeLut({ ...saved, size: 66 }), null);
  assert.equal(decodeLut({ ...saved, size: 2.5 }), null);
});

test('command line: strict numbers, flags are not values, terminator, short equals form, folder names', () => {
  const errs = (a) => parseCli(['render', 'a.lfp', ...a]).errors.join('; ');
  assert.match(errs(['--focus=']), /needs a value/);
  assert.match(errs(['--focus', '']), /needs a value/);
  assert.match(errs(['--quality', '']), /needs a value/);
  assert.match(errs(['--view', '.,.']), /--view/);
  assert.match(errs(['--view', '1']), /--view/);
  assert.match(errs(['--timeout', '-5']), /--timeout/);
  assert.match(errs(['--focus', '0x10']), /--focus/);
  assert.equal(errs(['--focus', '-0.3', '--view', '-1,.5']), '');
  assert.match(errs(['--out', '--quiet']), /needs a value/);
  assert.equal(parseCli(['render', 'a.lfp', '--out=-odd']).options.out, '-odd');
  const t = parseCli(['render', '--', '-a.lfp', '--b.lfp']);
  assert.deepEqual(t.files, ['-a.lfp', '--b.lfp']);
  assert.deepEqual(t.errors, []);
  assert.equal(parseCli(['render', 'a.lfp', '-o=x.png']).options.out, 'x.png');
  const p = { join: path.posix.join, dirname: path.posix.dirname, basename: path.posix.basename };
  assert.equal(outputPath('/in/a.lfp', { out: 'shots.2026' }, { ...p, many: false }), 'shots.2026/a.png');
  assert.equal(outputPath('/in/a.lfp', { out: 'x.png' }, { ...p, many: false }), 'x.png');
  assert.match(errs(['--out', 'x.png', '--format', 'jpeg']), /--format/);
  assert.equal(errs(['--out', 'x.jpg', '--format', 'jpeg']), '');
  assert.equal(errs(['--out', 'x.png', '--format', 'png16']), '');
});

test('saved masks with fields of the wrong type fall back to the defaults', () => {
  const [m] = parseMasks(JSON.stringify([{ kind: 'radial', x: 'a', on: 'yes', fx: { blur: null, exposure: 0.5, haze: 'x' } }]));
  const d = defaultMask('radial');
  assert.equal(m.x, d.x);
  assert.equal(m.on, true);
  assert.equal(m.fx.blur, 0);
  assert.equal(m.fx.haze, 0);
  assert.equal(m.fx.exposure, 0.5);
  assert.ok(Object.values(m).every((v) => typeof v !== 'number' || Number.isFinite(v)));
  const [k] = parseMasks(JSON.stringify([{ kind: 'depth', near: 0.1, far: null, feather: NaN }]));
  assert.equal(k.near, 0.1);
  assert.equal(k.far, defaultMask('depth').far);
});

test('only bullets at column 0 are release highlights', () => {
  const body = "## What's new\n- **One.** First.\n  - nested point\n    - deeper\n- **Two.** Second.\n";
  assert.deepEqual(releaseHighlights(body).map((h) => h.lead), ['One.', 'Two.']);
});
