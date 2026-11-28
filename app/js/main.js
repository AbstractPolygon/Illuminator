import { VERSION } from './version.js';
import { readEdits, writeEdits, editsStore, EDITS_FORMAT, EDITS_VERSION, EDIT_GROUPS } from './edits.js';
const EDIT_GROUPS_CAMERA = new Set(EDIT_GROUPS.camera);
import { Engine, toImageData } from './engine.js';
import { PreviewMirror } from './ui/previewmirror.js';
import { sliderStep } from './ui/exactslider.js';
import { F_STOPS } from './core/fstops.js';
import { initRetouch } from './ui/retouch.js';
import { initColorGrading } from './ui/colorwheel.js';
import { initHistogramEditing } from './ui/histedit.js';
import { initScriptingApi } from './ui/api.js';
import { tiltPreset } from './core/tiltpresets.js';
import { initMarks } from './ui/marks.js';
import { initLooks } from './ui/looks.js';
import { initQueue } from './ui/queue.js';
import { blobReader, openContainer } from './core/lfp.js';
import { PHOTO_ACCEPT } from './core/photoformats.js';
import { EXTRA } from './extra.js';
import { findRecipe, recipeToEdits } from './core/recipe.js';
import { decodePngGray, parseDepthRange, stackDepth } from './core/userdepth.js';
import { upscaleBits16 } from './gpu/upscale.js';
import { encodeProcessed, decodeProcessed } from './core/processed-cache.js';
import { hashKey, stillKeyText } from './core/still-cache.js';
import { bokehKernel, ballRGB, encodeBokehImage, BOKEH_IMAGE_SIZE } from './core/dof.js';
import { sharpenModelOf, methodModel, readModel } from './core/upscalemodels.js';
import { aiUpscale, aiSharpen, denoiseRgb16, addGrain16 } from './core/aiupscale.js';
import { methodDepthModel } from './core/depthmodels.js';
import { fitsMemory, memoryProblem, superResVram } from './core/memorybudget.js';
import { NativeFile, openFiles, isLightFieldName, findSidecar, download, native, CAMERA_IMPORT, LYTRO_USB_VENDOR, recallCameraFolder, captureDownloads } from './platform.js';
import { groupPhotos } from './library/scan.js';
import { MAX_MASKS } from './core/local.js';
import { ARCHIVE_SUFFIX } from './library/archive.js';
import { FPS as DEFAULT_FPS, emptyAnimation, isSettingTrack } from './core/keyframes.js';

// Frames a second of animations: for playback, keyframe times and video
// (the Frame rate setting).
import { geometry, isIdentity, apply as applyMatrix, invert, rotateOrientation, flipOrientation, flipVerticalOrientation, fitAspect, FULL_CROP } from './core/geometry.js';
import { hook, setHook } from './core/debugflags.js';
import { preColorKey } from './core/precolorkey.js';
import { colorSettings as buildColorSettings, renderSettings as buildRenderSettings, FRINGES } from './settingsmap.js';
import { initStereo } from './ui/stereo.js';
import { initLenticular } from './ui/lenticular.js';
import { initFrameRate } from './ui/framerate.js';
import { initUpdates } from './ui/updates.js';
import { initLocalAdjustments } from './ui/localadjust.js';
import { initLivingFilters } from './ui/livingfilters.js';
import { initKeyframes } from './ui/keyframes.js';
import { initCurvesView } from './ui/curvesview.js';
import { initExport } from './ui/export.js';
import { initCameraImport } from './ui/cameraimport.js';
import { initCameraSection } from './ui/camerasection.js';
import { initCameraWifi } from './ui/camerawifi.js';
import { initLut } from './ui/lut.js';
import { initWhiteBalancePicker } from './ui/whitebalance.js';
import { initColorMatrix } from './ui/colormatrix.js';
import { initToneCurve } from './ui/tonecurve.js';
import { initAnimation } from './ui/animation.js';
import { initL16Zoom } from './ui/l16zoom.js';
import { initModes } from './ui/modes.js';
import { initHistogram } from './ui/histogram.js';
import { initPeaking } from './ui/peaking.js';
import { initNumberFields } from './ui/numberfields.js';
import { initProgress } from './ui/progress.js';
import { initLibrary } from './ui/library.js';
import { initMenus } from './ui/menus.js';
import { initAlbums } from './ui/albums.js';
import { initGrid } from './ui/grid.js';
import { initFilmstrip } from './ui/filmstrip.js';
import { initLenslets } from './ui/lenslets.js';
import { initInfo } from './ui/info.js';
import { initSpeedReport } from './ui/speedreport.js';
import { initSettings } from './ui/settings.js';

const $ = (id) => document.getElementById(id);
const engine = new Engine();
// A second worker for quick previews while the first is busy (ui/previewmirror.js), only while Animation is enabled.
const previewMirror = new PreviewMirror(engine, { onLog: (...a) => console.info(...a) });
engine.onNotice = (text) => showNotice(text);
// The worker stopped: the requests waiting for it have failed (their callers clean up); what is left is the page's own busy flags, and the photo, which only the
// worker held, must be opened again.
engine.onWorkerLost = () => {
  previewMirror.stop();
  openSeq.next();
  state.view.busy = false;
  state.view.pending = false;
  spreadView.busy = false;
  spreadView.pending = false;
  state.applyAgain = false;
  hideProgress();
  showNotice('The rendering stopped unexpectedly', 'Open the photo again to keep working on it.');
};
// (the new worker is told again to keep full sensor pictures)
engine.onRecreate = () => { if (native) engine.request('stillStore', { on: true }).catch(() => {}); };
const canvas = $('view');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

const state = {
  info: null,
  mode: 'camera', // or 'lenslets'
  camera: { u: 0, v: 0 }, // viewpoint, sensor pixels within the lens aperture
  focusPoint: { x: 0.5, y: 0.5 }, // focus spread and tilt center, normalized picture coordinates
  // Camera mode shows either the live camera view or, while playing or
  // scrubbing, a frame of the animation.
  showingFrames: false,
  frames: [], // ImageBitmap | undefined while rendering
  frameValues: [], // focus value per frame of a focus sweep
  animKey: null, // settings the current frames were rendered with
  animDone: null, // promise resolved when every frame has arrived
  loop: 'loop', // or 'pingpong'
  repeat: true, // play over and over (the loop button)
  index: 0,
  direction: 1,
  playing: false,
  fps: DEFAULT_FPS,
  lastTick: 0,
  still: null, // ImageData of the full resolution render
  fullResMode: false, // the Full sensor checkbox
  fullRes: false, // a full resolution still is shown (or rendering)
  depthShown: false,
  album: null, // album shown in the sidebar (null: all photos)
  current: null, // { photo, name, file, sidecar } of the open photo
  view: { busy: false, pending: false },
  maskSel: -1, // the local adjustment mask being edited (-1: none)
  anim: emptyAnimation(), // the keyframes of the animation (core/keyframes.js)
  keySel: null, // { k, t }: the main selected keyframe
  upscaleShown: null, // the upscaling method whose settings the sliders hold
  lib: null, // the photo library (library/library.js), once opened
  cameraSection: {}, // what the camera section of the sidebar shows
  rememberedFailed: false, // the remembered camera folder could not be read
  webUsbConn: null, // the connected camera over WebUSB
  webUsbDevice: null,
  webUsbReport: '',
  askCameraPermission: async () => false, // set when the desktop app can watch for a camera
  emitEvent: () => {}, // events for scripts and plugins (ui/api.js), set once the interface exists
  marks: null, // ratings, flags and keywords of the library (ui/marks.js), set once the page is ready
  retouchUi: null, // the Retouch section (ui/retouch.js), set once the page is ready
  queueUi: null, // the render queue panel (ui/queue.js)
  looks: null, // the Looks panel (ui/looks.js)
  previewing: false, // an Animation > Preview is rendering
  processing: null, // { photo, my, drawn, prepared } for the photo being opened
  libReady: null, // the library's opening (a promise)
  calReady: Promise.resolve(), // the calibrations sent to the engine
  selectMode: false, // a click picks a photo (otherwise it opens it, and Ctrl/Cmd-click or Shift-click pick)
  gridOrder: [], // the ids of the photos the grid shows, in order
  gridTiles: new Map(), // the grid's tiles by photo id
  menuEl: null, // the open menu
  pressHandledUntil: 0, // a press on a photo was handled (see the opening section)
  pressHandledId: null,
  nrFinalTimer: 0, // the finished picture with noise reduction, asked for once the changes stop
  recoveryRunning: false,
  autoRenderTimer: 0,
  speedFacts: null, // the Speed block's facts (the speed report section)
  suppressClick: false, // a drag suppresses the click that follows it
  lastClick: null, // the last focus click
  depthModelShown: null, // the depth model method whose settings the sliders hold
  checkForUpdateNow: () => {}, // set by ui/updates.js
  saveTimer: 0,
  lastHistoryKey: 0,
  applyAgain: false,
};
// Lenslets mode view: `z` screen pixels per sensor pixel, (x, y) the sensor
// point at the middle of the viewer.
const lensView = { x: null, y: null, z: 4 };

// progress: ui/progress.js
const { PREVIEW_IDS, busy, busyBadge, beginProcessing, updateProcessing, FIRST_PICTURE, processingStep, endProcessing, showProgress, noteBusy, clearBusy, hideProgress, openSeq, staleSeq, progressFor, showError, showOpenError } = initProgress({ $: (...a) => $(...a), state, canvas, showNotice: (...a) => showNotice(...a), startNoticeTimer: (...a) => startNoticeTimer(...a) });

// library: ui/library.js
const { thumbs, PHOTO_DRAG, selection, QUEUE_RUNNER, openLibrary, thumbFor, saveThumbnail, EMPTY_LIBRARY, cameraThumbs, photoSig, renderLibrary } = initLibrary({ state, renderLibraryHead: (...a) => renderLibraryHead(...a), canvas, openSeq, virtualMasterName: (...a) => virtualMasterName(...a), busy, renderAlbums: (...a) => renderAlbums(...a), $: (...a) => $(...a), photoMenu: (...a) => photoMenu(...a), busyBadge: (...a) => busyBadge(...a), chooseListedPhoto: (...a) => chooseListedPhoto(...a), renderCameraSection: (...a) => renderCameraSection(...a), renderCameraGrid: (...a) => renderCameraGrid(...a), renderGrid: (...a) => renderGrid(...a), renderFilmstrip: (...a) => renderFilmstrip(...a) });

// libraries and the albums list: ui/albums.js
const { renderLibraryHead, useLibrary, renderAlbums } = initAlbums({ $: (...a) => $(...a), editName: (...a) => editName(...a), showError: (...a) => showError(...a), flushSave: (...a) => flushSave(...a), flushProcessed: (...a) => flushProcessed(...a), state, closePhoto: (...a) => closePhoto(...a), setSelectMode: (...a) => setSelectMode(...a), openLibrary: (...a) => openLibrary(...a), sendCalibrations: (...a) => sendCalibrations(...a), showGrid: (...a) => showGrid(...a), confirmInMenu: (...a) => confirmInMenu(...a), showMenu: (...a) => showMenu(...a), albumMenu: (...a) => albumMenu(...a), PHOTO_DRAG, renderLibrary: (...a) => renderLibrary(...a) });

// film strip and the way back to the thumbnails: ui/filmstrip.js
const { showPhotoNav, renderFilmstrip } = initFilmstrip({ state, $: (...a) => $(...a), thumbFor: (...a) => thumbFor(...a), selection, chooseListedPhoto: (...a) => chooseListedPhoto(...a), photoMenu: (...a) => photoMenu(...a), showGrid: (...a) => showGrid(...a) });

// grid: ui/grid.js
const { showGrid, setThumbSize, renderGrid, showSelection, setSelectMode, deletionWhere, removePhotos, editName, newAlbum } = initGrid({ state, showPhotoNav, $: (...a) => $(...a), setPlaying: (...a) => setPlaying(...a), renderLibrary: (...a) => renderLibrary(...a), layoutCanvas: (...a) => layoutCanvas(...a), selection, thumbFor: (...a) => thumbFor(...a), photoSig: (...a) => photoSig(...a), PHOTO_DRAG, busyBadge: (...a) => busyBadge(...a), busy, virtualMasterName: (...a) => virtualMasterName(...a), photoMenu: (...a) => photoMenu(...a), openItem: (...a) => openItem(...a), EMPTY_LIBRARY, showMenu: (...a) => showMenu(...a), confirmInMenu: (...a) => confirmInMenu(...a), cancelSaves: (...a) => cancelSaves(...a), thumbs, closePhoto: (...a) => closePhoto(...a) });

// menus: ui/menus.js
const { closeMenu, showMenu, confirmInMenu, virtualMasterName, photoMenu, albumMenu, importPhotos } = initMenus({ state, showError: (...a) => showError(...a), flushSave: (...a) => flushSave(...a), currentEdits: (...a) => currentEdits(...a), defaultEdits: () => DEFAULT_EDITS, applyEdits: (...a) => applyEdits(...a), scheduleSave: (...a) => scheduleSave(...a), $: (...a) => $(...a), renderLibrary: (...a) => renderLibrary(...a), editName: (...a) => editName(...a), showNotice: (...a) => showNotice(...a), openItem: (...a) => openItem(...a), selection, resetPhotoSettings: (...a) => resetPhotoSettings(...a), newAlbum: (...a) => newAlbum(...a), removePhotos: (...a) => removePhotos(...a), deletionWhere: (...a) => deletionWhere(...a), exportAlbum: (...a) => exportAlbum(...a), showProgress: (...a) => showProgress(...a), thumbs, hideProgress: (...a) => hideProgress(...a) });

// ---------------------------------------------------------------- opening

// With the Render Queue view open, Ctrl/Command-click and Shift-click choose several photos to add (ui/queue.js).
// A click on a photo in the sidebar list or the film strip: it opens the photo, or (Ctrl/Cmd: one more or one less; Shift: all from the last one picked to this one) picks it, with the same
// selection the grid has (Delete takes the picked photos out, and ••• on a picked photo acts on all of them where it can).
function chooseListedPhoto(photo, e) {
  if (state.queueUi && state.queueUi.pick(photo, e)) return;
  const order = (state.listedPhotos || []).map((p) => p.id);
  if (e && e.shiftKey) {
    // (the open photo is where a range starts when nothing was picked)
    if (!selection.size && state.current && state.current.photo && order.includes(state.current.photo.id)) selection.toggle(state.current.photo.id);
    selection.range(order, photo.id);
    showSelection();
    return;
  }
  if (e && (e.ctrlKey || e.metaKey)) {
    if (!selection.size && state.current && state.current.photo && state.current.photo.id !== photo.id && order.includes(state.current.photo.id)) selection.toggle(state.current.photo.id);
    selection.toggle(photo.id);
    showSelection();
    return;
  }
  if (selection.size) {
    selection.clear();
    showSelection();
  }
  openItem(photo);
}

// One click on a photo in the sidebar opens it. A click is only sent when the pointer is released on the element it was pressed on, and the list is rebuilt whenever something
// changes (a thumbnail arrives, a field that loses focus saves its value), so a press could lose its click and the photo needed a second one. The photo is chosen when the pointer is
// released over the same photo instead, whether or not the row was rebuilt in between. (A drag to an album ends without a release on a row of the same photo; the keyboard still
// uses click.)
let pressedPhotoId = null;
const photoRowAt = (target) => (target && target.closest && !target.closest('button, input, select, a') ? target.closest('#library-list li') : null);
$('library-list').addEventListener('pointerdown', (e) => {
  const row = e.button === 0 ? photoRowAt(e.target) : null;
  pressedPhotoId = row ? row.dataset.photoId : null;
});
$('library-list').addEventListener('pointerup', (e) => {
  const id = pressedPhotoId;
  pressedPhotoId = null;
  const row = e.button === 0 ? photoRowAt(e.target) : null;
  if (!id || !row || row.dataset.photoId !== id) return;
  const photo = (state.listedPhotos || []).find((p) => p.id === id);
  if (!photo) return;
  state.pressHandledId = id;
  state.pressHandledUntil = performance.now() + 500;
  chooseListedPhoto(photo, e);
});

async function openItem(photo) {
  // A pending Pick focus point (Lenticular Print) was for the photo that was open.
  cancelLentPick();
  // A click on another photo while this one is still loading takes over: everything below stops at its next await.
  const my = openSeq.next();
  state.scripted = false;
  closeMenu();
  beginProcessing(photo, my);
  // The photo on show keeps its last change before the view is reset or the controls are rewritten.
  await flushSave();
  if (openSeq.superseded(my)) return;
  await state.calReady;
  if (openSeq.superseded(my)) return;
  const file = await state.lib.file(photo).catch(() => null);
  if (openSeq.superseded(my)) return;
  if (!file) {
    endProcessing(my);
    showOpenError(new Error(`${photo.name} is missing from the library folder.`));
    return;
  }
  const sidecar = await state.lib.sidecar(photo).catch(() => null);
  if (openSeq.superseded(my)) return;
  // (a change made while the files were read)
  const saved = flushSave();
  state.current = { photo, name: photo.name, file, sidecar };
  state.editsKey = null; // no save of the old controls into this photo until its edits are restored
  timings.clear(); // the speed report starts again with the photo
  if (state.grid) showGrid(false);
  renderLibrary();
  await saved;
  const bytes = await file.arrayBuffer();
  if (openSeq.superseded(my)) return;
  const { userDepth, depthCache, transfer } = await depthInputs(photo, [bytes]);
  // (a Light L16 photo: what an earlier opening measured, kept next to it, core/l16-cache.js)
  const l16Cache = keepsDepth() ? await state.lib.l16Cache(photo).catch(() => null) : null;
  if (l16Cache) transfer.push(l16Cache);
  if (openSeq.superseded(my)) return;
  await openWith({ bytes, userDepth, depthCache, l16Cache }, transfer, my);
  if (!openSeq.superseded(my) && state.info && state.current && state.current.photo === photo) state.lib.setPhotoId(photo, state.info.photoId).catch(() => {});
}

// Whether the measured depth is kept next to each library photo: where the library is kept between sessions (the desktop app's folder, or the browser's storage in the web app), and
// not for a library that lives only in this session's memory.
const keepsDepth = () => !!(state.lib && state.lib.persistent);

// What a library photo brings to opening besides its file: the depth map made in Lytro Desktop, and (desktop app) the processed version kept next to the photo, so the depth is not
// measured again (core/processed-cache.js). `transfer` starts with the buffers already going to the worker and gets theirs added.
async function depthInputs(photo, transfer = []) {
  const [userDepth, depthCache] = await Promise.all([
    readUserDepth(photo),
    keepsDepth() ? state.lib.processed(photo).catch(() => null).then(decodeProcessed) : null,
  ]);
  return { userDepth, depthCache, transfer: depthTransfer(userDepth, depthCache, transfer) };
}

// Adds the buffers of these depth inputs to the list of what is handed over to the worker (not copied).
function depthTransfer(userDepth, depthCache, transfer) {
  if (userDepth) transfer.push(userDepth.data.buffer);
  if (depthCache) transfer.push(depthCache.alpha.buffer, ...depthCache.extra.flatMap((e) => [e.alpha.buffer, e.confidence.buffer]));
  return transfer;
}

// The worker measured something worth keeping (the depth, the focus offset): saved next to the photo, a moment after the last change.
let processedTimer = null;
// The Render Queue's hidden copy has no library: the page that runs the queue takes the latest of these and keeps it (api.processed).
const holdProcessed = (msg) => {
  if (staleSeq(msg.openSeq)) return;
  state.lastProcessed = { photoId: msg.photoId, cache: msg.cache };
};
// The save waiting for its moment: which photo it is for, and what to write.
let pendingProcessed = null;
function flushProcessed() {
  clearTimeout(processedTimer);
  processedTimer = null;
  const p = pendingProcessed;
  pendingProcessed = null;
  if (p && state.lib) return state.lib.saveProcessed(p.photo, encodeProcessed(p.cache)).catch((err) => console.warn('Could not save the processed version', err));
  return Promise.resolve();
}
const saveProcessed = (msg) => {
  if (staleSeq(msg.openSeq)) return;
  if (!keepsDepth() || !state.current || !state.current.photo || !state.info || state.info.photoId !== msg.photoId) return;
  const photo = state.current.photo;
  // Another photo's measuring that is still waiting is written now, not replaced by this one.
  if (pendingProcessed && pendingProcessed.photo !== photo) flushProcessed();
  clearTimeout(processedTimer);
  pendingProcessed = { photo, cache: msg.cache };
  processedTimer = setTimeout(flushProcessed, 1500);
};
engine.onCache = QUEUE_RUNNER ? holdProcessed : saveProcessed;
// A Light L16 photo's measurements (the depth between its cameras and the merged picture): kept next to the photo, so it opens in seconds the next time.
engine.onL16Cache = (msg) => {
  if (QUEUE_RUNNER || staleSeq(msg.openSeq) || !keepsDepth() || !state.current || !state.current.photo) return;
  const photo = state.current.photo;
  state.lib.saveL16Cache(photo, msg.bytes).catch((err) => console.warn('Could not keep the L16 measurements', err));
};

// The worker made a full sensor picture before its color pass: saved next to the photo (desktop app), so a color change on a photo opened again does not render it again.
engine.onStillKept = (msg) => {
  if (staleSeq(msg.openSeq) || !native || !state.lib || !state.current || !state.info || state.info.photoId !== msg.photoId) return;
  state.lib.saveKeptPicture(state.current.photo, msg.hash, msg.bytes).catch((err) => console.warn('Could not keep the full sensor picture', err));
};
// ...and asks for one it may have saved.
engine.onStillWant = async (msg) => {
  let bytes = null;
  if (!staleSeq(msg.openSeq) && native && state.lib && state.current && state.info && state.info.photoId === msg.photoId) bytes = await state.lib.keptPicture(state.current.photo, msg.hash).catch(() => null);
  engine.request('stillData', { nonce: msg.nonce, bytes }, { transfer: bytes ? [bytes] : [] });
};
// Only the desktop app keeps them: the worker then reads each picture back and encodes it.
if (native) engine.request('stillStore', { on: true });

