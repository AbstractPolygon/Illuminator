import test from 'node:test';
import assert from 'node:assert/strict';
import { slic, regionStats } from '../app/js/core/segments.js';
import { finishDepth } from '../app/js/core/depth.js';
import { DEPTH_MODELS } from '../app/js/core/depthmodels.js';
import { MODEL_REVISION, SEG_HASHES, SEG_FILES } from '../app/js/core/segmodel.js';

test('slic on a map one pixel wide or high still has a region 0', () => {
  for (const [w, h] of [[1, 1], [1, 20], [20, 1]]) {
    const lab = new Float32Array(w * h * 3);
    const { label, count: k } = slic(lab, w, h);
    assert.ok(k >= 1);
    const stats = regionStats(new Float32Array(w * h), new Float32Array(w * h).fill(1), lab, label, k, w, h, 10);
    assert.ok(stats.value.length === k);
  }
});

test('finishDepth on a flat input gives no NaN', () => {
  const n = 16 * 16;
  const r = finishDepth({ alpha: new Float32Array(n), cost: new Float32Array(n), meanCost: new Float32Array(n) }, 16, 16, new Float32Array(n * 3), { refine: false });
  assert.ok(r.confidence.every(Number.isFinite));
  assert.ok(r.alpha.every(Number.isFinite));
});

test('the segmentation model files are pinned to a commit and a hash', () => {
  assert.match(MODEL_REVISION, /^[0-9a-f]{40}$/);
  for (const f of Object.values(SEG_FILES)) assert.match(SEG_HASHES[f].sha256, /^[0-9a-f]{64}$/);
  assert.ok(DEPTH_MODELS.length > 0);
});
