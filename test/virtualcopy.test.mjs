import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryStorage } from '../app/js/library/storage.js';
import { Library } from '../app/js/library/library.js';

const file = (name, bytes = [1, 2, 3]) => new File([new Uint8Array(bytes)], name);

async function libraryWith(name = 'IMG_0001.LFR') {
  const lib = await new Library(memoryStorage(), { readSummary: async () => ({ photoId: `PID-${name}`, thumbnail: null }) }).load();
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

test('a copy follows its photo when the photo\'s files are replaced by an import', async () => {
  const { lib, photo } = await libraryWith('IMG_5.LFR');
  const copy = await lib.createVirtualCopy(photo);
  // (a replacing import of the same photo with another file name: the copy takes the names from the photo as they are now)
  photo.file = 'IMG_5.lfp';
  await lib.store.writeBlob(`Photos/${photo.id}/IMG_5.lfp`, new Blob([new Uint8Array([7, 7])]));
  assert.deepEqual([...new Uint8Array(await (await lib.file(copy)).arrayBuffer())], [7, 7]);
});

test('an album with a photo and its copy exports the files once and imports the copy with its settings', async () => {
  const { lib, photo } = await libraryWith('IMG_6.LFR');
  await lib.saveEdits(photo, { look: 'master' });
  const copy = await lib.createVirtualCopy(photo);
  await lib.saveEdits(copy, { look: 'copy' });
  const album = await lib.createAlbum('Trip');
  await lib.addToAlbum(album.id, [photo.id, copy.id]);
  const zip = await lib.exportAlbum(album.id);
  // another library: the photo comes in once, with its copy and the settings of each
  const readSummary = async () => ({ photoId: 'PID-6', thumbnail: null });
  const other = await new Library(memoryStorage(), { readSummary }).load();
  const { photos } = await other.importAlbum(zip);
  assert.equal(photos.length, 1, 'the copy is not a photo of its own in the archive');
  const imported = other.photos.filter((p) => !p.master);
  const copies = other.photos.filter((p) => p.master);
  assert.equal(imported.length, 1);
  assert.equal(copies.length, 1);
  assert.deepEqual(await other.loadEdits(imported[0]), { look: 'master' });
  assert.deepEqual(await other.loadEdits(copies[0]), { look: 'copy' });
  assert.equal(copies[0].name, copy.name);
  // importing it again does not make another copy
  await other.importAlbum(zip);
  assert.equal(other.photos.filter((p) => p.master).length, 1);
});

test('deleting a photo takes it out of the list before its folder goes, and puts it back if the folder cannot be removed', async () => {
  const { lib, photo } = await libraryWith('IMG_8.LFR');
  const real = lib.store.remove.bind(lib.store);
  let listedDuring = null;
  lib.store.remove = async (path, o) => {
    listedDuring = lib.isListed(photo);
    return real(path, o);
  };
  await lib.remove([photo.id]);
  assert.equal(listedDuring, false);
  const { lib: lib2, photo: p2 } = await libraryWith('IMG_9.LFR');
  lib2.store.remove = async () => { throw new Error('could not be moved to the trash'); };
  await assert.rejects(lib2.remove([p2.id]));
  assert.ok(lib2.get(p2.id), 'still listed: the folder is still there');
});