// The depth map from Lytro Desktop, kept with the photo when its library
// was imported: used instead of measuring depth (core/userdepth.js). An
// edited one if there is one, else the one Lytro computed (in stack.lfp).
async function readUserDepth(photo) {
  try {
    const files = await state.lib.userDepth(photo);
    if (!files) {
      const stack = await state.lib.stack(photo);
      return stack ? await stackDepth(new Uint8Array(await stack.arrayBuffer())) : null;
    }
    const range = parseDepthRange(new TextDecoder().decode(await files.range.arrayBuffer()));
    if (!range) return null;
    const bytes = new Uint8Array(await files.image.arrayBuffer());
    let map = await decodePngGray(bytes).catch(() => null);
    if (!map) {
      // Not a PNG we read ourselves: the browser decodes it (8 bit).
      const bmp = await createImageBitmap(new Blob([bytes]));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      g.drawImage(bmp, 0, 0);
      const px = g.getImageData(0, 0, bmp.width, bmp.height).data;
      const data = new Float32Array(bmp.width * bmp.height);
      for (let i = 0; i < data.length; i++) data[i] = px[i * 4] / 255;
      map = { width: bmp.width, height: bmp.height, data };
    }
    return { ...map, ...range };
  } catch (err) {
    console.warn('Lytro depth map unreadable', err);
    return null;
  }
}

function resetView() {
  finishCrop(false);
  state.lastImage = null;
  state.geom = null;
  hideNotice();
  state.notice = null;
  resetAnimation();
  state.info = null;
  state.still = null;
  state.lensStill = null;
  state.lensPicture = null;
  lensView.x = lensView.y = null;
  state.camera = { u: 0, v: 0 };
  showViewpoint();
  state.focusPoint = { x: 0.5, y: 0.5 };
  state.lastClick = null; // (a click on the photo before is not applied again to the depth of this one)
  showFocusPoint();
  $('spread-overlay').hidden = true;
  setFullRes(false, { restore: false });
  setDepthShown(false, { restore: false });
  showSidebarEnabled();
}

function cancelLentPick() {
  if (!state.lentPick) return;
  state.lentPick = null;
  canvas.style.cursor = '';
  try {
    lenticular.showFocus();
  } catch {
    // (not set up yet)
  }
}

function closePhoto() {
  cancelLentPick();
  // Its last change is kept, and nothing in flight (an open, a render) lands on the empty view.
  endProcessing();
  flushSave();
  flushProcessed();
  openSeq.next();
  clearTimeout(state.saveTimer);
  state.saveTimer = 0;
  state.editsKey = null;
  resetView();
  renderMasks();
  if (state.retouchUi) {
    state.retouchUi.setTool(null);
    state.retouchUi.renderList();
  }
  $('histogram').getContext('2d').clearRect(0, 0, 256, 80);
  state.current = null;
  showPhotoNav();
  canvas.classList.add('hidden');
  $('placeholder').hidden = false;
  $('placeholder').innerHTML = '<p>Drop a Lytro <code>.LFR</code> or <code>.LFP</code> file, or a Light L16 <code>.LRI</code> file, here.</p>';
  $('info').replaceChildren();
  $('speed').hidden = true;
  if (state.queueUi) setTimeout(() => state.queueUi.render(), 0);
  if (state.looks) setTimeout(() => state.looks.render(), 0);
  $('frame-label').textContent = '';
  setMode(state.mode);
}

async function openWith(args, transfer, my = openSeq.next()) {
  resetView();
  // After the reset, so a picture of the photo before cannot become this one's saved thumbnail.
  state.wantThumb = !!(state.current && state.current.photo && !state.current.photo.thumb);
  try {
    const shown = progressFor(my);
    const info = await engine.request('open', { ...args, openSeq: my }, { transfer, onProgress: (stage, p) => { shown(stage, p); updateProcessing(my, stage, p); } });
    if (openSeq.superseded(my)) return;
    hideProgress();
    state.info = info;
    // The photo is open but its first picture is not drawn yet (the depth may still have to be measured): say so.
    if (state.processing && state.processing.my === my && !state.processing.drawn) {
      showProgress(FIRST_PICTURE, null);
      // With no picture on screen, the spinner stays in the empty area until it is drawn.
      if (canvas.classList.contains('hidden')) {
        const text = Object.assign(document.createElement('p'), { textContent: `${FIRST_PICTURE}…` });
        $('placeholder').replaceChildren(Object.assign(document.createElement('div'), { className: 'spinner' }), text);
      } else $('placeholder').hidden = true;
    } else $('placeholder').hidden = true;
    await restoreEdits(info);
    if (openSeq.superseded(my)) return;
    showAutoFringe();
    renderInfo();
    if (!info.hasRaw && !info.processed) throw new Error('The file contains no light field image.');
    setMode(state.mode);
    if (state.notice) showNotice(...state.notice);
    if (info.hasRaw) {
      // The background preparation of the photo (refocus views, depth) is part of its first processing: the bar and the spinner stay until it is done.
      let last = null;
      engine.request('prepare', {}, {
        onProgress: (stage, p) => {
          if (openSeq.superseded(my)) return;
          last = stage;
          showProgress(stage, p);
          updateProcessing(my, stage, p);
        },
      }).catch(() => {}).finally(() => {
        if (openSeq.superseded(my)) return;
        if (last && $('progress-text').textContent === last) hideProgress();
        processingStep(my, 'prepared');
      });
    } else processingStep(my, 'prepared');
    state.emitEvent('photoOpened', { name: state.current ? state.current.name : null, raw: !!info.hasRaw });
  } catch (err) {
    if (!openSeq.superseded(my)) {
      endProcessing(my);
      showOpenError(err);
    }
  }
}

// Stops the saves still waiting for a photo that is going away (deleted): nothing may write its folder again.
function cancelSaves(photo) {
  if (state.current && state.current.photo === photo) {
    clearTimeout(state.saveTimer);
    state.saveTimer = 0;
    state.editsKey = null;
  }
  if (pendingProcessed && pendingProcessed.photo === photo) {
    clearTimeout(processedTimer);
    processedTimer = null;
    pendingProcessed = null;
  }
}


// ---------------------------------------------------------------- drawing

// `gen`: the open generation the picture was asked for in; a picture of the photo before is dropped.
function draw(img, gen = openSeq.current()) {
  if (!img || openSeq.superseded(gen)) return;
  clearBusy();
  processingStep(gen, 'drawn');
  state.enlarged = false;
  if (img.pair) return drawPair(img);
  startNoticeTimer();
  state.lastImage = img;
  const g = geometryFor(img.width, img.height);
  const k = g && state.showingFrames ? state.frameScale || 1 : 1;
  const w = Math.round((g ? g.width : img.width) * k);
  const h = Math.round((g ? g.height : img.height) * k);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    layoutCanvas();
  }
  if (!state.photoBase || state.photoBase[0] !== w || state.photoBase[1] !== h) {
    state.photoBase = [w, h];
    showPhotoSizes();
  }
  state.geom = g ? { ...g, inverse: invert(k === 1 ? g.matrix : g.matrix.map((v) => v * k)), srcW: img.width, srcH: img.height } : null;
  if (g) drawGeometry(ctx, img, g, k);
  else if (img instanceof ImageData) ctx.putImageData(img, 0, 0);
  else ctx.drawImage(img, 0, 0);
  if (cropState.editing) positionCropBox();
  canvas.classList.remove('hidden');
  scheduleDetail();
  scheduleHoles();
  // What the app shows is enlarged with the Upscaling settings too, as it will be saved or exported (not while dragging, nor the depth map).
  if (!drag.on && !state.depthShown && !state.skipEnlarge && state.mode === 'camera') showAtPhotoSize(shownScale(w, h));
  scheduleHistogram();
  if (state.wantThumb && state.mode === 'camera') saveThumbnail();
  state.emitEvent('rendered', { width: w, height: h });
  if (state.retouchUi) state.retouchUi.drawOverlay();
}

// A stereo pair next to each other (left eye first, or right eye first for
// cross-eyed viewing), each eye through the crop and rotation.
function drawPair(img) {
  startNoticeTimer();
  state.lastImage = img;
  const [first, second] = img.mode === 'cross' ? [img.pair[1], img.pair[0]] : img.pair;
  const g = geometryFor(first.width, first.height);
  const w = g ? g.width : first.width;
  const h = g ? g.height : first.height;
  if (canvas.width !== 2 * w || canvas.height !== h) {
    canvas.width = 2 * w;
    canvas.height = h;
    layoutCanvas();
  }
  state.geom = null;
  const eye = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const e = eye.getContext('2d');
  [first, second].forEach((view, i) => {
    if (g) drawGeometry(e, view, g);
    else e.putImageData(view, 0, 0);
    ctx.drawImage(eye, i * w, 0);
  });
  canvas.classList.remove('hidden');
  scheduleHistogram();
}

// histogram: ui/histogram.js
const { scheduleHistogram, fNumber, opticalInEffect, apertureFor, showFNumber, focusField, BOKEH_SHAPE, bokehParams, viewReach, showViewpoint, showFocusPoint, spreadView, updateSpreadOverlay } = initHistogram({ engine, drawPeaking: (...a) => drawPeaking(...a), refreshDepthRuler: (...a) => refreshDepthRuler(...a), $: (...a) => $(...a), canvas, state, ctx, hasDepth: (...a) => hasDepth(...a), openSeq, progressFor: (...a) => progressFor(...a), hideProgress: (...a) => hideProgress(...a), geometrySettings: (...a) => geometrySettings(...a), drawGeometry: (...a) => drawGeometry(...a), showError: (...a) => showError(...a) });

// focus peaking: ui/peaking.js
const { drawPeaking } = initPeaking({ $: (...a) => $(...a), state, canvas, showSliderValue: (...a) => showSliderValue(...a) });

// ---------------------------------------------------------------- depth ruler

// The depth ruler: a strip under the Depth settings with how much of the
// picture lies at each depth (nearer left, blue; farther right, orange), the
// focus as a line and the sharp range around it as a band. Click or drag to
// focus there. The counts come from the depth map once it exists.
const ruler = { info: null, key: '', counts: null, lo: -1.6, hi: 1.6, busy: false, ready: 0 };

function drawDepthRuler() {
  const row = $('depth-ruler-row');
  const on = hasDepth() && state.mode === 'camera' && !!state.info;
  row.hidden = !on;
  if (!on) return;
  const cv = $('depth-ruler');
  // Drawn at the size it is shown (and again when that changes), so nothing is stretched.
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(cv.clientWidth * dpr);
  const H = Math.round(cv.clientHeight * dpr);
  if (!W || !H) return;
  if (cv.width !== W) cv.width = W;
  if (cv.height !== H) cv.height = H;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, W, H);
  const { lo, hi } = ruler;
  const xOf = (a) => ((Math.min(hi, Math.max(lo, a)) - lo) / (hi - lo)) * W;
  const focus = +$('focus').value;
  const spread = hasDepth() ? focusField().spread : 0;
  const pad = 5 * dpr;
  const base = H - pad;
  const x0 = xOf(focus - spread);
  const x1 = xOf(focus + spread);
  // Near (blue) through gray to far (orange), left to right.
  const fill = g.createLinearGradient(0, 0, W, 0);
  fill.addColorStop(0, '#4f9dff');
  fill.addColorStop(0.5, '#b4bcc8');
  fill.addColorStop(1, '#ff9a5a');
  // The curve through the counts: smooth, filled below.
  const curve = new Path2D();
  const line = new Path2D();
  if (ruler.counts) {
    const n = ruler.counts.length;
    let max = 1;
    for (const c of ruler.counts) max = Math.max(max, c);
    const pts = Array.from({ length: n }, (_, i) => [(i / (n - 1)) * W, base - Math.sqrt(ruler.counts[i] / max) * (H - 2 * pad - 2 * dpr)]);
    line.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < n - 1; i++) line.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
    line.lineTo(pts[n - 1][0], pts[n - 1][1]);
    curve.addPath(line);
    curve.lineTo(W, base);
    curve.lineTo(0, base);
    curve.closePath();
  }
  // Outside the sharp range the curve is dim; inside it is lit.
  g.save();
  g.globalAlpha = 0.32;
  g.fillStyle = fill;
  g.fill(curve);
  g.restore();
  g.save();
  g.beginPath();
  g.rect(x0, 0, Math.max(1, x1 - x0), H);
  g.clip();
  g.fillStyle = fill;
  g.fill(curve);
  g.restore();
  g.lineWidth = 1.5 * dpr;
  g.lineJoin = 'round';
  g.strokeStyle = fill;
  g.globalAlpha = 0.55;
  g.stroke(line);
  g.globalAlpha = 1;
  g.save();
  g.beginPath();
  g.rect(x0, 0, Math.max(1, x1 - x0), H);
  g.clip();
  g.stroke(line);
  g.restore();
  // The ground line, and the sharp range along it.
  g.fillStyle = 'rgba(255, 255, 255, 0.25)';
  g.fillRect(0, base, W, dpr);
  g.fillStyle = 'rgba(255, 255, 255, 0.85)';
  g.fillRect(x0, base - dpr, Math.max(2 * dpr, x1 - x0), 3 * dpr);
  // The focus: a line with a knob on top.
  const fx = Math.min(W - 5 * dpr, Math.max(5 * dpr, Math.round(xOf(focus))));
  g.fillStyle = '#fff';
  g.fillRect(fx - dpr / 2, 6 * dpr, dpr, base - 6 * dpr);
  g.beginPath();
  g.arc(fx, 6 * dpr, 4 * dpr, 0, Math.PI * 2);
  g.fillStyle = '#fff';
  g.fill();
  g.lineWidth = dpr;
  g.strokeStyle = '#14161a';
  g.stroke();
  // The number under the line (page text, kept inside the strip).
  const label = $('depth-ruler-focus');
  label.textContent = focus.toFixed(2);
  label.style.left = `${Math.min(80, Math.max(20, (fx / W) * 100))}%`;
}

// Fetches the counts again when the photo, its depth settings or its depth map changed.
async function refreshDepthRuler() {
  drawDepthRuler();
  if (!(hasDepth() && state.mode === 'camera' && state.info) || ruler.busy) return;
  const key = ['depth-smooth', 'depth-hq', 'depth-style', 'depth-blend', 'depth-objects', 'depth-objects-soft', 'depth-contrast', 'lytro-depth'].map((id) => ($(id).type === 'checkbox' ? $(id).checked : $(id).value)).join('|') + `|${ruler.ready}`;
  if (ruler.info === state.info && ruler.key === key && ruler.counts) return;
  const info = state.info;
  if (ruler.info !== info) ruler.counts = null;
  ruler.busy = true;
  try {
    const res = await engine.request('depthHistogram', {});
    if (state.info !== info) return;
    if (res && res.counts) {
      ruler.counts = res.counts;
      ruler.lo = res.lo;
      ruler.hi = res.hi;
      ruler.info = info;
      ruler.key = key;
      drawDepthRuler();
    } else {
      // No depth map yet: the next time a picture is drawn (or the depth is ready) asks again.
      ruler.info = info;
      ruler.key = '';
    }
  } catch {
    // The ruler is only a guide.
  } finally {
    ruler.busy = false;
  }
}

(() => {
  const cv = $('depth-ruler');
  // The strip changes width with the sidebar: drawn again at the new size.
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => drawDepthRuler()).observe(cv);
  let dragging = false;
  const setFocusFrom = (event, final) => {
    const r = cv.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (event.clientX - r.left) / Math.max(1, r.width)));
    $('focus').value = (ruler.lo + t * (ruler.hi - ruler.lo)).toFixed(2);
    showSliderValue($('focus'));
    drawDepthRuler();
    cameraChanged({ final });
  };
  // Shift-drag: the range of the selected depth mask (from where the drag starts to where it is now), instead of the focus.
  let rangeFrom = null;
  const depthAt = (event) => {
    const r = cv.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (event.clientX - r.left) / Math.max(1, r.width)));
    return ruler.lo + t * (ruler.hi - ruler.lo);
  };
  cv.addEventListener('pointerdown', (event) => {
    if (!hasDepth()) return;
    if (event.shiftKey && selectedDepthMask()) {
      rangeFrom = depthAt(event);
      cv.setPointerCapture(event.pointerId);
      return;
    }
    dragging = true;
    cv.setPointerCapture(event.pointerId);
    setFocusFrom(event, false);
  });
  cv.addEventListener('pointermove', (event) => {
    if (rangeFrom !== null) setDepthRange(rangeFrom, depthAt(event), { final: false });
    else if (dragging) setFocusFrom(event, false);
  });
  const stop = (event) => {
    if (rangeFrom !== null) {
      setDepthRange(rangeFrom, depthAt(event), { final: true });
      rangeFrom = null;
      return;
    }
    if (!dragging) return;
    dragging = false;
    setFocusFrom(event, true);
  };
  cv.addEventListener('pointerup', stop);
  cv.addEventListener('pointercancel', () => {
    rangeFrom = null;
    dragging = false;
  });
})();

// Depth slider: the depth of field. Lower is shallower (things away from
// the focus blur faster), higher is deeper; each 50 steps is 4x the blur.
function depthOfFieldScale() {
  return 4 ** (-$('dof-depth').value / 50);
}

// Camera settings shared by the live view, animations and full resolution.
// Blur strength multiplies the simulated blur: a light field camera's own
// aperture is small, so true-to-the-optics blur is often subtle.
// `live`: for what is shown on screen. Retouching shows the whole picture in focus, so every blemish can be seen and fixed (the depth of field comes back when the tool is left);
// what is saved or exported keeps the depth of field.
function cameraParams({ live = false } = {}) {
  const lens = live && state.retouchTool ? { aperture: 0, dof: 0 } : apertureFor(fNumber());
  return {
    u: state.camera.u,
    v: state.camera.v,
    alpha: +$('focus').value,
    aperture: lens.aperture,
    dof: lens.dof * depthOfFieldScale(),
    // The synthetic blur's options: bokeh shape and brightness, and the
    // focus field (spread and tilt).
    bokeh: bokehParams(),
  };
}

// Raw photos and processed .lfp files both drive the camera view.
function canRender() {
  return !!(state.info && (state.info.hasRaw || state.info.processed));
}

// A photo that carries its depth (a Light L16 photo, a Lytro file saved with a depth map) has its own choices: Classic Depth (its depth as it opens, the default) and, for a
// Light L16 photo, Illuminator (Illuminator's raw-photo way of measuring, on its cameras); a raw photo has the measured ones (and one that had Classic Depth gets Classic
// Desktop, the default).
function showDepthMethods() {
  const select = $('depth-style');
  const own = !!(state.info && !state.info.hasRaw && state.info.processed && state.info.processed.hasDepth);
  const allowed = own ? (isL16() ? ['file', 'classic'] : ['file']) : null;
  // (the depth models work on every photo: on one that carries its depth, on top of that depth)
  const ok = (v) => allowed.includes(v) || !!methodDepthModel(v);
  for (const o of select.options) o.hidden = allowed ? !ok(o.value) : o.value === 'file';
  if (allowed && !ok(select.value)) select.value = 'file';
  else if (!own && select.value === 'file') select.value = 'match';
  $('depth-blend-row').hidden = select.value !== 'combined';
  showDepthModelControls();
}

function hasDepth() {
  return !!(state.info && (state.info.hasRaw || (state.info.processed && state.info.processed.hasDepth)));
}

function canDrag() {
  return !!(state.info && (state.info.hasRaw || (state.info.processed && state.info.processed.canDrag)));
}

function showsCamera() {
  return state.mode === 'camera' && !state.fullRes && !state.depthShown && !state.showingFrames;
}

// While a slider or the picture is dragged the camera view renders a quicker
// draft (strong blur at half size); the full picture follows on release.
const drag = { on: false, drafted: false };
document.addEventListener('pointerdown', (e) => {
  if (e.button === 0 && (e.target === canvas || (e.target.matches && e.target.matches('input[type=range]')))) drag.on = true;
}, true);
for (const type of ['pointerup', 'pointercancel']) {
  document.addEventListener(type, () => {
    if (!drag.on) return;
    drag.on = false;
    if (drag.drafted && showsCamera()) renderCamera();
    drag.drafted = false;
  }, true);
}

// Live camera view. Requests are coalesced: while one renders, only the
// latest settings are kept for the next.
// The engine's noise reduction takes long at the larger picture sizes: a camera view is shown without it first, and the finished picture (with it) is asked for
// once the changes stop (the worker says so with nrDeferred). `final`: that request.
// The slow Detail recovery pass runs on its own, not while the quick view is marked busy, so a newer quick preview is made at once and never waits for it. Any new render
// stops it (its picture is for settings that have changed).
let recoveryToken = 0;
async function runRecovery(gen, token) {
  state.recoveryRunning = true;
  try {
    const { promise } = engine.job('superRes', 'superres', { ...cameraParams({ live: true }), scale: +$('detail').value, passes: +$('still-passes').value, label: 'Processing' }, { onProgress: progressFor(gen) });
    const msg = await promise;
    if (openSeq.superseded(gen) || token !== recoveryToken) return;
    hideProgress();
    if (msg && (msg.pixels || msg.bitmap) && showsCamera()) {
      draw(toImageData(msg), gen);
      if (msg.gpuMs != null) showGpuTime(msg.gpuMs);
    }
  } catch (err) {
    if (!openSeq.superseded(gen) && token === recoveryToken) showError(err, 'Could not render the picture');
  } finally {
    state.recoveryRunning = false;
  }
}

async function renderCamera({ final = false } = {}) {
  clearTimeout(state.nrFinalTimer);
  cancelSharp();
  recoveryToken++;
  if (state.recoveryRunning) engine.cancel('superres').catch(() => {});
  // Changes keep coming: wait for them to stop before auto rendering.
  if (state.autoRenderTimer) scheduleAutoRender();
  if (!canRender()) return;
  // The slow final pass waits until the slider or playhead has been still (the quick view is made now; the pass is scheduled again below).
  if (final && !seekSettled()) final = false;
  const v = state.view;
  if (v.busy) {
    v.pending = true;
    return;
  }
  v.busy = true;
  const gen = openSeq.current();
  try {
    if (stereoShown()) {
      const img = await stereoPreview(cameraParams());
      if (openSeq.superseded(gen)) return;
      hideProgress();
      if (img && showsCamera()) draw(img, gen);
    } else {
      const draft = drag.on;
      // Detail recovery also rebuilds the picture itself (not just the full
      // sensor still): from every sensor pixel, at the picture's own size.
      // That takes long, so a change shows the quick view first and the
      // rebuilt picture follows once the changes stop (`final`), as the
      // noise reduction does.
      const passes = +$('still-passes').value;
      const recovery = passes > 0 && !draft && state.info.hasRaw;
      let msg = null;
      if (recovery && final) {
        runRecovery(gen, recoveryToken);
        return;
      }
      if (!msg) {
        // While the slider or playhead is being moved and the main engine is busy, the second worker makes the quick view.
        const maker = seekSettled() ? engine : previewMirror.quick();
        msg = await maker.request('view', { ...cameraParams({ live: true }), draft, deferNr: !draft && !final, final: final && !recovery, ...(levelWidths() ? { maxWidth: wantedWidth(draft) } : {}) }, {
          quick: true,
          onProgress: progressFor(gen),
          // A picture before its noise reduction (a CPU step) is done: shown at once, replaced when the finished one arrives.
          onFrame: (f) => { if (f.preview && f.bitmap && showsCamera()) draw(f.bitmap, gen); },
        });
      }
      // Another photo was opened while this rendered: its picture is not for the new one.
      if (openSeq.superseded(gen)) return;
      hideProgress();
      if (msg && (msg.pixels || msg.bitmap) && showsCamera()) {
        draw(toImageData(msg), gen);
        if (draft) drag.drafted = true;
      }
      if (msg && msg.gpuMs != null) showGpuTime(msg.gpuMs);
      if (msg && !final && (msg.nrDeferred || recovery)) state.nrFinalTimer = setTimeout(function again() { if (!seekSettled()) state.nrFinalTimer = setTimeout(again, seekWait()); else if (showsCamera()) renderCamera({ final: true }); }, 350);
    }
  } catch (err) {
    if (!openSeq.superseded(gen)) showError(err, 'Could not render the picture');
  } finally {
    v.busy = false;
    if (v.pending) {
      v.pending = false;
      renderCamera();
    } else {
      scheduleSharp();
    }
  }
}

