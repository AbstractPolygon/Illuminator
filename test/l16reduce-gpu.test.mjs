// The pictures a Light L16 photo's depth is measured on, made on the graphics card (gpu/l16reduce.js, set with setL16ReduceGpu), give the processor's (core/l16depth.js
// reducedPicture with no card): small made-up frames of packed 10 bit rows (flat areas, a sharp edge, a ramp, noise, the brightest value, padded rows and a file that ends
// right after the last row's values), reduced by 4 and by 3. And the reference's picture looked up through its lens distortion (undistorted) gives what depthSetup
// works out on the processor, with the pixels outside the picture flagged. Skipped where Playwright or its browser is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gpuPage } from './helpers/gpupage.mjs';

test('the L16 depth pictures on the graphics card match the processor’s', async (t) => {
  const page = await gpuPage(t);
  if (!page) return;
  const res = await page.evaluate(async () => {
    const gpu = await globalThis.makeGpu();
    if (!gpu) return null;
    const { reducedPicture, setL16ReduceGpu } = await import('/js/core/l16depth.js');
    const { makeDistortion } = await import('/js/core/l16geometry.js');
    const { l16ReduceGpu } = await import('/js/gpu/l16reduce.js');
    const onCard = l16ReduceGpu(gpu);
    // (a failure on the card falls back to the processor with a warning: the test counts both, so a fallback cannot pass for a match)
    const warnings = [];
    const warn = console.warn;
    console.warn = (...a) => warnings.push(a.map(String).join(' '));
    let calls = 0;
    let s = 5;
    const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 8) / 16777216;
    // A frame of W x H sensor values packed 4 to 5 bytes, rows `pad` bytes longer than their values, at `offset` in a file that ends after the last row's values.
    const frame = (W, H, pad, value) => {
      const stride = (W / 4) * 5 + pad;
      const blockStart = 7;
      const dataOffset = 5;
      const start = blockStart + dataOffset;
      const bytes = new Uint8Array(start + (H - 1) * stride + (W / 4) * 5);
      for (let i = 0; i < start; i++) bytes[i] = 0xa5;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x += 4) {
          const v = [0, 1, 2, 3].map((k) => value(x + k, y));
          const o = start + y * stride + (x / 4) * 5;
          bytes[o] = v[0] & 0xff;
          bytes[o + 1] = (v[0] >> 8) | ((v[1] & 0x3f) << 2);
          bytes[o + 2] = (v[1] >> 6) | ((v[2] & 0xf) << 4);
          bytes[o + 3] = (v[2] >> 4) | ((v[3] & 0x3) << 6);
          bytes[o + 4] = v[3] >> 2;
        }
        // (the row's padding: junk the reading must not see)
        if (y < H - 1) for (let k = 0; k < pad; k++) bytes[start + y * stride + (W / 4) * 5 + k] = 0xff;
      }
      return { bytes, frame: { blockStart, module: { sensor_data_surface: { format: 'RAW_PACKED_10BPP', size: { x: W, y: H }, row_stride: stride, data_offset: dataOffset } } } };
    };
    const scene = (x, y) => {
      if (x < 24 && y < 20) return 300;                                // flat
      if (x >= 24 && x < 40 && y < 20) return x < 31 ? 120 : 900;      // a sharp edge
      if (y >= 60) return 1023;                                        // the brightest value
      if (x >= 70) return Math.min(1023, 8 * x + 3 * y);               // a ramp
      return Math.max(0, Math.min(1023, Math.round(450 + 200 * Math.sin(0.3 * x) * Math.cos(0.2 * y) + 120 * (rnd() - 0.5))));
    };
    const cases = [];
    for (const [W, H, pad, sc] of [[96, 72, 3, 4], [96, 72, 0, 3], [64, 40, 6, 4]]) {
      const { bytes, frame: f } = frame(W, H, pad, scene);
      setL16ReduceGpu(null);
      const cpu = reducedPicture(bytes, f, sc);
      setL16ReduceGpu({ reduced: (a) => (calls++, onCard.reduced(a)), undistorted: onCard.undistorted });
      const card = reducedPicture(bytes, f, sc);
      setL16ReduceGpu(null);
      let worst = 0;
      let range = 0;
      for (let i = 0; i < cpu.g.length; i++) {
        worst = Math.max(worst, Math.abs(cpu.g[i] - card.g[i]));
        range = Math.max(range, Math.abs(cpu.g[i]));
      }
      cases.push({ W, H, sc, size: [card.w, card.h], cpuSize: [cpu.w, cpu.h], worst, range });
    }
    // the reference's picture through its lens distortion (depthSetup's refSample on the processor), with a strong one so that the corners fall outside
    const w = 40;
    const h = 30;
    const S = 4;
    const g = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) g[i] = 2 * Math.sin(0.4 * (i % w)) + Math.cos(0.3 * Math.floor(i / w)) + 0.3 * (rnd() - 0.5);
    const bilinear = (x, y) => {
      x -= 0.5;
      y -= 0.5;
      if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return NaN;
      const xi = x | 0;
      const yi = y | 0;
      const fx = x - xi;
      const fy = y - yi;
      const o = yi * w + xi;
      return (g[o] * (1 - fx) + g[o + 1] * fx) * (1 - fy) + (g[o + w] * (1 - fx) + g[o + w + 1] * fx) * fy;
    };
    const lens = [
      makeDistortion({ distortion: { polynomial: { coeffs: [0.08, -0.02, 3e-4, -2e-4, 0.004], normalization: { x: 160, y: 160 }, distortion_center: { x: 81, y: 59 } } } }),
      makeDistortion({}),
    ];
    const undistorted = lens.map((distort) => {
      const cpu = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const [sx, sy] = distort((x + 0.5) * S, (y + 0.5) * S);
          cpu[y * w + x] = bilinear(sx / S, sy / S);
        }
      }
      const card = onCard.undistorted(g, w, h, S, distort);
      let worst = 0;
      let flags = 0;
      let outside = 0;
      for (let i = 0; i < w * h; i++) {
        if (Number.isNaN(cpu[i])) outside++;
        if (Number.isNaN(cpu[i]) !== Number.isNaN(card[i])) flags++;
        else if (!Number.isNaN(cpu[i])) worst = Math.max(worst, Math.abs(cpu[i] - card[i]));
      }
      return { worst, flags, outside };
    });
    console.warn = warn;
    return { cases, undistorted, calls, warnings, err: gpu.gl.getError() };
  });
  if (!res) return t.skip('No float render targets');
  assert.equal(res.err, 0);
  assert.deepEqual(res.warnings, []);
  assert.equal(res.calls, 3);
  for (const c of res.cases) {
    assert.deepEqual(c.size, c.cpuSize);
    // The card blurs g and g squared in single precision (the processor keeps its running sums in double): for sensor values up to 1023 the squares are up to about
    // 1e6 and the spread is their difference, so it loses a few more digits than single precision's 1e-7; the normalized values (within about +-3) stay well inside
    // 1e-4 (about 6e-6 under SwiftShader).
    assert.ok(c.worst < 1e-4, `reduced by ${c.sc} from ${c.W} x ${c.H}: the card differs from the processor by up to ${c.worst} (values up to ${c.range})`);
  }
  const [poly, none] = res.undistorted;
  assert.ok(poly.outside > 0, 'the strong distortion puts no pixel outside the picture');
  assert.equal(poly.flags, 0, `${poly.flags} pixels inside on one side and outside on the other`);
  assert.equal(none.flags, 0);
  // (the lens and the lookup in single precision, values within about +-3.3: a few 1e-6)
  assert.ok(poly.worst < 1e-4, `through the lens: the card differs from the processor by up to ${poly.worst}`);
  assert.ok(none.worst < 1e-4, `with no lens distortion: the card differs from the processor by up to ${none.worst}`);
});
