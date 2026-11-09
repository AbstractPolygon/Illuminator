// A big import writes the library's index every so many photos and at the end, not once per photo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../app/js/library/library.js';
import { memoryStorage } from '../app/js/library/storage.js';

function entries(n) {
  return Array.from({ length: n }, (_, i) => ({ name: `p${i}.lfp`, file: new File([`photo ${i}`], `p${i}.lfp`) }));
}

test('importing many photos writes the index a few times, and every photo is in it', async () => {
  const store = memoryStorage();
  let writes = 0;
  const writeText = store.writeText.bind(store);
  store.writeText = (path, text) => {
    if (path === 'library.json') writes++;
    return writeText(path, text);
  };
  const lib = new Library(store);
  const out = await lib.add(entries(60));
  assert.equal(out.length, 60);
  assert.ok(writes >= 2 && writes <= 4, `${writes} index writes for 60 photos`);
  const again = await new Library(store).load();
  assert.equal(again.photos.length, 60);
});

test('the index is still written when an import fails part way', async () => {
  const store = memoryStorage();
  const lib = new Library(store, { readSummary: async (file) => { if (file.name === 'p3.lfp') throw new Error('x'); return { photoId: null, thumbnail: null }; } });
  const bad = entries(5);
  const copyIn = store.copyIn.bind(store);
  store.copyIn = async (file, path) => { if (file.name === 'p4.lfp') throw new Error('disk full'); return copyIn(file, path); };
  await assert.rejects(lib.add(bad), /disk full/);
  const again = await new Library(store).load();
  assert.ok(again.photos.length >= 4, `${again.photos.length} photos kept`);
});
