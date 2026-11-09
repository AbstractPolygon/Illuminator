// The processed version kept next to a photo: written by the library, read back, and applied only when it is for this photo, grid and revision.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../app/js/library/library.js';
import { memoryStorage } from '../app/js/library/storage.js';
import { encodeProcessed, decodeProcessed, PROCESSED_FILE } from '../app/js/core/processed-cache.js';
import { depthCacheKey, depthCacheFor, keptMethods } from '../app/js/core/cachekeys.js';
import { CACHE_REV } from '../app/js/core/cacherev.js';

const buf = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.length);
const entry = (name, body) => ({ name, file: new File([body], name), sidecar: null });
const stateFor = (photoId, grid = { p: 1 }) => ({ lf: { photoId, grid }, openGrid: JSON.stringify({ p: 1 }), settings: { detail: 1 } });
const alpha = Float32Array.from({ length: 6 }, (_, i) => i / 8);
const make = (state, extra = []) => ({ key: depthCacheKey(state), w: 3, h: 2, alpha, focusOffset: 0.25, extra });

test('encode then decode returns equal data, including extra depths and lens centers', () => {
  const extraKey = JSON.stringify({ rev: CACHE_REV, style: 'classic' });
  const e = { key: extraKey, w: 2, h: 2, alpha: Float32Array.of(1, 2, 3, 4), confidence: Float32Array.of(0.1, 0.2, 0.3, 0.4), range: [0, 1], flat: true };
  const lens = { key: 'lk', r0: 1, c0: 2, rows: 2, cols: 2, dx: Float32Array.of(1, 2, 3, 4), dy: Float32Array.of(5, 6, 7, 8) };
  const back = decodeProcessed(buf(encodeProcessed({ ...make(stateFor('P1'), [e]), open: { scale: [1, 2, 3] }, lens })));
  assert.deepEqual([...back.alpha], [...alpha]);
  assert.equal(back.focusOffset, 0.25);
  assert.deepEqual(back.open, { scale: [1, 2, 3] });
  assert.deepEqual([...back.extra[0].alpha], [1, 2, 3, 4]);
  assert.deepEqual([...back.extra[0].confidence], [0.1, 0.2, 0.3, 0.4].map(Math.fround));
  assert.equal(back.extra[0].flat, true);
  assert.deepEqual([...back.lens.dy], [5, 6, 7, 8]);
});

test('corrupt, truncated, wrong-version and foreign buffers are absent, never thrown', () => {
  const good = buf(encodeProcessed(make(stateFor('P1'))));
  const view = (b) => new DataView(b);
  const bad = [];
  for (const n of [0, 1, 11, 12, 20, good.byteLength - 1, good.byteLength - 8]) bad.push(good.slice(0, n));
  const version = good.slice(0); view(version).setUint32(4, 99, true); bad.push(version);
  const magic = good.slice(0); view(magic).setUint32(0, 0, true); bad.push(magic);
  const hugeHeader = good.slice(0); view(hugeHeader).setUint32(8, 0xffffffff, true); bad.push(hugeHeader);
  const junk = good.slice(0); new Uint8Array(junk).fill(0x7b, 12, 40); bad.push(junk);
  const noise = new Uint8Array(500).map((_, i) => (i * 37) & 255); bad.push(noise.buffer);
  for (const b of bad) assert.doesNotThrow(() => assert.equal(decodeProcessed(b), null));
  assert.equal(decodeProcessed(undefined), null);
  assert.equal(decodeProcessed('text'), null);
  assert.ok(decodeProcessed(good));
});

test('a cache written for another photo, grid or detail is not applied; the same one is', () => {
  const raster = { w: 3, h: 2 };
  const cache = decodeProcessed(buf(encodeProcessed(make(stateFor('P1')))));
  assert.equal(depthCacheFor(cache, depthCacheKey(stateFor('P1')), raster), cache);
  assert.equal(depthCacheFor(cache, depthCacheKey(stateFor('P2')), raster), null, 'another photo id');
  assert.equal(depthCacheFor(cache, depthCacheKey(stateFor('P1', { p: 2 })), raster), null, 'another lens grid');
  assert.equal(depthCacheFor(cache, depthCacheKey({ ...stateFor('P1'), settings: { detail: 2 } }), raster), null);
  assert.equal(depthCacheFor(cache, depthCacheKey(stateFor('P1')), { w: 4, h: 2 }), null, 'another size');
  assert.equal(depthCacheFor(null, 'k', raster), null);
  assert.equal(depthCacheFor({ key: 'k', w: 3, h: 2, alpha: new Float32Array(0) }, 'k', raster), null, 'not measured yet');
  assert.equal(depthCacheFor({ key: 'k', w: 3, h: 2 }, 'k', raster), null);
});

test('a cache from another CACHE_REV is not used, and its key says so', () => {
  const old = JSON.stringify({ ...JSON.parse(depthCacheKey(stateFor('P1'))), rev: CACHE_REV - 1 });
  const cache = { key: old, w: 3, h: 2, alpha };
  assert.equal(depthCacheFor(cache, depthCacheKey(stateFor('P1')), { w: 3, h: 2 }), null);
});

test('kept depth methods: other revisions are skipped, unreadable keys mark the cache damaged', () => {
  const ok = JSON.stringify({ rev: CACHE_REV, style: 'a' });
  const old = JSON.stringify({ rev: CACHE_REV - 1, style: 'b' });
  const mk = (key) => ({ key, w: 1, h: 1, alpha: new Float32Array(1), confidence: new Float32Array(1) });
  const r = keptMethods({ key: 'k', alpha, extra: [mk(ok), mk(old)] });
  assert.deepEqual([...r.methods.keys()], [ok]);
  assert.equal(r.damaged, false);
  assert.equal(keptMethods({ key: 'k', alpha, extra: [mk('{not json'), mk('"str"')] }).damaged, true);
  assert.equal(keptMethods({ key: '', alpha: null }).damaged, true);
  assert.deepEqual(keptMethods(null), { methods: new Map(), damaged: false });
});

test('the library writes the processed file, reads it back, and writes nothing for a removed photo', async () => {
  const store = memoryStorage();
  const lib = new Library(store);
  const [p] = await lib.add([entry('IMG_0001.lfp', 'one')]);
  assert.equal(await lib.processed(p), null);
  const bytes = encodeProcessed(make(stateFor('P1')));
  await lib.saveProcessed(p, bytes);
  assert.ok((await store.list(`Photos/${p.id}`)).some((f) => String(f.name || f).includes(PROCESSED_FILE)));
  const back = decodeProcessed(await lib.processed(p));
  assert.deepEqual([...back.alpha], [...alpha]);
  await lib.remove([p.id]);
  assert.equal(await lib.processed(p), null);
  await lib.saveProcessed(p, bytes);
  assert.deepEqual(await store.list(`Photos/${p.id}`), []);
});

test('a damaged file in the library reads as no cache', async () => {
  const store = memoryStorage();
  const lib = new Library(store);
  const [p] = await lib.add([entry('IMG_0001.lfp', 'one')]);
  await lib.saveProcessed(p, new Uint8Array([1, 2, 3]));
  assert.equal(decodeProcessed(await lib.processed(p)), null);
});
