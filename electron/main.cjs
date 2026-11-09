// Electron main process: window, native dialogs, file access and USB camera
// import. The app itself is the same code as the browser version (app/),
// served through a private app:// scheme so module workers and WebGL run as
// they do on the web.

const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net, session, shell } = require('electron');
const path = require('node:path');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const camera = require('./camera.cjs');
const { lytroPathsFrom } = require('./paths.cjs');
const { createIpc } = require('./ipc.cjs');
const { createAppProtocolHandler } = require('./protocol.cjs');
const { isAllowedNavigation, classifyWindowOpen, installPermissions } = require('./hardening.cjs');
const { createOpenQueue } = require('./openpaths.cjs');
const { readSettings, writeSettings } = require('./settingsfile.cjs');
const { createScanner } = require('./scanner.cjs');

// The app was called ILLUMinator: the settings and library state kept under that name stay in use (a case-sensitive file system, as on Linux, tells the two names apart).
{
  const legacy = path.join(app.getPath('appData'), 'ILLUMinator');
  if (fs.existsSync(legacy) && !fs.existsSync(path.join(app.getPath('appData'), 'Illuminator'))) app.setPath('userData', legacy);
}

// The memory limits chosen in Settings (the app's own settings.json, read now because Chromium's switches are set before the app is ready): the JavaScript heap of the
// page and its workers, and the video memory Chromium plans for. They take effect when the app starts. null: no limit beyond the 4 GB left for the system.
const GB = 1024 ** 3;
// What is left for the system: 4 GB of RAM, 512 MB of video memory.
const RAM_RESERVE = 4 * GB;
const VRAM_RESERVE = 512 * 1024 ** 2;
function savedMemoryLimits() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));
    const m = j && j.memory;
    return { ramGb: m && m.ramGb > 0 ? m.ramGb : null, vramGb: m && m.vramGb > 0 ? m.vramGb : null };
  } catch {
    return { ramGb: null, vramGb: null };
  }
}
{
  const m = savedMemoryLimits();
  if (m.ramGb) app.commandLine.appendSwitch('js-flags', `--max-old-space-size=${Math.round(m.ramGb * 1024)}`);
  if (m.vramGb) app.commandLine.appendSwitch('force-gpu-mem-available-mb', String(Math.round(m.vramGb * 1024)));
}

// Render on the faster GPU of computers that have two (laptops).
app.commandLine.appendSwitch('force_high_performance_gpu');

const APP_DIR = path.join(__dirname, '..', 'app');
const POLL_MS = 3000;
// After a Lytro is plugged in: scan every second for this long, while its
// drive mounts.
const FAST_POLL_MS = 1000;
const FAST_POLL_FOR_MS = 20000;
// Importing straight from a connected camera (as CAMERA_IMPORT in
// app/js/platform.js): over the camera's own USB protocol (first generation
// cameras, see camera.cjs), from a camera drive, or with adb.
const CAMERA_IMPORT = true;

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

let cameras = [];
let settings = { libraryDir: null };
let win = null;

// The window, or null once it is closed (macOS keeps the app running without one).
const liveWin = () => (win && !win.isDestroyed() ? win : null);
// dialog.* calls with the window as parent when there is one.
const withWin = (options) => (liveWin() ? [win, options] : [options]);

// App settings, kept in the user data folder.
function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

async function loadSettings() {
  const { settings: saved, problem } = await readSettings(settingsFile());
  // No file is the first run (defaults); a damaged one is kept aside, not overwritten.
  if (problem) console.error(`Settings file ${problem}`);
  if (saved) settings = { ...settings, ...saved };
}

function saveSettings() {
  return writeSettings(settingsFile(), settings);
}

