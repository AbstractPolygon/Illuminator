import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryStorage } from '../app/js/library/storage.js';
import { Library } from '../app/js/library/library.js';

const file = (name, bytes = [1, 2, 3]) => new File([new Uint8Array(bytes)], name);

async function libraryWith(name = 'IMG_0001.LFR') {
  const lib = await new Library(memoryStorage()).load();
  const [photo] = await lib.add([{ name, label: 'IMG_0001', file: file(name), sidecar: null, thumb: file('thumb.jpg', [9]) }]);
  return { lib, photo };
}

test('a virtual copy shares the photo\'s files and has settings of its own', async () => {
  const { lib, photo } = await libraryWith();
  await lib.saveEdits(photo, { exposure: 1 });
  const copy = await lib.createVirtualCopy(photo);
  assert.equal(copy.master, photo.id);
  assert.notEqual(copy.id, photo.id);
  assert.equal(copy.name, 'IMG_0001.LFR copy');
  // the same light field file, stored once
  assert.deepEqual([...new Uint8Array(await (await lib.file(copy)).arrayBuffer())], [1, 2, 3]);
  assert.equal((await lib.store.list(`Photos/${copy.id}`)).some((f) => f.name === 'IMG_0001.LFR'), false);
  // the thumbnail too, and the settings start as the photo's, then differ
  assert.ok(await lib.thumbnail(copy));
  assert.deepEqual(await lib.loadEdits(copy), { exposure: 1 });
  await lib.saveEdits(copy, { exposure: 2 });
  assert.deepEqual(await lib.loadEdits(photo), { exposure: 1 });
  assert.deepEqual(await lib.loadEdits(copy), { exposure: 2 });
  // the copy comes just after its photo in the list (newest first), and joins its albums
  assert.deepEqual(lib.list().map((p) => p.id), [photo.id, copy.id]);
});

test('copies are numbered, a copy of a copy is a copy of the photo, and the albums follow', async () => {
  const { lib, photo } = await libraryWith();
  const album = await lib.createAlbum('Trip');
  await lib.addToAlbum(album.id, [photo.id]);
  const one = await lib.createVirtualCopy(photo);
  const two = await lib.createVirtualCopy(one);
  assert.equal(two.master, photo.id);
  assert.equal(two.name, 'IMG_0001.LFR copy 2');
  assert.deepEqual(lib.album(album.id).photos.sort(), [photo.id, one.id, two.id].sort());
});

test('importing the photo again finds the photo, not a copy; deleting it deletes its copies', async () => {
  const { lib, photo } = await libraryWith();
  const copy = await lib.createVirtualCopy(photo);
  assert.equal(lib.photos.filter((p) => !p.master).length, 1);
  await lib.remove([photo.id]);
  assert.equal(lib.get(copy.id), null);
  assert.equal(lib.photos.length, 0);
  assert.equal((await lib.store.list('Photos')).length, 0);
});

test('a library read back keeps the copies, and rebuilds one from its note when the index is lost', async () => {
  const store = memoryStorage();
  const lib = await new Library(store).load();
  const [photo] = await lib.add([{ name: 'IMG_7.LFR', label: 'IMG_7', file: file('IMG_7.LFR') }]);
  const copy = await lib.createVirtualCopy(photo);
  await lib.save();
  const again = await new Library(store).load();
  assert.equal(again.get(copy.id).master, photo.id);
  await store.remove('library.json');
  const rebuilt = await new Library(store).load();
  assert.equal(rebuilt.photos.length, 2);
  assert.equal(rebuilt.photos.find((p) => p.master).master, photo.id);
  assert.equal(rebuilt.photos.find((p) => p.master).name, copy.name);
});

test('a photo can be renamed; a blank name changes nothing', async () => {
  const { lib, photo } = await libraryWith();
  assert.equal(await lib.renamePhoto(photo, '  Sunset   over the bay '), true);
  assert.equal(lib.get(photo.id).name, 'Sunset over the bay');
  assert.equal(await lib.renamePhoto(photo, '   '), false);
  assert.equal(lib.get(photo.id).name, 'Sunset over the bay');
  // kept with the library
  await lib.save();
  const again = await new Library(lib.store).load();
  assert.equal(again.get(photo.id).name, 'Sunset over the bay');
});
