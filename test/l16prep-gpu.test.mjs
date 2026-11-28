// A Light L16 camera's picture prepared on the graphics card (gpu/l16prep.js, set with core/l16fusion.js setL16PrepGpu) gives the processor's (core/l16fusion.js halfSize
// and demosaic) on small made-up sensor frames: packed 10 bit rows with a pattern, hard edges, a clipped highlight, hot, dead and warm pixels (some on the frame's edges),
// and red and blue drawn a little larger and smaller than green, so the color fringe measurement finds a shift and takes it out. Cameras with the red site at two phases,
// the monochrome camera, a long exposure, the half size picture (whole and cropped, from the packed rows and from an unpacked plane), and the full size demosaic (whole
// and a window, with the fringes measured on the half size picture taken out at twice the size). Skipped where Playwright or its browser is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gpuPage } from './helpers/gpupage.mjs';

test('the L16 camera pictures prepared on the graphics card match the processor’s', async (t) => {
  const page = await gpuPage(t);
  if (!page) return;
  const res = await page.evaluate(async () => {
    const gpu = await globalThis.makeGpu();
    if (!gpu) return null;
    const { halfSize, demosaic, setL16PrepGpu, chromaFor } = await import('/js/core/l16fusion.js');
    const { decodeFrame } = await import('/js/core/lri.js');
    const { l16PrepGpu } = await import('/js/gpu/l16prep.js');
    // (counted, and the processor's fallback watched for: a card that failed would leave the processor's picture on both sides)
    const onCardPrep = l16PrepGpu(gpu);
    let calls = 0;
    const prep = (args) => (calls++, onCardPrep(args));
    const warnings = [];
    const warn = console.warn;
    console.warn = (...a) => warnings.push(a.map(String).join(' '));
    let s = 5;
    const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 8) / 16777216;
    const SW = 192;
    const SH = 144;
    // The scene (0..1.3, linear) at a sensor point: a pattern, an edge, a bright patch past the white level.
    const scene = (x, y) => {
      let v = 0.3 + 0.18 * Math.sin(0.41 * x + 0.13 * y) + 0.12 * Math.cos(0.07 * x * 0.9 - 0.29 * y);
      if (x > 60 && x < 110 && y > 40 && y < 90) v += 0.35;
      if ((x - 150) ** 2 + (y - 100) ** 2 < 200) v = 1.3;
      return v;
    };
    // A camera's frame: its packed rows (10 bit, four pixels in five bytes, rows a few bytes longer than needed), red at phase `red` ({ x: -1 } for the monochrome
    // camera), red drawn 0.6% larger and blue 0.5% smaller than green about the middle, with noise and specks. `frame()` makes a new frame object for the same bytes (the
    // color fringes measured are kept per frame object).
    const camera = (id, red, exposure = 1e7) => {
      const stride = (SW / 4) * 5 + 3;
      const offset = 17;
      const bytes = new Uint8Array(9 + offset + SH * stride);
      const dn = new Uint16Array(SW * SH);
      const mono = red.x < 0;
      const cx = SW / 2;
      const cy = SH / 2;
      for (let y = 0; y < SH; y++) {
        for (let x = 0; x < SW; x++) {
          const isR = (x & 1) === red.x && (y & 1) === red.y;
          const isB = (x & 1) !== red.x && (y & 1) !== red.y;
          const k = mono ? 1 : isR ? 1.006 : isB ? 0.995 : 1;
          const v = scene(cx + (x + 0.5 - cx) * k, cy + (y + 0.5 - cy) * k) * (mono ? 1 : isR ? 0.6 : isB ? 0.75 : 1);
          dn[y * SW + x] = Math.max(0, Math.min(1023, Math.round(42 + v * 981 + 6 * (rnd() - 0.5))));
        }
      }
      // hot, dead and warm pixels, some on the edges and corners
      for (const [x, y] of [[0, 0], [SW - 1, 7], [5, SH - 1], [33, 21], [34, 21], [100, 3], [140, 70]]) dn[y * SW + x] = 1023;
      for (const [x, y] of [[71, 50], [1, 80], [120, 120]]) dn[y * SW + x] = 43;
      for (const [x, y] of [[20, 110], [21, 110], [90, 30], [91, 31], [SW - 2, SH - 2]]) dn[y * SW + x] = Math.min(1023, dn[y * SW + x] + 30);
      for (let y = 0; y < SH; y++) {
        for (let g = 0; g < SW / 4; g++) {
          const o = 9 + offset + y * stride + 5 * g;
          const [a, b, c, d] = dn.subarray(y * SW + 4 * g, y * SW + 4 * g + 4);
          bytes[o] = a & 0xff;
          bytes[o + 1] = (a >> 8) | ((b & 0x3f) << 2);
          bytes[o + 2] = (b >> 6) | ((c & 0xf) << 4);
          bytes[o + 3] = (c >> 4) | ((d & 0x3) << 6);
          bytes[o + 4] = d >> 2;
        }
      }
      const frame = (format = 'RAW_PACKED_10BPP') => ({ blockStart: 9, module: { id, sensor_bayer_red_override: red, sensor_exposure: exposure, sensor_data_surface: { size: { x: SW, y: SH }, format, data_offset: offset, row_stride: stride } } });
      return { bytes, frame, dn };
    };
    const cams = [camera('A1', { x: 0, y: 0 }), camera('A2', { x: 1, y: 0 }, 5e8), camera('A3', { x: -1, y: -1 })];
    // (the packing undone by the file reader gives the values made)
    const unpacked = decodeFrame(cams[0].bytes, cams[0].frame()).data;
    const packingOk = unpacked.every((v, i) => v === cams[0].dn[i]);

    // Each case run on the processor and on the card, on new frame objects; the pictures compared.
    const run = (onCard, fn) => {
      setL16PrepGpu(onCard ? prep : null);
      try {
        return fn();
      } finally {
        setL16PrepGpu(null);
      }
    };
    const compare = (a, b) => {
      let worst = 0;
      let sum = 0;
      for (let i = 0; i < a.length; i++) {
        const d = Math.abs(a[i] - b[i]);
        if (!(d <= worst)) worst = d;
        sum += d;
      }
      return { worst, mean: sum / a.length, size: a.length === b.length };
    };
    const out = {};
    const awb = [1.9, 1, 1.6];
    for (const [k, c] of cams.entries()) {
      const pair = [false, true].map((onCard) =>
        run(onCard, () => {
          const f = c.frame();
          const half = halfSize(c.bytes, f, { gains: awb });
          const crop = halfSize(c.bytes, f, { gains: awb }, null, { x: 13.4, y: 7, w: 40, h: 31.5 });
          const full = demosaic(c.bytes, f, { gains: awb });
          const win = demosaic(c.bytes, f, { gains: awb }, { x0: 51.5, y0: 1, w: 60, h: 33 });
          const noHot = halfSize(c.bytes, c.frame(), { gains: awb, hot: false });
          // (from the unpacked plane: a frame the card is not given the packed rows of)
          const cache = new Map([[f.module.id, decodeFrame(c.bytes, f)]]);
          const plane = halfSize(c.bytes, c.frame('UNPACKED'), { gains: awb }, cache);
          return { half, crop, full, win, noHot, plane, ca: chromaFor(f) };
        }),
      );
      const [cpu, card] = pair;
      for (const key of ['half', 'crop', 'full', 'win', 'noHot', 'plane']) {
        out[`${k}.${key}`] = { ...compare(cpu[key].rgb, card[key].rgb), dims: [cpu[key].width, cpu[key].height, card[key].width, card[key].height].join(), place: [cpu[key].ox, cpu[key].oy, cpu[key].x0, cpu[key].y0].join() === [card[key].ox, card[key].oy, card[key].x0, card[key].y0].join() };
      }
      out[`${k}.ca`] = { cpu: cpu.ca, card: card.ca };
      // (how much the specks' removal changed the processor's picture: the case is not a no-op)
      out[`${k}.specks`] = compare(cpu.half.rgb, cpu.noHot.rgb).worst;
    }
    console.warn = warn;
    return { out, packingOk, calls, warnings, err: gpu.gl.getError() };
  });
  if (!res) return t.skip('No float render targets');
  assert.equal(res.err, 0);
  assert.ok(res.packingOk, 'the made-up packed rows do not read back as the values made');
  assert.deepEqual(res.warnings, [], 'the card failed and the processor made the picture');
  assert.equal(res.calls, 18, 'every picture of the card side was made on the card');
  // The card works in single precision, as the processor's Float32Arrays hold the values, but the processor adds up in double: a few units in the last place of values up to
  // about 2 (0.25e-6 each). The color fringe lookup also places its point in single precision (about 1e-5 of a pixel at these coordinates), which on the pattern's steepest
  // slopes (about 0.5 a pixel, after the gains) moves a value by up to a few 1e-6, and the shifts measured differ by about 1e-6 of a pixel: hence the wider bound there.
  const withFringes = new Set(['half', 'full', 'win', 'noHot', 'plane']);
  for (const [key, r] of Object.entries(res.out)) {
    if (key.endsWith('.ca') || key.endsWith('.specks')) continue;
    const [cam, kind] = key.split('.');
    assert.ok(r.size && r.place, `${key}: the card's picture is not the processor's size or place (${r.dims})`);
    const fringes = cam !== '2' && withFringes.has(kind);
    const bound = fringes ? 5e-5 : 1e-6;
    assert.ok(r.worst < bound, `${key}: the card differs from the processor by up to ${r.worst} (bound ${bound})`);
    assert.ok(r.mean < 1e-6, `${key}: the card differs from the processor by ${r.mean} on average`);
  }
  // the color fringes measured (on the color cameras: a clear shift, the same on the card to well under a thousandth of a pixel; none on the monochrome camera)
  for (const cam of ['0', '1']) {
    const { cpu, card } = res.out[`${cam}.ca`];
    assert.ok(cpu && card, `camera ${cam}: no color fringes measured`);
    assert.ok(Math.abs(cpu.r.s) > 0.1 && Math.abs(cpu.b.s) > 0.1, `camera ${cam}: the made-up fringes were not found (${JSON.stringify(cpu)})`);
    for (const c of ['r', 'b']) for (const q of ['s', 'tx', 'ty']) assert.ok(Math.abs(cpu[c][q] - card[c][q]) < 1e-5, `camera ${cam}: the ${c}.${q} measured differs: ${cpu[c][q]} and ${card[c][q]}`);
  }
  assert.equal(res.out['2.ca'].cpu, null);
  assert.equal(res.out['2.ca'].card, null);
  for (const cam of ['0', '1', '2']) assert.ok(res.out[`${cam}.specks`] > 0.05, `camera ${cam}: taking the specks out changed nothing`);
});