// The video memory of the best graphics card, in bytes (and where it came from). Windows keeps the real 64-bit size in the registry (the WMI figure stops at 4 GB); macOS
// and Linux have their own tools. A card that shares the computer's memory (integrated, Apple silicon) counts as half of it (all of it on Apple silicon). Found once.
let videoMemoryFound = null;
function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 8000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}
async function videoMemory() {
  if (videoMemoryFound) return videoMemoryFound;
  const total = os.totalmem();
  let bytes = 0;
  let source = 'estimated';
  try {
    if (process.platform === 'win32') {
      const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "(Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue).'HardwareInformation.qwMemorySize' | Where-Object { $_ } | ForEach-Object { [string][uint64]$_ }"]);
      for (const line of out.split(/\r?\n/)) {
        const v = Number(line.trim());
        if (v > bytes) bytes = v;
      }
      if (bytes) source = 'registry';
    } else if (process.platform === 'darwin') {
      if (process.arch === 'arm64') {
        bytes = total;
        source = 'unified memory';
      } else {
        const out = await run('system_profiler', ['SPDisplaysDataType', '-json']);
        for (const gpu of JSON.parse(out || '{}').SPDisplaysDataType || []) {
          const m = /([\d.]+)\s*(MB|GB)/i.exec(String(gpu.spdisplays_vram || gpu.spdisplays_vram_shared || ''));
          if (m) bytes = Math.max(bytes, Number(m[1]) * (/gb/i.test(m[2]) ? GB : 1024 ** 2));
        }
        if (bytes) source = 'system_profiler';
      }
    } else {
      const smi = await run('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits']);
      for (const line of smi.split(/\r?\n/)) bytes = Math.max(bytes, Number(line.trim()) * 1024 ** 2 || 0);
      if (bytes) source = 'nvidia-smi';
      else {
        for (const card of await fsp.readdir('/sys/class/drm').catch(() => [])) {
          const v = Number(await fsp.readFile(`/sys/class/drm/${card}/device/mem_info_vram_total`, 'utf8').catch(() => '0'));
          if (v > bytes) bytes = v;
        }
        if (bytes) source = 'amdgpu';
      }
    }
  } catch {
    bytes = 0;
  }
  // an integrated card has little of its own and uses the computer's memory
  if (bytes < GB) {
    bytes = Math.round(total / 2);
    source = 'half of the computer\'s memory (shared)';
  }
  videoMemoryFound = { vramBytes: bytes, vramSource: source };
  return videoMemoryFound;
}

async function lfpModule() {
  return import(pathToFileURL(path.join(APP_DIR, 'js', 'core', 'lfp.js')).href);
}

