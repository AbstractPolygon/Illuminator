// The Light L16 zoomed-in telephoto detail made whole on the graphics card (gpu/l16region.js, through core/l16hires.js setL16RegionGpu) gives the processor's renderRegion
// result on a small made-up capture (helpers/l16scene.mjs): two telephoto cameras, one out of register (so the flow refinement moves it), one with lens distortion and a
// capture correction, a depth that disagrees with what they saw in one patch, a flat area, a clipped highlight and sensors that cover only part of the region. Skipped where
// Playwright or its browser is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gpuPage } from './helpers/gpupage.mjs';
import { makeL16Scene } from './helpers/l16scene.mjs';

test('the L16 telephoto detail on the graphics card matches the processor’s', async (t) => {
  const page = await gpuPage(t);
  if (!page) return;
  const res = await page.evaluate(async (src) => {
    const gpu = await globalThis.makeGpu();
    if (!gpu) return null;
    const hires = await import('/js/core/l16hires.js');
    const { l16RegionGpu } = await import('/js/gpu/l16region.js');
    const s = (0, eval)(`(${src})`)();
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
    const run = (flow) => {
      const opts = { ...s.opts, flow };
      hires.setL16RegionGpu(null);
      const cpu = hires.renderRegion(s.bytes, s.parsed, s.depth, s.wide, s.region, s.modules, opts, () => {}, s.rawCache);
      hires.setL16RegionGpu(watch(l16RegionGpu(gpu)));
      const card = hires.renderRegion(s.bytes, s.parsed, s.depth, s.wide, s.region, s.modules, opts, () => {}, s.rawCache);
      hires.setL16RegionGpu(null);
      let worst = 0;
      let sum = 0;
      let big = 0;
      let changed = 0;
      for (let i = 0; i < cpu.rgb.length; i++) {
        const d = Math.abs(cpu.rgb[i] - card.rgb[i]);
        worst = Math.max(worst, d);
        sum += d;
        if (d > 1e-3) big++;
        if (Math.abs(cpu.rgb[i] - cpu.wide[i]) > 1e-4) changed++;
      }
      let wideWorst = 0;
      for (let i = 0; i < cpu.wide.length; i++) wideWorst = Math.max(wideWorst, Math.abs(cpu.wide[i] - card.wide[i]));
      return {
        size: [cpu.width, cpu.height, card.width, card.height],
        worst, mean: sum / cpu.rgb.length, big, changed, n: cpu.rgb.length, wideWorst,
        covered: [cpu.covered, card.covered], agreement: [cpu.agreement, card.agreement],
      };
    };
    const out = { flow: run(true), noFlow: run(false) };
    out.err = gpu.gl.getError();
    out.log = log;
    return out;
  }, makeL16Scene.toString());
  if (!res) return t.skip('No float render targets');
  assert.equal(res.err, 0);
  assert.deepEqual(res.log.errors, [], 'a step on the graphics card failed');
  assert.ok(res.log.calls > 0, 'the graphics card was not used');
  for (const [name, r] of Object.entries({ 'with the flow refinement': res.flow, 'without it': res.noFlow })) {
    assert.deepEqual(r.size, [96, 72, 96, 72], name);
    // (the input reaches every step: the detail changes part of the region, and part is left as the wide picture, outside the cameras or where they disagree)
    assert.ok(r.changed > 1000 && r.changed < r.n - 1000, `${name}: ${r.changed} of ${r.n} values changed by the detail`);
    // Single precision on the card against the processor's mix of single precision pictures and double precision sums: a few units in the last place of values near 1
    // through the chain of blurs, divisions and exp (measured 2.6e-6 on SwiftShader). A pixel that fell on the other side of one of the thresholds (clipping, usable share,
    // agreement, the flow's best match) would differ by far more, so this bound also says none did.
    assert.ok(r.worst < 2e-5, `${name}: the card differs from the processor by up to ${r.worst}`);
    assert.ok(r.mean < 1e-6, `${name}: mean difference ${r.mean}`);
    assert.ok(r.wideWorst < 1e-6, `${name}: the wide picture on the output grid differs by up to ${r.wideWorst}`);
    // the same pixels take detail (a count, so exact), and each camera's mean agreement is the same to single precision
    assert.equal(r.covered[1], r.covered[0], name);
    assert.ok(r.covered[0] > 0.05 && r.covered[0] < 0.95, `${name}: covered ${r.covered[0]}`);
    for (const id of ['B1', 'C1']) {
      assert.ok(r.agreement[0][id] > 0, `${name}: ${id} has no agreement`);
      assert.ok(Math.abs(r.agreement[0][id] - r.agreement[1][id]) < 1e-5, `${name}: ${id} agreement ${r.agreement[0][id]} on the processor, ${r.agreement[1][id]} on the card`);
    }
  }
  // (the flow refinement moved the cameras: otherwise its steps would not have been tested)
  assert.notEqual(res.flow.covered[0], res.noFlow.covered[0]);
});
