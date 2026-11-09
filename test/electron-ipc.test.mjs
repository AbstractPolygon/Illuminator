// The page's calls into the Electron main process (electron/ipc.cjs): path containment, session-limited access, dialogs
// and the camera import, with fakes for Electron and a temporary folder as the library.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createIpc } = require('../electron/ipc.cjs');
const camera = require('../electron/camera.cjs');

async function setup(extra = {}) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'ipc-'));
  const lib = path.join(base, 'lib');
  await fsp.mkdir(path.join(base, 'lib2'));
  await fsp.mkdir(lib);
  await fsp.writeFile(path.join(base, 'secret.txt'), 'secret');
  await fsp.writeFile(path.join(base, 'lib2', 'x.lfp'), 'sibling');
  const settings = { libraryDir: lib };
  const calls = { open: [], trash: [], saved: 0, dialogs: [], polled: 0, soon: 0 };
  const state = { dialogResult: { canceled: true, filePaths: [] }, saveResult: { canceled: true }, trashError: null, openPathError: '', cameras: [] };
  const deps = {
    fs, fsp, path, os,
    dialog: {
      showOpenDialog: async (...a) => { calls.dialogs.push(a); return state.dialogResult; },
      showSaveDialog: async (...a) => { calls.dialogs.push(a); return state.saveResult; },
    },
    shell: {
      openPath: async (p) => { calls.open.push(p); return state.openPathError; },
      trashItem: async (p) => { calls.trash.push(p); if (state.trashError) throw state.trashError; },
    },
    app: { getPath: (n) => path.join(base, n) },
    camera,
    getSettings: () => settings,
    saveSettings: async () => { calls.saved++; },
    getCameras: () => state.cameras,
    summary: () => ['summary'],
    pollCameras: async () => { calls.polled++; },
    scanSoon: () => { calls.soon++; },
    withWin: (o) => [o],
    videoMemory: async () => ({ vramBytes: 1, vramSource: 'test' }),
    lfpModule: async () => ({ readThumbnail: async () => null }),
    memoryReserve: { ram: 10, vram: 5 },
    ...extra,
  };
  const ipc = createIpc(deps);
  return { base, lib, settings, calls, state, ipc, h: ipc.handlers, cleanup: () => fsp.rm(base, { recursive: true, force: true }) };
}

const text = (u8) => Buffer.from(u8).toString();

