import test from 'node:test';
import assert from 'node:assert/strict';
import { gridTag, depthCacheKey, depthMethodKey, openCacheKey } from '../app/js/core/cachekeys.js';
import { CACHE_REV } from '../app/js/core/cacherev.js';

const grid = { pitch: 13.5, rot: 0.001 };
const make = (over = {}) => ({ lf: { photoId: 'P1', grid }, openGrid: JSON.stringify(grid), settings: { detail: 1 }, userDepth: null, ...over });

test('the default grid leaves no tag and the same keys', () => {
  const a = make();
  const b = make({ lf: { photoId: 'P1', grid: { ...grid } } });
  assert.equal(gridTag(a), undefined);
  assert.equal(depthCacheKey(a), depthCacheKey(b));
  assert.equal(depthMethodKey(a, 'classic'), depthMethodKey(b, 'classic'));
  assert.equal(JSON.parse(depthCacheKey(a)).grid, undefined);
});

test('a changed lens grid changes the keys', () => {
  const a = make();
  const moved = make({ lf: { photoId: 'P1', grid: { ...grid, pitch: 13.6 } } });
  assert.equal(gridTag(moved), JSON.stringify({ ...grid, pitch: 13.6 }));
  assert.notEqual(depthCacheKey(a), depthCacheKey(moved));
  assert.notEqual(depthMethodKey(a, 'classic'), depthMethodKey(moved, 'classic'));
});

test('no lf or no grid gives no tag and does not throw', () => {
  assert.equal(gridTag({ lf: null, settings: {} }), undefined);
  assert.equal(gridTag({ lf: { photoId: 'x' }, settings: {} }), undefined);
  assert.doesNotThrow(() => depthCacheKey({ lf: null, settings: {} }));
});

test('keys depend on photo, detail, hot pixels and revision, and the depth key not on smoothing', () => {
  const a = make();
  assert.notEqual(depthCacheKey(a), depthCacheKey(make({ lf: { photoId: 'P2', grid } })));
  assert.notEqual(depthCacheKey(a), depthCacheKey(make({ settings: { detail: 2 } })));
  assert.notEqual(depthCacheKey(a), depthCacheKey(make({ settings: { detail: 1, hotPixels: false } })));
  assert.equal(depthCacheKey(a), depthCacheKey(make({ settings: { detail: 1, depthSmooth: 9 } })));
  assert.equal(JSON.parse(depthCacheKey(a)).rev, CACHE_REV);
  assert.equal(JSON.parse(openCacheKey(a)).rev, CACHE_REV);
});

test('the method key follows style, quality, objects, Lytro depth and guided', () => {
  const a = make();
  const k = depthMethodKey(a, 'classic');
  assert.notEqual(k, depthMethodKey(a, 'guided'));
  assert.notEqual(k, depthMethodKey(make({ settings: { detail: 1, depthQuality: 'high' } }), 'classic'));
  assert.notEqual(k, depthMethodKey(make({ settings: { detail: 1, depthObjects: true } }), 'classic'));
  const withUser = make({ userDepth: {} });
  assert.notEqual(k, depthMethodKey(withUser, 'classic'));
  assert.equal(depthMethodKey(withUser, 'classic'), depthMethodKey(make({ userDepth: {}, settings: { detail: 1, lytroDepth: true } }), 'classic'));
  assert.equal(depthMethodKey(make({ userDepth: {}, settings: { detail: 1, lytroDepth: false } }), 'classic'), k);
});

test('the open key follows white balance and modulation, not the grid', () => {
  const a = make();
  assert.notEqual(openCacheKey(a), openCacheKey(make({ settings: { engineWb: false } })));
  assert.notEqual(openCacheKey(a), openCacheKey(make({ settings: { engineModulation: false } })));
  assert.equal(openCacheKey(a), openCacheKey(make({ lf: { photoId: 'P1', grid: { ...grid, pitch: 99 } } })));
});
