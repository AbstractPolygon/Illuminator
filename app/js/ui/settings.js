// settings: moved out of main.js. initSettings() runs where the section used to, with what it uses from the rest of the page.
import { native, pickFolder, openCalibrationFile } from '../platform.js';
import { groupPhotos } from '../library/scan.js';
import { listCalibrations, loadCalibration, removeCalibration, importCalibration } from '../core/calibration.js';
import { DEPTH_MODELS, downloadDepthModel, removeDepthModel, depthModelState, depthModelMethod } from '../core/depthmodels.js';
import { FILL_MODEL, downloadFillModel, removeFillModel, fillModelState } from '../core/fillmodel.js';
import { aiUpscaleAvailable } from '../core/aiupscale.js';
import { UPSCALE_MODELS, modelState, downloadModel, SHARPEN_MODELS, removeModel, modelMethod, sharpenMethod } from '../core/upscalemodels.js';
import { setMemoryLimits } from '../core/memorybudget.js';
import { updateCheckOn } from './updates.js';
import { VERSION } from '../version.js';

export function initSettings({ state, $, showError, showNotice, startNoticeTimer, importPhotos, showGrid, engine, showDepthBlend, showDepthMethods, showUpscaleControls, scheduleSave, useLibrary }) {

  // Settings window (gear at the right of the top bar).
  async function showLibraryLocation() {
    await state.libReady;
    const kind = state.lib.store.kind;
    $('library-path').classList.toggle('mono', kind === 'folder');
    $('library-choose').hidden = kind !== 'folder';
    if (kind === 'folder') {
      $('library-path').textContent = await native.libraryDir();
    } else if (kind === 'browser') {
      $('library-path').textContent = 'This browser’s storage';
    } else {
      $('library-path').textContent = 'Not available';
    }
  }

  // A Lytro Desktop library (or any folder of photos), into a new album.
  async function importFolder() {
    // Libraries are imported by the desktop app; the browser version points
    // there.
    if (!native) {
      showDesktopOnly();
      return;
    }
    const picked = await pickFolder('Import a Lytro Desktop library or a folder of photos').catch((err) => {
      showError(err);
      return null;
    });
    if (!picked) return;
    const entries = groupPhotos(picked.files);
    if ($('settings-dialog').open) $('settings-dialog').close();
    if (!entries.length) {
      showNotice(`No Lytro photos found in ${picked.name}.`);
      startNoticeTimer();
      return;
    }
    await state.libReady;
    const albumName = picked.name.replace(/\.lytrolibrary$/i, '');
    const album = state.lib.albums.find((a) => a.name === albumName) || (await state.lib.createAlbum(albumName));
    // Photos imported before with the same names are replaced by these.
    const added = await importPhotos(entries, { album: album.id, replace: true });
    state.album = album.id;
    state.cameraView = false;
    showGrid(true);
    const withEdits = entries.filter((e) => e.sidecar).length;
    showNotice(`Added ${added.length} photo${added.length === 1 ? '' : 's'} from ${picked.name} to the album “${album.name}”.`,
      withEdits ? `${withEdits === 1 ? 'One carries' : `${withEdits} carry`} Lytro Desktop edits, applied when ${withEdits === 1 ? 'it is' : 'each is'} first opened.` : '');
    startNoticeTimer();
  }

  $('import-folder').onclick = importFolder;

  // The browser version points to the desktop app for imports that need it.
  const LIBRARY_ONLY = { title: $('desktop-only-title').textContent, text: $('desktop-only-text').textContent };
  function showDesktopOnly(title = LIBRARY_ONLY.title, text = LIBRARY_ONLY.text) {
    $('desktop-only-title').textContent = title;
    $('desktop-only-text').textContent = text;
    $('desktop-only-hint').hidden = title !== LIBRARY_ONLY.title;
    $('desktop-only-dialog').showModal();
  }

  // ---- camera calibration

  const lensSource = () => {
    try {
      return localStorage.getItem('illuminator.lensSource') === 'measured' ? 'measured' : 'calibration';
    } catch {
      return 'calibration';
    }
  };

  // Kept calibration goes to the render worker, keyed by camera serial number.
  async function sendCalibrations() {
    await state.libReady;
    const kept = await listCalibrations(state.lib.store).catch(() => []);
    const list = [];
    for (const k of kept) list.push(await loadCalibration(state.lib.store, k.serial).catch(() => null));
    await engine.request('setCalibrations', { list: list.filter(Boolean), useWhites: lensSource() === 'calibration' });
    return kept;
  }

  async function showCalibrations() {
    const kept = await sendCalibrations();
    const ul = $('cal-list');
    ul.replaceChildren();
    for (const k of kept) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = `Camera ${k.serial}${k.hotPixels ? ' · hot pixel list' : ''}${k.whites && k.whites.length ? ` · ${k.whites.length} white images` : ''}`;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'link';
      del.textContent = 'Remove';
      del.onclick = async () => {
        await removeCalibration(state.lib.store, k.serial);
        $('cal-note').textContent = `Removed the calibration for camera ${k.serial}.`;
        showCalibrations();
      };
      li.append(name, del);
      ul.append(li);
    }
    if (!kept.length) $('cal-note').textContent ||= 'No camera calibration added yet.';
  }

  async function addCalibration(source) {
    if (!source) return;
    await state.libReady;
    $('cal-note').textContent = 'Reading calibration data…';
    try {
      const info = await importCalibration(source, state.lib.store, {
        onProgress: (p, name) => { $('cal-note').textContent = `Reading ${name}…`; },
        // The white images are measured in the render worker.
        measure: (bytes, meta) => engine.request('measureWhite', { bytes: bytes.buffer, meta }, { transfer: [bytes.buffer] }),
      });
      $('cal-note').textContent = `Added camera ${info.serial}: ${info.saved} files kept` +
        (info.hotPixels ? `, its hot pixel list` : '') +
        (info.whites.length ? ` and ${info.whites.length} white images` : '') +
        '. Photos from this camera use it the next time they are opened.';
      await showCalibrations();
    } catch (err) {
      $('cal-note').textContent = err.message || String(err);
    }
  }

  const CALIBRATION_ONLY = ['Add camera calibration', 'Adding camera calibration data needs the Illuminator desktop app, for Windows, macOS and Linux. Backups are over a gigabyte, so the desktop app reads them on your computer and keeps the calibration in your library.'];
  $('cal-lens-source').value = lensSource();
  $('cal-lens-source').onchange = () => {
    try {
      localStorage.setItem('illuminator.lensSource', $('cal-lens-source').value);
    } catch {
      // Not remembered.
    }
    sendCalibrations();
  };
  $('cal-add').onclick = async () => (!native ? showDesktopOnly(...CALIBRATION_ONLY) : addCalibration(await openCalibrationFile().catch(() => null)));
  $('cal-folder').onclick = async () => {
    if (!native) return showDesktopOnly(...CALIBRATION_ONLY);
    const picked = await pickFolder('Choose the camera’s calibration folder', { calibration: true }).catch(() => null);
    if (picked && picked.files.length) addCalibration(picked.files.map((f) => ({ path: f.path, file: f.file })));
  };

  // Settings > Upscaling models: a checkbox per optional model (core/upscalemodels.js). Ticking downloads it, unticking deletes it; a downloaded model appears in Render Settings >
  // Upscaling > Method. They need a graphics card with WebGPU.
  let modelBusy = false;
  const updatingModels = new Set();
  // Depth models (Settings > Depth models): a downloaded model is a choice under Camera > Depth > Depth method.
  let depthModelBusy = false;
  async function refreshDepthModels() {
    const select = $('depth-style');
    const before = select.value;
    const list = $('depth-models-list');
    if (!list.children.length) {
      for (const m of DEPTH_MODELS) {
        const row = document.createElement('label');
        row.className = 'check model-row';
        const box = Object.assign(document.createElement('input'), { type: 'checkbox' });
        box.dataset.model = m.id;
        const text = document.createElement('span');
        text.textContent = `${m.name}, ${m.note} (${Math.round(m.size / 1e6)} MB)`;
        const status = Object.assign(document.createElement('span'), { className: 'hint model-state' });
        row.append(box, text, status);
        list.append(row);
        box.onchange = async () => {
          if (depthModelBusy) {
            box.checked = !box.checked;
            return;
          }
          depthModelBusy = true;
          box.disabled = true;
          try {
            if (box.checked) {
              status.textContent = 'Downloading… 0%';
              await downloadDepthModel(m, (p) => { status.textContent = `Downloading… ${Math.round(p * 100)}%`; });
            } else {
              await removeDepthModel(m);
              // The worker keeps the model's session (tens of megabytes) until told to let it go.
              await engine.request('releaseDepthModel', { model: m.id }).catch(() => {});
            }
            status.textContent = '';
          } catch (err) {
            box.checked = false;
            status.textContent = err && err.message ? err.message : String(err);
          }
          depthModelBusy = false;
          await refreshDepthModels();
        };
      }
    }
    for (const m of DEPTH_MODELS) {
      const have = (await depthModelState(m)) === 'ready';
      const box = list.querySelector(`input[data-model="${m.id}"]`);
      box.checked = have;
      const value = depthModelMethod(m.id);
      const option = [...select.options].find((o) => o.value === value);
      if (have && !option) select.append(new Option(m.name, value));
      else if (!have && option) option.remove();
    }
    // a model that was the method and is gone: back to Automatic
    if (before && ![...select.options].some((o) => o.value === before)) {
      select.value = 'auto';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (before) {
      select.value = before;
    }
    showDepthBlend();
    // (a photo that carries its depth: From the file)
    showDepthMethods();
  }
  refreshDepthModels().catch(() => {});

  // Settings > Fill model (core/fillmodel.js): ticking downloads MI-GAN, unticking deletes it; while it is downloaded, Camera > Perspective > Fill with AI can be turned on.
  let fillModelBusy = false;
  async function refreshFillModel() {
    const list = $('fill-model-list');
    if (!list.children.length) {
      const row = document.createElement('label');
      row.className = 'check model-row';
      const box = Object.assign(document.createElement('input'), { type: 'checkbox' });
      box.dataset.model = FILL_MODEL.id;
      const text = document.createElement('span');
      text.textContent = `${FILL_MODEL.name}, ${FILL_MODEL.note} (${Math.round(FILL_MODEL.size / 1e6)} MB)`;
      const status = Object.assign(document.createElement('span'), { className: 'hint model-state' });
      row.append(box, text, status);
      list.append(row);
      box.onchange = async () => {
        if (fillModelBusy) {
          box.checked = !box.checked;
          return;
        }
        fillModelBusy = true;
        box.disabled = true;
        try {
          if (box.checked) {
            status.textContent = 'Downloading… 0%';
            await downloadFillModel((p) => { status.textContent = `Downloading… ${Math.round(p * 100)}%`; });
          } else {
            await removeFillModel();
          }
          status.textContent = '';
        } catch (err) {
          box.checked = false;
          status.textContent = err && err.message ? err.message : String(err);
        }
        fillModelBusy = false;
        await refreshFillModel();
      };
    }
    const have = (await fillModelState()) === 'ready';
    const box = list.querySelector(`input[data-model="${FILL_MODEL.id}"]`);
    box.checked = have;
    box.disabled = false;
    $('view-fill').disabled = !have;
    // (a preference kept in this browser, not a photo's edit)
    let wanted = false;
    try {
      wanted = localStorage.getItem('illuminator.viewFill') === '1';
    } catch {}
    $('view-fill').checked = have && wanted;
  }
  $('view-fill').addEventListener('change', () => {
    try {
      localStorage.setItem('illuminator.viewFill', $('view-fill').checked ? '1' : '0');
    } catch {}
  });
  refreshFillModel().catch(() => {});

  // First run after an install: a window listing the optional models that can be downloaded, and where to find them in Settings later. Shown once (not in automated runs).
  // Each ticked model is downloaded the way its Settings list does it, and that list is refreshed, so the model appears where it is used.
  async function showModelsIntro() {
    try {
      if (localStorage.getItem('illuminator.modelsIntro') === '1' || navigator.webdriver) return;
    } catch {
      return;
    }
    const dialog = $('models-intro-dialog');
    const list = $('models-intro-list');
    const gpuOk = await aiUpscaleAvailable();
    const groups = [
      { title: 'Depth models', where: 'Camera > Depth > Depth method', items: DEPTH_MODELS.map((m) => ({ m, have: () => depthModelState(m), get: (p) => downloadDepthModel(m, p) })), refresh: refreshDepthModels },
      { title: 'Upscaling models', where: 'Render Settings > Upscaling > Method', gpu: true, items: UPSCALE_MODELS.map((m) => ({ m, have: () => modelState(m), get: (p) => downloadModel(m, p) })), refresh: refreshUpscaleModels },
      { title: 'Sharpening models', where: 'Render Settings > Upscaling > Sharpening model', gpu: true, items: SHARPEN_MODELS.map((m) => ({ m, have: () => modelState(m), get: (p) => downloadModel(m, p) })), refresh: refreshSharpenModels },
      { title: 'Fill model', where: 'Camera > Perspective > Fill with AI', items: [{ m: FILL_MODEL, have: () => fillModelState(), get: (p) => downloadFillModel(p) }], refresh: refreshFillModel },
    ];
    const rows = [];
    for (const g of groups) {
      const head = document.createElement('h3');
      head.textContent = g.title;
      const where = Object.assign(document.createElement('p'), { className: 'hint', textContent: `Used in ${g.where}.` });
      list.append(head, where);
      for (const it of g.items) {
        const row = document.createElement('label');
        row.className = 'check model-row';
        const box = Object.assign(document.createElement('input'), { type: 'checkbox' });
        const text = document.createElement('span');
        text.textContent = `${it.m.name}, ${it.m.note} (${Math.round(it.m.size / 1e6)} MB)`;
        const status = Object.assign(document.createElement('span'), { className: 'hint model-state' });
        row.append(box, text, status);
        list.append(row);
        const have = (await it.have()) === 'ready';
        if (have) {
          box.checked = true;
          box.disabled = true;
          status.textContent = 'Downloaded';
        } else if (g.gpu && !gpuOk) {
          box.disabled = true;
          status.textContent = 'Needs a GPU';
        }
        rows.push({ g, it, box, status, have });
      }
    }
    // Nothing left to offer (every model is already here): no window.
    if (!rows.some((r) => !r.box.disabled)) {
      list.textContent = '';
      return;
    }
    try {
      localStorage.setItem('illuminator.modelsIntro', '1');
    } catch {
      // It may be shown again next time.
    }
    $('models-intro-go').onclick = async () => {
      const go = $('models-intro-go');
      go.disabled = true;
      const wanted = rows.filter((r) => r.box.checked && !r.box.disabled);
      let failed = 0;
      for (const r of wanted) {
        r.box.disabled = true;
        try {
          await r.it.get((p) => { r.status.textContent = `Downloading… ${Math.round(p * 100)}%`; });
          r.status.textContent = 'Downloaded';
        } catch (err) {
          failed++;
          r.box.checked = false;
          r.status.textContent = err && err.message ? err.message : String(err);
        }
      }
      for (const g of new Set(wanted.map((r) => r.g))) await g.refresh().catch(() => {});
      $('models-intro-status').textContent = failed ? 'Some models could not be downloaded; try again in Settings.' : wanted.length ? 'Done. Find them any time in Settings.' : '';
      go.disabled = false;
      if (wanted.length && !failed) dialog.close();
    };
    dialog.showModal();
  }
  // (after the first screen is up, so it does not hold the start)
  setTimeout(() => { showModelsIntro().catch(() => {}); }, 1500);

  async function refreshUpscaleModels() {
    const select = $('upscale-method');
    const before = select.value;
    const gpuOk = await aiUpscaleAvailable();
    const list = $('models-list');
    if (!list.children.length) {
      for (const m of UPSCALE_MODELS) {
        const row = document.createElement('label');
        row.className = 'check model-row';
        const box = Object.assign(document.createElement('input'), { type: 'checkbox' });
        box.dataset.model = m.id;
        const text = document.createElement('span');
        text.textContent = `${m.name}, ${m.note} (${Math.round(m.size / 1e6)} MB)`;
        const status = Object.assign(document.createElement('span'), { className: 'hint model-state' });
        row.append(box, text, status);
        list.append(row);
        box.onchange = async () => {
          if (modelBusy) {
            box.checked = !box.checked;
            return;
          }
          modelBusy = true;
          box.disabled = true;
          try {
            if (box.checked) {
              status.textContent = 'Downloading… 0%';
              await downloadModel(m, (p) => { status.textContent = `Downloading… ${Math.round(p * 100)}%`; });
            } else {
              await removeModel(m);
            }
            status.textContent = '';
          } catch (err) {
            box.checked = false;
            status.textContent = err && err.message ? err.message : String(err);
          }
          modelBusy = false;
          await refreshUpscaleModels();
        };
      }
    }
    for (const m of UPSCALE_MODELS) {
      const state = await modelState(m);
      const have = state === 'ready';
      const box = list.querySelector(`input[data-model="${m.id}"]`);
      // a model replaced in the repository since it was downloaded: the new one is fetched again by itself (it was chosen once already)
      if (state === 'stale' && !modelBusy && !updatingModels.has(m.id)) {
        updatingModels.add(m.id);
        const status = box.parentElement.querySelector('.model-state');
        status.textContent = 'Updating…';
        downloadModel(m, (p) => { status.textContent = `Updating… ${Math.round(p * 100)}%`; })
          .then(() => { status.textContent = ''; }, (err) => { status.textContent = err && err.message ? err.message : String(err); })
          .finally(() => { updatingModels.delete(m.id); refreshUpscaleModels().catch(() => {}); });
      }
      box.checked = have || state === 'stale';
      box.disabled = !gpuOk && !have;
      box.title = gpuOk ? '' : 'Needs a GPU';
      const value = modelMethod(m.id);
      const option = [...select.options].find((o) => o.value === value);
      if (have && !option) select.append(new Option(m.name, value));
      else if (!have && option) option.remove();
    }
    // a model that was the method and is gone: back to Lanczos
    if (before && ![...select.options].some((o) => o.value === before)) {
      select.value = 'lanczos';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (before) {
      select.value = before;
    }
    showUpscaleControls();
  }
  refreshUpscaleModels().catch(() => {});

  // Settings > Sharpening models: the same download list for models that keep the picture's size (core/upscalemodels.js, scale 1). A downloaded one is a choice under Render
  // Settings > Upscaling > Sharpening model, applied to saved photos and the picture made at its size before any enlargement.
  async function refreshSharpenModels() {
    const select = $('sharpen-model');
    const before = select.value;
    const gpuOk = await aiUpscaleAvailable();
    const list = $('sharpen-models-list');
    if (!list.children.length) {
      for (const m of SHARPEN_MODELS) {
        const row = document.createElement('label');
        row.className = 'check model-row';
        const box = Object.assign(document.createElement('input'), { type: 'checkbox' });
        box.dataset.model = m.id;
        const text = document.createElement('span');
        text.textContent = `${m.name}, ${m.note} (${Math.round(m.size / 1e6)} MB)`;
        const status = Object.assign(document.createElement('span'), { className: 'hint model-state' });
        row.append(box, text, status);
        list.append(row);
        box.onchange = async () => {
          if (modelBusy) {
            box.checked = !box.checked;
            return;
          }
          modelBusy = true;
          box.disabled = true;
          try {
            if (box.checked) {
              status.textContent = 'Downloading… 0%';
              await downloadModel(m, (p) => { status.textContent = `Downloading… ${Math.round(p * 100)}%`; });
            } else {
              await removeModel(m);
            }
            status.textContent = '';
          } catch (err) {
            box.checked = false;
            status.textContent = err && err.message ? err.message : String(err);
          }
          modelBusy = false;
          await refreshSharpenModels();
        };
      }
    }
    for (const m of SHARPEN_MODELS) {
      const have = (await modelState(m)) === 'ready';
      const box = list.querySelector(`input[data-model="${m.id}"]`);
      box.checked = have;
      box.disabled = !gpuOk && !have;
      box.title = gpuOk ? '' : 'Needs a GPU';
      const value = sharpenMethod(m.id);
      const option = [...select.options].find((o) => o.value === value);
      if (have && !option) select.append(new Option(m.name, value));
      else if (!have && option) option.remove();
    }
    if (before && ![...select.options].some((o) => o.value === before)) select.value = '';
    else select.value = before;
    const any = select.options.length > 1;
    $('sharpen-model-row').hidden = !any;
    $('sharpen-model-amount-row').hidden = !any || !select.value;
  }
  refreshSharpenModels().catch(() => {});
  $('sharpen-model').addEventListener('change', () => {
    $('sharpen-model-amount-row').hidden = !$('sharpen-model').value;
    scheduleSave();
  });

  // Settings > Memory (the desktop app): the most RAM and video memory the app may plan to use, from 1 GB up to what the computer has less what the system keeps (4 GB of RAM, 512 MB of video memory). At the top
  // of the range (the start) there is no limit of the app's own. The limits size the heavy steps (a full sensor render, a 16-bit export, an upscaling model; core/memorybudget.js)
  // and, when the app starts, cap its JavaScript heap and the video memory Chromium plans for (electron/main.cjs).
  const GIB = 1024 ** 3;
  async function setupMemorySettings() {
    if (!native || !native.systemMemory) return;
    const sys = await native.systemMemory();
    const top = (bytes, reserve) => Math.max(1, Math.floor(((bytes - reserve) / GIB) * 2) / 2);
    const rows = [
      { key: 'ramGb', input: $('mem-ram'), out: $('mem-ram-out'), max: top(sys.ramBytes, sys.ramReserveBytes), title: `This computer has ${(sys.ramBytes / GIB).toFixed(1)} GB of RAM; 4 GB are left for the system. Applies when the app starts.` },
      { key: 'vramGb', input: $('mem-vram'), out: $('mem-vram-out'), max: top(sys.vramBytes, sys.vramReserveBytes), title: `Video memory found: ${(sys.vramBytes / GIB).toFixed(1)} GB (${sys.vramSource}); 512 MB are left for the system. Applies when the app starts.` },
    ];
    const apply = (save) => {
      const gb = Object.fromEntries(rows.map((r) => [r.key, +r.input.value]));
      setMemoryLimits({ ramBytes: gb.ramGb * GIB, vramBytes: gb.vramGb * GIB });
      engine.request('memoryLimits', { ramBytes: gb.ramGb * GIB, vramBytes: gb.vramGb * GIB }).catch(() => {});
      // at the top of a range: no limit kept, so more memory in the computer later raises it by itself
      if (save) native.setMemoryLimits(Object.fromEntries(rows.map((r) => [r.key, gb[r.key] >= r.max ? null : gb[r.key]]))).catch(() => {});
    };
    for (const r of rows) {
      const saved = sys.limits && sys.limits[r.key];
      r.input.max = r.max;
      r.input.min = Math.min(1, r.max);
      r.input.value = saved ? Math.min(saved, r.max) : r.max;
      r.input.disabled = r.max <= 1;
      r.input.title = r.title;
      r.out.textContent = `${r.input.value} GB`;
      r.input.oninput = () => {
        r.out.textContent = `${r.input.value} GB`;
        apply(false);
      };
      r.input.onchange = () => apply(true);
    }
    $('memory-setting').hidden = false;
    apply(false);
  }
  setupMemorySettings().catch((err) => console.warn('Could not read the computer\'s memory', err));

  // Settings > Check for updates on startup (the desktop app; Help > Check for Updates works whatever it says).
  $('updates-setting').hidden = !native;
  $('check-updates').checked = updateCheckOn();
  $('check-updates').onchange = () => {
    try {
      localStorage.setItem('illuminator.checkUpdates', $('check-updates').checked ? '1' : '0');
    } catch {
      // Not remembered.
    }
  };

  $('settings-btn').onclick = async () => {
    await showLibraryLocation();
    $('cal-note').textContent = '';
    showCalibrations();
    $('settings-btn').setAttribute('aria-expanded', 'true');
    $('settings-dialog').showModal();
  };
  $('settings-dialog').addEventListener('close', () => $('settings-btn').setAttribute('aria-expanded', 'false'));

  // The About window shows the top bar's logo.
  $('about-title').prepend(document.querySelector('.toolbar h1 .logo').cloneNode(true));

  // Full screen: the whole app fills the screen (the desktop app's window too).
  function showFullscreen() {
    const on = !!document.fullscreenElement;
    const b = $('fullscreen-btn');
    b.setAttribute('aria-pressed', String(on));
    b.title = on ? 'Exit full screen' : 'Full screen';
    b.setAttribute('aria-label', b.title);
    b.querySelector('.fs-enter').hidden = on;
    b.querySelector('.fs-exit').hidden = !on;
  }
  $('fullscreen-btn').hidden = !document.fullscreenEnabled;
  $('fullscreen-btn').onclick = () => {
    const done = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    Promise.resolve(done).catch(() => {});
  };
  document.addEventListener('fullscreenchange', showFullscreen);

  $('about-btn').onclick = () => {
    $('about-version').textContent = VERSION;
    $('about-btn').setAttribute('aria-expanded', 'true');
    $('about-dialog').showModal();
  };
  $('about-dialog').addEventListener('close', () => $('about-btn').setAttribute('aria-expanded', 'false'));

  $('library-choose').onclick = async () => {
    if (!native) return;
    await useLibrary(() => native.chooseLibraryDir()).catch((err) => showError(err));
    await showLibraryLocation();
  };
  return { importFolder, sendCalibrations };
}
