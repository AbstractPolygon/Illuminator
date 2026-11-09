// Pure helpers of the Electron main process: path checks, the camera scan loop, the settings file, and a failing camera import.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isInside, resolveInside, lytroPathsFrom } = require('../electron/paths.cjs');
const { createScanner } = require('../electron/scanner.cjs');
const { readSettings, writeSettings } = require('../electron/settingsfile.cjs');
const camera = require('../electron/camera.cjs');

test('paths: a drive root and a share root contain their files', () => {
  assert.equal(isInside('C:\\', 'C:\\Photos\\a.lfp', 'win32'), true);
  assert.equal(isInside('\\\\srv\\share', '\\\\srv\\share\\Photos\\a.lfp', 'win32'), true);
  assert.equal(isInside('\\\\srv\\share\\', '\\\\srv\\other\\a.lfp', 'win32'), false);
  assert.equal(isInside('C:\\', 'D:\\a.lfp', 'win32'), false);
  assert.equal(isInside('/', '/home/a.lfp', 'posix'), true);
});

test('paths: sibling prefixes, climbing out and the root itself', () => {
  assert.equal(isInside('/lib', '/lib2/x', 'posix'), false);
  assert.equal(isInside('/lib', '/lib/../etc/passwd', 'posix'), false);
  assert.equal(isInside('/lib', '/lib/..data/x', 'posix'), true);
  assert.equal(isInside('/lib', '/lib', 'posix'), false);
  assert.equal(isInside('/lib', '/lib', 'posix', true), true);
  assert.equal(isInside('C:\\Lib', 'C:\\Lib2\\x', 'win32'), false);
});

test('paths: Windows names compare without regard to case, POSIX names do not', () => {
  assert.equal(isInside('C:\\Photos', 'c:\\photos\\A.lfp', 'win32'), true);
  assert.equal(isInside('/Photos', '/photos/a.lfp', 'posix'), false);
});

test('paths: the page cannot name a path outside the library', () => {
  assert.equal(resolveInside('/lib', 'Photos/a/b.lfp', 'posix'), '/lib/Photos/a/b.lfp');
  assert.equal(resolveInside('/lib', '', 'posix'), '/lib');
  assert.equal(resolveInside('C:\\', 'Photos/a.lfp', 'win32'), 'C:\\Photos\\a.lfp');
  for (const bad of ['../x', 'a/../../x', './a', 'a/./b']) assert.throws(() => resolveInside('/lib', bad, 'posix'), /Outside/);
  assert.throws(() => resolveInside('C:\\Lib', 'a\\..\\..\\x', 'win32'), /Outside/);
  assert.throws(() => resolveInside('C:\\Lib', 'D:/x', 'win32'), /Outside/);
});

test('open-file paths: only Lytro files, options skipped', () => {
  assert.deepEqual(lytroPathsFrom(['--flag', '/a/b.LFR', '/a/c.txt', 'x.raw'], '/cwd', 'posix'), ['/a/b.LFR', '/cwd/x.raw']);
});

test('scanner: overlapping requests run one scan at a time and leave one timer', async () => {
  let active = 0;
  let maxActive = 0;
  let scans = 0;
  const timers = new Set();
  let nextId = 0;
  const scanner = createScanner({
    scan: async () => { scans++; active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 10)); active--; },
    nextDelay: () => 1000,
    setTimer: () => { const id = ++nextId; timers.add(id); return id; },
    clearTimer: (id) => timers.delete(id),
  });
  await Promise.all([scanner.request(), scanner.request(), scanner.request()]);
  assert.equal(maxActive, 1);
  assert.equal(scans, 2); // the first, and one more for everything asked meanwhile
  assert.equal(timers.size, 1);
  await scanner.request();
  assert.equal(timers.size, 1);
});

test('settings: written atomically, a corrupt file is kept as .bad and the backup restored', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lytro-settings-'));
  const file = path.join(dir, 'settings.json');
  assert.deepEqual(await readSettings(file), { settings: null, problem: null });
  await writeSettings(file, { libraryDir: 'D:\\Photos' });
  await writeSettings(file, { libraryDir: 'D:\\Photos', memory: { ramGb: 8 } });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['settings.json', 'settings.json.bak']);
  fs.writeFileSync(file, '{ "libraryDir": "D:\\\\Pho');
  const r = await readSettings(file);
  assert.equal(r.settings.libraryDir, 'D:\\Photos');
  assert.match(r.problem, /settings\.json\.bad/);
  assert.ok(fs.existsSync(`${file}.bad`));
  fs.rmSync(`${file}.bak`);
  fs.writeFileSync(file, 'nonsense');
  assert.equal((await readSettings(file)).settings, null);
});

test('import: a failing file leaves no .part, keeps the files already written and stops', async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'lytro-src-'));
  fs.writeFileSync(path.join(src, 'ok.LFR'), 'abc');
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'lytro-dest-'));
  const cam = { kind: 'drive', files: [{ id: path.join(src, 'ok.LFR'), name: 'ok.LFR', folder: '', size: 3 }, { id: path.join(src, 'gone.LFR'), name: 'gone.LFR', folder: '', size: 3 }] };
  await assert.rejects(() => camera.importFiles(cam, cam.files.map((f) => f.id), dest), (err) => err.imported.length === 1 && /gone\.LFR/.test(err.message));
  assert.deepEqual(fs.readdirSync(dest), ['ok.LFR']);
});

test('import: a camera that sends a short file leaves nothing behind', async () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'lytro-dest-'));
  const short = { kind: 'lytro', product: 0x00b1, pictures: [{ id: 'p', folder: '100PHOTO', name: 'IMG_0001' }], files: [{ id: 'p', name: 'IMG_0001', folder: '100PHOTO', size: 0 }], camera: { download: async () => { throw new Error('The camera sent only 65546 of 200000 bytes of x'); } } };
  await assert.rejects(() => camera.importFiles(short, ['p'], dest), /only 65546 of 200000/);
  assert.deepEqual(fs.readdirSync(dest), []);
});