test('every channel the preload invokes has a handler', async () => {
  const t = await setup();
  const pre = fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  const channels = [...pre.matchAll(/ipcRenderer\.(?:invoke|send)\('([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(channels.length >= 24);
  for (const c of channels) assert.equal(typeof t.h[c], 'function', c);
  await t.cleanup();
});

test('library paths: inside works, escapes are refused by every library call', async () => {
  const t = await setup();
  await t.h['lib-write']('Photos/a/b.txt', 'hello');
  assert.equal(await t.h['lib-read-text']('Photos/a/b.txt'), 'hello');
  assert.deepEqual(await t.h['lib-stat']('Photos/a/b.txt'), { path: path.join(t.lib, 'Photos', 'a', 'b.txt'), name: 'b.txt', size: 5 });
  // An absolute path becomes a library-relative one (its leading slash is dropped), never the real file.
  for (const rel of ['../secret.txt', 'a/../../secret.txt', '../lib2/x.lfp', './x']) {
    for (const name of ['lib-list', 'lib-read-text', 'lib-stat', 'lib-open', 'lib-remove']) await assert.rejects(t.h[name](rel), /Outside the library/, `${name} ${rel}`);
    await assert.rejects(t.h['lib-write'](rel, 'x'), /Outside the library/);
    await assert.rejects(t.h['lib-move'](rel, 'ok'), /Outside the library/);
    await assert.rejects(t.h['lib-move']('Photos/a/b.txt', rel), /Outside the library/);
  }
  assert.equal(await t.h['lib-stat'](path.join(t.base, 'secret.txt')), null);
  assert.equal(await t.h['lib-read-text']('/etc/passwd'), null);
  assert.equal(fs.readFileSync(path.join(t.base, 'secret.txt'), 'utf8'), 'secret');
  assert.equal(t.calls.open.length, 0);
  assert.equal(t.calls.trash.length, 0);
  await t.cleanup();
});

test('library paths: a sibling that shares the prefix (lib2) is not inside', async () => {
  const t = await setup();
  await assert.rejects(t.h['lib-read-text']('../lib2/x.lfp'), /Outside/);
  await assert.rejects(t.h['read-file'](path.join(t.base, 'lib2', 'x.lfp')), /not opened in Illuminator/);
  await assert.rejects(t.h['read-file'](`${t.lib}2/x.lfp`), /not opened in Illuminator/);
  await t.cleanup();
});

test('read-file and read-range: library files and chosen files only', async () => {
  const t = await setup();
  await t.h['lib-write']('p.bin', 'abcdefghij');
  assert.equal(text(await t.h['read-file'](path.join(t.lib, 'p.bin'))), 'abcdefghij');
  await assert.rejects(t.h['read-file'](path.join(t.base, 'secret.txt')), /This file was not opened in Illuminator\./);
  await assert.rejects(t.h['read-file'](path.join(t.lib, '..', 'secret.txt')), /not opened/);
  await assert.rejects(t.h['read-range'](path.join(t.base, 'secret.txt'), 0, 3), /not opened/);
  // A file the person chose in a dialog becomes readable.
  t.state.dialogResult = { canceled: false, filePaths: [path.join(t.base, 'secret.txt')] };
  const [opened] = await t.h['open-files']();
  assert.equal(opened.name, 'secret.txt');
  assert.equal(opened.size, 6);
  assert.equal(text(await t.h['read-file'](path.join(t.base, 'secret.txt'))), 'secret');
  await t.cleanup();
});

test('read-range clamps the length and an offset past the end gives nothing', async () => {
  const t = await setup();
  await t.h['lib-write']('p.bin', 'abcdefghij');
  const f = path.join(t.lib, 'p.bin');
  assert.equal(text(await t.h['read-range'](f, 2, 3)), 'cde');
  assert.equal(text(await t.h['read-range'](f, 8, 100)), 'ij');
  assert.equal((await t.h['read-range'](f, 10, 5)).length, 0);
  assert.equal((await t.h['read-range'](f, 500, 5)).length, 0);
  assert.equal(text(await t.h['read-range'](f, 1.9, 2.9)), 'bc');
  for (const [o, l] of [[0, NaN], [NaN, 2], [0, Infinity], [-Infinity, 1], [0, -4], [-1, 2], ['1', 2], [0, '2'], [null, 2], [0, undefined], [{}, 1]]) {
    await assert.rejects(t.h['read-range'](f, o, l), /^Error: Invalid read range\.$/, `${String(o)} ${String(l)}`);
  }
  await t.cleanup();
});

test('allow list: relative and unnormalized names match the resolved path only', async () => {
  const t = await setup();
  t.ipc.allow(path.join(t.base, 'secret.txt'));
  assert.equal(await t.ipc.checkAllowed(path.join(t.base, 'lib', '..', 'secret.txt')), path.join(t.base, 'secret.txt'));
  await assert.rejects(t.ipc.checkAllowed(path.join(t.base, 'secret.txt2')), /not opened/);
  await t.cleanup();
});

// Symlinks need a privilege on Windows; without it these cannot run.
async function linkable(t, target, link) {
  try {
    await fsp.symlink(target, link);
    return true;
  } catch (err) {
    if (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'EACCES')) return false;
    throw err;
  }
}

test('symlinks: a link inside the library to something outside is refused', async (ctx) => {
  const t = await setup();
  if (!(await linkable(t, path.join(t.base, 'secret.txt'), path.join(t.lib, 'filelink')))) { ctx.skip('symlinks need a privilege on this Windows account'); return; }
  await linkable(t, t.base, path.join(t.lib, 'dirlink'));
  // a link to a file outside: read and write refused
  await assert.rejects(t.h['lib-read-text']('filelink'), /Outside the library/);
  await assert.rejects(t.h['lib-stat']('filelink'), /Outside the library/);
  await assert.rejects(t.h['lib-write']('filelink', 'overwritten'), /Outside the library/);
  await assert.rejects(t.h['read-file'](path.join(t.lib, 'filelink')), /not opened in Illuminator/);
  await assert.rejects(t.h['read-range'](path.join(t.lib, 'filelink'), 0, 2), /not opened/);
  // a link to an outside folder: listing, reading and writing through it, also to a name that does not exist yet
  await assert.rejects(t.h['lib-list']('dirlink'), /Outside the library/);
  await assert.rejects(t.h['lib-read-text']('dirlink/secret.txt'), /Outside the library/);
  await assert.rejects(t.h['lib-write']('dirlink/new.txt', 'x'), /Outside the library/);
  await assert.rejects(t.h['lib-write']('dirlink/newdir/new.txt', 'x'), /Outside the library/);
  await assert.rejects(t.h['lib-move']('dirlink/secret.txt', 'moved.txt'), /Outside the library/);
  await assert.rejects(t.h['lib-copy-in'](path.join(t.lib, 'dirlink', 'secret.txt'), 'c.txt'), /not opened/);
  t.ipc.allow(path.join(t.base, 'secret.txt'));
  await assert.rejects(t.h['lib-copy-in'](path.join(t.base, 'secret.txt'), 'dirlink/c.txt'), /Outside the library/);
  await assert.rejects(t.h['find-sidecar'](path.join(t.lib, 'dirlink', 'secret.txt')), /not opened/);
  assert.equal(fs.readFileSync(path.join(t.base, 'secret.txt'), 'utf8'), 'secret');
  assert.ok(!fs.existsSync(path.join(t.base, 'new.txt')));
  assert.ok(!fs.existsSync(path.join(t.base, 'newdir')));
  assert.ok(!fs.existsSync(path.join(t.base, 'c.txt')));
  // the links themselves can be removed or renamed without touching their targets
  await t.h['lib-move']('filelink', 'renamed');
  await t.h['lib-remove']('dirlink', { permanent: true });
  assert.ok(!fs.existsSync(path.join(t.lib, 'dirlink')));
  assert.ok(fs.existsSync(path.join(t.base, 'secret.txt')));
  await t.cleanup();
});

test('symlinks: a dangling link is outside', async (ctx) => {
  const t = await setup();
  if (!(await linkable(t, path.join(t.base, 'nowhere'), path.join(t.lib, 'dangling')))) { ctx.skip('symlinks need a privilege on this Windows account'); return; }
  await assert.rejects(t.h['lib-write']('dangling', 'x'), /Outside the library/);
  assert.ok(!fs.existsSync(path.join(t.base, 'nowhere')));
  await t.cleanup();
});

test('symlinks: a link to another place inside the library still works', async (ctx) => {
  const t = await setup();
  await t.h['lib-write']('Photos/a.txt', 'abc');
  if (!(await linkable(t, path.join(t.lib, 'Photos'), path.join(t.lib, 'alias')))) { ctx.skip('symlinks need a privilege on this Windows account'); return; }
  assert.equal(await t.h['lib-read-text']('alias/a.txt'), 'abc');
  assert.deepEqual((await t.h['lib-list']('alias')).map((e) => e.name), ['a.txt']);
  await t.h['lib-write']('alias/b.txt', 'new');
  assert.equal(fs.readFileSync(path.join(t.lib, 'Photos', 'b.txt'), 'utf8'), 'new');
  assert.equal(text(await t.h['read-file'](path.join(t.lib, 'alias', 'a.txt'))), 'abc');
  await t.cleanup();
});

test('symlinks: the library root itself may be a link', async (ctx) => {
  const t = await setup();
  const rootLink = path.join(t.base, 'rootlink');
  if (!(await linkable(t, t.lib, rootLink))) { ctx.skip('symlinks need a privilege on this Windows account'); return; }
  t.settings.libraryDir = rootLink;
  await t.h['lib-write']('Photos/a.txt', 'abc');
  assert.equal(fs.readFileSync(path.join(t.lib, 'Photos', 'a.txt'), 'utf8'), 'abc');
  assert.equal(await t.h['lib-read-text']('Photos/a.txt'), 'abc');
  assert.equal(text(await t.h['read-file'](path.join(rootLink, 'Photos', 'a.txt'))), 'abc');
  assert.deepEqual((await t.h['lib-list']('')).map((e) => e.name), ['Photos']);
  await assert.rejects(t.h['lib-read-text']('../secret.txt'), /Outside/);
  await assert.rejects(t.h['lib-remove'](''), /Will not remove the library itself/);
  // and a library that does not exist yet (first run) is fine too
  t.settings.libraryDir = path.join(rootLink, 'new', 'deeper');
  await t.h['lib-write']('x.txt', 'y');
  assert.equal(fs.readFileSync(path.join(t.lib, 'new', 'deeper', 'x.txt'), 'utf8'), 'y');
  await t.cleanup();
});

test('symlinks: write-output refuses a link that leads out of the chosen folder', async (ctx) => {
  const t = await setup();
  const out = path.join(t.base, 'out');
  await fsp.mkdir(out);
  if (!(await linkable(t, t.lib, path.join(out, 'escape')))) { ctx.skip('symlinks need a privilege on this Windows account'); return; }
  await linkable(t, path.join(t.base, 'target.png'), path.join(out, 'a.png'));
  t.state.dialogResult = { canceled: false, filePaths: [out] };
  await t.h['choose-output-folder']();
  // a.png is a dangling link: writing would create target.png outside
  await assert.rejects(t.h['write-output'](out, 'a.png', new Uint8Array(1)), /That folder was not chosen in this session\./);
  assert.ok(!fs.existsSync(path.join(t.base, 'target.png')));
  // a chosen folder that is itself a link works
  const folderLink = path.join(t.base, 'outlink');
  await linkable(t, out, folderLink);
  t.state.dialogResult = { canceled: false, filePaths: [folderLink] };
  await t.h['choose-output-folder']();
  assert.equal(await t.h['write-output'](folderLink, 'b.png', new Uint8Array([9])), path.join(folderLink, 'b.png'));
  assert.deepEqual([...fs.readFileSync(path.join(out, 'b.png'))], [9]);
  await t.cleanup();
});

test('a library root that is a drive or share root (win32 rules)', async () => {
  for (const root of ['C:\\', '\\\\srv\\share\\']) {
    // The real file system would be asked about a made-up share (a Windows runner answers a UNC name with an unknown error, not ENOENT): nothing of these paths exists.
    const gone = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const nothing = { ...fsp, realpath: async () => { throw gone(); }, lstat: async () => { throw gone(); }, stat: async () => { throw gone(); } };
    const t = await setup({ path: path.win32, platform: 'win32', fs: { existsSync: () => false }, fsp: nothing });
    t.settings.libraryDir = root;
    // Resolved before any disk access, so the escapes can be checked on any system.
    for (const rel of ['..\\x', 'a/../../x', 'D:/x', '.']) await assert.rejects(t.h['lib-stat'](rel), /Outside the library/, rel);
    assert.equal(await t.ipc.checkAllowed(`${root}Photos\\a.lfp`), path.win32.resolve(`${root}Photos\\a.lfp`));
    await assert.rejects(t.ipc.checkAllowed('D:\\Photos\\a.lfp'), /not opened/);
    // '..' at a root cannot leave it: the name resolves to a file of the root itself.
    assert.equal(await t.ipc.checkAllowed(`${root}..\\x`), path.win32.resolve(`${root}x`));
    await assert.rejects(t.h['lib-remove'](''), /Will not remove the library itself/);
    await t.cleanup();
  }
});

test('lib-list skips unreadable entries and dot files, an absent folder is empty', async () => {
  const t = await setup();
  await t.h['lib-write']('Photos/a.txt', 'abc');
  await fsp.mkdir(path.join(t.lib, 'Photos', 'sub'));
  await fsp.writeFile(path.join(t.lib, 'Photos', '.hidden'), 'x');
  await fsp.symlink(path.join(t.base, 'nowhere'), path.join(t.lib, 'Photos', 'dangling'));
  const list = await t.h['lib-list']('Photos');
  assert.deepEqual(list.map((e) => e.name).sort(), ['a.txt', 'sub']);
  assert.deepEqual(list.find((e) => e.name === 'sub'), { name: 'sub', dir: true, size: 0 });
  assert.equal(list.find((e) => e.name === 'a.txt').size, 3);
  assert.deepEqual(await t.h['lib-list']('Missing'), []);
  assert.deepEqual(await t.h['lib-list']('Photos/a.txt'), []); // ENOTDIR
  await t.cleanup();
});

test('lib-write leaves no temporary file; lib-copy-in needs an allowed source', async () => {
  const t = await setup();
  await t.h['lib-write']('d/x.bin', new Uint8Array([1, 2, 3]));
  assert.deepEqual([...fs.readFileSync(path.join(t.lib, 'd', 'x.bin'))], [1, 2, 3]);
  assert.deepEqual(fs.readdirSync(path.join(t.lib, 'd')), ['x.bin']);
  await assert.rejects(t.h['lib-copy-in'](path.join(t.base, 'secret.txt'), 'in/secret.txt'), /not opened/);
  t.ipc.allow(path.join(t.base, 'secret.txt'));
  await t.h['lib-copy-in'](path.join(t.base, 'secret.txt'), 'in/secret.txt');
  assert.equal(fs.readFileSync(path.join(t.lib, 'in', 'secret.txt'), 'utf8'), 'secret');
  assert.deepEqual(fs.readdirSync(path.join(t.lib, 'in')), ['secret.txt']);
  await assert.rejects(t.h['lib-copy-in'](path.join(t.base, 'secret.txt'), '../out.txt'), /Outside/);
  // A failing write cleans up its temporary file.
  await fsp.mkdir(path.join(t.lib, 'dir'));
  await assert.rejects(t.h['lib-write']('dir', 'x'));
  assert.deepEqual(fs.readdirSync(t.lib).filter((n) => n.endsWith('.part')), []);
  await t.cleanup();
});

test('lib-move and lib-open', async () => {
  const t = await setup();
  await t.h['lib-write']('a/x.txt', '1');
  await t.h['lib-move']('a/x.txt', 'b/y.txt');
  assert.equal(await t.h['lib-read-text']('b/y.txt'), '1');
  assert.equal(await t.h['lib-read-text']('a/x.txt'), null);
  await t.h['lib-open']('b');
  assert.deepEqual(t.calls.open, [path.join(t.lib, 'b')]);
  t.state.openPathError = 'no file manager';
  await assert.rejects(t.h['lib-open']('b'), /no file manager/);
  await t.cleanup();
});

test('lib-remove: trash first, a clear message when the trash fails, permanent only when asked', async () => {
  const t = await setup();
  await t.h['lib-write']('Photos/a/x.txt', '1');
  const dir = path.join(t.lib, 'Photos', 'a');
  await t.h['lib-remove']('Photos/a');
  assert.deepEqual(t.calls.trash, [dir]);
  assert.ok(fs.existsSync(dir)); // the fake trash moved nothing

  t.state.trashError = new Error('no trash here');
  await assert.rejects(t.h['lib-remove']('Photos/a'), (e) => e.message === 'a could not be moved to the trash (no trash here), so it was not deleted. Delete it permanently instead?');
  await assert.rejects(t.h['lib-remove']('Photos/a', { permanent: 'yes' }), /could not be moved to the trash/);
  assert.ok(fs.existsSync(dir));
  await t.h['lib-remove']('Photos/a', { permanent: true });
  assert.ok(!fs.existsSync(dir));

  // Already gone: not an error.
  await t.h['lib-remove']('Photos/a');
  // Scratch folders skip the trash.
  await t.h['lib-write']('Staging/s/x', '1');
  await t.h['lib-write']('.incoming/y', '1');
  const before = t.calls.trash.length;
  await t.h['lib-remove']('Staging/s');
  await t.h['lib-remove']('.incoming');
  assert.equal(t.calls.trash.length, before);
  assert.ok(!fs.existsSync(path.join(t.lib, 'Staging', 's')));
  assert.ok(!fs.existsSync(path.join(t.lib, '.incoming')));
  await assert.rejects(t.h['lib-remove'](''), /Will not remove the library itself/);
  await assert.rejects(t.h['lib-remove']('/'), /Will not remove the library itself/);
  await assert.rejects(t.h['lib-remove']('../lib2'), /Outside/);
  assert.ok(fs.existsSync(t.lib));
  await t.cleanup();
});

test('library-dir falls back to the legacy folder only when it exists; choose-library-dir saves', async () => {
  const t = await setup();
  t.settings.libraryDir = null;
  assert.equal(await t.h['library-dir'](), path.join(t.base, 'pictures', 'Illuminator'));
  await fsp.mkdir(path.join(t.base, 'pictures', 'ILLUMinator'), { recursive: true });
  assert.equal(await t.h['library-dir'](), path.join(t.base, 'pictures', 'ILLUMinator'));
  assert.equal(await t.h['choose-library-dir'](), null); // cancelled
  assert.equal(t.calls.saved, 0);
  t.state.dialogResult = { canceled: false, filePaths: [t.lib] };
  assert.equal(await t.h['choose-library-dir'](), t.lib);
  assert.equal(t.settings.libraryDir, t.lib);
  assert.equal(t.calls.saved, 1);
  await t.cleanup();
});

test('dialogs: cancel gives null, [] or nothing and allows nothing', async () => {
  const t = await setup();
  assert.deepEqual(await t.h['open-files'](), []);
  assert.equal(await t.h['pick-folder'](), null);
  assert.equal(await t.h['choose-output-folder'](), null);
  assert.equal(await t.h['save-file']('a.png', new Uint8Array(1)), null);
  t.state.dialogResult = { canceled: false, filePaths: [] }; // no choice made
  assert.equal(await t.h['pick-folder'](), null);
  assert.equal(await t.h['choose-output-folder'](), null);
  t.state.saveResult = { canceled: false, filePath: '' };
  assert.equal(await t.h['save-file']('a.png', new Uint8Array(1)), null);
  await t.cleanup();
});

test('open-files asks for calibration backups or photos', async () => {
  const t = await setup();
  await t.h['open-files']({ kind: 'calibration' });
  await t.h['open-files']({ kind: 'other' });
  const [cal, photos] = t.calls.dialogs.map((a) => a[0]);
  assert.deepEqual(cal.properties, ['openFile']);
  assert.deepEqual(cal.filters[0].extensions, ['tar', 'TAR']);
  assert.deepEqual(photos.properties, ['openFile', 'multiSelections']);
  await t.cleanup();
});

test('save-file writes where the person chose', async () => {
  const t = await setup();
  const out = path.join(t.base, 'saved.bin');
  t.state.saveResult = { canceled: false, filePath: out };
  assert.equal(await t.h['save-file']('pic.png', new Uint8Array([7, 8])), out);
  assert.deepEqual([...fs.readFileSync(out)], [7, 8]);
  assert.equal(t.calls.dialogs[0][0].defaultPath, path.join(t.base, 'pictures', 'pic.png'));
  await t.cleanup();
});

test('write-output: only a folder chosen in this session, only the file name, no overwriting', async () => {
  const t = await setup();
  const out = path.join(t.base, 'out');
  await fsp.mkdir(out);
  await assert.rejects(t.h['write-output'](out, 'a.png', new Uint8Array(1)), /That folder was not chosen in this session\./);
  t.state.dialogResult = { canceled: false, filePaths: [out] };
  assert.equal(await t.h['choose-output-folder'](), out);
  assert.equal(await t.h['write-output'](out, 'a.png', new Uint8Array([1])), path.join(out, 'a.png'));
  assert.equal(await t.h['write-output'](out, 'a.png', new Uint8Array([2])), path.join(out, 'a (2).png'));
  assert.equal(await t.h['write-output'](out, 'a.png', new Uint8Array([3])), path.join(out, 'a (3).png'));
  assert.equal(await t.h['write-output'](out, '../../evil.png', new Uint8Array([4])), path.join(out, 'evil.png'));
  assert.equal(await t.h['write-output'](out, '', new Uint8Array([5])), path.join(out, 'picture'));
  assert.equal(await t.h['write-output'](out, '.hidden', new Uint8Array([6])), path.join(out, '.hidden'));
  assert.deepEqual([...fs.readFileSync(path.join(out, 'a.png'))], [1]);
  // Another folder, even a sibling-prefix or parent of the chosen one, is refused.
  await assert.rejects(t.h['write-output'](t.base, 'x.png', new Uint8Array(1)), /not chosen/);
  await assert.rejects(t.h['write-output'](`${out}2`, 'x.png', new Uint8Array(1)), /not chosen/);
  await assert.rejects(t.h['write-output'](path.join(out, 'sub'), 'x.png', new Uint8Array(1)), /not chosen/);
  assert.ok(!fs.existsSync(path.join(t.base, 'evil.png')));
  await t.cleanup();
});

test('pick-folder lists photos in subfolders and allows them to be read', async () => {
  const t = await setup();
  const root = path.join(t.base, 'cam');
  await fsp.mkdir(path.join(root, 'DCIM', '100'), { recursive: true });
  await fsp.mkdir(path.join(root, '.trash'));
  await fsp.writeFile(path.join(root, 'DCIM', '100', 'IMG_1.LFR'), 'raw');
  await fsp.writeFile(path.join(root, 'DCIM', 'notes.txt'), 'n');
  await fsp.writeFile(path.join(root, '.trash', 'x.lfr'), 'n');
  t.state.dialogResult = { canceled: false, filePaths: [root] };
  const res = await t.h['pick-folder']('Pick');
  assert.equal(res.name, 'cam');
  assert.deepEqual(res.files.map((f) => f.rel), ['DCIM/100/IMG_1.LFR']);
  assert.equal(text(await t.h['read-file'](path.join(root, 'DCIM', '100', 'IMG_1.LFR'))), 'raw');
  assert.equal(t.calls.dialogs[0][0].title, 'Pick');
  await assert.rejects(t.h['read-file'](path.join(root, 'DCIM', 'notes.txt')), /not opened/);
  await t.cleanup();
});

test('find-sidecar: only next to an allowed file, and allows what it finds', async () => {
  const t = await setup();
  await assert.rejects(t.h['find-sidecar'](path.join(t.base, 'secret.txt')), /not opened/);
  await t.h['lib-write']('P/IMG_0001.lfr', 'r');
  await t.h['lib-write']('P/img_0001.lfp', 'edits');
  const found = await t.h['find-sidecar'](path.join(t.lib, 'P', 'IMG_0001.lfr'));
  assert.equal(found.name, 'img_0001.lfp');
  await t.h['lib-write']('Q/stack.view.lfp', 'v');
  await t.h['lib-write']('Q/raw.lfp', 'r');
  assert.equal((await t.h['find-sidecar'](path.join(t.lib, 'Q', 'raw.lfp'))).name, 'stack.view.lfp');
  assert.equal(await t.h['find-sidecar'](path.join(t.lib, 'Q', 'stack.view.lfp')), null);
  await t.cleanup();
});

test('set-memory-limits validates numbers and rounds to half gigabytes', async () => {
  const t = await setup();
  assert.deepEqual(await t.h['set-memory-limits']({ ramGb: 8.3, vramGb: 2 }), { ramGb: 8.5, vramGb: 2 });
  assert.equal(t.calls.saved, 1);
  for (const bad of [NaN, Infinity, -1, 0, '4', null, undefined, {}]) {
    assert.deepEqual(await t.h['set-memory-limits']({ ramGb: bad, vramGb: bad }), { ramGb: null, vramGb: null }, String(bad));
  }
  assert.deepEqual(await t.h['set-memory-limits'](undefined), { ramGb: null, vramGb: null });
  assert.deepEqual(await t.h['set-memory-limits']({ ramGb: 4 }), { ramGb: 4, vramGb: null });
  const m = await t.h['system-memory']();
  assert.equal(m.ramReserveBytes, 10);
  assert.equal(m.vramBytes, 1);
  assert.deepEqual(m.limits, { ramGb: 4, vramGb: null });
  await t.cleanup();
});

test('camera calls: an unknown camera, scan wake-up and the list', async () => {
  const t = await setup();
  await assert.rejects(t.h['import-from-camera']('nope', []), /That camera is no longer connected\./);
  await assert.rejects(t.h['camera-thumbnail']('nope', 'f'), /no longer connected/);
  t.h['camera-usb-connected']();
  assert.equal(t.calls.soon, 1);
  assert.deepEqual(await t.h['list-cameras'](), ['summary']);
  assert.equal(t.calls.polled, 1);
  t.state.cameras = [{ id: 'adb1', kind: 'adb', files: [] }];
  assert.equal(await t.h['camera-thumbnail']('adb1', 'f'), null);
  await t.cleanup();
});

test('import-from-camera copies only the ids the camera listed, into the staging folder', async () => {
  const t = await setup();
  const drive = path.join(t.base, 'drive');
  await fsp.mkdir(drive);
  const a = path.join(drive, 'IMG_1.LFR');
  await fsp.writeFile(a, 'AAAA');
  t.state.cameras = [{ id: 'd1', kind: 'drive', files: [{ id: a, name: 'IMG_1.LFR', size: 4, folder: '100' }] }];
  const progress = [];
  const res = await t.h['import-from-camera']('d1', [a, path.join(t.base, 'secret.txt'), '../../etc/passwd'], (p) => progress.push(p));
  assert.equal(res.length, 1);
  assert.equal(res[0].path, path.join(t.lib, '.incoming', '100_IMG_1.LFR'));
  assert.equal(fs.readFileSync(res[0].path, 'utf8'), 'AAAA');
  assert.deepEqual(fs.readdirSync(path.join(t.lib, '.incoming')), ['100_IMG_1.LFR']);
  assert.ok(progress.length >= 1);
  await t.cleanup();
});

test('import-from-camera: a partial failure keeps what was copied and says so', async () => {
  const t = await setup();
  const done = path.join(t.lib, '.incoming', 'one.lfr');
  await fsp.mkdir(path.dirname(done), { recursive: true });
  await fsp.writeFile(done, 'x');
  const fake = { ...camera, importFiles: async () => { const e = new Error('Cable pulled'); e.imported = [done]; throw e; } };
  const t2 = await setup({ camera: fake });
  t2.state.cameras = [{ id: 'c', kind: 'adb', files: [] }];
  const done2 = path.join(t2.lib, '.incoming', 'one.lfr');
  // The photos copied before the failure come back as a result (an error would reach the page as its message alone), described like a finished import.
  await fsp.mkdir(path.dirname(done2), { recursive: true });
  await fsp.writeFile(done2, 'x');
  await fsp.writeFile(`${done2}2`, 'yy');
  fake.importFiles = async () => { const e = new Error('Cable pulled'); e.imported = [done2]; e.failedFile = 'IMG_2.LFR'; throw e; };
  const one = await t2.h['import-from-camera']('c', ['x']);
  assert.deepEqual(one, { partial: true, files: [{ path: done2, name: 'one.lfr', size: 1 }], failedFile: 'IMG_2.LFR', message: 'Cable pulled' });
  assert.equal(await t2.ipc.checkAllowed(done2), done2);
  fake.importFiles = async () => { const e = new Error('Boom'); e.imported = [done2, `${done2}2`]; throw e; };
  const two = await t2.h['import-from-camera']('c', ['x']);
  assert.equal(two.partial, true);
  assert.deepEqual(two.files.map((f) => f.size), [1, 2]);
  // Listed files that vanished are left out; with none left it is an error again.
  fake.importFiles = async () => { const e = new Error('Gone'); e.imported = [path.join(t2.lib, '.incoming', 'missing.lfr')]; throw e; };
  await assert.rejects(t2.h['import-from-camera']('c', ['x']), (e) => e.message === 'Gone');
  fake.importFiles = async () => { throw new Error('Plain'); };
  await assert.rejects(t2.h['import-from-camera']('c', ['x']), (e) => e.message === 'Plain');
  await t.cleanup();
  await t2.cleanup();
});
