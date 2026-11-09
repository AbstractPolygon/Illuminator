// The library keeps what it has when a replacement fails, backs up an index it cannot use, and ignores writes for removed photos.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library, EDITS_FILE } from '../app/js/library/library.js';
import { stillFileName } from '../app/js/core/still-cache.js';
import { memoryStorage } from '../app/js/library/storage.js';

const entry = (name, body, sidecar) => ({ name, file: new File([body], name), sidecar: sidecar ? new File([sidecar], `${name}.json`) : null });

test('a replacement that fails to copy leaves the old photo whole', async () => {
  const store = memoryStorage();
  const lib = new Library(store);
  const [old] = await lib.add([entry('a.lfp', 'old photo', 'old sidecar')]);
  await lib.saveEdits(old, { exposure: 1 });
  const copyIn = store.copyIn.bind(store);
  let n = 0;
  store.copyIn = async (file, path) => {
    if (++n === 2) throw new Error('disk full');
    return copyIn(file, path);
  };
  await assert.rejects(lib.add([entry('a.lfp', 'new photo', 'new sidecar')], { replace: true }), /disk full/);
  assert.equal(await (await store.file(`Photos/${old.id}/a.lfp`)).text(), 'old photo');
  assert.equal(await (await store.file(`Photos/${old.id}/a.lfp.json`)).text(), 'old sidecar');
  assert.ok(await store.readText(`Photos/${old.id}/${EDITS_FILE}`));
  assert.equal((await store.list('Staging')).length, 0);
  assert.equal(lib.photos.length, 1);
  // And a replacement that works swaps everything and drops the old edits.
  store.copyIn = copyIn;
  await lib.add([entry('a.lfp', 'new photo', 'new sidecar')], { replace: true });
  assert.equal(await (await store.file(`Photos/${old.id}/a.lfp`)).text(), 'new photo');
  assert.equal(await store.readText(`Photos/${old.id}/${EDITS_FILE}`), null);
});

test('an index that cannot be parsed is kept as library.json.bak before it is rebuilt', async () => {
  const store = memoryStorage();
  await store.writeText('library.json', '{ "albums": [ broken');
  await store.writeText('library.json.bak', 'older backup');
  await store.writeBlob('Photos/Beach/Beach.lfp', new Blob(['x']));
  const lib = await new Library(store).load();
  assert.equal(lib.photos.length, 1);
  assert.equal(await store.readText('library.json.bak'), 'older backup');
  const baks = (await store.list('')).filter((e) => /^library\.json\..*bak$/.test(e.name));
  assert.equal(baks.length, 2);
  assert.ok(JSON.parse(await store.readText('library.json')).photos);
});

test('an index from a newer version is kept as a backup', async () => {
  const store = memoryStorage();
  const newer = JSON.stringify({ format: 'illuminator-library', version: 99, photos: [], albums: [{ id: 'x', name: 'X', photos: [], future: 1 }] });
  await store.writeText('library.json', newer);
  await new Library(store).load();
  assert.equal(await store.readText('library.json.bak'), newer);
});

test('a photo folder the index lost gets its photo id back from the file', async () => {
  const store = memoryStorage();
  await store.writeBlob('Photos/Beach/Beach.lfp', new Blob(['x']));
  const lib = await new Library(store, { readSummary: async () => ({ photoId: 'sha1-abc', thumbnail: null }) }).load();
  assert.equal(lib.photos[0].photoId, 'sha1-abc');
});

test('nothing is written for a photo that was removed, and a new photo does not inherit its leftovers', async () => {
  const store = memoryStorage();
  const lib = new Library(store);
  const [p] = await lib.add([entry('IMG_0001.lfp', 'one')]);
  await lib.saveEdits(p, { a: 1 });
  await lib.remove([p.id]);
  await lib.saveEdits(p, { a: 2 });
  await lib.saveProcessed(p, new Uint8Array([1]));
  await lib.saveStill(p, 'h1', new Blob(['x']));
  await lib.saveKeptPicture(p, 'h2', new Uint8Array([1]));
  await lib.saveThumbnail(p, new Blob(['t'], { type: 'image/png' }));
  await lib.setMarks(p, { rating: 3, flag: '', keywords: ['a'] });
  await lib.setPhotoId(p, 'sha1-new');
  assert.deepEqual(await store.list(`Photos/${p.id}`), []);
  assert.equal(p.rating, undefined);
  assert.ok(!p.thumb);
  // A stale folder with the id of a new photo is cleared before the copy.
  await store.writeText('Photos/img_0002/edits.illuminator.json', '{"stale":1}');
  const [q] = await lib.add([entry('IMG_0002.lfp', 'two')]);
  assert.equal(q.id, 'img_0002');
  assert.equal(await store.readText(`Photos/${q.id}/${EDITS_FILE}`), null);
});

test('two stills saved at once both end up in the index', async () => {
  const store = memoryStorage();
  const lib = new Library(store);
  const [p] = await lib.add([entry('a.lfp', 'one')]);
  await Promise.all(['aa', 'bb', 'cc'].map((h) => lib.saveStill(p, h, new Blob([h]))));
  const names = (await store.list(`Photos/${p.id}`)).map((e) => e.name);
  for (const h of ['aa', 'bb', 'cc']) assert.ok(names.includes(stillFileName(h)), names.join());
});