// The menu bar: Electron's standard menus without reload and developer tools,
// plus the app's import commands. On macOS, Quit sits in the app menu.
function buildMenu() {
  const mac = process.platform === 'darwin';
  const send = (id) => () => { const w = liveWin(); if (w) w.webContents.send('menu', id); };
  const template = [
    ...(mac ? [{ role: 'appMenu', submenu: [
      { label: 'About Illuminator', click: send('about') },
      { label: 'Check for Updates…', click: send('check-update') }, { type: 'separator' },
      { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' }, { role: 'quit' },
    ] }] : []),
    { label: 'File', submenu: [
      { label: 'Import Lytro File…', accelerator: 'CmdOrCtrl+O', click: send('open') },
      { label: 'Import Lytro Library…', click: send('import-library') },
      ...(mac ? [] : [{ type: 'separator' }, { role: 'quit' }]),
    ] },
    // Undo and redo step through a photo's edits (text fields keep their
    // own); the page decides which.
    { label: 'Edit', submenu: [
      { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: send('undo') },
      { label: 'Redo', accelerator: process.platform === 'darwin' ? 'Shift+Cmd+Z' : 'Ctrl+Y', click: send('redo') },
      { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ] },
    { label: 'View', submenu: [
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [
      { label: 'Check for Updates…', click: send('check-update') },
      { label: 'About', click: send('about') },
      { label: 'Wiki', click: () => shell.openExternal('https://github.com/AbstractPolygon/Illuminator/wiki') },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#121417',
    title: 'Illuminator',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // No developer tools in the installed app; `npm start` keeps them.
      devTools: !app.isPackaged,
    },
  });
  const self = win;
  self.on('closed', () => { if (win === self) win = null; });
  win.webContents.on('did-finish-load', () => openQueue.flush());
  win.loadURL('app://lytro/index.html');
  // Links to other sites open in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (classifyWindowOpen(url) === 'external') shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAllowedNavigation(url)) e.preventDefault();
  });
}

// Watches for cameras being plugged in or removed: every few seconds, and
// every second for a while after the app sees a Lytro arrive on USB.
let fastUntil = 0;
const scanner = createScanner({
  scan: async () => {
    try {
      const found = await camera.listCameras();
      const key = (list) => list.map((c) => `${c.id}:${c.files.length}`).join('|');
      if (key(found) !== key(cameras)) {
        cameras = found;
        for (const c of cameras) for (const f of c.files) if (c.kind === 'drive') allow(f.id);
        const w = liveWin();
        if (w) w.webContents.send('cameras-changed', summary());
      }
    } catch (err) {
      console.error('Camera scan failed', err);
    }
  },
  nextDelay: () => (Date.now() < fastUntil ? FAST_POLL_MS : POLL_MS),
});
const pollCameras = () => scanner.request();

function scanSoon() {
  fastUntil = Date.now() + FAST_POLL_FOR_MS;
  pollCameras();
}

function summary() {
  return cameras.map((c) => ({ id: c.id, kind: c.kind, label: c.label, files: c.files.map(({ id, name, size, folder }) => ({ id, name, size, folder })) }));
}

// The page's calls (electron/ipc.cjs holds the checks and is tested without Electron).
const { handlers, allow, describe } = createIpc({
  fs, fsp, path, os, dialog, shell, app, camera,
  getSettings: () => settings,
  saveSettings: () => saveSettings(),
  getCameras: () => cameras,
  summary: () => summary(),
  pollCameras: () => pollCameras(),
  scanSoon: () => scanSoon(),
  withWin,
  videoMemory,
  lfpModule: () => lfpModule(),
  memoryReserve: { ram: RAM_RESERVE, vram: VRAM_RESERVE },
});

function registerIpc() {
  for (const [name, fn] of Object.entries(handlers)) {
    // One-way: the page does not wait for an answer.
    if (name === 'camera-usb-connected') ipcMain.on(name, () => fn());
    // The progress events go back to the window that asked.
    else if (name === 'import-from-camera') ipcMain.handle(name, (e, cameraId, fileIds) => fn(cameraId, fileIds, (p) => e.sender.send('import-progress', p)));
    else ipcMain.handle(name, (_e, ...args) => fn(...args));
  }
}

// A Linux AppImage is one file that does not put itself in the applications
// menu. The first time it runs the user is asked whether to add it (and, ticked
// by default, a desktop shortcut); .deb installs get their menu entry from the package.
async function offerLinuxMenuEntry() {
  const appImage = process.env.APPIMAGE;
  if (process.platform !== 'linux' || !appImage || settings.menuEntry) return;
  const res = await dialog.showMessageBox(...withWin({
    type: 'question',
    title: 'Illuminator',
    message: 'Add Illuminator to your applications menu?',
    detail: 'This copies a launcher and an icon into your home folder; nothing outside it is changed. You can remove them by deleting illuminator.desktop from ~/.local/share/applications.',
    buttons: ['Add to menu', 'Not now', 'Don\'t ask again'],
    defaultId: 0,
    cancelId: 1,
    checkboxLabel: 'Add to desktop',
    checkboxChecked: true,
  }));
  if (res.response === 2) {
    settings.menuEntry = 'never';
    await saveSettings();
    return;
  }
  if (res.response !== 0) return;
  try {
    const home = app.getPath('home');
    const dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
    const iconDir = path.join(dataHome, 'icons', 'hicolor', 'scalable', 'apps');
    await fsp.mkdir(iconDir, { recursive: true });
    await fsp.writeFile(path.join(iconDir, 'illuminator.svg'), await fsp.readFile(path.join(APP_DIR, 'icon.svg')));
    const entry = [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Illuminator',
      'Comment=Lytro light field photo editor',
      `Exec="${appImage}" %F`,
      'Icon=illuminator',
      'Terminal=false',
      'Categories=Graphics;Photography;',
      'MimeType=image/x-lytro-lfr;image/x-lytro-lfp;',
      'StartupWMClass=Illuminator',
      '',
    ].join('\n');
    const appsDir = path.join(dataHome, 'applications');
    await fsp.mkdir(appsDir, { recursive: true });
    await fsp.writeFile(path.join(appsDir, 'illuminator.desktop'), entry, { mode: 0o755 });
    if (res.checkboxChecked) {
      const desktop = app.getPath('desktop');
      await fsp.mkdir(desktop, { recursive: true });
      await fsp.writeFile(path.join(desktop, 'Illuminator.desktop'), entry, { mode: 0o755 });
    }
    settings.menuEntry = 'added';
    await saveSettings();
  } catch (err) {
    dialog.showErrorBox('Illuminator', `The menu entry could not be added: ${err.message}`);
  }
}

// `Illuminator --cli ...`: no window to show, the command is run and the app exits (electron/cli.cjs).
const CLI_AT = process.argv.indexOf('--cli');

// Files handed to the app by the system (electron/openpaths.cjs).
const openQueue = createOpenQueue({
  describe,
  allow,
  getWindow: liveWin,
  createWindow: () => createWindow(),
  isReady: () => app.isReady(),
  cliMode: CLI_AT >= 0,
  lytroPathsFrom,
});
if (CLI_AT < 0) {
  // argv[0] is the executable (and, unpackaged, the app folder): only the files named after it count.
  openQueue.fromArgv(process.argv.slice(app.isPackaged ? 1 : 2));
  app.on('open-file', (event, file) => openQueue.fromOpenFileEvent(event, file));
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    app.on('second-instance', (_e, argv, cwd) => openQueue.fromSecondInstance(argv, cwd));
  }
}