// The live view is one view of the light field, at the lens grid's resolution: with a lens per pixel. Once changes stop, the all-in-focus picture from
// every sensor pixel (at twice the view's size; at f/16 and f/22 the engine's, as Render makes it) is made in the background and shown instead, with the
// depth of field's blur put on it at wider f-stops; any change goes back to the live view and cancels it. Not on a
// software renderer (minutes), not while Full resolution mode is on (it has its own Render), and not when the card's memory limit says no.
const SHARP_DELAY = 1500;
// Once the all in focus picture for this photo and viewpoint has been made, the worker keeps it: a change of focus or blur only puts the blur and the color on it again
// (moments on a graphics card), so the sharp picture comes back sooner.
const SHARP_KEPT_DELAY = 300;
const SHARP_SCALE = 2;
let sharpTimer = 0;
const sharp = { running: false, token: 0, kept: '' };
const sharpBaseKey = () => `${state.current && state.current.photo}|${state.camera.u}|${state.camera.v}|${$('detail').value}`;

function sharpWanted() {
  const info = state.info;
  if (!info || !info.hasRaw || state.mode !== 'camera' || !showsCamera() || state.fullResMode || state.playing || drag.on || stereoShown()) return false;
  // Detail recovery makes the picture itself from every sensor pixel (runRecovery): a sharp picture made after it would take its place, or stop it.
  if (+$('still-passes').value > 0) return false;
  if (!hook('sharpAnyGpu') && /swiftshader|llvmpipe|software|softpipe|^CPU/i.test(info.renderer || 'CPU')) return false;  // (the flag: tests on a software renderer)
  // With the blur drawn from the depth map (aperture 0, the default bokeh) the sharp picture is made too, and the blur is put on it: what is in focus keeps
  // every sensor pixel's detail at any f-stop (on the live view alone it was as soft as one view). Optical refocusing (aperture above 0) keeps its view.
  const lens = state.retouchTool ? { aperture: 0, dof: 0 } : apertureFor(fNumber());
  if (lens.aperture !== 0) return false;
  const size = info.stillSizes && info.stillSizes[SHARP_SCALE];
  return !(size && !fitsMemory('vram', superResVram(size[0], size[1])));
}

function cancelSharp() {
  clearTimeout(sharpTimer);
  sharpTimer = 0;
  sharp.token++;
  if (sharp.running) engine.cancel('superres').catch(() => {});
}

function scheduleSharp() {
  clearTimeout(sharpTimer);
  sharpTimer = 0;
  if (!sharpWanted()) return;
  sharpTimer = setTimeout(runSharp, sharp.kept === sharpBaseKey() ? SHARP_KEPT_DELAY : SHARP_DELAY);
}

async function runSharp() {
  sharpTimer = 0;
  if (!sharpWanted() || state.view.busy) return;
  if (!seekSettled()) {
    sharpTimer = setTimeout(runSharp, seekWait());
    return;
  }
  if (sharp.running) return;  // (when it ends, a cancelled one starts the next, see below)
  const token = ++sharp.token;
  const photo = state.current && state.current.photo;
  sharp.running = true;
  try {
    const { promise } = engine.job('superRes', 'superres', { ...cameraParams({ live: true }), scale: SHARP_SCALE, passes: 0, label: 'Sharpening', quiet: true }, { onProgress: (stage, p) => { if (sharp.token === token) $('frame-label').textContent = `Sharpening ${Math.round((p ?? 0) * 100)}%`; } });
    const msg = await promise;
    // A change since (or another photo) makes it stale.
    if (token === sharp.token && msg && (msg.pixels || msg.bitmap) && sharpWanted() && state.current && state.current.photo === photo) {
      const img = toImageData(msg);
      sharp.kept = sharpBaseKey();
      draw(img);
      $('frame-label').textContent = `${canvas.width}×${canvas.height}`;
    }
  } catch (err) {
    // the quick view stays; nothing to tell the user about a background picture
    console.warn('Sharp preview failed', err);
  } finally {
    sharp.running = false;
    if (token === sharp.token && !$('frame-label').textContent.includes('×')) $('frame-label').textContent = `${canvas.width}×${canvas.height}`;
    // A change cancelled it (or came while it ran, and its own try found it busy): start again once the live view is up to date.
    if (token !== sharp.token && !sharpTimer && !state.view.busy && !state.view.pending) scheduleSharp();
  }
}

// Shows whatever the current state calls for.
function refresh() {
  if (!state.info) return;
  if (state.mode === 'lenslets') renderLenslets();
  else if (state.depthShown) {
    renderDepth();
    if (state.fullRes && !state.still) renderStill();
  } else if (state.fullRes && state.still) draw(state.still);
  else if (state.fullRes) renderStill();
  else if (state.showingFrames) showFrame(state.index);
  else renderCamera();
}

// animation: ui/animation.js
const { animationRequest, resetAnimation, animationPlan, ensureAnimation, framesMissing, seekSettled, seekWait, stopProcessing, renderSingleFrame, invalidateAnimation, updateFrameLabel, showFrame, live, stopLivePlay, setPlaying, backToCamera } = initAnimation({ cameraParams: (...a) => cameraParams(...a), $: (...a) => $(...a), keyframeFrames: (...a) => keyframeFrames(...a), liveFraming: (...a) => liveFraming(...a), state, viewReach: (...a) => viewReach(...a), engine, withPivotZoom: (...a) => withPivotZoom(...a), pivotFor: (...a) => pivotFor(...a), combineMotion: (...a) => combineMotion(...a), showProgress: (...a) => showProgress(...a), hideProgress: (...a) => hideProgress(...a), draw: (...a) => draw(...a), showError: (...a) => showError(...a), cancelSharp: (...a) => cancelSharp(...a), setFullRes: (...a) => setFullRes(...a), updatePreviewStatus: (...a) => updatePreviewStatus(...a), canRender: (...a) => canRender(...a), previewMirror, updatePlayhead: (...a) => updatePlayhead(...a), setDepthShown: (...a) => setDepthShown(...a), showPlayIcon: (...a) => showPlayIcon(...a), previewAt: (...a) => previewAt(...a) });

// ---------------------------------------------------------------- full resolution, depth

// The saved render (desktop app, a library photo) of these settings: the hash naming it, or null where renders are not kept.
function stillHash(scale, passes) {
  if (!native || !state.lib || !state.current || !state.current.photo) return null;
  return hashKey(stillKeyText({
    edits: currentEdits(), camera: cameraParams(), scale, passes, frame: state.stillFrame, photoId: state.current.photo.photoId || state.current.photo.id, version: VERSION,
  }));
}

// PNG of a render (an ImageData, or an ImageBitmap from the GPU).
async function stillPng(img) {
  const c = new OffscreenCanvas(img.width, img.height);
  const g = c.getContext('2d');
  if (img instanceof ImageData) g.putImageData(img, 0, 0);
  else g.drawImage(img, 0, 0);
  return c.convertToBlob({ type: 'image/png' });
}

// ImageData of a saved render, or null.
async function stillFromFile(file) {
  try {
    const bmp = await createImageBitmap(file, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    bmp.close();
    return g.getImageData(0, 0, c.width, c.height);
  } catch {
    return null;
  }
}

// What decides the full sensor picture before its color pass, from the page's side (the worker keeps the picture under the same idea, worker.js): the settings that are not
// color settings, the camera and the render's size. A change that leaves it alone only needs the color pass again.
function stillPreKey(settings = buildRenderSettings({ el: $, num: (id) => +$(id).value }, { ...localSettings(), spots: $('retouch-spots').value })) {
  const photo = state.current && state.current.photo;
  return preColorKey(settings, [photo ? photo.photoId || photo.id : null, state.stillFrame ? 1 : 0], [state.stillFrame || cameraParams(), +$('still-scale').value, +$('still-passes').value]);
}

async function renderStill() {
  const scale = +$('still-scale').value;
  // The card's memory (Settings > Memory): a full sensor render of this size needs about this much.
  const size = state.info && state.info.stillSizes && state.info.stillSizes[scale];
  if (size && !fitsMemory('vram', superResVram(size[0], size[1]))) {
    showNotice('Not rendered', memoryProblem('vram', superResVram(size[0], size[1]), `A ${size[0]}×${size[1]} full sensor render`, 'Lower the Scale (Render Settings > Quality) or raise the limit.'));
    setFullRes(false);
    return;
  }
  const gen = openSeq.current();
  try {
    const passes = +$('still-passes').value;
    const hash = stillHash(scale, passes);
    const photo = state.current && state.current.photo;
    const preKey = stillPreKey();
    // The same render was made before: show it.
    if (hash) {
      const file = await state.lib.still(photo, hash);
      const img = file && (await stillFromFile(file));
      if (openSeq.superseded(gen)) return;
      if (img && state.fullRes && state.current && state.current.photo === photo) {
        state.still = img;
        state.stillKept = false;
        state.lensStill = { img, scale };
        if (!state.depthShown) {
          draw(img);
          showAtPhotoSize();
          $('frame-label').textContent = `${canvas.width}×${canvas.height}`;
        }
        return;
      }
    }
    // A quick look comes first (one pixel per lens, a quarter of the lenses): shown at once and replaced by the finished picture. Not for a picture that was kept (a color
    // change), which is made again within moments, and only where the worker can make one (settings.fullSensorPreview = false turns it off).
    let finished = false;
    if (!state.still && !state.depthShown) {
      engine.job('superResPreview', 'preview', { ...(state.stillFrame || cameraParams()), scale, passes }).promise.then((pv) => {
        if (finished || openSeq.superseded(gen) || !pv || !(pv.pixels || pv.bitmap) || !state.fullRes || state.depthShown) return;
        draw(toImageData(pv), gen);
        showAtPhotoSize();
        $('frame-label').textContent = `${canvas.width}×${canvas.height} preview`;
      }).catch(() => {});
    }
    // The animation frame on show renders as it is (its camera and local
    // adjustment settings), not the live camera's.
    const { promise } = engine.job('superRes', 'superres', { ...(state.stillFrame || cameraParams()), scale, passes }, { onProgress: progressFor(gen) });
    const msg = await promise;
    finished = true;
    if (openSeq.superseded(gen)) return;
    // Ignore a result that arrives after full resolution was switched off.
    if (msg && (msg.pixels || msg.bitmap) && state.fullRes) {
      state.still = toImageData(msg);
      // The worker kept the picture before its color pass: a color change only asks for the color pass again (applySettings), with this picture left on show meanwhile.
      state.stillKept = !!msg.kept;
      state.stillPre = preKey;
      setHook('stillRendered', { n: (hook('stillRendered')?.n || 0) + 1, kept: state.stillKept, keys: Object.keys(msg).join() }); // for tests: a full sensor picture arrived, and whether the worker kept it
      state.lensStill = { img: state.still, scale };
      if (!state.depthShown) {
        draw(state.still);
        showAtPhotoSize();
        $('frame-label').textContent = `${canvas.width}×${canvas.height}`;
      }
      // Kept next to the photo for next time (not waited for).
      if (hash) {
        const shown = state.still;
        stillPng(shown).then((blob) => state.lib.saveStill(photo, hash, blob)).catch((err) => console.warn('Could not keep the full sensor render', err));
      }
    }
  } catch (err) {
    if (!openSeq.superseded(gen)) showError(err, 'Could not render the full sensor picture');
  } finally {
    if (!openSeq.superseded(gen)) hideProgress();
  }
}

// Full resolution re-renders what the camera shows (viewpoint, focus,
// aperture, depth of field) from every sensor pixel. The checkbox turns the
// mode on (Scale appears, Render is enabled); Render makes the still. Any change to
// the picture returns to the live view until Render is pressed again.
// Render works for any raw photo in the camera view: at the Photo Size with the chosen Upscaling (a downloaded model enlarges the picture here), or, with Full
// sensor on, as the full sensor still.
// Full resolution: raw photos (the full sensor render) and Light L16 photos (the final render with the telephoto cameras' detail).
const isL16 = () => !!(state.info && state.info.processed && state.info.processed.hires);
const fullResCapable = () => !!(state.info && (state.info.hasRaw || (state.info.processed && state.info.processed.hires)));
// A Light L16 photo's Render scale is in multiples of the camera's size (the quick views are half that); a raw photo's is in multiples of its lens grid.
function showStillScales() {
  const sel = $('still-scale');
  const l16 = !!(state.info && state.info.processed && state.info.processed.hires);
  // A Light L16 photo's resolution is set under Quality (its own list, the same setting as the Render scale); a raw photo's Resolution is the lens picture's size.
  $('l16-resolution-row').hidden = !l16;
  $('detail').closest('label').hidden = l16;
  $('still-scale-row').hidden = l16;
  if (sel.dataset.kind === (l16 ? 'l16' : 'raw')) {
    if (l16) $('l16-resolution').value = sel.value;
    return;
  }
  sel.dataset.kind = l16 ? 'l16' : 'raw';
  sel.innerHTML = l16
    ? '<option value="1">1× camera size</option><option value="1.5">1.5×</option><option value="2" selected>2×</option><option value="2.5">2.5×</option><option value="3">3×</option><option value="4">4×</option>'
    : '<option value="2">2× lens grid</option><option value="3" selected>3× lens grid</option><option value="4">4× lens grid</option>';
  if (l16) $('l16-resolution').value = sel.value;
}
$('l16-resolution').onchange = () => {
  $('still-scale').value = $('l16-resolution').value;
  $('still-scale').dispatchEvent(new Event('change', { bubbles: true }));
};
function updateRenderButton() {
  showStillScales();
  $('render-btn').disabled = !(fullResCapable() && state.mode === 'camera');
}

function setFullResMode(on) {
  if (on && !(fullResCapable() && state.mode === 'camera')) on = false;
  state.fullResMode = on;
  $('fullres-on').checked = on;
  // (a Light L16 photo has no Full sensor choice: its Render is always the full render, and its size is the Resolution under Quality)
  $('fullres-panel').hidden = !on || isL16();
  $('auto-render-row').hidden = isL16();
  updateRenderButton();
  $('auto-render').disabled = !on;
  showPhotoSizes();
  if (!on) setFullRes(false);
  else if ($('auto-render').checked) scheduleAutoRender(0);
}

// Auto render: with Full resolution on, the still is rendered again by
// itself once changes stop (not while a slider or the picture is dragged,
// during playback, or while frames or the depth map are shown).
const AUTO_RENDER_DELAY = 800;
function scheduleAutoRender(delay = AUTO_RENDER_DELAY) {
  clearTimeout(state.autoRenderTimer);
  state.autoRenderTimer = 0;
  // (a Light L16 photo is rendered when Render is pressed: the render takes minutes)
  if (!$('auto-render').checked || !state.fullResMode || state.fullRes || isL16()) return;
  state.autoRenderTimer = setTimeout(() => {
    state.autoRenderTimer = 0;
    if (drag.on) return scheduleAutoRender();
    if (!seekSettled()) return scheduleAutoRender(seekWait());
    if (state.playing || state.showingFrames || state.depthShown || $('auto-render').disabled) return;
    setFullRes(true);
  }, delay);
}
// Auto render is saved with each photo (edits.js), not remembered globally.
$('auto-render').onchange = () => scheduleAutoRender(0);

function renderFullRes() {
  if (!state.fullResMode) {
    renderAtPhotoSize();
    return;
  }
  if (state.fullRes) renderStill();
  else setFullRes(true);
}

// The picture shown at the Photo Size, made with the chosen Upscaling: the plain methods are already what draw() shows; a downloaded model enlarges the picture on
// show here (it takes a while, so it is made when Render is pressed), blended with the plain enlargement by Model strength. Save writes what is on show.
let renderingAtSize = false;
async function renderAtPhotoSize() {
  if (renderingAtSize || !state.lastImage || state.lastImage.pair || state.mode !== 'camera') return;
  const k = +$('photo-size').value || 1;
  const sharp = sharpenParams();
  if (!(k > 1) && !sharp) {
    showNotice('Photo Size is Native', 'Choose a larger Photo size (Render Settings > Upscaling) to enlarge the picture, or a Sharpening model to sharpen it.');
    return;
  }
  const model = methodModel($('upscale-method').value);
  if (!model && !sharp) {
    draw(state.lastImage);
    return;
  }
  renderingAtSize = true;
  try {
    // the picture at its own size (through crop and rotation), before any enlargement
    state.skipEnlarge = true;
    draw(state.lastImage);
    state.skipEnlarge = false;
    const w = canvas.width;
    const h = canvas.height;
    const base = ctx.getImageData(0, 0, w, h);
    let rgb = new Uint16Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      rgb[3 * i] = base.data[4 * i] * 257;
      rgb[3 * i + 1] = base.data[4 * i + 1] * 257;
      rgb[3 * i + 2] = base.data[4 * i + 2] * 257;
    }
    // the sharpening model works at the picture's size, before the enlargement
    if (sharp) {
      rgb = await aiSharpen(sharp.model, () => readModel(sharp.model), rgb, w, h, sharp.amount, showProgress);
      hideProgress();
    }
    const W = Math.round(w * k);
    const H = Math.round(h * k);
    const P = modelUpscaleParams();
    let big;
    if (model && k > 1) {
      const grown = await aiUpscale(model, () => readModel(model), denoiseRgb16(rgb, w, h, P.denoise), w, h, showProgress);
      hideProgress();
      big = { rgb: grown.rgb, width: grown.width, height: grown.height };
      if (grown.width !== W) {
        const sized = upscaleBits16(grown.rgb, grown.width, grown.height, W, H, { method: 'lanczos', sharpen: 0 });
        if (sized) big = { rgb: sized, width: W, height: H };
      }
      big = finishModelEnlargement(big, rgb, w, h, P);
    } else {
      // no enlarging model: the plain enlargement (or none, at the native size) of the sharpened picture
      const plain = k > 1 ? upscaleBits16(rgb, w, h, W, H, { method: $('upscale-method').value || 'lanczos', sharpen: +$('upscale-sharpen').value / 100, lobes: +$('upscale-lobes').value }) : null;
      big = plain ? { rgb: plain, width: W, height: H } : { rgb, width: w, height: h };
    }
    const out = new ImageData(big.width, big.height);
    for (let i = 0; i < big.width * big.height; i++) {
      out.data[4 * i] = big.rgb[3 * i] >> 8;
      out.data[4 * i + 1] = big.rgb[3 * i + 1] >> 8;
      out.data[4 * i + 2] = big.rgb[3 * i + 2] >> 8;
      out.data[4 * i + 3] = 255;
    }
    canvas.width = big.width;
    canvas.height = big.height;
    ctx.putImageData(out, 0, 0);
    layoutCanvas();
    if (state.geom) state.geom = { ...state.geom, inverse: invert(state.geom.matrix.map((v) => v * (big.width / w))) };
    state.enlarged = true;
    $('frame-label').textContent = `${canvas.width}×${canvas.height}`;
  } catch (err) {
    hideProgress();
    state.skipEnlarge = false;
    showNotice('Could not enlarge with the model', `${err && err.message ? err.message : err} The picture is enlarged with Lanczos instead.`);
    draw(state.lastImage);
  } finally {
    renderingAtSize = false;
  }
}

// The downloaded model's own settings (Render > Upscaling, kept per model): how much of its result is used, how much the picture is smoothed before it goes in, the
// sharpening and the grain applied to what comes out.
function modelUpscaleParams() {
  return { strength: +$('upscale-strength').value / 100, denoise: +$('upscale-denoise').value / 100, sharpen: +$('upscale-sharpen').value / 100, grain: +$('upscale-grain').value / 100 };
}

// The chosen sharpening model (Render Settings > Upscaling) and how much of its result is used, or null when none is chosen (or it was removed).
function sharpenParams() {
  const model = sharpenModelOf($('sharpen-model').value);
  return model ? { model, amount: +$('sharpen-model-amount').value / 100 } : null;
}

// The model's enlargement `big` (16-bit RGB of the picture `rgb`, w x h) with the model settings applied: mixed with the plain enlargement, sharpened, grained.
function finishModelEnlargement(big, rgb, w, h, P) {
  big = blendWithPlain(big, rgb, w, h, P.strength);
  if (P.sharpen > 0) {
    const sharp = upscaleBits16(big.rgb, big.width, big.height, big.width, big.height, { method: 'lanczos', sharpen: P.sharpen });
    if (sharp) big = { rgb: sharp, width: big.width, height: big.height };
  }
  if (P.grain > 0) big = { rgb: addGrain16(big.rgb, big.width, big.height, P.grain), width: big.width, height: big.height };
  return big;
}

// `big` (the model's enlargement, 16-bit RGB) mixed with the plain Lanczos enlargement of `rgb` (w x h) of the same size: strength 1 is the model alone.
function blendWithPlain(big, rgb, w, h, strength) {
  if (!(strength < 1)) return big;
  const plain = upscaleBits16(rgb, w, h, big.width, big.height, { method: 'lanczos', sharpen: 0 });
  if (!plain) return big;
  const out = new Uint16Array(big.rgb.length);
  for (let i = 0; i < out.length; i++) out[i] = plain[i] + (big.rgb[i] - plain[i]) * strength;
  return { rgb: out, width: big.width, height: big.height };
}

