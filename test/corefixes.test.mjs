// Regression tests for review findings in core/raw.js, segmodel.js, raywarp.js, recipe.js and depthmodel.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { blendedCcm } from '../app/js/core/raw.js';
import { findObjectMasks } from '../app/js/core/segmodel.js';
import { parseRayWarp } from '../app/js/core/raywarp.js';
import * as recipe from '../app/js/core/recipe.js';
import { releaseDepthSession } from '../app/js/core/depthmodel.js';

const m = (v) => Array(9).fill(v);

test('blendedCcm: a temperature exactly on an interior entry gives that matrix, not NaN', () => {
  const per = [{ cct: 2800, ccm: m(1) }, { cct: 5000, ccm: m(2) }, { cct: 6500, ccm: m(3) }];
  assert.deepEqual(blendedCcm(per, 5000, null), m(2));
  assert.deepEqual(blendedCcm(per, 3900, null).map((v) => +v.toFixed(6)), m(1.5));
  assert.deepEqual(blendedCcm(per, 100, null), m(1));
  assert.deepEqual(blendedCcm(per, 9000, null), m(3));
  assert.equal(blendedCcm(per, NaN, 'fb'), 'fb');
  assert.equal(blendedCcm(per, undefined, 'fb'), 'fb');
  // duplicate temperatures
  const dup = [{ cct: 3000, ccm: m(1) }, { cct: 5000, ccm: m(2) }, { cct: 5000, ccm: m(2) }, { cct: 7000, ccm: m(3) }];
  assert.ok(blendedCcm(dup, 5000, null).every(Number.isFinite));
});

function fakeOrt() {
  class Tensor {
    constructor(type, data, dims) { this.data = data; this.dims = dims; }
  }
  return { Tensor };
}

test('findObjectMasks disposes the GPU embeddings, also after a CPU fallback or an error', async () => {
  const ort = fakeOrt();
  const disposed = [];
  const gpu = { dims: [1, 4], dispose() { disposed.push('gpu'); }, async getData() { return new Float32Array(4); } };
  const out = { masks: { data: new Float32Array(16) }, iou_predictions: { data: [0.5] } };
  const encoder = { run: async () => ({ image_embeddings: gpu }) };
  const failing = { run: async () => { throw new Error('no gpu'); } };
  const cpuDecoder = { run: async () => out };
  const model = { ort, encoder, decoder: failing, device: 'gpu', decoderBytes: null, cpuDecoder };
  const prep = () => ({ input: new Float32Array(3), nw: 1, nh: 1, scale: 1 });
  const res = await findObjectMasks(model, null, 4, 4, { cols: 1, rows: 1, prep });
  assert.equal(res.masks.length, 1);
  assert.deepEqual(disposed, ['gpu']); // disposed once, when replaced by the CPU copy

  disposed.length = 0;
  const gpu2 = { dims: [1, 4], dispose() { disposed.push('gpu2'); } };
  const ok = { run: async () => out };
  await findObjectMasks({ ort, encoder: { run: async () => ({ image_embeddings: gpu2 }) }, decoder: ok, device: 'gpu' }, null, 4, 4, { cols: 1, rows: 1, prep });
  assert.deepEqual(disposed, ['gpu2']);

  disposed.length = 0;
  const bad = { run: async () => { throw new Error('boom'); } };
  await assert.rejects(findObjectMasks({ ort, encoder: { run: async () => ({ image_embeddings: gpu2 }) }, decoder: bad, device: 'cpu' }, null, 4, 4, { cols: 1, rows: 1, prep }), /boom/);
  assert.deepEqual(disposed, ['gpu2']);

  // a plain CPU tensor has no dispose(): nothing throws
  await findObjectMasks({ ort, encoder: { run: async () => ({ image_embeddings: { dims: [1] } }) }, decoder: ok, device: 'cpu' }, null, 4, 4, { cols: 1, rows: 1, prep });
});

test('parseRayWarp refuses grids that would exhaust memory', () => {
  const MAGIC = 0xaf0990fa;
  const r = Math.fround;
  const [aMax, bMax, stepA, stepB, stepC] = [0.58, 0.58, 0.5, 0.5, 0.5].map(r);
  const na = Math.ceil(r(r(r(1) / stepA) * aMax)) + 2;
  const nb = Math.ceil(r(r(r(1) / stepB) * bMax)) + 2;
  const nc = Math.ceil(r(r(r(1) / stepC) * 2)) + 2;
  const nodes = na * nb * nc;
  for (const step of [1e-3, 1e-2, 0, NaN]) {
    const bytes = new Uint8Array(104 + 18 * nodes);
    const v = new DataView(bytes.buffer);
    v.setUint32(0, MAGIC, true);
    v.setInt32(4, 3, true);
    v.setInt32(16, bytes.length, true);
    for (let k = 0; k < 4; k++) { v.setFloat32(28 + 4 * k, -0.5, true); v.setFloat32(44 + 4 * k, 1, true); v.setFloat32(60 + 4 * k, step, true); }
    v.setInt32(76, 2, true);
    [aMax, bMax, stepA, stepB, stepC].forEach((p, k) => v.setFloat32(84 + 4 * k, p, true));
    assert.equal(parseRayWarp(bytes, 100, 80), null, `step ${step}`);
  }
});

test('recipes ignore prototype keys and null control points', () => {
  const fn = Object.keys(recipe).find((k) => /^(recipeToEdits|importRecipe|recipeEdits|lytroRecipeToEdits)$/.test(k));
  assert.ok(fn, `recipe exports: ${Object.keys(recipe)}`);
  const call = (r) => recipe[fn](r, { asShot: 5000 });
  for (const key of ['constructor', 'toString', '__proto__']) {
    const out = call({ viewWhiteBalance: key, viewFilterEffect: key });
    assert.equal(typeof out.edits.process['wb-temperature'], 'number');
  }
  const masks = recipe.recipeMasks({ fxContainerSequence: [{ fxSequence: [{ kind: 'fxColorize', controlPoints: [null, { r: 0.5, g: 0.5, b: 0.5 }] }] }] });
  assert.ok(Array.isArray(masks));
});

test('releaseDepthSession is safe for unknown ids', async () => {
  await releaseDepthSession('never-created');
});