app.whenReady().then(async () => {
  await loadSettings();
  const handleApp = createAppProtocolHandler({ appDir: APP_DIR, fetchFile: (file) => net.fetch(pathToFileURL(file).href) });
  protocol.handle('app', async (request) => {
    const r = await handleApp(request.url);
    return new Response(r.body, { status: r.status, statusText: r.statusText, headers: r.headers });
  });
  // USB plug-in events reach the page (WebUSB) for Lytro cameras only,
  // without asking: the page only watches them come and go.
  if (CAMERA_IMPORT) session.defaultSession.setDevicePermissionHandler((details) => details.deviceType === 'usb' && camera.isLytroUsb(details.device));
  installPermissions(session.defaultSession);
  registerIpc();
  if (CLI_AT >= 0) {
    const { runCli } = require('./cli.cjs');
    const code = await runCli({ args: process.argv.slice(CLI_AT + 1), BrowserWindow, allow, appDir: APP_DIR, preload: path.join(__dirname, 'preload.cjs'), version: app.getVersion() });
    // Straight out with the exit code: Chromium's own shutdown after a page has run crashed the process on some systems (losing the code), and nothing is left to save.
    process.stdout.write('', () => process.stderr.write('', () => (process.reallyExit || process.exit)(code)));
    return;
  }
  buildMenu();
  createWindow();
  win.once('ready-to-show', () => offerLinuxMenuEntry().catch(() => {}));
  if (CAMERA_IMPORT) pollCameras();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// In --cli mode the command ends the process itself with its exit code: quitting here would race that and could turn a failed render into exit code 0.
app.on('window-all-closed', () => {
  if (CLI_AT < 0 && process.platform !== 'darwin') app.quit();
});