function setFullRes(on, { restore = true } = {}) {
  if (on && !(state.fullResMode && fullResCapable() && state.mode === 'camera')) return;
  if (on === state.fullRes) return;
  state.fullRes = on;
  showPhotoSizes();
  if (on) {
    // Rendering from an animation frame keeps that frame's settings.
    state.stillFrame = state.showingFrames ? frameList()[state.index] || null : null;
    state.stillIndex = state.index;
    setPlaying(false);
    state.showingFrames = false;
    // The depth map, if shown, stays on screen; the still is made meanwhile and shows when the depth map goes off.
    renderStill();
    return;
  }
  engine.cancel('superres');
  engine.cancel('preview');
  hideProgress();
  state.still = null;
  state.stillFrame = null;
  $('frame-label').textContent = '';
  if (restore) refresh();
  scheduleAutoRender();
}

async function renderDepth() {
  const gen = openSeq.current();
  try {
    const msg = await engine.request('depthMap', { grey: $('depth-grey').checked, contrast: $('depth-contrast').value / 100 }, {
      onProgress: progressFor(gen),
      // The quick depth the live view uses, shown at once while the full one is measured.
      onFrame: (f) => {
        if (openSeq.superseded(gen) || !state.depthShown || !f.pixels) return;
        draw(toImageData(f), gen);
        showProgress('Measuring the full depth…', null);
      },
    });
    if (openSeq.superseded(gen)) return;
    hideProgress();
    if (msg && msg.pixels && state.depthShown) draw(toImageData(msg), gen);
  } catch (err) {
    if (!openSeq.superseded(gen)) showError(err, 'Could not show the depth map');
  }
}

// Depth map contrast reshapes the depth itself (the worker applies it with the other depth settings), so the picture's blur and the shown map change together.
$('depth-contrast').oninput = () => {
  showSliderValue($('depth-contrast'));
  applySettingsSoon();
};
$('depth-contrast-persp').onchange = applySettingsSoon;
$('depth-grey').addEventListener('change', () => {
  if (state.depthShown) renderDepth();
});

function setDepthShown(on, { restore = true } = {}) {
  if (on && !(hasDepth() && state.mode === 'camera')) {
    $('depth-btn').checked = false;
    return;
  }
  if (on === state.depthShown) return;
  state.depthShown = on;
  updateSpreadOverlay();
  $('depth-btn').checked = on;
  $('depth-grey').disabled = !on;
  if (on) {
    setPlaying(false);
    state.showingFrames = false;
    setFullRes(false, { restore: false });
    renderDepth();
  } else if (restore) {
    refresh();
  }
}

// modes: ui/modes.js
const { showSidebarEnabled, setMode } = initModes({ state, $: (...a) => $(...a), updateRenderButton: (...a) => updateRenderButton(...a), updateSpreadOverlay: (...a) => updateSpreadOverlay(...a), hasDepth: (...a) => hasDepth(...a), isL16: (...a) => isL16(...a), setFullResMode: (...a) => setFullResMode(...a), showDepthMethods: (...a) => showDepthMethods(...a), BOKEH_SHAPE, PREVIEW_IDS, canDrag: (...a) => canDrag(...a), setFullRes: (...a) => setFullRes(...a), setDepthShown: (...a) => setDepthShown(...a), layoutCanvas: (...a) => layoutCanvas(...a), setPlaying: (...a) => setPlaying(...a), renderGridInfo: (...a) => renderGridInfo(...a), renderTimeline: (...a) => renderTimeline(...a), refresh: (...a) => refresh(...a), updateKeyButtons: (...a) => updateKeyButtons(...a) });

// info: ui/info.js
const { fmt, showResolutionSizes, showPhotoSizes, renderInfo } = initInfo({ $: (...a) => $(...a), state, scheduleSpeed: (...a) => scheduleSpeed(...a), updateKeyButtons: (...a) => updateKeyButtons(...a), gpuTimeText: (...a) => gpuTimeText(...a), renderGridInfo: (...a) => renderGridInfo(...a) });

// speed report: ui/speedreport.js
const { timings, scheduleSpeed, speedReportText, gpuTimeText, showGpuTime, renderGridInfo } = initSpeedReport({ engine, $: (...a) => $(...a), state, previewMirror, cameraParams: (...a) => cameraParams(...a), showNotice: (...a) => showNotice(...a), fmt: (...a) => fmt(...a), renderInfo: (...a) => renderInfo(...a) });

// ---------------------------------------------------------------- zoom

// Zoom is a multiple of the fit-to-window scale, and the view center is kept
// in normalized image coordinates, so both survive switching between the
// camera view and a larger full resolution still.
const view = { k: 1, cx: 0.5, cy: 0.5 };
const viewer = $('drop-zone');
const MAX_SCALE = 16;

// How many of a Light L16 photo's real pixels one pixel of the picture on the canvas stands for (2 for the quick picture, which is half the camera's size); 1 for any other photo.
function nativeFactor() {
  const native = state.info && state.info.processed && state.info.processed.native;
  return native && canvas.width ? native[0] / canvas.width : 1;
}

function fitScale() {
  // While cropping, leave room around the picture for the frame's handles.
  const margin = cropState.editing ? 48 : 0;
  const vw = Math.max(1, viewer.clientWidth - margin);
  const vh = Math.max(1, viewer.clientHeight - margin);
  return Math.min(vw / canvas.width, vh / canvas.height) || 1;
}

function clampView(w, h) {
  const vw = viewer.clientWidth;
  const vh = viewer.clientHeight;
  view.cx = w <= vw ? 0.5 : Math.min(1 - vw / (2 * w), Math.max(vw / (2 * w), view.cx));
  view.cy = h <= vh ? 0.5 : Math.min(1 - vh / (2 * h), Math.max(vh / (2 * h), view.cy));
}

// A Light L16 photo keeps the picture at several sizes (the worker's levelFor): the size that the zoom shows is made, a smaller one while the viewpoint is dragged.
// `wantedWidth`: how many pixels across the whole picture is on the screen (the zoom, at the screen's pixel density).
// (not in the command line and automated runs: what they save is the full size)
const levelWidths = () => (!navigator.webdriver && state.info && state.info.processed && state.info.processed.levelWidths) || null;
// (set while a save waits for the full size picture)
let forceFullLevel = false;
function wantedWidth(draft = false) {
  if (forceFullLevel) return 1e9;
  const shown = (parseFloat(canvas.style.width) || canvas.width) * (window.devicePixelRatio || 1);
  // (through a crop, straighten or turn the canvas is not the picture: the picture's width is what is wanted)
  const g = state.geom;
  const per = g ? g.srcW / canvas.width : 1;
  return Math.ceil(shown * per * (draft ? 0.6 : 1));
}
// The level that wantedWidth selects (the smallest that is wide enough), and the level of the picture on the canvas.
function levelIndexFor(width) {
  const widths = levelWidths();
  let best = 0;
  widths.forEach((w, i) => { if (w >= width && w < widths[best]) best = i; });
  return best;
}
// Before a save: makes sure the picture on the canvas is the full size one (a Light L16 photo shows a smaller one when zoomed out). Resolves when it is, or after a while.
async function ensureFullLevel() {
  const widths = levelWidths();
  if (!widths || !showsCamera() || canvas.width >= Math.max(...widths)) return;
  forceFullLevel = true;
  try {
    cameraChanged({ final: true });
    const until = Date.now() + 180000;
    while (canvas.width < Math.max(...widths) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  } finally {
    forceFullLevel = false;
  }
}
let levelTimer = 0;
// After a zoom: when the picture on the canvas is not the size the zoom needs, make the right one (once the zoom has stopped).
// The width of the picture on the canvas (before its crop, straighten and turn).
function shownLevelWidth() {
  return state.geom ? state.geom.srcW : canvas.width;
}
function watchLevel() {
  const widths = levelWidths();
  if (!widths || !showsCamera()) return;
  const have = widths.indexOf(shownLevelWidth());
  if (have < 0 || have === levelIndexFor(wantedWidth())) return;
  clearTimeout(levelTimer);
  levelTimer = setTimeout(() => {
    const widths2 = levelWidths();
    if (widths2 && showsCamera() && widths2.indexOf(shownLevelWidth()) !== levelIndexFor(wantedWidth())) cameraChanged({ final: true });
  }, 250);
}

// lenslets: ui/lenslets.js
const { lensMinZoom, lensZoomBy, lensDrag, renderLenslets } = initLenslets({ state, viewer, lensView, canvas, $: (...a) => $(...a), cameraParams: (...a) => cameraParams(...a), engine, view, layoutCanvas: (...a) => layoutCanvas(...a), ctx, scheduleHistogram: (...a) => scheduleHistogram(...a), showError: (...a) => showError(...a) });

// zoomed in on a Light L16 photo: ui/l16zoom.js
const { scheduleDetail, scheduleHoles, layoutCanvas, startPan } = initL16Zoom({ $: (...a) => $(...a), state, showsCamera: (...a) => showsCamera(...a), canvas, engine, hideProgress: (...a) => hideProgress(...a), drag, fitScale: (...a) => fitScale(...a), view, viewer, openSeq, showProgress: (...a) => showProgress(...a), cameraParams: (...a) => cameraParams(...a), MAX_SCALE, clampView: (...a) => clampView(...a), nativeFactor: (...a) => nativeFactor(...a), positionCropBox: (...a) => positionCropBox(...a), watchLevel: (...a) => watchLevel(...a), lensZoomBy: (...a) => lensZoomBy(...a), renderLenslets: (...a) => renderLenslets(...a), lensMinZoom: (...a) => lensMinZoom(...a), lensView });

// ---------------------------------------------------------------- pointer

// Pointer position in camera view pixels (the full resolution still is
// larger than the camera view; both cover the same picture).
function viewPoint(event) {
  const [fx, fy] = sourceFraction(event);
  return state.info && state.info.width ? [fx * state.info.width, fy * state.info.height] : [fx * canvas.width, fy * canvas.height];
}


// Depth mask > Pick range from picture: the next click on the picture centers the selected depth mask's range on the depth there.
function setDepthPick(on) {
  state.depthPick = on && !!selectedDepthMask() && hasDepth();
  $('mask-pick-depth').classList.toggle('active', state.depthPick);
  canvas.style.cursor = state.depthPick ? 'crosshair' : '';
}
async function pickDepthFromClick(event) {
  const [x, y] = viewPoint(event);
  const gen = openSeq.current();
  try {
    const res = await engine.request('focusAt', { x, y, u: state.camera.u, v: state.camera.v, depth: true }, { onProgress: progressFor(gen) });
    if (openSeq.superseded(gen)) return;
    hideProgress();
    if (res && typeof res.alpha === 'number') pickDepthRange(res.alpha);
  } catch (err) {
    if (!openSeq.superseded(gen)) showError(err, 'Could not pick the depth');
  }
  setDepthPick(false);
}
$('mask-pick-depth').onclick = () => setDepthPick(!state.depthPick);
$('mask-depth-focus').onclick = () => {
  if (!hasDepth()) return;
  const f = +$('focus').value;
  const spread = focusField().spread;
  setDepthRange(f - Math.max(0.1, spread), f + Math.max(0.1, spread));
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.depthPick) setDepthPick(false);
});

// Click to focus on the clicked spot. With a small aperture everything is
// already sharp, so a click also opens up to f/2.8 to make the change visible.
async function focusAt(event) {
  // Lenticular Print > Pick focus point: the click gives the focus of the print, not of the picture.
  if (state.lentPick) {
    const pick = state.lentPick;
    canvas.style.cursor = '';
    const [vx, vy] = viewPoint(event);
    const [px, py] = sourceFraction(event);
    await pick(vx, vy, Math.min(1, Math.max(0, px)), Math.min(1, Math.max(0, py)));
    return;
  }
  // Picking a depth mask's range: the click gives the depth, not the focus.
  if (state.depthPick) {
    await pickDepthFromClick(event);
    return;
  }
  const [x, y] = viewPoint(event);
  const [fx, fy] = sourceFraction(event);
  state.focusPoint = { x: Math.min(1, Math.max(0, fx)), y: Math.min(1, Math.max(0, fy)) };
  showFocusPoint();
  const gen = openSeq.current();
  try {
    await applyFocusAt(x, y, true);
  } catch (err) {
    if (!openSeq.superseded(gen)) showError(err, 'Could not focus there');
  }
}

// The click's own measurement, then (once the full depth map exists, see engine.onDepthReady) again on it if nothing has moved the focus since.
async function applyFocusAt(x, y, opening) {
  // Blur drawn from the depth map (the default): the focus value is the depth map's value at the click. Optical refocusing: measured from the views.
  const depth = apertureFor(Math.min(fNumber(), 2.8)).aperture === 0;
  const gen = openSeq.current();
  const res = await engine.request('focusAt', { x, y, u: state.camera.u, v: state.camera.v, depth }, { onProgress: opening ? progressFor(gen) : undefined });
  // (the click was on a photo that is no longer open)
  if (openSeq.superseded(gen)) return;
  if (opening) hideProgress();
  if (!res || typeof res.alpha !== 'number') return;
  if (!opening && !(state.lastClick && state.lastClick.x === x && state.lastClick.y === y && $('focus').value === state.lastClick.value)) return;
  $('focus').value = res.alpha.toFixed(2);
  showSliderValue($('focus'));
  state.lastClick = { x, y, value: $('focus').value, again: depth && !res.final };
  cameraChanged({ final: true });
}

engine.onDepthReady = (msg) => {
  if (msg && staleSeq(msg.openSeq)) return;
  ruler.ready++;
  refreshDepthRuler();
  if (state.lastClick && (state.lastClick.again || (msg && msg.reapply))) {
    state.lastClick.again = false;
    applyFocusAt(state.lastClick.x, state.lastClick.y, false).catch((err) => console.warn('Could not refocus on the full depth map', err));
  }
};

// Only a short click on the picture sets the focus: not one that follows a
// drag (turning the viewpoint, panning) or a press held down for a while.
const CLICK_MAX_MS = 400;
// How far a press may move and still count as a click, by input: a finger or a trackpad tap moves several pixels on its own, so with the mouse's few pixels a tap
// became a drag of the viewpoint and set no focus. (The viewpoint drag starts past the same distance, minus one.)
const CLICK_MAX_MOVE = { mouse: 4, pen: 7, touch: 11 };
const clickSlop = (type) => CLICK_MAX_MOVE[type] || CLICK_MAX_MOVE.mouse;
let pressed = null;
canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  state.suppressClick = false;
  pressed = { x: event.clientX, y: event.clientY, t: performance.now(), moved: false, slop: clickSlop(event.pointerType) };
}, true);
window.addEventListener('pointermove', (event) => {
  if (pressed && Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > pressed.slop) pressed.moved = true;
}, true);
window.addEventListener('pointercancel', () => {
  pressed = null;
}, true);

canvas.addEventListener('click', (event) => {
  const press = pressed;
  pressed = null;
  if (cropState.editing || state.retouchTool || state.maskPaint) return;
  if (state.picking) {
    pickWhiteBalance(event);
    return;
  }
  if (state.suppressClick) {
    state.suppressClick = false;
    return;
  }
  if (press && (press.moved || performance.now() - press.t > CLICK_MAX_MS)) return;
  if (!state.info || state.mode !== 'camera' || state.depthShown) return;
  focusAt(event);
});

// Middle button drag pans the picture in any mode (instead of the browser's
// autoscroll).
canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 1 || !state.info) return;
  event.preventDefault();
  if (state.mode === 'lenslets') lensDrag(event);
  else startPan(event);
});
canvas.addEventListener('mousedown', (event) => {
  if (event.button === 1) event.preventDefault();
});

canvas.addEventListener('pointerdown', (event) => {
  if (!state.info || event.button !== 0 || state.picking || cropState.editing) return;
  if (state.mode === 'lenslets') {
    lensDrag(event);
    return;
  }
  if (event.shiftKey || (view.k > 1 && state.mode !== 'camera')) {
    startPan(event);
    return;
  }
  if (state.mode !== 'camera' || !canDrag()) return;
  // Drag to turn the viewpoint, like grabbing the scene: dragging across half
  // the picture moves through the whole aperture.
  canvas.setPointerCapture(event.pointerId);
  const rect = canvas.getBoundingClientRect();
  const r = state.info.radius;
  const start = { x: event.clientX, y: event.clientY, u: state.camera.u, v: state.camera.v };
  let moved = false;
  const dragFrom = clickSlop(event.pointerType) - 1;
  canvas.onpointermove = (e) => {
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!moved && Math.hypot(dx, dy) < dragFrom) return;
    if (!moved) {
      moved = true;
      setFullRes(false, { restore: false });
      // Moving the viewpoint keeps the depth map on screen (it does not change with the viewpoint).
      if (!state.depthShown) backToCamera();
    }
    let u = start.u - (dx / (rect.width / 2)) * r;
    let v = start.v - (dy / (rect.height / 2)) * r;
    // (out to Perspective > Reach: past the lens's opening the worker moves the picture on by the depth)
    const reach = r * viewReach();
    const len = Math.hypot(u, v);
    if (len > reach) {
      u *= reach / len;
      v *= reach / len;
    }
    state.camera.u = u;
    state.camera.v = v;
    showViewpoint();
    if (!state.depthShown) renderCamera();
  };
  canvas.onpointerup = () => {
    canvas.onpointermove = null;
    state.suppressClick = moved;
    if (moved) {
      autoKey();
      invalidateAnimation();
      scheduleSave();
    }
  };
});

// The viewpoint back to the center: a double-click on the picture, or Camera > Perspective > Reset.
function centerViewpoint() {
  if (state.mode !== 'camera' || !canDrag()) return;
  state.camera.u = 0;
  state.camera.v = 0;
  cameraChanged({ final: true });
}
canvas.addEventListener('dblclick', centerViewpoint);
$('view-center').onclick = centerViewpoint;

// A camera setting changed: update the picture and drop stale animation
// frames. `final` is false while a slider is being dragged.
function cameraChanged({ final }) {
  showViewpoint();
  if (final) autoKey();
  invalidateAnimation();
  scheduleSave();
  updateSpreadOverlay();
  drawDepthRuler();
  if (state.fullRes) setFullRes(false, { restore: false });
  if (!state.depthShown) {
    backToCamera();
    renderCamera();
  }
}

// Depth smoothing is applied in the worker like the color settings.
$('depth-smooth').oninput = () => {
  showSliderValue($('depth-smooth'));
  applySettingsSoon();
};
$('depth-smooth').onchange = () => {};
// Normal or high quality depth: the depth map is measured again.
$('depth-hq').onchange = () => {
  if (canRender()) noteBusy($('depth-hq').checked ? 'Measuring the high quality depth…' : 'Switching to the normal depth…');
  applySettingsSoon();
};
// The mix of the two depth measurements, shown for Blended only; the worker recombines without measuring again.
const showDepthBlend = (loaded = false) => {
  $('depth-blend-row').hidden = $('depth-style').value !== 'combined';
  showDepthModelControls(loaded);
};
// Each depth model keeps its own settings (Model blend, Model smoothing, Model curve): the sliders show the chosen method's, and every model's are kept together in the
// hidden `depth-model-params` (saved with the photo).
const DEPTH_MODEL_SLIDERS = { blend: 'depth-model-blend', smooth: 'depth-model-smooth', curve: 'depth-model-curve' };
function rememberDepthModel() {
  const all = readParams('depth-model-params');
  all[state.depthModelShown ?? $('depth-style').value] = Object.fromEntries(Object.entries(DEPTH_MODEL_SLIDERS).map(([k, id]) => [k, +$(id).value]));
  $('depth-model-params').value = JSON.stringify(all);
}
// `loaded`: the settings were just read from a photo's saved edits, so the sliders already hold the chosen method's values.
function showDepthModelControls(loaded = false) {
  const method = $('depth-style').value;
  const model = !!methodDepthModel(method);
  if (model && state.depthModelShown !== method) {
    const saved = readParams('depth-model-params')[method];
    if (!loaded || saved) {
      for (const [k, id] of Object.entries(DEPTH_MODEL_SLIDERS)) {
        $(id).value = saved && saved[k] !== undefined ? saved[k] : $(id).dataset.default;
        showSliderValue($(id));
      }
    }
  }
  state.depthModelShown = model ? method : null;
  for (const id of ['depth-model-blend-row', 'depth-model-smooth-row', 'depth-model-curve-row']) $(id).hidden = !model;
}
for (const id of Object.values(DEPTH_MODEL_SLIDERS)) {
  $(id).oninput = () => {
    showSliderValue($(id));
    rememberDepthModel();
    applySettingsSoon();
  };
  $(id).ondblclick = () => {
    $(id).value = $(id).dataset.default;
    showSliderValue($(id));
    rememberDepthModel();
    applySettingsSoon();
  };
}
$('depth-style').onchange = () => {
  if (state.depthModelShown) rememberDepthModel(); // the old model's settings, still in the sliders
  if (canRender()) noteBusy(`Switching to ${$('depth-style').selectedOptions[0]?.textContent || 'the depth method'}…`);
  showDepthBlend();
  applySettingsSoon();
};
$('depth-blend').oninput = () => {
  showSliderValue($('depth-blend'));
  applySettingsSoon();
};
showDepthBlend();
// Object edges work on their own: with or without the high quality depth map.
const showObjectSoft = () => { $('depth-objects-soft-row').hidden = !$('depth-objects').checked; };
$('depth-objects').onchange = () => {
  showObjectSoft();
  // (the depth is measured again with or without the object outlines: the depth map on show changes when that is done)
  if (canRender()) noteBusy($('depth-objects').checked ? 'Finding objects and measuring the depth…' : 'Measuring the depth without object edges…');
  applySettingsSoon();
};
$('depth-objects-soft').oninput = () => {
  showSliderValue($('depth-objects-soft'));
  applySettingsSoon();
};
showObjectSoft();
$('lytro-depth').onchange = () => applySettingsSoon();

$('pivot-on').onchange = () => {
  $('pivot').disabled = !$('pivot-on').checked;
  // Its keyframes show only while it is on.
  clearSelection();
  renderTimeline();
  invalidateAnimation();
  geometryChanged();
};
$('pivot').oninput = () => {
  showSliderValue($('pivot'));
  if (state.lastImage) draw(state.lastImage);
};
$('pivot').onchange = () => {
  autoKey();
  invalidateAnimation();
  geometryChanged();
};
$('view-reach').oninput = () => showSliderValue($('view-reach'));
$('view-reach').onchange = () => {
  // A viewpoint past the new reach comes back to it.
  const reach = ((state.info && state.info.radius) || 1) * viewReach();
  const len = Math.hypot(state.camera.u, state.camera.v);
  if (len > reach) {
    state.camera.u *= reach / len;
    state.camera.v *= reach / len;
    showViewpoint();
    if (state.mode === 'camera' && !state.depthShown && state.info) renderCamera();
  } else if (stereoShown()) refresh();
  invalidateAnimation();
  scheduleSave();
};

