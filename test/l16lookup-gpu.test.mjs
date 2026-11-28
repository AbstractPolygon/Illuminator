// The telephoto cameras' lookup of the Light L16 zoomed-in detail on the graphics card (gpu/l16lookup.js, through core/l16hires.js setL16LookupGpu) gives the processor's:
// where each output pixel lands on a camera's sensor (depth, pose, lens distortion, the capture's correction; nowhere where the point is behind the camera) and the camera's
// picture there (nothing past the window of it made), and renderRegion's result with only the lookup on the card. On the made-up capture of helpers/l16scene.mjs. Skipped
// where Playwright or its browser is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gpuPage } from './helpers/gpupage.mjs';
import { makeL16Scene } from './helpers/l16scene.mjs';

test('the L16 telephoto lookup on the graphics card matches the processor’s', async (t) => {
  const page = await gpuPage(t);
  if (!page) return;
  const res = await page.evaluate(async (src) => {
    const gpu = await globalThis.makeGpu();
    if (!gpu) return null;
    const hires = await import('/js/core/l16hires.js');
    const { cameraModel } = await import('/js/core/l16geometry.js');
    const { relativePose } = await import('/js/core/l16depth.js');
    const { l16LookupGpu } = await import('/js/gpu/l16lookup.js');
    const s = (0, eval)(`(${src})`)();
    const { x0, y0, scale, grid } = s.region;
    const W = Math.round(s.region.w * scale);
    const H = Math.round(s.region.h * scale);
    const refCam = cameraModel(s.parsed.header, s.parsed.modules.A1[0]);
    const K = refCam.K;
    // the depth of every output pixel: a slope, and a few points too close (behind the camera's center after its baseline: nowhere on its sensor)
    const z = new Float32Array(W * H);
    for (let Y = 0; Y < H; Y++) for (let X = 0; X < W; X++) z[Y * W + X] = 2500 + 8 * X + 3 * Y;
    for (let i = 0; i < W * H; i += 97) z[i] = 0.5;
    // (every call to the card's functions counted, and any failure kept: the processor's code falls back to itself when one fails, which would compare it with itself)
    const log = { calls: 0, errors: [] };
    const watch = (v) => {
      if (typeof v === 'function') {
        return (...a) => {
          log.calls++;
          try {
            return watch(v(...a));
          } catch (e) {
            log.errors.push(String((e && e.message) || e));
            throw e;
          }
        };
      }
      if (v && typeof v === 'object' && !ArrayBuffer.isView(v) && Object.values(v).some((x) => typeof x === 'function')) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, watch(x)]));
      return v;
    };
    const lookup = watch(l16LookupGpu(gpu));
    const out = {};
    for (const id of s.modules) {
      const cam = cameraModel(s.parsed.header, s.parsed.modules[id][0]);
      const rel = relativePose(refCam, cam);
      const corr = s.region.corrections[id];
      // the processor's (core/l16hires.js renderRegion's lookup, step for step)
      const R = rel.R;
      const T = rel.T;
      const sx = new Float32Array(W * H).fill(NaN);
      const sy = new Float32Array(W * H);
      for (let Y = 0; Y < H; Y++) {
        const py = (y0 + (Y + 0.5) / scale) * grid;
        for (let X = 0; X < W; X++) {
          const i = Y * W + X;
          const px = (x0 + (X + 0.5) / scale) * grid;
          const Z = z[i];
          const Xr = ((px - K[2]) / K[0]) * Z;
          const Yr = ((py - K[5]) / K[4]) * Z;
          const Pz = R[6] * Xr + R[7] * Yr + R[8] * Z + T[2];
          if (Pz <= 1) continue;
          const ix = (cam.K[0] * (R[0] * Xr + R[1] * Yr + R[2] * Z + T[0])) / Pz + cam.K[2];
          const iy = (cam.K[4] * (R[3] * Xr + R[4] * Yr + R[5] * Z + T[1])) / Pz + cam.K[5];
          let [a, b] = cam.distort(ix, iy);
          if (corr) {
            const u = a / 4160;
            const v = b / 3120;
            a += corr.ax[0] + corr.ax[1] * u + corr.ax[2] * v;
            b += corr.ay[0] + corr.ay[1] * u + corr.ay[2] * v;
          }
          sx[i] = a;
          sy[i] = b;
        }
      }
      const card = lookup.project({ W, H, x0, y0, scale, grid, K, z, cam, rel, corr });
      let posWorst = 0;
      let nanMismatch = 0;
      let lands = 0;
      let lo = [Infinity, Infinity];
      let hi = [-Infinity, -Infinity];
      for (let i = 0; i < W * H; i++) {
        if ((sx[i] !== sx[i]) !== (card.sx[i] !== card.sx[i])) nanMismatch++;
        if (sx[i] !== sx[i] || card.sx[i] !== card.sx[i]) continue;
        lands++;
        posWorst = Math.max(posWorst, Math.abs(sx[i] - card.sx[i]), Math.abs(sy[i] - card.sy[i]));
        lo = [Math.min(lo[0], sx[i]), Math.min(lo[1], sy[i])];
        hi = [Math.max(hi[0], sx[i]), Math.max(hi[1], sy[i])];
      }
      // A window of the camera's picture that covers only the middle of where the pixels land (so some have nothing), with a texture of its own: the processor's bilinear
      // lookup (core/l16hires.js bilinear) against the card's.
      const img = { x0: Math.floor(lo[0] + (hi[0] - lo[0]) * 0.2), y0: Math.floor(lo[1] + (hi[1] - lo[1]) * 0.15) };
      img.width = Math.ceil((hi[0] - lo[0]) * 0.6);
      img.height = Math.ceil((hi[1] - lo[1]) * 0.7);
      img.rgb = new Float32Array(3 * img.width * img.height);
      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
          const v = 0.5 + 0.3 * Math.sin(0.21 * x + 0.13 * y) * Math.cos(0.17 * y - 0.05 * x);
          img.rgb.set([v, 0.8 * v + 0.1, 1 - v], 3 * (y * img.width + x));
        }
      }
      const looked = card.sample(img);
      card.release();
      let sampWorst = 0;
      let haveMismatch = 0;
      let have = 0;
      for (let i = 0; i < W * H; i++) {
        let ok = false;
        const o = [0, 0, 0];
        if (sx[i] === sx[i]) {
          const xx = sx[i] - img.x0 - 0.5;
          const yy = sy[i] - img.y0 - 0.5;
          if (!(xx < 0 || yy < 0 || xx >= img.width - 1 || yy >= img.height - 1)) {
            ok = true;
            const ix = xx | 0;
            const iy = yy | 0;
            const fx = xx - ix;
            const fy = yy - iy;
            const j = 3 * (iy * img.width + ix);
            const r = img.rgb;
            for (let c = 0; c < 3; c++) o[c] = (r[j + c] * (1 - fx) + r[j + 3 + c] * fx) * (1 - fy) + (r[j + 3 * img.width + c] * (1 - fx) + r[j + 3 * img.width + 3 + c] * fx) * fy;
          }
        }
        if (ok !== !!looked.have[i]) {
          haveMismatch++;
          continue;
        }
        if (!ok) continue;
        have++;
        for (let c = 0; c < 3; c++) sampWorst = Math.max(sampWorst, Math.abs(o[c] - looked.samp[3 * i + c]));
      }
      out[id] = { posWorst, nanMismatch, lands, n: W * H, sampWorst, haveMismatch, have };
    }
    // renderRegion with only the lookup on the card, against the processor's
    const whole = (flow) => {
      const opts = { ...s.opts, flow };
      hires.setL16LookupGpu(null);
      const cpu = hires.renderRegion(s.bytes, s.parsed, s.depth, s.wide, s.region, s.modules, opts, () => {}, s.rawCache);
      hires.setL16LookupGpu(lookup);
      const card = hires.renderRegion(s.bytes, s.parsed, s.depth, s.wide, s.region, s.modules, opts, () => {}, s.rawCache);
      hires.setL16LookupGpu(null);
      let worst = 0;
      let sum = 0;
      for (let i = 0; i < cpu.rgb.length; i++) {
        const d = Math.abs(cpu.rgb[i] - card.rgb[i]);
        worst = Math.max(worst, d);
        sum += d;
      }
      return { worst, mean: sum / cpu.rgb.length, covered: [cpu.covered, card.covered] };
    };
    out.whole = { flow: whole(true), noFlow: whole(false) };
    out.err = gpu.gl.getError();
    out.log = log;
    return out;
  }, makeL16Scene.toString());
  if (!res) return t.skip('No float render targets');
  assert.equal(res.err, 0);
  assert.deepEqual(res.log.errors, [], 'a step on the graphics card failed');
  assert.ok(res.log.calls > 0, 'the graphics card was not used');
  for (const id of ['B1', 'C1']) {
    const r = res[id];
    // (the points too close land nowhere on both; the rest land, and the window cuts part of them off)
    assert.equal(r.nanMismatch, 0, `${id}: ${r.nanMismatch} pixels land on the sensor on one side only`);
    assert.ok(r.lands > 0.9 * r.n && r.lands < r.n, `${id}: ${r.lands} of ${r.n} land`);
    assert.equal(r.haveMismatch, 0, `${id}: ${r.haveMismatch} pixels have the camera's picture on one side only`);
    assert.ok(r.have > 0.2 * r.n && r.have < 0.8 * r.lands, `${id}: ${r.have} of ${r.lands} have the camera's picture`);
    // Sensor positions of a few hundred pixels in single precision (a unit in the last place is 3e-5 there) through the projection and the distortion polynomial:
    // measured 1.5e-5 (B1) and 4.6e-5 (C1) on SwiftShader, held to about ten units in the last place.
    assert.ok(r.posWorst < 5e-4, `${id}: positions differ by up to ${r.posWorst} sensor pixels`);
    // the picture there: its slope (under 0.1 a pixel) times that, plus the bilinear sum in single precision (measured 1.7e-6)
    assert.ok(r.sampWorst < 1e-4, `${id}: the camera's picture differs by up to ${r.sampWorst}`);
  }
  for (const [name, r] of Object.entries({ 'with the flow refinement': res.whole.flow, 'without it': res.whole.noFlow })) {
    // (renderRegion: as in l16region-gpu.test.mjs, a pixel on the other side of a threshold would differ by far more; measured 2.4e-6)
    assert.ok(r.worst < 2e-5, `${name}: renderRegion differs by up to ${r.worst} with the lookup on the card`);
    assert.ok(r.mean < 1e-6, `${name}: mean difference ${r.mean}`);
    assert.equal(r.covered[1], r.covered[0], name);
  }
});
