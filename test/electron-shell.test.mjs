// The Electron shell around the page: the app:// protocol handler, window hardening, the open-file queue and the CLI's
// exit code handling (electron/protocol.cjs, hardening.cjs, openpaths.cjs, cli.cjs), all without a window.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAppProtocolHandler } = require('../electron/protocol.cjs');
const { headerPolicy } = require('../electron/csp.cjs');
const { isAllowedNavigation, classifyWindowOpen, isAllowedPermission, installPermissions } = require('../electron/hardening.cjs');
const { createOpenQueue } = require('../electron/openpaths.cjs');
const { lytroPathsFrom } = require('../electron/paths.cjs');
const { runCli } = require('../electron/cli.cjs');

async function appFixture() {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'proto-'));
  const appDir = path.join(base, 'app');
  await fsp.mkdir(path.join(appDir, 'js'), { recursive: true });
  await fsp.mkdir(path.join(base, 'app2'));
  await fsp.writeFile(path.join(base, 'secret.txt'), 'secret');
  await fsp.writeFile(path.join(base, 'app2', 'x.js'), 'sibling');
  const files = ['index.html', 'js/a.js', 'js/w.mjs', 'js/m.wasm', 'style.css', 'icon.svg', 'p.png', 'd.json', 'model.onnx', 'data.bin', 'UP.JS'];
  for (const f of files) await fsp.writeFile(path.join(appDir, f), f);
  const fetched = [];
  const fetchFile = async (file) => {
    fetched.push(file);
    try {
      const body = await fsp.readFile(file);
      return { status: 200, statusText: 'OK', headers: new Headers({ 'Content-Type': 'application/x-guess' }), body };
    } catch {
      return { status: 404, statusText: 'Not Found', headers: new Headers(), body: null };
    }
  };
  return { base, appDir, fetched, handle: createAppProtocolHandler({ appDir, fetchFile }), cleanup: () => fsp.rm(base, { recursive: true, force: true }) };
}

test('app://: serves files under the app folder with the CSP header', async () => {
  const f = await appFixture();
  const r = await f.handle('app://lytro/index.html');
  assert.equal(r.status, 200);
  assert.equal(Buffer.from(r.body).toString(), 'index.html');
  assert.equal(r.headers.get('content-security-policy'), headerPolicy);
  assert.match(headerPolicy, /frame-ancestors 'self'/);
  assert.equal((await f.handle('app://lytro/js/a.js?v=3#x')).status, 200);
  await f.cleanup();
});

test('app://: content types', async () => {
  const f = await appFixture();
  const want = {
    'index.html': /^text\/html/, 'js/a.js': /^text\/javascript/, 'js/w.mjs': /^text\/javascript/, 'js/m.wasm': /^application\/wasm$/,
    'style.css': /^text\/css/, 'icon.svg': /^image\/svg\+xml$/, 'p.png': /^image\/png$/, 'd.json': /^application\/json/, 'model.onnx': /^application\/octet-stream$/,
    'UP.JS': /^text\/javascript/, 'data.bin': /^application\/x-guess$/, // unknown: what the file fetch said
  };
  for (const [name, re] of Object.entries(want)) assert.match((await f.handle(`app://lytro/${name}`)).headers.get('content-type'), re, name);
  await f.cleanup();
});

test('app://: nothing outside the app folder, whatever the spelling', async () => {
  const f = await appFixture();
  const bad = [
    'app://lytro/../secret.txt', 'app://lytro/%2e%2e/secret.txt', 'app://lytro/..%2fsecret.txt', 'app://lytro/..%2Fsecret.txt', 'app://lytro/js/..%2f..%2fsecret.txt',
    'app://lytro/%2e%2e%2f%2e%2e%2fetc/passwd', 'app://lytro/../app2/x.js', 'app://lytro/..%2fapp2%2fx.js', 'app://lytro/js/%2e%2e/%2e%2e/secret.txt',
    'app://lytro/', 'app://lytro', 'app://lytro/js/..', 'app://lytro/%00', 'app://lytro/index.html%00.png', 'app://lytro/%', 'app://lytro/%E0%A4%A',
  ];
  for (const u of bad) {
    const r = await f.handle(u);
    assert.equal(r.status, 404, u);
  }
  assert.ok(f.fetched.every((p) => p.startsWith(f.appDir + path.sep)), 'nothing outside was ever fetched');
  // (the URL parser itself folds a plain '../' away, so those land on a missing file below the folder)
  // Backslashes and drive letters are plain characters on this system and stay below the folder (Windows normalizes
  // backslashes first, so they are caught by the same containment test).
  for (const u of ['app://lytro/..%5csecret.txt', 'app://lytro/C:/Windows/win.ini', 'app://lytro/%5c%5csrv%5cshare']) {
    const r = await f.handle(u);
    assert.equal(r.status, 404, u);
  }
  assert.ok(f.fetched.every((p) => p.startsWith(f.appDir + path.sep)));
  await f.cleanup();
});