// Shape settings show for the shapes they change: blades for Blades, oval
// for Circle, rotation for both (a round circle has nothing to turn).
function showBokehShape() {
  const shape = $('bokeh').value;
  const shaped = ['blades', 'circle', 'custom', 'star', 'heart'].includes(shape);
  $('bokeh-blades-row').hidden = shape !== 'blades';
  $('bokeh-points-row').hidden = shape !== 'star';
  $('bokeh-inner-row').hidden = shape !== 'star';
  $('bokeh-outer-row').hidden = shape !== 'star';
  $('bokeh-width-row').hidden = shape !== 'heart';
  $('bokeh-oval-row').hidden = shape !== 'circle';
  $('bokeh-rotation-row').hidden = !shaped;
  $('bokeh-onion-on-row').hidden = !shaped;
  const rings = shaped && $('bokeh-onion-on').checked;
  $('bokeh-onion-row').hidden = !rings;
  // (irregularity, ring blur and warp shape the rings, so they show with some Onion)
  $('bokeh-irregular-row').hidden = !rings || !(+$('bokeh-onion').value > 0);
  $('bokeh-ring-blur-row').hidden = !rings || !(+$('bokeh-onion').value > 0);
  $('bokeh-warp-row').hidden = !rings || !(+$('bokeh-onion').value > 0);
  $('bokeh-spots-row').hidden = !shaped;
  // the ball's character, in a group of its own, and Swirl with some Cat's-eye
  $('bokeh-ball-group').hidden = !shaped;
  // (Swirl always shows: it turns the cat's-eye lenses, so moving it brings some Cat's-eye in)
  // (the streak's length and the starburst's spikes with some of each)
  $('bokeh-streak-len-row').hidden = !(+$('bokeh-streak').value > 0);
  $('bokeh-streak-threshold-row').hidden = !(+$('bokeh-streak').value > 0);
  $('bokeh-spikes-row').hidden = !(+$('bokeh-star').value > 0);
  $('bokeh-image-row').hidden = shape !== 'custom';
  $('bokeh-image-btn').textContent = $('bokeh-image').value ? 'Replace shape image…' : 'Load shape image…';
  drawBokehPreview();
}

// The preview above the Shape list: one out of focus point of light, drawn with the blur's own ball (core/dof.js bokehBall), brighter with more Highlights.
function drawBokehPreview() {
  const c = $('bokeh-preview');
  const g = c.getContext('2d');
  const W = c.width;
  const H = c.height;
  const p = bokehParams();
  const k = bokehKernel(p);
  const optical = opticalInEffect();
  const img = g.createImageData(W, H);
  const light = new Float32Array(W * H * 3);
  const r = 0.4 * H;
  const size = 2 * Math.ceil(r * 1.6) + 1;
  // (the cat's-eye and swirl depend on where the ball is in the frame: it is shown as it looks near the corner, a ball behind the focus)
  const ball = optical ? null : ballRGB(k, size, r, k.catEye > 0 ? { d: 0.8, ang: Math.PI / 4 } : null, 1);
  const mono = optical ? opticalBall(size, r) : null;
  const x0 = Math.round(W / 2 - (size - 1) / 2);
  const y0 = Math.round(H / 2 - (size - 1) / 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const X = x0 + x;
      const Y = y0 + y;
      if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
      for (let ch = 0; ch < 3; ch++) light[3 * (Y * W + X) + ch] += ball ? ball[3 * (y * size + x) + ch] : mono[y * size + x];
    }
  }
  const gain = 0.6 + 0.4 * (p.highlights || 0);
  // (warm light on a dark background, whatever the theme: bokeh is light out of the dark; a colored ball keeps its colors)
  const base = [[18, 237], [20, 210], [24, 160]];
  for (let i = 0; i < W * H; i++) {
    for (let ch = 0; ch < 3; ch++) img.data[4 * i + ch] = base[ch][0] + base[ch][1] * Math.min(1, light[3 * i + ch] * gain);
    img.data[4 * i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}

// Optical: the views across the lens averaged (worker apertureOptions): wide open every view counts the same, a disc with the lens's own soft, slightly darker
// edge; stopped down the views are weighted by a Gaussian of 0.6 x the opening, so the disc softens toward a glow. Past the camera's widest f-stop the depth map's
// Gaussian blur is added on top.
function opticalBall(size, r) {
  const lens = apertureFor(fNumber());
  const a = Math.max(0.05, lens.aperture || 0);
  const sigma = a >= 1 ? Infinity : 0.6 * a;
  const extra = lens.aperture >= 1 && lens.dof > 0 ? 0.25 : 0;
  const out = new Float32Array(size * size);
  const c = (size - 1) / 2;
  let top = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = Math.hypot(x - c, y - c) / r;
      const edge = Math.max(0, Math.min(1, (1 + 0.06 + extra * 0.5 - t) / (0.12 + extra)));
      const weight = Number.isFinite(sigma) ? Math.exp(-(t * t) / (2 * sigma * sigma)) : 1;
      const v = edge * weight * (1 - 0.15 * t * t);
      out[y * size + x] = v;
      if (v > top) top = v;
    }
  }
  if (top > 0) for (let i = 0; i < out.length; i++) out[i] /= top;
  return out;
}

// Custom image: the loaded picture, fitted into a BOKEH_IMAGE_SIZE square on black (its shape, centered), kept as its brightness (core/dof.js encodeBokehImage).
$('bokeh-image-btn').onclick = () => $('bokeh-image-file').click();
$('bokeh-image-file').onchange = async () => {
  const file = $('bokeh-image-file').files[0];
  $('bokeh-image-file').value = '';
  if (!file) return;
  try {
    const bmp = await createImageBitmap(file);
    const N = BOKEH_IMAGE_SIZE;
    const c = new OffscreenCanvas(N, N);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#000';
    g.fillRect(0, 0, N, N);
    const f = Math.min(N / bmp.width, N / bmp.height);
    const w = bmp.width * f;
    const h = bmp.height * f;
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, (N - w) / 2, (N - h) / 2, w, h);
    bmp.close();
    const text = encodeBokehImage(g.getImageData(0, 0, N, N).data);
    if (!text) {
      showNotice('No shape in the image', 'The image is all black. White shows where light passes; use a white shape on black.');
      return;
    }
    $('bokeh-image').value = text;
    $('bokeh').value = 'custom';
    showBokehShape();
    cameraChanged({ final: true });
  } catch (err) {
    showNotice('Could not read the image', err && err.message ? err.message : String(err));
  }
};

for (const id of ['fstop', 'bokeh', 'dof-depth', 'highlights', 'spread', 'spread-smooth', 'spread-blur', 'tilt', 'tilt-rotation', ...BOKEH_SHAPE]) {
  $(id).oninput = () => {
    // Swirl turns the cat's-eye lenses: with none, it brings some in so the slider shows something
    if (id === 'bokeh-swirl' && +$(id).value > 0 && !(+$('bokeh-cat').value > 0)) {
      $('bokeh-cat').value = 60;
      showSliderValue($('bokeh-cat'));
    }
    // (these two decide which other settings show)
    if (id === 'bokeh' || id === 'bokeh-onion' || id === 'bokeh-onion-on' || id === 'bokeh-cat' || id === 'bokeh-streak' || id === 'bokeh-star') showBokehShape();
    // (the f-stop, Depth, Focus Spread and Tilt change Optical's ball too)
    else drawBokehPreview();
    showFNumber();
    showSliderValue($(id));
    cameraChanged({ final: false });
  };
  $(id).onchange = () => cameraChanged({ final: true });
}
showBokehShape();

// One tint at a time: Show spread and Show tilt switch each other off.
$('spread-show').onchange = () => {
  if ($('spread-show').checked) $('tilt-show').checked = false;
  updateSpreadOverlay();
};
$('tilt-show').onchange = () => {
  if ($('tilt-show').checked) $('spread-show').checked = false;
  updateSpreadOverlay();
};
$('tilt-on').onchange = () => {
  drawBokehPreview();
  const off = !$('tilt-on').checked;
  for (const id of ['tilt', 'tilt-rotation', 'tilt-show']) $(id).disabled = off || $('tilt-on').disabled;
  // Its keyframes show only while it is on.
  clearSelection();
  renderTimeline();
  invalidateAnimation();
  cameraChanged({ final: true });
};

// Tilt presets: sets the tilt, aperture, blur (and for a miniature, color) in one step, as one undoable change.
$('tilt-preset').onchange = () => {
  const id = $('tilt-preset').value;
  $('tilt-preset').value = '';
  const preset = tiltPreset(id);
  if (!preset || !state.info || $('tilt-on').disabled && id !== 'off') return;
  for (const [key, value] of Object.entries(preset.values)) {
    if (key === 'fNumber') {
      $('fstop').value = F_STOPS.indexOf(value);
      showFNumber();
      continue;
    }
    const el = $(key);
    if (el.type === 'checkbox') el.checked = value;
    else el.value = value;
    if (el.type === 'range') showSliderValue(el);
    // Settings outside the camera panel (color) take the change like a drag of their slider.
    if (!EDIT_GROUPS_CAMERA.has(key)) {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  $('tilt-on').onchange();
};

// settings: ui/settings.js
const { importFolder, sendCalibrations } = initSettings({ state, $: (...a) => $(...a), showError: (...a) => showError(...a), showNotice: (...a) => showNotice(...a), startNoticeTimer: (...a) => startNoticeTimer(...a), importPhotos: (...a) => importPhotos(...a), showGrid: (...a) => showGrid(...a), engine, showDepthBlend: (...a) => showDepthBlend(...a), showDepthMethods: (...a) => showDepthMethods(...a), showUpscaleControls: (...a) => showUpscaleControls(...a), scheduleSave: (...a) => scheduleSave(...a), useLibrary: (...a) => useLibrary(...a) });

// ---------------------------------------------------------------- crop, straighten, orientation

// Applied to the finished picture in camera mode (core/geometry.js); the
// settings are kept with the photo's edits. While the crop frame is being
// edited the whole straightened picture is shown with the frame over it.
const srcCanvas = document.createElement('canvas');
const cropState = { editing: false, saved: null, rect: null, drag: null };

function cropValues() {
  return { x: +$('crop-x').value, y: +$('crop-y').value, w: +$('crop-w').value, h: +$('crop-h').value };
}

function setCropValues(c) {
  $('crop-x').value = c.x;
  $('crop-y').value = c.y;
  $('crop-w').value = c.w;
  $('crop-h').value = c.h;
}

// Perspective pivot: moving the viewpoint shifts every depth but one: the
// camera's own focus with the aperture closed, the focus plane otherwise.
// A custom pivot keeps another depth still instead, by shifting the picture
// against the viewpoint (and zooming in a little so no edge shows).
// Positions move by (depth - still depth) x viewpoint offset, in lens
// spacings: one view pixel at 1x resolution.
// `depth`: an animation's Pivot depth for this frame, or null for the
// slider's. Either is used only with Custom pivot on.
function pivotFor(u, v, alpha, aperture, depth = null) {
  const keyed = Number.isFinite(depth);
  if (!$('pivot-on').checked || !state.info || !state.info.hasRaw || state.depthShown) return null;
  const pivot = 1.6 * (keyed ? depth : +$('pivot').value) / 100;
  const still = aperture > 0 ? alpha : 0;
  const k = +$('detail').value;
  const { width: W, height: H } = state.info;
  const s = (still - pivot) * k;
  return { shift: [(s * u) / W, (s * v) / H], reach: Math.abs(s) * (state.info.radius || 0) };
}

// Zoom that hides the edges for every shift in `pivots`.
function withPivotZoom(pivots) {
  const reach = Math.max(0, ...pivots.map((p) => (p ? p.reach : 0)));
  const zoom = state.info ? 1 + (2 * reach) / Math.min(state.info.width, state.info.height) : 1;
  return pivots.map((p) => (p ? { shift: p.shift, zoom } : null));
}

function currentPivot() {
  if (state.showingFrames && state.framePivots) return state.framePivots[state.drawFrame ?? state.index] || null;
  // A still rendered from an animation frame keeps that frame's framing.
  if (state.fullRes && state.stillFrame && state.framePivots) return state.framePivots[state.stillIndex] || null;
  const p = cameraParams({ live: true });
  const pivot = withPivotZoom([pivotFor(p.u, p.v, p.alpha, p.aperture)])[0];
  return keyframesOn() ? combineMotion(pivot, liveFraming()) : pivot;
}

function geometrySettings() {
  return {
    ...(state.mode === 'camera' ? currentPivot() : null),
    orientation: +$('orientation').value || 1,
    angle: +$('straighten').value,
    crop: cropState.editing ? FULL_CROP : cropValues(),
  };
}

// Geometry for an image of this size, or null when there is none to apply.
function geometryFor(w, h) {
  if (state.mode !== 'camera') return null;
  const s = geometrySettings();
  return isIdentity(s) ? null : geometry(w, h, s);
}

// Draws `img` through `g` into a 2D context (scaled by `k`), on black (or,
// with `fill` false, on transparency: overlays).
function drawGeometry(c2d, img, g, k = 1, fill = true) {
  let src = img;
  if (img instanceof ImageData) {
    if (srcCanvas.width !== img.width || srcCanvas.height !== img.height) {
      srcCanvas.width = img.width;
      srcCanvas.height = img.height;
    }
    srcCanvas.getContext('2d').putImageData(img, 0, 0);
    src = srcCanvas;
  }
  c2d.setTransform(1, 0, 0, 1, 0, 0);
  if (fill) {
    c2d.fillStyle = '#000';
    c2d.fillRect(0, 0, c2d.canvas.width, c2d.canvas.height);
  } else {
    c2d.clearRect(0, 0, c2d.canvas.width, c2d.canvas.height);
  }
  const m = g.matrix;
  c2d.setTransform(m[0] * k, m[1] * k, m[2] * k, m[3] * k, m[4] * k, m[5] * k);
  c2d.imageSmoothingEnabled = true;
  c2d.imageSmoothingQuality = 'high';
  c2d.drawImage(src, 0, 0);
  c2d.setTransform(1, 0, 0, 1, 0, 0);
}

// Where an event on the picture falls in the rendered picture, as fractions.
function sourceFraction(event) {
  const rect = canvas.getBoundingClientRect();
  let fx = (event.clientX - rect.left) / rect.width;
  const fy = (event.clientY - rect.top) / rect.height;
  // Side by side: either half points at the same place.
  if (state.lastImage && state.lastImage.pair) fx = (fx * 2) % 1;
  if (!state.geom) return [fx, fy];
  const [x, y] = applyMatrix(state.geom.inverse, fx * canvas.width, fy * canvas.height);
  return [x / state.geom.srcW, y / state.geom.srcH];
}

function geometryChanged() {
  if (state.lastImage) draw(state.lastImage);
  updateSpreadOverlay();
  scheduleSave();
}

// The crop as a pixel aspect ratio (width / height), or 0 for free.
function aspectRatio() {
  const v = $('crop-aspect').value;
  if (v === 'free') return 0;
  const g = state.geom;
  const fw = g ? g.frameWidth : canvas.width;
  const fh = g ? g.frameHeight : canvas.height;
  if (v === 'original') return fw / fh;
  // Wide ratios on a portrait frame (and tall ones on a landscape frame)
  // turn with it: 3 : 2 on a portrait picture is 2 : 3.
  return fh > fw ? 1 / +v : +v;
}

function frameSize() {
  if (state.geom) return [state.geom.frameWidth, state.geom.frameHeight];
  return [canvas.width, canvas.height];
}

function constrainCrop(c) {
  const r = aspectRatio();
  if (!r) return c;
  const [fw, fh] = frameSize();
  return fitAspect(c, r, fw, fh);
}

function turnCrop(c, dir) {
  // A quarter turn of the picture turns its crop with it.
  return dir > 0 ? { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w } : { x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w };
}

function rotatePicture(dir) {
  if (!canRender()) return;
  $('orientation').value = rotateOrientation(+$('orientation').value || 1, dir);
  if (cropState.editing) cropState.rect = turnCrop(cropState.rect, dir);
  else setCropValues(turnCrop(cropValues(), dir));
  geometryChanged();
}

$('rotate-left').onclick = () => rotatePicture(-1);
$('rotate-right').onclick = () => rotatePicture(1);
$('flip-h').onclick = () => {
  if (!canRender()) return;
  $('orientation').value = flipOrientation(+$('orientation').value || 1);
  const flip = (c) => ({ ...c, x: 1 - c.x - c.w });
  if (cropState.editing) cropState.rect = flip(cropState.rect);
  else setCropValues(flip(cropValues()));
  geometryChanged();
};
$('flip-v').onclick = () => {
  if (!canRender()) return;
  $('orientation').value = flipVerticalOrientation(+$('orientation').value || 1);
  const flip = (c) => ({ ...c, y: 1 - c.y - c.h });
  if (cropState.editing) cropState.rect = flip(cropState.rect);
  else setCropValues(flip(cropValues()));
  geometryChanged();
};
$('straighten').oninput = () => {
  showSliderValue($('straighten'));
  if (state.lastImage) draw(state.lastImage);
};
$('straighten').onchange = geometryChanged;
// Choosing an aspect ratio opens the crop frame to adjust.
$('crop-aspect').onchange = () => {
  if (!cropState.editing) startCrop();
  if (!cropState.editing) return;
  cropState.rect = constrainCrop(cropState.rect);
  positionCropBox();
};
$('geometry-reset').onclick = () => {
  $('orientation').value = 1;
  $('straighten').value = 0;
  $('crop-aspect').value = 'free';
  showSliderValue($('straighten'));
  setCropValues(FULL_CROP);
  if (cropState.editing) cropState.rect = { ...FULL_CROP };
  geometryChanged();
  if (cropState.editing) positionCropBox();
};

function startCrop() {
  if (!canRender() || state.mode !== 'camera' || cropState.editing) return;
  if (state.playing) setPlaying(false);
  cropState.editing = true;
  cropState.saved = cropValues();
  cropState.rect = cropValues();
  $('crop-btn').setAttribute('aria-pressed', 'true');
  // (the crop icon stays; pressed, it finishes the crop)
  $('crop-btn').title = 'Finish cropping (Enter); Esc cancels';
  $('crop-btn').setAttribute('aria-label', 'Finish cropping');
  viewer.classList.add('cropping');
  $('crop-box').hidden = false;
  if (state.lastImage) draw(state.lastImage);
  layoutCanvas();
}

function finishCrop(keep) {
  if (!cropState.editing) return;
  cropState.editing = false;
  if (keep) setCropValues(cropState.rect);
  $('crop-btn').setAttribute('aria-pressed', 'false');
  $('crop-btn').title = 'Crop: drag the corners or edges of the frame (Enter to finish, Esc to cancel)';
  $('crop-btn').setAttribute('aria-label', 'Crop');
  viewer.classList.remove('cropping');
  $('crop-box').hidden = true;
  if (keep) geometryChanged();
  else if (state.lastImage) draw(state.lastImage);
  layoutCanvas();
}

$('crop-btn').onclick = () => (cropState.editing ? finishCrop(true) : startCrop());

// The frame over the picture, in the viewer's coordinates.
function positionCropBox() {
  if (!cropState.editing) return;
  const box = $('crop-box');
  const left = parseFloat(canvas.style.left) || 0;
  const top = parseFloat(canvas.style.top) || 0;
  const w = parseFloat(canvas.style.width) || canvas.width;
  const h = parseFloat(canvas.style.height) || canvas.height;
  const c = cropState.rect;
  box.style.left = `${left + c.x * w}px`;
  box.style.top = `${top + c.y * h}px`;
  box.style.width = `${c.w * w}px`;
  box.style.height = `${c.h * h}px`;
}

const MIN_CROP = 0.05;

$('crop-box').addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const handle = e.target.dataset.h || 'move';
  const c = cropState.rect;
  if (handle === 'move' && c.w > 0.995 && c.h > 0.995) {
    // Nothing to move yet: draw a crop from here instead.
    const rect = canvas.getBoundingClientRect();
    cropState.drag = {
      handle: 'draw',
      ax: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      ay: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  } else {
    cropState.drag = { handle, x: e.clientX, y: e.clientY, start: { ...c } };
  }
  $('crop-box').setPointerCapture(e.pointerId);
});

// Dragging on the picture outside the frame draws a new one.
canvas.addEventListener('pointerdown', (e) => {
  if (!cropState.editing || e.button !== 0) return;
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const ax = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  const ay = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
  cropState.drag = { handle: 'draw', ax, ay, moved: false };
  $('crop-box').setPointerCapture(e.pointerId);
});

function drawCrop(d, e) {
  const rect = canvas.getBoundingClientRect();
  const bx = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  const by = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
  let w = Math.max(MIN_CROP, Math.abs(bx - d.ax));
  let h = Math.max(MIN_CROP, Math.abs(by - d.ay));
  const ratio = aspectRatio();
  if (ratio) {
    // The ratio holds; the longer drag direction leads.
    const [fw, fh] = frameSize();
    const rn = (ratio * fh) / fw;
    if (w / h > rn) h = w / rn;
    else w = h * rn;
    const maxW = bx >= d.ax ? 1 - d.ax : d.ax;
    const maxH = by >= d.ay ? 1 - d.ay : d.ay;
    const k = Math.min(1, maxW / w, maxH / h);
    w *= k;
    h *= k;
  }
  const x = bx >= d.ax ? d.ax : d.ax - w;
  const y = by >= d.ay ? d.ay : d.ay - h;
  cropState.rect = { x: Math.max(0, x), y: Math.max(0, y), w: Math.min(w, 1), h: Math.min(h, 1) };
}

$('crop-box').addEventListener('pointermove', (e) => {
  const d = cropState.drag;
  if (!d) return;
  if (d.handle === 'draw') {
    d.moved = true;
    drawCrop(d, e);
    positionCropBox();
    return;
  }
  const w = parseFloat(canvas.style.width) || canvas.width;
  const h = parseFloat(canvas.style.height) || canvas.height;
  const dx = (e.clientX - d.x) / w;
  const dy = (e.clientY - d.y) / h;
  const s = d.start;
  let { x, y } = s;
  let r = s.x + s.w;
  let b = s.y + s.h;
  if (d.handle === 'move') {
    x = Math.min(1 - s.w, Math.max(0, s.x + dx));
    y = Math.min(1 - s.h, Math.max(0, s.y + dy));
    cropState.rect = { x, y, w: s.w, h: s.h };
  } else {
    if (d.handle.includes('w')) x = Math.min(r - MIN_CROP, Math.max(0, s.x + dx));
    if (d.handle.includes('e')) r = Math.max(x + MIN_CROP, Math.min(1, r + dx));
    if (d.handle.includes('n')) y = Math.min(b - MIN_CROP, Math.max(0, s.y + dy));
    if (d.handle.includes('s')) b = Math.max(y + MIN_CROP, Math.min(1, b + dy));
    let c = { x, y, w: r - x, h: b - y };
    const ratio = aspectRatio();
    if (ratio) {
      // Keep the ratio: the dragged side leads, the edge opposite the
      // handle stays where it is.
      const [fw, fh] = frameSize();
      const rn = (ratio * fh) / fw;
      const sideOnly = d.handle.length === 1;
      if (sideOnly && (d.handle === 'n' || d.handle === 's')) {
        const nw = Math.min(1, c.h * rn);
        const cx = s.x + s.w / 2;
        c = { ...c, w: nw, x: Math.min(1 - nw, Math.max(0, cx - nw / 2)) };
      } else {
        let nh = c.w / rn;
        let nw = c.w;
        const maxH = d.handle.includes('n') ? b : 1 - y;
        if (nh > maxH) {
          nh = maxH;
          nw = nh * rn;
        }
        const nx = d.handle.includes('w') ? r - nw : x;
        if (sideOnly) {
          const cy = s.y + s.h / 2;
          const ny = Math.min(1 - nh, Math.max(0, cy - nh / 2));
          c = { x: nx, y: ny, w: nw, h: nh };
        } else {
          c = { x: nx, y: d.handle.includes('n') ? b - nh : y, w: nw, h: nh };
        }
      }
    }
    cropState.rect = c;
  }
  positionCropBox();
});

for (const type of ['pointerup', 'pointercancel']) {
  $('crop-box').addEventListener(type, () => {
    cropState.drag = null;
  });
}

document.addEventListener('keydown', (e) => {
  if (!cropState.editing || e.target.matches('input, select, textarea')) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    finishCrop(true);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    finishCrop(false);
  }
}, true);

