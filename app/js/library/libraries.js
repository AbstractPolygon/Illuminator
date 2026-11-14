// Several libraries. The desktop app keeps each in a folder of its own (the person adds folders; the main process keeps the list, see electron/ipc.cjs). A browser keeps them in its private
// file system, one directory each, and this page's own list (localStorage). One call set for both: a library is { id, name, detail } (the id is the folder on the desktop).
import { native } from '../platform.js';

const KEY = 'illuminator.libraries';
export const DEFAULT_LIBRARY = 'default'; // the browser's first library: the one that was there before there were several

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY));
    if (v && Array.isArray(v.list) && v.list.length) {
      const list = v.list.filter((l) => l && typeof l.id === 'string' && l.id);
      if (!list.some((l) => l.id === DEFAULT_LIBRARY)) list.unshift({ id: DEFAULT_LIBRARY, name: 'Library' });
      return { current: list.some((l) => l.id === v.current) ? v.current : DEFAULT_LIBRARY, list };
    }
  } catch {
    // (no list yet, or one that cannot be read: the first library alone)
  }
  return { current: DEFAULT_LIBRARY, list: [{ id: DEFAULT_LIBRARY, name: 'Library' }] };
}

function write(v) {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    // (the list is not kept)
  }
}

export const activeWebLibrary = () => read().current;

// Where a browser library lives in its private file system.
export const opfsLibraryPath = (id) => (id === DEFAULT_LIBRARY ? 'library' : `libraries/${id}`);

// Whether libraries are folders the person adds (the desktop app) rather than names (a browser).
export const librariesAreFolders = () => !!(native && native.libraries);

const newId = () => Math.random().toString(36).slice(2, 10);

// { current, list: [{ id, name, detail }] }
export async function listLibraries() {
  if (librariesAreFolders()) {
    const r = await native.libraries();
    return { current: r.current, list: r.list.map((l) => ({ id: l.dir, name: l.name, detail: l.dir })) };
  }
  const v = read();
  return { current: v.current, list: v.list.map((l) => ({ id: l.id, name: l.name, detail: '' })) };
}

// Adds a library and makes it the one in use: a folder the person chooses (desktop; null when they cancel) or a new one called `name`.
export async function addLibrary(name) {
  if (librariesAreFolders()) return native.addLibrary();
  const v = read();
  const clean = String(name || '').trim().slice(0, 60) || 'Library';
  const id = newId();
  v.list.push({ id, name: clean });
  v.current = id;
  write(v);
  return listLibraries();
}

export async function switchLibrary(id) {
  if (librariesAreFolders()) return native.switchLibrary(id);
  const v = read();
  if (!v.list.some((l) => l.id === id)) throw new Error('That library is not in the list');
  v.current = id;
  write(v);
  return listLibraries();
}

export async function renameLibrary(id, name) {
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) throw new Error('A library needs a name');
  if (librariesAreFolders()) return native.renameLibrary(id, clean);
  const v = read();
  const l = v.list.find((x) => x.id === id);
  if (!l) throw new Error('That library is not in the list');
  l.name = clean;
  write(v);
  return listLibraries();
}

// Takes a library out of the list. On the desktop that is all: its folder and photos stay. In a browser the library is its storage, so its photos go too (the page asks first).
export async function removeLibrary(id) {
  if (librariesAreFolders()) return native.removeLibrary(id);
  const v = read();
  if (id === DEFAULT_LIBRARY) throw new Error('The first library stays');
  if (v.current === id) throw new Error('Switch to another library first');
  if (!v.list.some((l) => l.id === id)) return listLibraries();
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('libraries');
    await dir.removeEntry(id, { recursive: true });
  } catch {
    // (nothing was kept for it yet)
  }
  v.list = v.list.filter((l) => l.id !== id);
  write(v);
  return listLibraries();
}
