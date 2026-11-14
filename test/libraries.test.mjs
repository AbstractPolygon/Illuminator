import test from 'node:test';
import assert from 'node:assert/strict';

// A browser's list of libraries (localStorage) and where each lives; the desktop app's folders are tested with the main process (electron-ipc.test.mjs).
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const L = await import('../app/js/library/libraries.js');

test('a browser starts with one library, kept where it always was', async () => {
  mem.clear();
  const r = await L.listLibraries();
  assert.equal(r.current, L.DEFAULT_LIBRARY);
  assert.equal(r.list.length, 1);
  assert.equal(L.opfsLibraryPath(L.DEFAULT_LIBRARY), 'library');
  assert.equal(L.librariesAreFolders(), false);
});

test('add makes a new library the one in use, with its own place', async () => {
  mem.clear();
  const r = await L.addLibrary('  Travel  ');
  assert.equal(r.list.length, 2);
  const added = r.list.find((l) => l.name === 'Travel');
  assert.ok(added && r.current === added.id);
  assert.equal(L.activeWebLibrary(), added.id);
  assert.equal(L.opfsLibraryPath(added.id), `libraries/${added.id}`);
  assert.equal((await L.addLibrary('')).list.at(-1).name, 'Library');
});

test('switch and rename; an unknown library is refused', async () => {
  mem.clear();
  await L.addLibrary('Work');
  const back = await L.switchLibrary(L.DEFAULT_LIBRARY);
  assert.equal(back.current, L.DEFAULT_LIBRARY);
  await assert.rejects(L.switchLibrary('nope'), /not in the list/);
  const work = back.list.find((l) => l.name === 'Work');
  const renamed = await L.renameLibrary(work.id, 'Studio');
  assert.ok(renamed.list.some((l) => l.name === 'Studio'));
  await assert.rejects(L.renameLibrary(work.id, '  '), /needs a name/);
});

test('remove: not the first library, not the one in use', async () => {
  mem.clear();
  const r = await L.addLibrary('Work');
  const work = r.list.find((l) => l.name === 'Work');
  await assert.rejects(L.removeLibrary(L.DEFAULT_LIBRARY), /first library stays/);
  await assert.rejects(L.removeLibrary(work.id), /Switch to another/);
  await L.switchLibrary(L.DEFAULT_LIBRARY);
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => ({ removeEntry: async () => {} }) }) } } });
  const after = await L.removeLibrary(work.id);
  assert.equal(after.list.length, 1);
});

test('a damaged list falls back to the first library', async () => {
  mem.set('illuminator.libraries', '{not json');
  assert.equal(L.activeWebLibrary(), L.DEFAULT_LIBRARY);
  mem.set('illuminator.libraries', JSON.stringify({ current: 'gone', list: [{ id: 'x', name: 'X' }] }));
  const r = await L.listLibraries();
  assert.equal(r.current, L.DEFAULT_LIBRARY);
  assert.ok(r.list.some((l) => l.id === 'x'));
});