// color matrix: ui/colormatrix.js
const { showColorMatrix } = initColorMatrix({ $, state, applySettings: (...a) => applySettings(...a), applySettingsSoon: (...a) => applySettingsSoon(...a) });

// local adjustments: ui/localadjust.js
const { getMasks, setMasks, maskLabel, TRASH_ICON, renderMasks, localSettings, setDepthRange, pickDepthRange, selectedDepthMask } = initLocalAdjustments({ $, applySettingsSoon: (...a) => applySettingsSoon(...a), scheduleSave: (...a) => scheduleSave(...a), state, clearSelection: (...a) => clearSelection(...a), saveAnimation: (...a) => saveAnimation(...a), renderTimeline: (...a) => renderTimeline(...a), showMenu: (...a) => showMenu(...a), confirmInMenu: (...a) => confirmInMenu(...a), editName: (...a) => editName(...a), canRender: (...a) => canRender(...a), showSliderValue: (...a) => showSliderValue(...a), updateKeyButtons: (...a) => updateKeyButtons(...a), autoKey: (...a) => autoKey(...a), canvas, engine, sourceFraction: (...a) => sourceFraction(...a), stillDepth: () => (apertureFor(fNumber()).aperture > 0 ? +$('focus').value || 0 : 0), showError: (...a) => showError(...a), retouchTool: (t) => state.retouchUi && state.retouchUi.setTool(t) });
// Retouch (spot removal): the spots over the picture, and the tool that places them.
state.retouchUi = initRetouch({ $, state, canvas, engine, applySettingsSoon: (...a) => applySettingsSoon(...a), scheduleSave: (...a) => scheduleSave(...a), viewPoint: (...a) => viewPoint(...a), sourceFraction: (...a) => sourceFraction(...a), canRender: (...a) => canRender(...a), showError: (...a) => showError(...a), applyMatrix, stillDepth: () => (!state.retouchTool && apertureFor(fNumber()).aperture > 0 ? +$('focus').value || 0 : 0), refocus: () => { if (state.fullRes) setFullRes(false, { restore: false }); if (!state.depthShown && canRender()) renderCamera(); } });
const colorGrading = initColorGrading({ $, applySettingsSoon: (...a) => applySettingsSoon(...a), showSliderValue: (...a) => showSliderValue(...a) });
// Dragging in the histogram moves Blacks, Shadows, Exposure, Highlights or Whites (ui/histedit.js).
initHistogramEditing({ $, showSliderValue: (...a) => showSliderValue(...a), canEdit: () => !!state.info && state.mode === 'camera' });

// keyframes: ui/keyframes.js
const { MASK_LIMITS, parseMaskTrack, trackGroups, tracks, KEY_CONTROLS, settingControl, updateKeyButtons, groupCollapsed, shownTracks, groupHidden, trackName, tlSel, tlCurves, keyframesOn, animLength, loadAnimation, saveAnimation, liveFraming, combineMotion, showValue, previewAt, autoKey, playheadTime, clearSelection, selectKey, selectedKeys, moveKeys, selectedKey, viewWindow, tickStep, updatePlayhead, groupHeading, renderTimeline, timeAt, seekTimeline, seekTo, showAnimationLength, keyframeFrames } = initKeyframes({ $, getMasks, maskLabel, state, canRender: (...a) => canRender(...a), F_STOPS, scheduleSave: (...a) => scheduleSave(...a), invalidateAnimation: (...a) => invalidateAnimation(...a), backToCamera: (...a) => backToCamera(...a), renderCamera: (...a) => renderCamera(...a), showSliderValue: (...a) => showSliderValue(...a), setMasks, renderMasks, showFNumber: (...a) => showFNumber(...a), showFocusPoint: (...a) => showFocusPoint(...a), applySettingsSoon: (...a) => applySettingsSoon(...a), cameraChanged: (...a) => cameraChanged(...a), layoutCanvas: (...a) => layoutCanvas(...a), drawCurves: (...a) => drawCurves(...a), stopProcessing: (...a) => stopProcessing(...a), setPlaying: (...a) => setPlaying(...a), showFrame: (...a) => showFrame(...a), updateFrameLabel: (...a) => updateFrameLabel(...a), plotBox: (...a) => plotBox(...a), animationSettingsChanged: (...a) => animationSettingsChanged(...a), draw: (...a) => draw(...a), apertureFor: (...a) => apertureFor(...a), view, bokehParams: (...a) => bokehParams(...a), colorSettings: (...a) => colorSettings(...a) });

// curves view: ui/curvesview.js
const { plotBox, drawCurves } = initCurvesView({ trackGroups, shownTracks, trackName, $, state, settingControl, MASK_LIMITS, parseMaskTrack, F_STOPS, groupHeading, groupCollapsed, tlCurves, viewWindow, tickStep, selectedKey, groupHidden, animLength, tlSel, playheadTime, renderTimeline, saveAnimation, tracks, layoutCanvas: (...a) => layoutCanvas(...a), seekTimeline, selectedKeys, selectKey, moveKeys, timeAt, showValue, clearSelection, seekTo, scheduleSave: (...a) => scheduleSave(...a) });

// frame rate: ui/framerate.js
const { showFrameRate } = initFrameRate({ $, state, scheduleSave: (...a) => scheduleSave(...a), animationSettingsChanged: (...a) => animationSettingsChanged(...a), showAnimationLength: (...a) => showAnimationLength(...a), renderTimeline: (...a) => renderTimeline(...a), updateFrameLabel: (...a) => updateFrameLabel(...a) });

// 3D: ui/stereo.js
const { stereoShown, eyeOffset, eyeParams, stereoPreview, stereoTag } = initStereo({ $, state, canDrag: () => canDrag(), engine, showProgress: (...a) => showProgress(...a), backToCamera: (...a) => backToCamera(...a), setFullRes: (...a) => setFullRes(...a), refresh: (...a) => refresh(...a), cameraParams: (...a) => cameraParams(...a), withPivotZoom: (...a) => withPivotZoom(...a), pivotFor: (...a) => pivotFor(...a), cropValues: (...a) => cropValues(...a), drawGeometry: (...a) => drawGeometry(...a), canRender: (...a) => canRender(...a), savePhoto: (...a) => savePhoto(...a), baseName: (...a) => baseName(...a), showError: (...a) => showError(...a), hideProgress: (...a) => hideProgress(...a), showSliderValue: (...a) => showSliderValue(...a) });

// living filters: ui/livingfilters.js
const { livingFilter } = initLivingFilters({ $, state, canRender: (...a) => canRender(...a), getMasks, showNotice: (...a) => showNotice(...a), startNoticeTimer: (...a) => startNoticeTimer(...a), setMasks, renderMasks, renderTimeline: (...a) => renderTimeline(...a) });

// number fields: ui/numberfields.js
initNumberFields();

// tone curve: ui/tonecurve.js
const { curve } = initToneCurve({ $, applySettingsSoon: (...a) => applySettingsSoon(...a), scheduleSave: (...a) => scheduleSave(...a), showSliderValue: (...a) => showSliderValue(...a) });

// white balance eyedropper: ui/whitebalance.js
const { setPicking, pickWhiteBalance } = initWhiteBalancePicker({ state, canRender: (...a) => canRender(...a), $, canvas, viewPoint: (...a) => viewPoint(...a), engine, showSliderValue: (...a) => showSliderValue(...a), applySettings: (...a) => applySettings(...a), scheduleSave: (...a) => scheduleSave(...a), showError: (...a) => showError(...a) });

// export: ui/export.js
const { baseName, shownScale, showAtPhotoSize, savePhoto, showPhotoFormat, savePng, showVideoCodecs, readParams, showUpscaleControls, frameList, exportVideo } = initExport({ state, $, canvas, ctx, layoutCanvas: (...a) => layoutCanvas(...a), showsCamera: (...a) => showsCamera(...a), stereoShown, showNotice: (...a) => showNotice(...a), engine, cameraParams: (...a) => cameraParams(...a), showProgress: (...a) => showProgress(...a), hideProgress: (...a) => hideProgress(...a), modelUpscaleParams: (...a) => modelUpscaleParams(...a), sharpenParams: (...a) => sharpenParams(...a), finishModelEnlargement: (...a) => finishModelEnlargement(...a), showError: (...a) => showError(...a), showSliderValue: (...a) => showSliderValue(...a), scheduleSave: (...a) => scheduleSave(...a), draw: (...a) => draw(...a), cropValues: (...a) => cropValues(...a), animationRequest: (...a) => animationRequest(...a), eyeOffset, eyeParams, ensureAnimation: (...a) => ensureAnimation(...a), drawGeometry: (...a) => drawGeometry(...a), stereoTag, ensureFullLevel: () => ensureFullLevel() });
const lenticular = initLenticular({ $, state, engine, cameraParams: (...a) => cameraParams(...a), eyeParams, withPivotZoom: (...a) => withPivotZoom(...a), pivotFor: (...a) => pivotFor(...a), cropValues: (...a) => cropValues(...a), drawGeometry: (...a) => drawGeometry(...a), animationPlan: (...a) => animationPlan(...a), invalidateAnimation: (...a) => invalidateAnimation(...a), showNotice: (...a) => showNotice(...a), showProgress: (...a) => showProgress(...a), hideProgress: (...a) => hideProgress(...a), showError: (...a) => showError(...a), baseName, showSliderValue: (...a) => showSliderValue(...a) , scheduleSave: (...a) => scheduleSave(...a) });

// camera import: ui/cameraimport.js
const { showCameraDialog, openWebUsbCamera, importFromCameraFolder, importFromConnectedCamera } = initCameraImport({ $, state, setCameraSection: (...a) => setCameraSection(...a), showError: (...a) => showError(...a), webCameraLabel: (...a) => webCameraLabel(...a), importCameraFiles: (...a) => importCameraFiles(...a), openItem: (...a) => openItem(...a) });

// camera section: ui/camerasection.js
const { setCameraSection, renderCameraSection, renderCameraGrid, importCameraFiles, webCameraLabel, showWebCamera, importFromCamera } = initCameraSection({ state, cameraThumbs, renderLibrary: (...a) => renderLibrary(...a), $, showGrid: (...a) => showGrid(...a), openItem: (...a) => openItem(...a), showProgress: (...a) => showProgress(...a), showError: (...a) => showError(...a), hideProgress: (...a) => hideProgress(...a), importPhotos: (...a) => importPhotos(...a), importFromConnectedCamera, importFromCameraFolder, showCameraDialog, showNotice: (...a) => showNotice(...a) });

// ---------------------------------------------------------------- wiring

// An album as an archive (library/archive.js), to add to another library:
// the browser version's to the desktop app's, say.
async function exportAlbum(id) {
  const album = state.lib.album(id);
  if (!album) return;
  if (!album.photos.length) {
    showNotice(`“${album.name}” has no photos to export.`);
    startNoticeTimer();
    return;
  }
  try {
    showProgress(`Exporting “${album.name}”`, 0);
    const blob = await state.lib.exportAlbum(id, { onProgress: (p) => showProgress(`Exporting “${album.name}”`, p) });
    download(blob, `${album.name.replace(/[\\/:*?"<>|]+/g, '_') || 'Album'}${ARCHIVE_SUFFIX}`);
  } catch (err) {
    showError(err);
  } finally {
    hideProgress();
  }
}

// An exported album: its photos join the library and the album is made
// again (or joined, if one has its name).
async function importAlbumArchive(file) {
  await state.libReady;
  try {
    const { album, photos } = await state.lib.importAlbum(file, {
      onProgress: (e, i, n) => {
        if (e) showProgress(`Importing ${e.name} (${i + 1} of ${n})`, i / n);
      },
    });
    state.album = album.id;
    state.cameraView = false;
    showNotice(`Imported the album “${album.name}”: ${photos.length} photo${photos.length === 1 ? '' : 's'}.`);
    startNoticeTimer();
  } catch (err) {
    showError(err);
  } finally {
    hideProgress();
    renderLibrary();
  }
}

// Picked or dropped files are added to the library; Lytro Desktop edits
// picked with a photo go with it (scan.js). Album archives are imported as
// albums.
async function openPicked(files) {
  for (const f of files.filter((f) => /\.zip$/i.test(f.name))) await importAlbumArchive(f);
  const entries = groupPhotos(files.filter((f) => isLightFieldName(f.name) || /\.xmp$/i.test(f.name)).map((f) => ({ path: f.name, file: f })));
  const added = await importPhotos(entries);
  if (added.length) openItem(added[0]);
}

// (the file picker takes what app/js/extra.js opens too, with the .xmp files beside them)
if (EXTRA) $('file-input').accept = `${PHOTO_ACCEPT},.xmp,.XMP,.zip`;
$('open-btn').onclick = async () => openPicked(await openFiles());
$('library-import').onclick = () => importFolder();
// Commands from the desktop app's menu bar.
// Photos opened from outside the page (double-clicked in the file manager, or sent to a second instance).
if (native && native.onOpenPaths) native.onOpenPaths((files) => openPicked(files.map((f) => new NativeFile(f))));
// + Connect over Wi-Fi (the sidebar, under the library; desktop app, first generation cameras).
const cameraWifi = native && native.connectCameraWifi && CAMERA_IMPORT ? initCameraWifi({ $, native, importFromCamera: () => importFromCamera() }) : null;
if (cameraWifi) {
  $('camera-wifi-btn').hidden = false;
  $('camera-wifi-btn').onclick = () => cameraWifi.open();
}
if (native && native.onMenu) {
  native.onMenu((id) => {
    if (id === 'undo' || id === 'redo') {
      // The key itself may already have been handled in the page.
      if (performance.now() - state.lastHistoryKey < 300) return;
      if (typing(document.activeElement)) document.execCommand(id);
      else if (id === 'undo') undo();
      else redo();
    } else if (id === 'open') $('open-btn').click();
    else if (id === 'import-library') importFolder();
    else if (id === 'about') $('about-btn').click();
    else if (id === 'check-update') state.checkForUpdateNow();
  });
}
$('camera-btn').onclick = importFromCamera;
$('sample-btn').onclick = async () => {
  const my = openSeq.next();
  await flushSave();
  if (openSeq.superseded(my)) return;
  state.current = null;
  state.editsKey = null;
  state.wantThumb = false;
  renderLibrary();
  openWith({ synthetic: { width: 3864, height: 2684 } }, undefined, my);
};
// One button plays and pauses (its icon shows what a press does).
$('play-btn').onclick = () => setPlaying(!(state.playing || live.on));
// Stop: pause and go back to the start.
$('stop-btn').onclick = () => {
  stopProcessing();
  setPlaying(false);
  state.index = 0;
  state.direction = 1;
  state.keyTime = 0;
  if (state.frames.length && state.showingFrames) showFrame(0);
  else if (keyframesOn()) previewAt(0);
  renderTimeline();
  updateFrameLabel();
};
$('loop-btn').onclick = () => {
  state.repeat = !state.repeat;
  showLoop();
};

const icon = (d) => `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="${d}"/></svg>`;
$('stop-btn').innerHTML = icon('M3.5 3.5h9v9h-9z');
$('key-prev').innerHTML = icon('M7.5 3v10L1.5 8zM11.5 4.5L15 8l-3.5 3.5L8 8z');
$('key-next').innerHTML = icon('M8.5 3v10l6-5zM4.5 4.5L8 8l-3.5 3.5L1 8z');
// Previous / next keyframe: the playhead to the nearest keyframe time before / after it, on any track.
function stepKeyframe(dir) {
  const anim = state.anim;
  if (!anim || !anim.tracks) return;
  const now = playheadTime();
  const near = 0.5 / state.fps;
  let best = null;
  for (const keys of Object.values(anim.tracks)) {
    for (const key of keys || []) {
      if (dir > 0 ? key.t > now + near && (best === null || key.t < best) : key.t < now - near && (best === null || key.t > best)) best = key.t;
    }
  }
  if (best !== null) seekTo(best);
}
$('key-prev').onclick = () => stepKeyframe(-1);
$('key-next').onclick = () => stepKeyframe(1);
const ICON_PLAY = icon('M4 2.5v11l9.5-5.5z');
const ICON_PAUSE = icon('M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z');
$('loop-btn').innerHTML = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 9V7.5a3 3 0 0 1 3-3h8M11 2l2.5 2.5L11 7"/><path d="M13.5 7v1.5a3 3 0 0 1-3 3h-8M5 14l-2.5-2.5L5 9"/></g></svg>';

// The play button lights up while playing.
function showPlayIcon(playing) {
  for (const id of ['play-btn', 'pv-play']) {
    const b = $(id);
    b.classList.toggle('active', playing);
    b.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
    b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    b.setAttribute('aria-pressed', String(playing));
  }
}

function showLoop() {
  for (const id of ['loop-btn', 'pv-loop']) {
    $(id).classList.toggle('active', state.repeat);
    $(id).setAttribute('aria-pressed', String(state.repeat));
  }
}
// Animation > Preview: render every frame, then the usual transport controls (first, previous, stop, pause, play, next, last, loop) and a slider, as in a video editor's
// preview panel. They drive the same playback as the play bar under the picture.
$('pv-first').innerHTML = icon('M3 3h1.6v10H3zM13 3v10L5.5 8z');
$('pv-prev').innerHTML = icon('M11 3v10L4.5 8z');
$('pv-stop').innerHTML = $('stop-btn').innerHTML;
$('pv-next').innerHTML = icon('M5 3v10l6.5-5z');
$('pv-last').innerHTML = icon('M13 3h-1.6v10H13zM3 3v10l7.5-5z');
$('pv-loop').innerHTML = $('loop-btn').innerHTML;
$('pv-play').onclick = () => setPlaying(!(state.playing || live.on));
$('pv-res').onchange = () => {
  invalidateAnimation();
  if (state.showingFrames) backToCamera();
  updatePreviewStatus();
};
$('pv-stop').onclick = () => $('stop-btn').onclick();
$('pv-loop').onclick = () => $('loop-btn').onclick();
// Steps to a rendered frame and shows it (pausing).
function goToFrame(pick) {
  stopProcessing();
  setPlaying(false);
  if (state.frames.length < 2) return;
  setFullRes(false, { restore: false });
  setDepthShown(false, { restore: false });
  state.showingFrames = true;
  state.index = Math.min(state.frames.length - 1, Math.max(0, pick(state.index, state.frames.length)));
  showFrame(state.index);
  showPlayIcon(false);
}
$('pv-first').onclick = () => goToFrame(() => 0);
$('pv-last').onclick = () => goToFrame((i, n) => n - 1);
$('pv-prev').onclick = () => goToFrame((i) => i - 1);
$('pv-next').onclick = () => goToFrame((i) => i + 1);
$('pv-scrub').oninput = () => {
  $('scrub').value = $('pv-scrub').value;
  $('scrub').oninput();
};
// Render preview: all the frames first, then it plays; pressed again while rendering, it cancels.
$('pv-render').onclick = async () => {
  if (state.previewing) {
    invalidateAnimation();
    return;
  }
  if (!state.info || !$('anim-on').checked) return;
  setPlaying(false);
  state.previewing = true;
  updatePreviewStatus();
  const done = ensureAnimation();
  const key = state.animKey;
  await done;
  state.previewing = false;
  // Cancelled or changed meanwhile: the frames are gone.
  if (state.animKey === key && state.frames.length && !framesMissing()) setPlaying(true);
  updatePreviewStatus();
};
function updatePreviewStatus() {
  const n = state.frames.length;
  const ready = state.frames.filter(Boolean).length;
  $('pv-render').textContent = state.previewing ? 'Cancel' : n && ready === n ? 'Render again' : 'Render preview';
  $('pv-status').textContent = !n ? '' : ready === n ? `Ready · ${n} frames · ${(n / state.fps).toFixed(2)} s` : state.animKey ? `Rendering ${ready} / ${n}` : `Stopped at ${ready} / ${n}`;
  $('pv-status').hidden = !$('pv-status').textContent;
  $('pv-scrub').max = $('scrub').max;
  $('pv-scrub').value = $('scrub').value;
  showRenderedFrames();
}

