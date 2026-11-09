'use strict';
// The page's calls into the main process (window.lytroNative, electron/preload.cjs), as plain async functions keyed by
// channel name. Everything Electron or the disk-facing environment provides is passed in, so the checks that keep the
// page inside the library and inside the files the person chose can be tested without a window. main.cjs registers
// each with ipcMain.handle(name, (event, ...args) => handlers[name](...args)).

const { isInside, resolveInside } = require('./paths.cjs');

const notFound = (err) => err && (err.code === 'ENOENT' || err.code === 'ENOTDIR');

// deps:
//  fs, fsp, path, os      node modules (path.win32 and a platform of 'win32' test the Windows rules)
//  dialog, shell, app     Electron's
//  camera                 electron/camera.cjs
//  getSettings()          the live settings object (libraryDir, memory); saveSettings() persists it
//  getCameras()           the detected cameras; summary(); pollCameras(); scanSoon()
//  withWin(options)       argument list for dialog.* (the window as parent when there is one)
//  videoMemory(), lfpModule(), memoryReserve { ram, vram }
function createIpc(deps) {
  const { fs, fsp, path, os, dialog, shell, app, camera, getSettings, saveSettings, getCameras, summary, pollCameras, scanSoon, withWin, videoMemory, lfpModule } = deps;
  const platform = deps.platform || process.platform;
  const reserve = deps.memoryReserve || { ram: 0, vram: 0 };
  const settings = () => getSettings();

  // The renderer may only read files the user chose (dialogs), files on a detected camera and files in the library.
  const allowed = new Set();
  const outputFolders = new Set();

  function allow(file) {
    allowed.add(path.resolve(file));
  }

  // Where the library lives (the user can choose it in Settings).
  function libraryDir() {
    if (settings().libraryDir) return settings().libraryDir;
    // The app was called ILLUMinator: a library already made under that name stays there (a case-sensitive file system tells the two apart).
    const legacy = path.join(app.getPath('pictures'), 'ILLUMinator');
    return fs.existsSync(legacy) ? legacy : path.join(app.getPath('pictures'), 'Illuminator');
  }

  // The real location of a path that may not exist yet: its nearest existing ancestor, resolved through symlinks, plus the
  // names below it. A dangling symlink counts as outside (writing through it would create a file wherever it points).
  async function realOf(p, outsideMessage) {
    const tail = [];
    for (let cur = p; ;) {
      let dangling = false;
      try {
        return path.join(await fsp.realpath(cur), ...tail);
      } catch (err) {
        if (!notFound(err)) throw err;
        dangling = await fsp.lstat(cur).then(() => true, () => false);
      }
      if (dangling) throw new Error(outsideMessage);
      const parent = path.dirname(cur);
      if (parent === cur) return p; // nothing of it exists (also a Windows path on another system)
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }

  // A symlink inside the folder must not lead out of it: compare real locations. With followLeaf false the last name is
  // kept as it is (removing or renaming a link acts on the link, never on what it points to).
  async function contained(root, target, outsideMessage, allowSame, followLeaf = true) {
    if (!followLeaf && target === path.resolve(root)) return; // the root itself, possibly a link: callers refuse to remove it
    const realRoot = await realOf(path.resolve(root), outsideMessage);
    const parent = followLeaf ? target : path.dirname(target);
    const realTarget = await realOf(parent, outsideMessage);
    const full = followLeaf ? realTarget : path.join(realTarget, path.basename(target));
    if (!isInside(realRoot, full, platform, allowSame)) throw new Error(outsideMessage);
  }

  async function checkAllowed(file) {
    const p = path.resolve(file);
    if (allowed.has(p)) return p;
    const message = 'This file was not opened in Illuminator.';
    if (isInside(libraryDir(), p, platform)) {
      await contained(libraryDir(), p, message, false);
      return p;
    }
    throw new Error(message);
  }

  // A path inside the library from one the app gives ('Photos/IMG_0001/...').
  async function inLibrary(rel, followLeaf = true) {
    const p = resolveInside(libraryDir(), rel, platform);
    await contained(libraryDir(), p, 'Outside the library', true, followLeaf);
    return p;
  }

  async function describe(file) {
    const st = await fsp.stat(file);
    return { path: file, name: path.basename(file), size: st.size };
  }

  // Every light field file and thumbnail under a folder, with paths relative to it. Used to import a Lytro Desktop library or a camera folder.
  async function walk(root, rel = '', out = [], depth = 0) {
    if (depth > 12 || out.length > 20000) return out;
    let entries = [];
    try {
      entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(root, r, out, depth + 1);
      else if (/\.(lfr|lfp|raw|jpe?g|png)$/i.test(e.name)) out.push(r);
    }
    return out;
  }

  // A temporary file name beside `target`, different for every call.
  let tempCounter = 0;
  const tempName = (target) => `${target}.${process.pid}-${++tempCounter}-${Math.random().toString(36).slice(2, 8)}.part`;

  function findCamera(id) {
    const c = getCameras().find((x) => x.id === id);
    if (!c) throw new Error('That camera is no longer connected.');
    return c;
  }

  const handlers = {
    'open-files': async (options) => {
      // `options` picks another kind of file (camera calibration backups).
      const kind = options && options.kind === 'calibration';
      const res = await dialog.showOpenDialog(...withWin({
        title: kind ? 'Add camera calibration data' : 'Open light field photos',
        properties: kind ? ['openFile'] : ['openFile', 'multiSelections'],
        filters: kind
          ? [{ name: 'Camera calibration backup', extensions: ['tar', 'TAR'] }]
          : [{ name: 'Lytro photos and album archives', extensions: ['lfr', 'lfp', 'raw', 'zip', 'LFR', 'LFP', 'RAW', 'ZIP'] }],
      }));
      if (res.canceled) return [];
      res.filePaths.forEach(allow);
      return Promise.all(res.filePaths.map(describe));
    },

    'read-file': async (file) => {
      const buf = await fsp.readFile(await checkAllowed(file));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
    },

    'read-range': async (file, offset, length) => {
      // Numbers only: NaN or a string would make the buffer allocation throw an unhelpful error.
      const valid = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
      if (!valid(offset) || !valid(length)) throw new Error('Invalid read range.');
      const reader = await camera.fileReader(await checkAllowed(file));
      try {
        return await reader.read(Math.floor(offset), Math.floor(length));
      } finally {
        await reader.close();
      }
    },

    // Lytro Desktop keeps a picture's edits in stack.view.lfp, in the same folder as its raw.lfp; an exported IMG_0001.lfp next to IMG_0001.lfr carries them too.
    'find-sidecar': async (file) => {
      const p = await checkAllowed(file);
      const dir = path.dirname(p);
      const candidates = [path.join(dir, 'stack.view.lfp')];
      if (/\.lfr$/i.test(p)) {
        const base = path.basename(p).replace(/\.[^.]+$/, '').toLowerCase();
        try {
          for (const name of await fsp.readdir(dir)) {
            if (/\.lfp$/i.test(name) && name.replace(/\.[^.]+$/, '').toLowerCase() === base) candidates.push(path.join(dir, name));
          }
        } catch {
          // Folder not readable: only the fixed name is tried.
        }
      }
      for (const side of candidates) {
        if (side === p) continue;
        try {
          const found = await describe(side);
          allow(side);
          return found;
        } catch {
          // Not there.
        }
      }
      return null;
    },

    // The page saw a Lytro plugged in over USB (app/js/main.js, WebUSB).
    'camera-usb-connected': () => scanSoon(),

    // Why a Lytro on USB could not be used, and the protocol log.
    'camera-problems': () => ({ problems: camera.usbProblems(), log: camera.usbDiagnostics() }),

    'list-cameras': async () => {
      // Through the one scan loop: a second scan at the same time would open the same camera twice.
      await pollCameras();
      return summary();
    },

    // Thumbnail of a photo on a camera drive, reading only the thumbnail.
    'camera-thumbnail': async (cameraId, fileId) => {
      const c = findCamera(cameraId);
      if (c.kind === 'lytro') return camera.lytroThumbnail(c, fileId);
      if (c.kind !== 'drive') return null;
      const { readThumbnail } = await lfpModule();
      const reader = await camera.fileReader(await checkAllowed(fileId));
      try {
        const t = await readThumbnail(reader);
        return t ? { mime: t.mime, bytes: t.bytes } : null;
      } catch {
        return null;
      } finally {
        await reader.close();
      }
    },

    // What the computer has, for Settings > Memory: its RAM and its video memory (found the way each system tells it; null where it cannot be told), and the limits kept.
    'system-memory': async () => ({ ramBytes: os.totalmem(), ...(await videoMemory()), ramReserveBytes: reserve.ram, vramReserveBytes: reserve.vram, limits: settings().memory || { ramGb: null, vramGb: null } }),

    'set-memory-limits': async (limits) => {
      const clean = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v * 2) / 2 : null);
      settings().memory = { ramGb: clean(limits && limits.ramGb), vramGb: clean(limits && limits.vramGb) };
      await saveSettings();
      return settings().memory;
    },

    'library-dir': async () => libraryDir(),

    'choose-library-dir': async () => {
      const res = await dialog.showOpenDialog(...withWin({
        title: 'Choose library location',
        defaultPath: libraryDir(),
        properties: ['openDirectory', 'createDirectory'],
      }));
      if (res.canceled || !res.filePaths.length) return null;
      settings().libraryDir = res.filePaths[0];
      await saveSettings();
      return libraryDir();
    },

    // Copies photos off a camera reached over adb into the library's staging folder; the app then adds them to the library (and empties it).
    // camera.importFiles takes only ids that are in the camera's own list, so the page cannot name other paths.
    'import-from-camera': async (cameraId, fileIds, onProgress = () => {}) => {
      const c = findCamera(cameraId);
      let paths;
      try {
        paths = await camera.importFiles(c, fileIds, await inLibrary('.incoming'), onProgress);
      } catch (err) {
        // The files written before the failure stay allowed and in the staging folder; the page shows which one failed.
        const done = err && err.imported ? err.imported : [];
        done.forEach(allow);
        if (done.length) err.message = `${err.message} (${done.length} photo${done.length === 1 ? ' was' : 's were'} copied before this)`;
        throw err;
      }
      paths.forEach(allow);
      return Promise.all(paths.map(describe));
    },

    // The library folder (relative paths, see inLibrary).
    'lib-list': async (rel) => {
      try {
        const dir = await inLibrary(rel);
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        // Each entry on its own: a dangling symlink or a file deleted meanwhile is skipped, it must not make the whole folder look empty.
        const listed = await Promise.all(entries.filter((e) => !e.name.startsWith('.')).map(async (e) => {
          try {
            return { name: e.name, dir: e.isDirectory(), size: e.isDirectory() ? 0 : (await fsp.stat(path.join(dir, e.name))).size };
          } catch {
            return null;
          }
        }));
        return listed.filter(Boolean);
      } catch (err) {
        if (notFound(err)) return [];
        throw err;
      }
    },

    'lib-read-text': async (rel) => {
      try {
        return await fsp.readFile(await inLibrary(rel), 'utf8');
      } catch (err) {
        if (notFound(err)) return null;
        throw err;
      }
    },

    // Written to a temporary file first, so a crash never leaves half a file.
    'lib-write': async (rel, data) => {
      const p = await inLibrary(rel);
      await fsp.mkdir(path.dirname(p), { recursive: true });
      // A name per write: two writes to one path at once must not share a temporary file.
      const tmp = tempName(p);
      try {
        await fsp.writeFile(tmp, typeof data === 'string' ? data : Buffer.from(data));
        await fsp.rename(tmp, p);
      } catch (err) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
    },

    'lib-copy-in': async (src, rel) => {
      const from = await checkAllowed(src);
      const p = await inLibrary(rel);
      await fsp.mkdir(path.dirname(p), { recursive: true });
      const tmp = tempName(p);
      try {
        await fsp.copyFile(from, tmp);
        await fsp.rename(tmp, p);
      } catch (err) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
    },

    'lib-stat': async (rel) => {
      try {
        return await describe(await inLibrary(rel));
      } catch (err) {
        if (notFound(err)) return null;
        throw err;
      }
    },

    'lib-move': async (from, to) => {
      const dest = await inLibrary(to, false);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.rename(await inLibrary(from, false), dest);
    },

    // Opens a folder of the library in the system's file manager (Explorer, Finder).
    'lib-open': async (rel) => {
      const p = await inLibrary(rel);
      const err = await shell.openPath(p);
      if (err) throw new Error(err);
    },

    // Removed photos go to the system trash. Where the trash cannot take them (network drives, Linux without a trash) nothing is deleted unless the caller passes
    // { permanent: true } (after asking the person). The app's scratch folders (Staging, dot folders) are never worth keeping and are removed outright.
    'lib-remove': async (rel, options) => {
      const p = await inLibrary(rel, false);
      if (p === path.resolve(libraryDir())) throw new Error('Will not remove the library itself');
      const scratch = /^\/*(\.|Staging(\/|$))/.test(String(rel || ''));
      if (scratch || (options && options.permanent === true)) {
        await fsp.rm(p, { recursive: true, force: true });
        return;
      }
      try {
        await shell.trashItem(p);
      } catch (err) {
        if (notFound(err) || !fs.existsSync(p)) return;
        throw new Error(`${path.basename(p)} could not be moved to the trash (${err.message}), so it was not deleted. Delete it permanently instead?`);
      }
    },

    // Picks a folder and lists the photos in it (all subfolders included).
    'pick-folder': async (title) => {
      const res = await dialog.showOpenDialog(...withWin({ title: title || 'Choose a folder', properties: ['openDirectory'] }));
      if (res.canceled || !res.filePaths.length) return null;
      const root = res.filePaths[0];
      const files = [];
      for (const rel of await walk(root)) {
        const abs = path.join(root, ...rel.split('/'));
        allow(abs);
        try {
          files.push({ rel, ...(await describe(abs)) });
        } catch {
          // Vanished while scanning.
        }
      }
      return { root, name: path.basename(root), files };
    },

    // The render queue's files: written one after another into a folder chosen here, without asking each time.
    'choose-output-folder': async () => {
      const res = await dialog.showOpenDialog(...withWin({ title: 'Choose where the render queue saves its files', properties: ['openDirectory', 'createDirectory'] }));
      if (res.canceled || !res.filePaths.length) return null;
      outputFolders.add(path.resolve(res.filePaths[0]));
      return res.filePaths[0];
    },

    'write-output': async (folder, name, bytes) => {
      const dir = path.resolve(String(folder));
      if (!outputFolders.has(dir)) throw new Error('That folder was not chosen in this session.');
      const base = path.basename(String(name)) || 'picture';
      const dot = base.lastIndexOf('.');
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const ext = dot > 0 ? base.slice(dot) : '';
      let file = path.join(dir, base);
      for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${stem} (${n})${ext}`);
      // The folder itself may be a link the person chose; a link inside it must not lead out.
      await contained(dir, file, 'That folder was not chosen in this session.', false);
      await fsp.writeFile(file, Buffer.from(bytes));
      return file;
    },

    'save-file': async (name, bytes) => {
      const res = await dialog.showSaveDialog(...withWin({ defaultPath: path.join(app.getPath('pictures'), name) }));
      if (res.canceled || !res.filePath) return null;
      await fsp.writeFile(res.filePath, Buffer.from(bytes));
      return res.filePath;
    },
  };

  return { handlers, allow, checkAllowed, libraryDir, describe };
}

const createHandlers = (deps) => createIpc(deps).handlers;

module.exports = { createIpc, createHandlers };