test('app://: Windows rules, injected path module', async () => {
  const seen = [];
  const handle = createAppProtocolHandler({ appDir: 'C:\\Program Files\\Illuminator\\app', path: path.win32, fetchFile: async (file) => { seen.push(file); return { status: 200, headers: new Headers(), body: '' }; } });
  assert.equal((await handle('app://lytro/js/a.js')).status, 200);
  assert.equal(seen[0], 'C:\\Program Files\\Illuminator\\app\\js\\a.js');
  for (const u of ['app://lytro/..%5csecret.txt', 'app://lytro/js/..%5c..%5cx', 'app://lytro/..%2f..%2fx', 'app://lytro/..%5C..%5CWindows']) assert.equal((await handle(u)).status, 404, u);
  // a drive letter in the path stays below the root
  assert.equal((await handle('app://lytro/D:/x')).status, 200);
  assert.equal(seen[1], 'C:\\Program Files\\Illuminator\\app\\D:\\x');
  assert.equal(seen.length, 2);
});

test('app://: a missing file is the file fetch\'s 404, with the policy still set and no forced type', async () => {
  const f = await appFixture();
  const r = await f.handle('app://lytro/nope.js');
  assert.equal(r.status, 404);
  assert.equal(r.headers.get('content-security-policy'), headerPolicy);
  assert.equal(r.headers.get('content-type'), null);
  await f.cleanup();
});

test('window hardening: navigation stays on app://lytro', () => {
  assert.equal(isAllowedNavigation('app://lytro/index.html'), true);
  assert.equal(isAllowedNavigation('app://lytro/index.html?queue'), true);
  for (const u of ['https://huggingface.co/x', 'http://localhost/', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'app://evil/index.html', 'app://lytro.evil.com/', 'about:blank', 'blob:app://lytro/x', '', 'not a url', undefined]) {
    assert.equal(isAllowedNavigation(u), false, String(u));
  }
});

test('window hardening: only http(s) links go to the browser', () => {
  for (const u of ['https://huggingface.co/x', 'http://example.com', 'HTTPS://EXAMPLE.COM/']) assert.equal(classifyWindowOpen(u), 'external', u);
  for (const u of ['javascript:alert(1)', 'file:///etc/passwd', 'app://lytro/index.html', 'data:text/html,x', 'ftp://x', 'vbscript:x', 'ms-msdt:/id', '', undefined, 'httpx://a']) assert.equal(classifyWindowOpen(u), 'deny', String(u));
});

test('window hardening: only fullscreen, clipboard writes and usb are granted', () => {
  for (const p of ['fullscreen', 'clipboard-sanitized-write', 'usb']) assert.equal(isAllowedPermission(p), true, p);
  for (const p of ['media', 'geolocation', 'notifications', 'midi', 'hid', 'serial', 'clipboard-read', 'camera', 'microphone', 'openExternal', 'pointerLock', '', undefined]) assert.equal(isAllowedPermission(p), false, String(p));
  let request;
  let check;
  installPermissions({ setPermissionRequestHandler: (fn) => { request = fn; }, setPermissionCheckHandler: (fn) => { check = fn; } });
  const answers = [];
  request(null, 'usb', (ok) => answers.push(ok));
  request(null, 'media', (ok) => answers.push(ok));
  assert.deepEqual(answers, [true, false]);
  assert.equal(check(null, 'fullscreen'), true);
  assert.equal(check(null, 'geolocation'), false);
});

function queueFixture(over = {}) {
  const sent = [];
  const events = [];
  const win = {
    loading: false,
    webContents: { isLoading: () => win.loading, send: (...a) => sent.push(a) },
    isMinimized: () => !!win.minimized,
    restore: () => events.push('restore'),
    focus: () => events.push('focus'),
  };
  const state = { win, ready: true, created: 0, allowed: [] };
  const existing = new Set(over.existing || []);
  const q = createOpenQueue({
    describe: async (p) => { if (!existing.has(p)) throw new Error('ENOENT'); return { path: p, name: path.basename(p), size: 1 }; },
    allow: (p) => state.allowed.push(p),
    getWindow: () => state.win,
    createWindow: () => { state.created++; state.win = win; },
    isReady: () => state.ready,
    cliMode: !!over.cliMode,
    lytroPathsFrom,
  });
  return { q, state, sent, events, win };
}