// The play bar's slider (and the preview's) is lit where frames are rendered, so a render in progress fills it from the left.
function showRenderedFrames() {
  const n = state.frames.length;
  let channel = '';
  if (n > 1 && state.frames.some(Boolean)) {
    const stops = [];
    let last = 0;
    const at = (i) => `${(100 * Math.min(n, Math.max(0, i))) / n}%`;
    for (let i = 0; i < n; ) {
      if (!state.frames[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < n && state.frames[j + 1]) j++;
      stops.push(`var(--line) ${at(last)} ${at(i)}`, `var(--live) ${at(i)} ${at(j + 1)}`);
      last = j + 1;
      i = j + 1;
    }
    stops.push(`var(--line) ${at(last)} 100%`);
    channel = `linear-gradient(to right, ${stops.join(', ')})`;
  }
  for (const id of ['scrub', 'pv-scrub']) {
    if (channel) $(id).style.setProperty('--channel', channel);
    else $(id).style.removeProperty('--channel');
  }
}
showPlayIcon(false);
showLoop();
// Dragging the play bar's slider moves the playhead: a rendered frame
// where there is one, the animation's settings there until then.
$('scrub').oninput = () => {
  stopProcessing();
  setDepthShown(false, { restore: false });
  stopLivePlay();
  state.playing = false;
  showPlayIcon(false);
  const i = Math.round(+$('scrub').value);
  seekTo(i / state.fps);
  // Only the frame under the slider is made, never the whole preview (that is what Render preview is for). Keyframed animations show it through the live view (seekTo).
  if ($('anim').value !== 'keyframes' && !state.frames[i]) renderSingleFrame(i);
};
$('png-btn').onclick = savePng;

// The scripting interface (window.illuminator, ui/api.js): scripts, plugins and the command line drive the app through it.
({ emit: state.emitEvent } = initScriptingApi({
  state,
  $,
  engine,
  version: VERSION,
  openBytes: async (name, bytes, sidecar = null, { userDepth = null, depthCache = null } = {}) => {
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const my = openSeq.next();
    await flushSave();
    if (openSeq.superseded(my)) return;
    state.lastProcessed = null;
    state.scripted = true; // its settings are not read from, or saved to, the app's store
    state.current = { photo: null, name, file: new File([copy], name), sidecar };
    state.editsKey = null;
    state.wantThumb = false;
    timings.clear();
    renderLibrary();
    await openWith({ bytes: copy, userDepth, depthCache }, depthTransfer(userDepth, depthCache, [copy]), my);
  },
  // What opening and rendering the photo measured, as the file kept next to a library photo (the Render Queue saves it for the photo), or null.
  processedBytes: () => (state.lastProcessed && state.info && state.lastProcessed.photoId === state.info.photoId ? encodeProcessed(state.lastProcessed.cache) : null),
  applyEdits: (info, edits) => applyEdits(info, edits),
  currentEdits: () => currentEdits(),
  setCamera: async ({ fNumber, focus, u, v }) => {
    if (fNumber != null) {
      const i = F_STOPS.indexOf(+fNumber);
      if (i < 0) throw new Error(`f/${fNumber} is not offered: ${F_STOPS.join(', ')}`);
      $('fstop').value = i;
      showFNumber();
    }
    if (focus != null) {
      $('focus').value = (+focus).toFixed(2);
      showSliderValue($('focus'));
    }
    if (u != null || v != null) state.camera = { ...state.camera, ...(u != null ? { u: +u } : {}), ...(v != null ? { v: +v } : {}) };
    cameraChanged({ final: true });
  },
  setFullResMode: (on) => setFullResMode(on),
  exportPhoto: () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      captureDownloads(null);
      reject(new Error('The picture was not saved'));
    }, 20 * 60 * 1000);
    captureDownloads(async (blob, name) => {
      captureDownloads(null);
      clearTimeout(timer);
      resolve({ name, type: blob.type, bytes: new Uint8Array(await blob.arrayBuffer()) });
    });
    savePng();
  }),
  exportVideo: () => new Promise((resolve, reject) => {
    let got = false;
    const timer = setTimeout(() => {
      captureDownloads(null);
      reject(new Error('The video was not made'));
    }, 60 * 60 * 1000);
    captureDownloads(async (blob, name) => {
      got = true;
      captureDownloads(null);
      clearTimeout(timer);
      resolve({ name, type: blob.type, bytes: new Uint8Array(await blob.arrayBuffer()) });
    });
    exportVideo().then(() => {
      if (!got) {
        captureDownloads(null);
        clearTimeout(timer);
        reject(new Error('No video was made: Animation must be on and set up, and this computer must be able to record the chosen format'));
      }
    }, reject);
  }),
  speedReport: async () => {
    state.speedFacts = await engine.request('speedFacts', {}).catch(() => state.speedFacts);
    return speedReportText();
  },
}));

// The render queue (ui/queue.js): not inside the hidden copy that does its renders.
if (!QUEUE_RUNNER) state.queueUi = initQueue({ $, state, native, currentEdits: () => currentEdits(), showNotice: (...a) => showNotice(...a), showError: (...a) => showError(...a), thumbFor: (photo) => thumbFor(photo), openPhoto: (photo) => openItem(photo), renderLibrary: () => renderLibrary(), depthInputs: (photo) => depthInputs(photo) });

$('webm-btn').onclick = exportVideo;

// Quick export (top bar): the Photo and Video settings of Render Settings
// in a popup. Each field mirrors its sidebar control: read when shown, and
// a change is made on the sidebar control (so it is saved and undoable like
// any setting), then everything is read back (the video format limits the
// compressions offered).
const QUICK_EXPORT = ['stereo-on', 'stereo-mode', 'stereo-baseline', 'depth-hq', 'detail', 'fullres-on', 'still-scale', 'still-passes',
  'upscale-method', 'upscale-sharpen', 'photo-size', 'photo-format', 'photo-colorspace', 'photo-quality', 'video-size', 'video-codec', 'video-format', 'video-quality'];
const QUICK_ROWS = ['stereo-on-row', 'depth-hq-row', 'fullres-panel', 'photo-quality-row'];
const QUICK_BUTTONS = { 'qe-stereo-btn': 'stereo-btn', 'qe-render-btn': 'render-btn', 'qe-photo-btn': 'png-btn', 'qe-video-btn': 'webm-btn' };
function showQuickExport() {
  for (const id of QUICK_EXPORT) {
    const src = $(id);
    const el = $(`qe-${id}`);
    if (src.type === 'checkbox') el.checked = src.checked;
    else {
      if (src.tagName === 'SELECT') el.innerHTML = src.innerHTML;
      else for (const a of ['min', 'max', 'step']) el[a] = src[a];
      el.value = src.value;
    }
    el.disabled = src.disabled;
    const out = document.querySelector(`output[data-for="qe-${id}"]`);
    const shown = document.querySelector(`output[data-for="${id}"]`);
    if (out && shown) out.textContent = shown.textContent;
  }
  for (const id of QUICK_ROWS) $(`qe-${id}`).hidden = $(id).hidden;
  for (const [id, src] of Object.entries(QUICK_BUTTONS)) {
    $(id).textContent = $(src).textContent;
    $(id).disabled = $(src).disabled;
  }
  $('qe-video-btn').title = $('webm-btn').disabled ? 'Turn on Animation (in the Camera view) to export a video' : '';
}
for (const id of QUICK_EXPORT) {
  const el = $(`qe-${id}`);
  const copy = (type) => {
    if (el.type === 'checkbox') $(id).checked = el.checked;
    else $(id).value = el.value;
    $(id).dispatchEvent(new Event(type, { bubbles: true }));
    if (type === 'input' && el.type === 'range') showSliderValue($(id));
    showQuickExport();
  };
  el.addEventListener('input', () => copy('input'));
  el.addEventListener('change', () => copy('change'));
}
for (const [id, src] of Object.entries(QUICK_BUTTONS)) {
  $(id).onclick = () => {
    // Render keeps the popup open, to save the still once it is ready.
    if (id !== 'qe-render-btn') $('quick-export-dialog').close();
    $(src).click();
    showQuickExport();
  };
}
// Photo or Video: only the settings that kind of export uses.
function showQuickExportKind() {
  const kind = $('qe-kind').value;
  for (const el of document.querySelectorAll('#quick-export-dialog [data-qe]')) el.hidden = el.dataset.qe !== kind;
}
$('qe-kind').onchange = showQuickExportKind;
$('quick-export-btn').onclick = () => {
  showQuickExportKind();
  showQuickExport();
  $('quick-export-dialog').showModal();
};
$('fullres-on').onchange = () => setFullResMode($('fullres-on').checked);
$('render-btn').onclick = renderFullRes;
$('depth-btn').onchange = () => setDepthShown($('depth-btn').checked);
$('still-scale').onchange = () => setFullRes(false);
$('lens-centres').onchange = () => {
  applySettingsSoon();
  setFullRes(false);
};
$('still-scale').addEventListener('change', showPhotoSizes);
// The lattice filter's controls (under Scale, in the Full sensor panel, so shown with Full sensor on); changing one is a new render.
for (const id of ['lattice-on', 'lattice-strength', 'lattice-detect']) {
  $(id).addEventListener('input', () => {
    if ($(id).type === 'range') showSliderValue($(id));
    applySettingsSoon();
    setFullRes(false);
  });
}
for (const id of ['lattice-strength', 'lattice-detect']) {
  $(id).ondblclick = () => {
    $(id).value = $(id).dataset.default;
    showSliderValue($(id));
    applySettingsSoon();
    setFullRes(false);
  };
}
$('still-passes').onchange = () => {
  setFullRes(false);
  if (!state.fullRes) refresh();
};
$('grid-auto').onclick = () => updateGrid({ mode: 'auto' });
$('grid-meta').onclick = () => updateGrid({ mode: 'metadata' });
$('lens-circles').onchange = () => renderLenslets();
$('still-scale').addEventListener('change', () => renderLenslets());

async function updateGrid(args) {
  const info = await engine.request('setGrid', args, { onProgress: showProgress });
  hideProgress();
  state.info = { ...state.info, ...info };
  if (state.fullRes) setFullRes(false, { restore: false });
  state.still = null;
  invalidateAnimation();
  renderInfo();
  renderLenslets();
}

for (const b of document.querySelectorAll('#modes button')) b.onclick = () => setMode(b.dataset.mode);

function animationSettingsChanged() {
  $('anim-viewpoint').hidden = $('anim').value !== 'viewpoint';
  $('anim-focus').hidden = $('anim').value !== 'focus';
  $('anim-keyframes').hidden = $('anim').value !== 'keyframes';
  showAnimationLength();
  renderTimeline();
  if (state.lastImage) draw(state.lastImage);
  invalidateAnimation();
  if (state.showingFrames) {
    backToCamera();
    renderCamera();
  }
}
for (const id of ['anim', 'path', 'frames', 'steps']) $(id).onchange = animationSettingsChanged;
// Amount, Near and Far can be keyframed (Auto key records them).
// Auto key for Process and Optics sliders.
$('controls').addEventListener('change', (e) => {
  const k = KEY_CONTROLS[e.target.id] && KEY_CONTROLS[e.target.id][0];
  if (k && isSettingTrack(k)) autoKey();
});
for (const id of ['amount', 'near', 'far']) {
  $(id).onchange = () => {
    autoKey();
    animationSettingsChanged();
  };
}

// Animation > Enabled: playing, scrubbing and video export.
function showAnimationEnabled() {
  const on = $('anim-on').checked;
  $('anim-controls').disabled = !on;
  previewMirror.want(on && !!state.info);
  const camera = state.mode === 'camera';
  for (const id of ['stop-btn', 'key-prev', 'key-next', 'play-btn', 'loop-btn', 'webm-btn', 'scrub', ...PREVIEW_IDS]) $(id).disabled = !state.info || !camera || !on;
  // The keyframe controls in the sidebar show only while animation is enabled.
  updateKeyButtons();
}
$('anim-on').onchange = () => {
  if (!$('anim-on').checked) {
    setPlaying(false);
    if (state.showingFrames) {
      backToCamera();
      renderCamera();
    }
  }
  showAnimationEnabled();
  updateKeyButtons();
  renderTimeline();
  if (state.lastImage) draw(state.lastImage);
};

// The settings the color pass applies (Process and Optics), each slider read through `val(id)`: its value, or an animation frame's keyframed one (core: settingsmap.js).
function colorSettings(val = (id) => +$(id).value) {
  return buildColorSettings({ el: $, num: val });
}

// Never rejects (it is an onchange handler): a failure shows as a notice and the progress bar goes away.
async function applySettings() {
  const gen = openSeq.current();
  try {
    await applySettingsNow(gen);
  } catch (err) {
    if (!openSeq.superseded(gen)) {
      clearBusy();
      hideProgress();
      showError(err, 'Could not apply the settings');
    }
  }
}

async function applySettingsNow(gen) {
  await sendLut();
  const settings = buildRenderSettings({ el: $, num: (id) => +$(id).value }, { ...localSettings(), spots: $('retouch-spots').value });
  setHook('appliedSettings', settings); // for tests: what the page sends the engine
  $('fringe-controls').disabled = !settings.defringe.on;
  $('fringe-auto').disabled = !settings.defringe.on;
  // Auto defringe sets the colors itself.
  for (const key of FRINGES) {
    $(`fringe-${key}`).disabled = settings.defringe.auto;
    $(`fringe-${key}-hue`).disabled = settings.defringe.auto;
  }
  $('wb-temperature').disabled = settings.autoWb;
  $('wb-tint').disabled = settings.autoWb;
  $('mv-blend').disabled = !settings.mvDenoise.on;
  $('fringe-radius-label').textContent = `${settings.defringe.radius} px`;
  showFringeHues();
  // Which sliders can be used decides which of their tracks show.
  renderTimeline();
  if (!canRender()) return;
  // Progress shows when a setting needs work first (a depth mask measures depth).
  const info = await engine.request('settings', { settings }, { onProgress: progressFor(gen) });
  // Another photo opened meanwhile: these are not its settings.
  if (openSeq.superseded(gen)) return;
  hideProgress();
  if (info) state.info = { ...state.info, ...info };
  showAutoFringe();
  showResolutionSizes();
  // A change to the color settings alone, with Auto render on and the picture before its color pass kept (the worker says so): the full sensor picture stays on show and is
  // made again from the kept one, which takes moments. Any other change goes back to the live view until Render (or Auto render) makes a new still.
  const colorOnly = state.fullRes && state.still && state.stillKept && state.stillPre === stillPreKey(settings) && $('auto-render').checked && !state.depthShown && !state.showingFrames && !state.playing;
  setHook('stillColorOnly', { colorOnly: !!colorOnly, fullRes: state.fullRes, still: !!state.still, kept: state.stillKept, same: state.stillPre === stillPreKey(settings) }); // for tests
  if (colorOnly) {
    invalidateAnimation();
    renderStill();
    return;
  }
  if (state.fullRes) setFullRes(false, { restore: false });
  state.still = null;
  invalidateAnimation();
  if (state.showingFrames) backToCamera();
  refresh();
}

// Moves the defringe sliders to what auto defringe found.
function showAutoFringe() {
  const found = state.info && state.info.fringeAuto;
  if (!found || !$('fringe-auto').checked) return;
  FRINGES.forEach((key, i) => {
    $(`fringe-${key}`).value = found[i][0];
    $(`fringe-${key}-hue`).value = found[i][1];
  });
  showFringeHues();
}

function showFringeHues() {
  for (const key of FRINGES) $(`fringe-${key}-hue-label`).textContent = `${(+$(`fringe-${key}-hue`).value + 360) % 360}°`;
}

// Temperature starts at the white balance the camera used for this photo.
// Temperature starts at the white balance the camera used for this photo
// (`keep`: a saved value stays).
function resetTemperature(info, { keep = false } = {}) {
  const cct = info && info.cam && info.cam.capture && info.cam.capture.cct;
  const k = Math.min(10000, Math.max(2000, Math.round((cct || 5500) / 50) * 50));
  const input = $('wb-temperature');
  input.dataset.default = k;
  if (!keep) input.value = k;
  showSliderValue(input);
}

// ---------------------------------------------------------------- edits

// Every photo keeps its own edits (edits.js): restored when it opens, saved
// shortly after each change. Photos without saved edits start from the
// defaults.
const DEFAULT_EDITS = readEdits(document);

function photoKey(info) {
  if (info && info.photoId) return info.photoId;
  const cur = state.current;
  return cur ? `file:${cur.name}:${cur.file.size}` : null;
}

// Reset settings (a photo's ••• menu): its edits are replaced by a reset
// mark, so it opens as a new photo does, without Lytro Desktop's edits; an
// open photo starts over at once.
async function resetPhotoSettings(photo) {
  clearTimeout(state.saveTimer);
  await state.lib.saveEdits(photo, { format: EDITS_FORMAT, version: EDITS_VERSION, reset: true, photo: { id: photo.id, name: photo.name } });
  if (state.current && state.current.photo === photo && state.info) {
    if (state.playing) setPlaying(false);
    await restoreEdits(state.info);
    renderInfo();
  }
}

async function restoreEdits(info) {
  const gen = openSeq.current();
  clearTimeout(state.saveTimer);
  state.editsKey = photoKey(info);
  const photo = state.current && state.current.photo;
  // Library photos keep their edits in their folder; earlier versions kept
  // them in the app's storage, which is still read for those photos.
  let saved = photo ? await state.lib.loadEdits(photo) : null;
  if (openSeq.superseded(gen)) return;
  if (!saved && state.editsKey && !state.scripted) saved = await editsStore.load(state.editsKey);
  if (openSeq.superseded(gen)) return;
  const reset = !!(saved && saved.reset);
  if (reset) saved = null;
  else if (!saved) saved = await lytroEdits(info, state.current);
  // Another photo was opened meanwhile: these edits are not for it.
  if (openSeq.superseded(gen)) return;
  await applyEdits(info, saved);
  if (openSeq.superseded(gen)) return;
  resetHistory();
}

// Sets every control from an edits document (null: the defaults) and
// renders the result.
async function applyEdits(info, saved) {
  const gen = openSeq.current();
  // A count, not a flag: two overlapping runs must not end each other's restoring.
  state.restoring = openSeq.beginRestore();
  try {
    const { view, focusPoint } = writeEdits(document, saved, DEFAULT_EDITS);
    // Tilt is off by default; edits saved before it could be turned off keep
    // the tilt they had.
    const cam = saved && saved.camera;
    if (cam && !('tilt-on' in cam) && +cam.tilt) $('tilt-on').checked = true;
    // Hexagon became Blades (six of them by default).
    if (cam && cam.bokeh === 'hexagon') $('bokeh').value = 'blades';
    showBokehShape();
    for (const id of ['tilt', 'tilt-rotation', 'tilt-show']) $(id).disabled = !$('tilt-on').checked || $('tilt-on').disabled;
    $('pivot').disabled = !$('pivot-on').checked;
    curve.draw();
    colorGrading.redraw();
    showColorMatrix();
    $('flare-amount').disabled = !$('flare-on').checked;
    state.customFps = false;
    showFrameRate();
    showAnimationEnabled();
    showVideoCodecs();
    showPhotoFormat();
    state.upscaleShown = null;
    showUpscaleControls(true);
    showObjectSoft();
    state.depthModelShown = null;
    showDepthBlend(true);
    // (a photo that carries its depth uses it whatever its saved edits say)
    if (info === state.info) showDepthMethods();
    state.maskSel = getMasks().length ? 0 : -1;
    $('mask-show').checked = false;
    renderMasks();
    if (state.retouchUi) {
      state.retouchUi.setTool(null);
      state.retouchSel = state.retouchUi.getSpots().length ? 0 : -1;
      state.retouchUi.renderList();
    }
    resetTemperature(info, { keep: !!saved });
    state.camera = { ...view };
    showViewpoint();
    state.focusPoint = { ...focusPoint };
    // Lytro Desktop's living filter: ours like it, around the focus.
    if (saved && saved.lytroFilter) {
      const opt = [...$('mask-filter').options].find((o) => o.value === saved.lytroFilter);
      const added = livingFilter(saved.lytroFilter).map((m) => ({ ...m, name: opt ? opt.textContent.trim() : '' }));
      const masks = [...getMasks(), ...added].slice(0, MAX_MASKS);
      $('local-masks').value = JSON.stringify(masks);
      state.maskSel = masks.length ? 0 : -1;
      renderMasks();
    }
    showFocusPoint();
    // (the lenticular print's focus point comes with the photo's settings)
    lenticular.showFocus();
    for (const input of document.querySelectorAll('aside.controls input[type=range]')) showSliderValue(input);
    showFNumber();
    $('anim-viewpoint').hidden = $('anim').value !== 'viewpoint';
    $('anim-keyframes').hidden = $('anim').value !== 'keyframes';
    loadAnimation();
    $('anim-focus').hidden = $('anim').value !== 'focus';
    await applySettings();
  } finally {
    state.restoring = openSeq.endRestore();
  }
  if (openSeq.superseded(gen)) return;
  // Full sensor is a mode (the panel, the Render button, Auto render), not just a value.
  setFullResMode($('fullres-on').checked);
}

// The edits Lytro Desktop saved for a photo (in its stack.view.lfp, or in
// the file itself), as Illuminator edits, or null. Used for photos that have
// no Illuminator edits yet; they are saved as ours once changed.
async function lytroEdits(info, item) {
  let recipe = null;
  try {
    const sidecar = item ? item.sidecar || (await findSidecar(item.file)) : null;
    if (sidecar) recipe = findRecipe((await openContainer(blobReader(sidecar))).toc);
  } catch (err) {
    console.warn('Could not read Lytro Desktop edits', err);
  }
  if (!recipe) recipe = info && info.recipe;
  if (!recipe) return null;
  const capture = (info.cam && info.cam.capture) || {};
  const { edits, unsupported } = recipeToEdits(recipe, {
    nativeF: capture.fNumber || 2,
    asShot: capture.cct || 5500,
    radius: info.radius || 4.5,
    viewWidth: info.width || 615,
  });
  // A processed file's pictures already carry Lytro's color and detail
  // edits; only its focus, aperture and viewpoint apply.
  if (!info.hasRaw) {
    delete edits.process;
    delete edits.details;
    delete edits.defringe;
    delete edits.local;
    delete edits.lytroFilter;
  }
  state.notice = ['Applied this photo\u2019s edits from Lytro Desktop.', unsupported.length ? `Not supported yet: ${unsupported.join(', ')}.` : ''];
  return edits;
}

// A note over the picture; it goes away by itself a while after the picture
// first shows.
let noticeTimer = null;
// Where the notice lives when no dialog is open.
const noticeHome = $('notice').parentElement;

function showNotice(text, detail = '') {
  hideNotice();
  $('notice-text').textContent = text;
  $('notice-detail').textContent = detail;
  $('notice-detail').hidden = !detail;
  $('notice').hidden = false;
  // Above an open dialog and its backdrop, and usable: everything outside a
  // modal dialog is inert (its text cannot be selected), so the notice goes
  // into the dialog while one is open.
  const dialog = document.querySelector('dialog[open]');
  if (dialog && $('notice').parentElement !== dialog) dialog.prepend($('notice'));
  else if (!dialog && $('notice').parentElement !== noticeHome) noticeHome.prepend($('notice'));
  try {
    if ($('notice').matches(':popover-open')) $('notice').hidePopover();
    $('notice').showPopover();
  } catch {
    // No popover support: it stays under a dialog's backdrop.
  }
}