test('open queue: only Lytro files that exist reach the page, and they become readable', async () => {
  // Relative names are resolved against the working folder with the system's own rules ('/p/a.lfr' on POSIX, 'D:\\p\\a.lfr' on Windows).
  const cwd = '/p';
  const at = (name) => path.resolve(cwd, name);
  const f = queueFixture({ existing: [at('a.lfr'), at('b.RAW')] });
  await f.q.fromSecondInstance(['/app/exe', '--flag', 'a.lfr', 'b.RAW', 'gone.lfp', 'notes.txt', '', '-x.lfr'], cwd);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0][0], 'open-paths');
  assert.deepEqual(f.sent[0][1].map((x) => x.path), [at('a.lfr'), at('b.RAW')]);
  assert.deepEqual(f.state.allowed, [at('a.lfr'), at('b.RAW')]);
  assert.deepEqual(f.events, ['focus', 'focus']); // forward on a second launch, then for the files
});

test('open queue: paths wait for the page to load, a minimized window is restored', async () => {
  const f = queueFixture({ existing: ['/p/a.lfp'] });
  f.win.loading = true;
  await f.q.open(['/p/a.lfp']);
  assert.equal(f.sent.length, 0);
  assert.equal(f.q.size(), 1);
  f.win.loading = false;
  f.win.minimized = true;
  await f.q.flush();
  assert.equal(f.sent.length, 1);
  assert.equal(f.q.size(), 0);
  assert.deepEqual(f.events, ['restore', 'focus']);
  await f.q.flush(); // nothing left: nothing sent twice
  assert.equal(f.sent.length, 1);
});

test('open queue: no window opens one (not in CLI mode); nothing is sent for files that are gone', async () => {
  const f = queueFixture({ existing: ['/p/a.lfx'] });
  const w = f.state.win;
  f.state.win = null;
  await f.q.open(['/p/a.lfx']);
  assert.equal(f.state.created, 1);
  assert.equal(f.sent.length, 1);
  f.state.win = w;
  await f.q.open(['/p/missing.lfr']);
  assert.equal(f.sent.length, 1);

  const cli = queueFixture({ cliMode: true, existing: ['/p/a.lfx'] });
  cli.state.win = null;
  await cli.q.open(['/p/a.lfx']);
  assert.equal(cli.state.created, 0);
  const early = queueFixture({ existing: ['/p/a.lfx'] });
  early.state.win = null;
  early.state.ready = false;
  await early.q.open(['/p/a.lfx']);
  assert.equal(early.state.created, 0);
  assert.equal(early.q.size(), 1);
});

test('open queue: the macOS open-file event is claimed and filtered', async () => {
  const f = queueFixture({ existing: [path.resolve('x.lfr')] });
  let prevented = 0;
  await f.q.fromOpenFileEvent({ preventDefault: () => prevented++ }, 'x.lfr');
  await f.q.fromOpenFileEvent({ preventDefault: () => prevented++ }, 'x.txt');
  assert.equal(prevented, 2);
  assert.equal(f.sent.length, 1);
});

test('command line: the exit code is written to the file, creating its folder', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-'));
  const appDir = path.resolve('app');
  const quiet = (fn) => {
    const o = process.stdout.write;
    const e = process.stderr.write;
    process.stdout.write = () => true;
    process.stderr.write = () => true;
    return fn().finally(() => { process.stdout.write = o; process.stderr.write = e; });
  };
  const run = (args) => quiet(() => runCli({ args, appDir, version: '9.9.9', BrowserWindow: class { constructor() { throw new Error('no window for this'); } }, allow() {}, preload: '' }));
  const exit1 = path.join(dir, 'new', 'deep', 'code.txt');
  assert.equal(await run(['help', `--exit-file=${exit1}`]), 0);
  assert.equal(fs.readFileSync(exit1, 'utf8'), '0\n');
  const exit2 = path.join(dir, 'two.txt');
  assert.equal(await run(['version', '--exit-file', exit2]), 0);
  assert.equal(fs.readFileSync(exit2, 'utf8'), '0\n');
  // Not understood: 2.
  const exit3 = path.join(dir, 'three.txt');
  assert.equal(await run(['frobnicate', '--exit-file', exit3]), 2);
  assert.equal(fs.readFileSync(exit3, 'utf8'), '2\n');
  assert.equal(await run(['render', '--bogus-option', 'a.lfr']), 2);
  // An exit file that cannot be written never throws and does not change the code.
  assert.equal(await run(['help', '--exit-file', path.join(exit1, 'inside-a-file.txt')]), 0);
  // A window that cannot be made: the code is 1, still written.
  const exit4 = path.join(dir, 'four.txt');
  await assert.rejects(run(['info', 'a.lfr', '--exit-file', exit4]), /no window for this/);
  await fsp.rm(dir, { recursive: true, force: true });
});