// While the pointer is over a notice (to select its text) it stays.
$('notice').addEventListener('pointerenter', () => { clearTimeout(noticeTimer); noticeTimer = null; });

function startNoticeTimer() {
  if (noticeTimer || $('notice').hidden) return;
  noticeTimer = setTimeout(hideNotice, $('notice-detail').hidden ? 6000 : 12000);
}

function hideNotice() {
  clearTimeout(noticeTimer);
  noticeTimer = null;
  try {
    if ($('notice').matches(':popover-open')) $('notice').hidePopover();
  } catch {
    // Not a popover here.
  }
  $('notice').hidden = true;
}

$('notice-close').onclick = hideNotice;

function scheduleSave() {
  if (state.restoring || !state.editsKey || !canRender() || state.scripted) return;
  clearTimeout(state.saveTimer);
  const key = state.editsKey;
  const photo = state.current && state.current.photo;
  state.saveTimer = setTimeout(() => {
    state.saveTimer = 0;
    // The controls and the viewpoint must still be this photo's (another one may be opening, with the view reset).
    if (key !== state.editsKey || !state.info || (state.current && state.current.photo) !== photo) return;
    const edits = readEdits(document, {
      photo: { id: key, name: state.current ? state.current.name : null },
      view: state.camera,
      focusPoint: state.focusPoint,
    });
    recordHistory(edits);
    if (photo) state.lib.saveEdits(photo, edits).catch((err) => console.warn('Could not save edits', err));
    else editsStore.save(key, edits);
  }, 500);
}

// ---------------------------------------------------------------- undo

// Undo and redo (Ctrl / ⌘ + Z, Ctrl / ⌘ + Y or Shift + Ctrl / ⌘ + Z): every
// saved state of the open photo's edits is a step, so one slider drag or
// keyframe change is one step. History starts over when a photo opens.
const HISTORY_LIMIT = 200;
const history = { undo: [], redo: [], current: null };
const editsState = (edits) => {
  const { modified, photo, ...rest } = edits;
  return JSON.stringify(rest);
};
function currentEdits() {
  return readEdits(document, { view: { ...state.camera }, focusPoint: { ...state.focusPoint } });
}
function resetHistory() {
  history.undo = [];
  history.redo = [];
  history.current = state.info ? currentEdits() : null;
}
function recordHistory(edits) {
  if (!history.current) {
    history.current = edits;
    return;
  }
  if (editsState(edits) === editsState(history.current)) return;
  history.undo.push(history.current);
  if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
  history.redo = [];
  history.current = edits;
}
// A change still waiting to be saved counts as a step.
// Returns the save, so a caller can wait for it.
function flushSave() {
  if (!state.saveTimer) return Promise.resolve();
  clearTimeout(state.saveTimer);
  state.saveTimer = 0;
  const key = state.editsKey;
  const photo = state.current && state.current.photo;
  // (the view of a photo being opened was reset: those controls are not this photo's)
  if (!key || !state.info) return Promise.resolve();
  const edits = readEdits(document, { photo: { id: key, name: state.current ? state.current.name : null }, view: state.camera, focusPoint: state.focusPoint });
  recordHistory(edits);
  if (photo) return state.lib.saveEdits(photo, edits).catch((err) => console.warn('Could not save edits', err));
  editsStore.save(key, edits);
  return Promise.resolve();
}
let historyBusy = false;
async function stepHistory(back) {
  if (historyBusy || !state.info || state.restoring) return;
  await flushSave();
  const from = back ? history.undo : history.redo;
  const to = back ? history.redo : history.undo;
  if (!from.length) return;
  historyBusy = true;
  try {
    if (state.playing) setPlaying(false);
    to.push(history.current);
    await applyEdits(state.info, from.pop());
    // What the controls hold now (the document as applied).
    history.current = currentEdits();
    scheduleSave();
  } catch (err) {
    showError(err);
  } finally {
    historyBusy = false;
  }
}
const undo = () => stepHistory(true);
const redo = () => stepHistory(false);
// Text fields keep their own undo.
const typing = (el) => el && (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|number|email|url|password)$/.test(el.type)));
state.marks = initMarks({ $, state, renderLibrary: () => renderLibrary(), typing });
state.looks = initLooks({ $, state, defaultEdits: () => DEFAULT_EDITS, showMenu: (...a) => showMenu(...a), editName: (...a) => editName(...a), confirmInMenu: (...a) => confirmInMenu(...a), currentEdits: () => currentEdits(), flushSave: () => flushSave(), applyEdits: (...a) => applyEdits(...a), scheduleSave: () => scheduleSave(), showNotice: (...a) => showNotice(...a), showError: (...a) => showError(...a), download: (...a) => download(...a) });
renderLibrary();
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || typing(document.activeElement) || document.querySelector('dialog[open]')) return;
  const k = e.key.toLowerCase();
  const isUndo = k === 'z' && !e.shiftKey;
  const isRedo = k === 'y' || (k === 'z' && e.shiftKey);
  if (!isUndo && !isRedo) return;
  e.preventDefault();
  state.lastHistoryKey = performance.now();
  if (isUndo) undo();
  else redo();
});

for (const type of ['input', 'change']) $('controls').addEventListener(type, scheduleSave);


// Color sliders update the picture while dragging (one request at a time),
// show their value and reset to their default on double-click.
let applying = null;
function applySettingsSoon() {
  if (applying) {
    state.applyAgain = true;
    return;
  }
  applying = applySettings().catch((err) => showError(err, 'Could not apply the settings')).finally(() => {
    applying = null;
    if (state.applyAgain) {
      state.applyAgain = false;
      applySettingsSoon();
    }
  });
}
function showSliderValue(input) {
  const out = document.querySelector(`output[data-for="${input.id}"]`);
  if (!out) return;
  // (an animation's in-between value is held exactly, see ui/exactslider.js, and shown as it is: two more decimals than the slider's step where it is between steps)
  const step = sliderStep(input);
  const raw = +input.value;
  const onStep = Math.abs(raw / step - Math.round(raw / step)) < 1e-6;
  const decimals = Math.min(6, (String(step).split('.')[1] || '').length + (onStep ? 0 : 2));
  const v = +raw.toFixed(decimals);
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  if (input.id === 'ev') out.textContent = `${sign}${Math.abs(v).toFixed(Math.max(2, decimals))} EV`;
  else if (input.id === 'focus') out.textContent = `${sign}${Math.abs(v).toFixed(Math.max(2, decimals))}`;
  else if (input.id === 'tilt-rotation' || input.id === 'bokeh-rotation') out.textContent = `${v}°`;
  else if (input.id === 'straighten') out.textContent = `${v.toFixed(1)}°`;
  else if (input.id === 'ml-angle') out.textContent = `${v}°`;
  else if (/^grade-.*-hue$/.test(input.id)) out.textContent = `${v}°`;
  else if (/^grade-.*-sat$/.test(input.id) || input.id === 'grade-blend') out.textContent = `${v}`;
  else if (input.id === 'frame-zoom') out.textContent = `${v}%`;
  else if (input.id === 'frame-pan-x' || input.id === 'frame-pan-y') out.textContent = `${sign}${Math.abs(v)}`;
  else if (input.id === 'view-reach' || input.id === 'lent-depth') out.textContent = `${v}%`;
  else if (input.id === 'highlights') out.textContent = `${+(v * 100).toFixed(Math.max(0, decimals - 2))}%`;
  else if (input.id === 'video-quality') out.textContent = `${v} Mbit/s`;
  else if (['photo-quality', 'bokeh-blades', 'stereo-baseline', 'upscale-sharpen', 'upscale-strength', 'upscale-lobes', 'upscale-denoise', 'upscale-grain', 'depth-model-smooth', 'depth-model-curve', 'lattice-strength', 'lattice-detect'].includes(input.id)) out.textContent = `${v}`;
  else if (input.id === 'mx-strength' || input.id === 'lut-amount') out.textContent = `${v}%`;
  else if (input.id === 'mx-exposure') out.textContent = `${sign}${Math.abs(v / 100).toFixed(2)} EV`;
  else if (input.id === 'md-near' || input.id === 'md-far') out.textContent = `${sign}${Math.abs(v / 100).toFixed(2)}`;
  else if (input.closest('.mask-shape')) out.textContent = `${v}`;
  else if (input.id === 'wb-temperature') out.textContent = `${v} K`;
  else if (input.id === 'sharp-radius') out.textContent = v.toFixed(1);
  else if (input.id === 'nr-speckle-size') out.textContent = `${v} px`;
  else if (input.parentElement.closest('.details-panel')) out.textContent = `${v}`;
  else out.textContent = `${sign}${Math.abs(v)}`;
}
// Camera sliders with a default reset the same way.
for (const input of document.querySelectorAll('[data-panel=camera] input[type=range][data-default]')) {
  if (input.closest('.color-panel, .details-panel')) continue; // those two panels reset their sliders below
  showSliderValue(input);
  input.addEventListener('dblclick', () => {
    input.value = input.dataset.default;
    input.oninput();
    input.onchange();
  });
}

for (const input of document.querySelectorAll('.color-panel input[type=range], .details-panel input[type=range]')) {
  showSliderValue(input);
  input.addEventListener('input', () => {
    showSliderValue(input);
    applySettingsSoon();
  });
  input.addEventListener('dblclick', () => {
    input.value = input.dataset.default;
    showSliderValue(input);
    applySettingsSoon();
  });
}

$('flare-on').onchange = () => {
  $('flare-amount').disabled = !$('flare-on').checked;
  applySettings();
};
$('lens-auto').onchange = applySettings;
for (const id of ['lens-distortion', 'lens-vignetting', 'lens-midpoint', 'lens-softness']) {
  $(id).oninput = () => {
    showSliderValue($(id));
    applySettingsSoon();
  };
  $(id).ondblclick = () => {
    $(id).value = $(id).dataset.default;
    $(id).oninput();
  };
}
$('flare-amount').oninput = () => {
  showSliderValue($('flare-amount'));
  applySettingsSoon();
};
for (const id of ['awb', 'base-look', 'mv-on', 'nr-hot', 'detail', 'fringe-on', 'fringe-auto', 'fringe-radius', 'fringe-threshold', ...FRINGES.flatMap((k) => [`fringe-${k}`, `fringe-${k}-hue`])]) $(id).onchange = applySettings;
$('fringe-radius').oninput = () => { $('fringe-radius-label').textContent = `${$('fringe-radius').value} px`; };
for (const key of FRINGES) $(`fringe-${key}-hue`).oninput = showFringeHues;

// A focused button or checkbox would also act on Space (on key up): not
// when Space just played or paused.
let spacePlayed = false;
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && spacePlayed) {
    spacePlayed = false;
    if (!document.querySelector('dialog[open]')) e.preventDefault();
  }
}, true);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.picking) {
    setPicking(false);
    return;
  }
  // Shortcuts belong to the page, not to an open dialog.
  if (document.querySelector('dialog[open]')) return;
  // Space plays and pauses from anywhere, also right after using a slider; fields that take typing keep it, and so do buttons, checkboxes and links (Space presses them).
  if (e.code === 'Space' && !e.repeat && state.mode === 'camera' && state.info && $('anim-on').checked
    && !e.target.matches('textarea, select, button, a[href], summary, [role=button], [contenteditable], input:not([type=range])')) {
    e.preventDefault();
    setPlaying(!(state.playing || live.on));
    spacePlayed = true;
    return;
  }
  if (e.target.matches('input, select, textarea')) return;
  if (e.code === 'Space') {
    e.preventDefault();
  } else if (state.grid && (e.key === '+' || e.key === '=')) {
    setThumbSize(+$('thumb-size').value * 1.25);
  } else if (state.grid && (e.key === '-' || e.key === '_')) {
    setThumbSize(+$('thumb-size').value / 1.25);
  } else if (e.key === '+' || e.key === '=') {
    $('zoom-in').click();
  } else if (e.key === '-' || e.key === '_') {
    $('zoom-out').click();
  } else if (e.key === 'f' || e.key === 'F') {
    setFullResMode(!state.fullResMode);
  } else if (e.key === 'd' || e.key === 'D') {
    setDepthShown(!state.depthShown);
  } else if (e.key === '0') {
    $('zoom-label').click();
  } else if (e.key === '1') {
    $('zoom-1').click();
  }
});

// Files can be dropped anywhere in the window.
const drop = $('drop-zone');
let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
  dragDepth++;
  drop.classList.add('dragover');
});
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) drop.classList.remove('dragover');
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  drop.classList.remove('dragover');
  const files = [...(e.dataTransfer ? e.dataTransfer.files : [])];
  if (!files.length) return;
  if (!files.some((f) => isLightFieldName(f.name))) {
    showError(new Error(EXTRA ? `${files[0].name} is not a photo Illuminator can open. Drop ${EXTRA.dropHint}.` : `${files[0].name} is not a Lytro or Light L16 file. Drop an .LFR, .LFP, .LRI or .RAW file.`));
    return;
  }
  openPicked(files);
});

canvas.classList.add('hidden');
setMode('camera');
state.libReady = openLibrary();
state.calReady = state.libReady.then(() => sendCalibrations()).catch(() => {});
$('version').textContent = VERSION;

// Desktop app: the camera's photos show in the Camera section as soon as
// it is connected (a drive, or adb). WebUSB plug-in events (any OS; the main
// process lets the page see Lytro's vendor ID only) show it at once, before
// its drive mounts, and make the main process look for the drive sooner.
if (native) document.body.classList.add('native');
if (CAMERA_IMPORT) {
  // The desktop app shows the button once a camera is detected (below);
  // a browser has no way to tell, so it always shows it.
  $('camera-btn').hidden = !!native;
  $('camera-status').hidden = false;
}
if (native && CAMERA_IMPORT) {
  let lastCams = [];
  let usbLytros = 0;
  let usbProblem = '';
  const showCameras = () => {
    const count = lastCams.reduce((n, c) => n + c.files.length, 0);
    $('camera-status').textContent = lastCams.length
      ? `Lytro camera connected · ${count} photo${count === 1 ? '' : 's'}`
      : usbLytros ? 'Lytro camera connected · looking for photos…' : '';
    $('camera-status').classList.toggle('connected', lastCams.length > 0 || usbLytros > 0);
    $('camera-btn').hidden = !(lastCams.length > 0 || usbLytros > 0);
    const c = lastCams.find((x) => x.files.length) || lastCams[0];
    setCameraSection(c ? { cam: { kind: c.kind, id: c.id, label: c.label, files: c.files } }
      : usbProblem ? { note: usbProblem } : usbLytros ? { note: 'Lytro camera connected. Looking for its photos…' } : {});
  };
  // A Lytro on USB the app could not use: say why (a driver, a protocol the
  // camera does not answer), instead of showing nothing.
  const refreshProblems = () => {
    if (lastCams.length || !native.cameraProblems) return;
    native.cameraProblems().then(({ problems }) => {
      const next = problems && problems.length ? problems[0] : '';
      if (next === usbProblem) return;
      usbProblem = next;
      if (!lastCams.length) setCameraSection(usbProblem ? { note: usbProblem } : usbLytros ? { note: 'Lytro camera connected. Looking for its photos…' } : {});
    }).catch(() => {});
  };
  setInterval(refreshProblems, 5000);
  native.listCameras().then((cams) => {
    lastCams = cams;
    showCameras();
    refreshProblems();
    if (cameraWifi) cameraWifi.camerasChanged(cams);
  }).catch(() => {});
  native.onCamerasChanged((cams) => {
    lastCams = cams;
    showCameras();
    if (cameraWifi) cameraWifi.camerasChanged(cams);
  });
  if (navigator.usb) {
    const isLytro = (d) => d.vendorId === LYTRO_USB_VENDOR;
    navigator.usb.addEventListener('connect', (e) => {
      if (!isLytro(e.device)) return;
      usbLytros++;
      showCameras();
      native.cameraUsbConnected();
    });
    navigator.usb.addEventListener('disconnect', (e) => {
      if (!isLytro(e.device)) return;
      usbLytros = Math.max(0, usbLytros - 1);
      showCameras();
    });
    navigator.usb.getDevices().then((devices) => {
      usbLytros = devices.filter(isLytro).length;
      showCameras();
    }).catch(() => {});
  }
}

// Browser: WebUSB tells the page when a Lytro is plugged in, once the user
// has allowed this site to see it (Detect camera…, Chrome and Edge). It
// cannot read the photos over USB (browsers keep USB drives to the OS):
// the camera's drive is chosen once and remembered, and its photos show in
// the Camera section on later plug-ins (the browser may ask to allow
// reading it again).
if (!native && !navigator.usb && CAMERA_IMPORT) {
  // Firefox and Safari have no WebUSB: say so instead of hiding the button.
  $('usb-watch-btn').hidden = false;
  $('usb-watch-btn').onclick = () => {
    showNotice('This browser cannot detect a camera being plugged in (it has no WebUSB). Use Chrome or Edge, or choose the camera\'s DCIM folder instead.');
    startNoticeTimer();
  };
}
if (!native && navigator.usb && CAMERA_IMPORT) {
  const isLytro = (d) => d.vendorId === LYTRO_USB_VENDOR;
  const allowedKey = 'illuminator.usbWatch';
  let connected = 0;
  const showUsbStatus = () => {
    $('camera-status').textContent = connected ? 'Lytro camera connected' : '';
    $('camera-status').classList.toggle('connected', connected > 0);
    // Always shown, so the camera can be chosen again.
    $('usb-watch-btn').hidden = false;
  };
  const arrived = async () => {
    showUsbStatus();
    if (state.cameraSection.cam) return;
    setCameraSection({ note: 'Lytro camera connected.', show: true });
    // The drive chosen last time, if the browser still lets the page read
    // it: list it (it can take a few seconds to mount).
    const dir = await recallCameraFolder();
    if (!dir || !dir.queryPermission || (await dir.queryPermission({ mode: 'read' }).catch(() => 'denied')) !== 'granted') return;
    for (let i = 0; i < 10 && connected && !state.cameraSection.cam; i++) {
      if (await showWebCamera(dir)) return;
      await new Promise((r) => setTimeout(r, 1500));
    }
  };
  navigator.usb.addEventListener('connect', (e) => {
    if (!isLytro(e.device)) return;
    connected++;
    openWebUsbCamera(e.device).then((ok) => { if (!ok) arrived(); });
  });
  navigator.usb.addEventListener('disconnect', (e) => {
    if (!isLytro(e.device)) return;
    if (state.webUsbDevice === e.device) {
      state.webUsbConn = null;
      state.webUsbDevice = null;
    }
    connected = Math.max(0, connected - 1);
    showUsbStatus();
    if (!connected) setCameraSection({});
  });
  navigator.usb.getDevices().then(async (devices) => {
    const cameras = devices.filter(isLytro);
    connected = cameras.length;
    if (connected) {
      if (await openWebUsbCamera(cameras[0])) {
        showUsbStatus();
        return;
      }
      arrived();
    } else showUsbStatus();
  }).catch(() => showUsbStatus());
  state.askCameraPermission = async () => {
    try {
      const device = await navigator.usb.requestDevice({ filters: [{ vendorId: LYTRO_USB_VENDOR }] });
      try {
        localStorage.setItem(allowedKey, '1');
      } catch {
        // Only hides the button next time.
      }
      if (isLytro(device)) {
        connected = Math.max(connected, 1);
        // Read the camera over USB if it has an interface a browser can use.
        if (await openWebUsbCamera(device)) {
          showUsbStatus();
          return true;
        }
        arrived();
      }
      showUsbStatus();
      showNotice(state.webUsbReport ? `The camera was found but could not be read over USB. ${state.cameraSection.note || ''} ${state.webUsbReport.replace(/\n/g, ' · ')}` : 'Illuminator will now notice when this camera is plugged in.');
      startNoticeTimer();
      return true;
    } catch (err) {
      if (err.name === 'SecurityError') {
        // A page embedded in another (a preview frame) is not allowed to use USB.
        showNotice('This page is not allowed to use USB because it is shown inside another page (a preview or an artifact viewer, even in a separate tab). Open Illuminator from its web address, such as the website\'s Try online link, in Chrome or Edge.');
        startNoticeTimer();
      } else if (err.name === 'NotFoundError') {
        // Also what a closed chooser gives. A first generation camera shows
        // itself to the computer only as a USB drive, a kind of device the
        // browser does not offer to pages, so it may not be listed at all.
        showNotice('No camera was chosen. If none was listed: the browser only offers cameras that are not plain USB drives (a first generation camera may not be listed), and the camera must be plugged in and switched on.');
        startNoticeTimer();
      } else showError(err);
    }
    return false;
  };
  $('usb-watch-btn').onclick = () => state.askCameraPermission();
}
$('camera-choose').onclick = () => importFromCameraFolder();

// The browser version: a browser may serve the page and its scripts from its cache for a while after a new version went live, so the first open shows the old one (the
// old About window, for one). When the live version number differs from the one running, the page is loaded once more from the server (not in the desktop app, whose files
// come with it). Once per tab session, so a host that serves an old file cannot loop it.
if (!native && /^https?:$/.test(location.protocol)) {
  (async () => {
    try {
      if (sessionStorage.getItem('illuminator.reloaded') === VERSION) return;
      const text = await (await fetch(new URL('./version.js', import.meta.url), { cache: 'no-store' })).text();
      const live = /VERSION\s*=\s*'([^']+)'/.exec(text);
      if (live && live[1] !== VERSION) {
        sessionStorage.setItem('illuminator.reloaded', VERSION);
        location.reload();
      }
    } catch {
      // No network or no storage: the page stays as it is.
    }
  })();
}

// Test hook: ?sample opens the synthetic sample on load.
if (new URLSearchParams(location.search).has('sample')) $('sample-btn').click();

// LUT: ui/lut.js
const { sendLut } = initLut({ $, engine, showProgress: (...a) => showProgress(...a), hideProgress: (...a) => hideProgress(...a), canRender: (...a) => canRender(...a), showNotice: (...a) => showNotice(...a), startNoticeTimer: (...a) => startNoticeTimer(...a), showError: (...a) => showError(...a), scheduleSave: (...a) => scheduleSave(...a), applySettingsSoon: (...a) => applySettingsSoon(...a), TRASH_ICON, showSliderValue: (...a) => showSliderValue(...a) });

// updates: ui/updates.js
const { checkNow } = initUpdates({ showNotice: (...a) => showNotice(...a), $ });
state.checkForUpdateNow = checkNow;
