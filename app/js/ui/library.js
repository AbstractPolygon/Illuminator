// library: moved out of main.js. initLibrary() runs where the section used to, with what it uses from the rest of the page.
import { Selection } from './selection.js';
import { EXTRA } from '../extra.js';
import { LIGHT_FIELD_FILE } from '../core/photoformats.js';
import { hashBytes } from '../core/keptpicture.js';
import { readPhotoSummary, blobReader } from '../core/lfp.js';
import { Library } from '../library/library.js';
import { openStorage, memoryStorage } from '../library/storage.js';
import { CAMERA_IMPORT } from '../platform.js';

export function initLibrary({ state, renderLibraryHead, canvas, openSeq, virtualMasterName, busy, renderAlbums, $, photoMenu, busyBadge, chooseListedPhoto, renderCameraSection, renderCameraGrid, renderGrid, renderFilmstrip }) {

  // The photo library (library/library.js): every photo opened, dropped or
  // imported is copied into it, in a folder of its own.
  const thumbs = new Map(); // photo id -> object URL (null while loading)
  const PHOTO_DRAG = 'application/x-illuminator-photo';
  // Picking several photos in the grid to delete them together.
  const selection = new Selection();

  // The render queue's renders run in a hidden copy of this page opened with ?queue (ui/queue.js).
  const QUEUE_RUNNER = typeof location !== 'undefined' && /[?&]queue\b/.test(location.search);

  async function openLibrary() {
    for (const url of thumbs.values()) if (url) URL.revokeObjectURL(url);
    thumbs.clear();
    // (the pictures still waiting belong to the library being left)
    thumbWaiting.length = 0;
    // (a photo app/js/extra.js opens: what it keeps of it)
    const readSummary = (f) => (EXTRA && !LIGHT_FIELD_FILE.test(f.name) ? EXTRA.readSummary(f, hashBytes) : readPhotoSummary(blobReader(f)));
    try {
      // (the hidden copy that makes the render queue's files keeps no library of its own)
      if (QUEUE_RUNNER) throw new Error('queue runner');
      state.lib = await new Library(await openStorage(), { readSummary }).load();
    } catch (err) {
      if (!QUEUE_RUNNER) console.warn('Could not open the library; photos are kept for this session only', err);
      state.lib = await new Library(memoryStorage(), { readSummary }).load();
    }
    if (state.album && !state.lib.album(state.album)) state.album = null;
    renderLibrary();
    renderLibraryHead();
    return state.lib;
  }

  async function asBlob(f) {
    if (!f || f instanceof Blob) return f;
    return new Blob([await f.arrayBuffer()], { type: /\.png$/i.test(f.name) ? 'image/png' : 'image/jpeg' });
  }

  // The library's pictures load a few at a time, and the list is drawn again once for a batch of them, not once for each: drawing the whole list after every
  // picture made opening a big library cost the square of its size.
  const THUMB_LOADS_AT_ONCE = 6;
  const thumbWaiting = [];
  let thumbWorkers = 0;
  let thumbRedraw = null;
  async function loadThumbs() {
    while (thumbWaiting.length) {
      const photo = thumbWaiting.shift();
      const lib = state.lib;
      if (!lib || lib.get(photo.id) !== photo) continue; // removed from the library meanwhile, or from another library
      try {
        const blob = await asBlob(await lib.thumbnail(photo));
        if (state.lib !== lib || !blob || thumbs.get(photo.id) !== null) continue;
        thumbs.set(photo.id, URL.createObjectURL(blob));
        thumbRedraw ||= setTimeout(() => {
          thumbRedraw = null;
          renderLibrary();
        }, 150);
      } catch {
        // (the picture stays missing)
      }
    }
  }

  function thumbFor(photo) {
    if (thumbs.has(photo.id)) return thumbs.get(photo.id);
    thumbs.set(photo.id, null);
    if (photo.thumb) {
      thumbWaiting.push(photo);
      if (thumbWorkers < THUMB_LOADS_AT_ONCE) {
        thumbWorkers++;
        loadThumbs().finally(() => thumbWorkers--);
      }
    }
    return null;
  }

  // A small picture of the photo as first shown, for photos whose file has no
  // thumbnail of its own (Lytro Desktop's raw.lfp).
  function saveThumbnail() {
    state.wantThumb = false;
    const photo = state.current && state.current.photo;
    if (!photo || !state.lib || !canvas.width) return;
    const gen = openSeq.current();
    const s = Math.min(1, 320 / Math.max(canvas.width, canvas.height));
    const c = document.createElement('canvas');
    c.width = Math.round(canvas.width * s);
    c.height = Math.round(canvas.height * s);
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
    c.toBlob((blob) => {
      if (!blob || openSeq.superseded(gen)) return;
      state.lib.saveThumbnail(photo, blob).then(() => {
        const old = thumbs.get(photo.id);
        if (old) URL.revokeObjectURL(old);
        thumbs.set(photo.id, URL.createObjectURL(blob));
        renderLibrary();
      }).catch(() => {});
    }, 'image/jpeg', 0.85);
  }

  const EMPTY_LIBRARY = CAMERA_IMPORT
    ? `${EXTRA ? EXTRA.openHint : 'Open .LFR / .LFP / .LRI files, drop them here, or import from'} a camera or Lytro Desktop.`
    : `${EXTRA ? EXTRA.openHint : 'Open .LFR / .LFP / .LRI files, drop them here, or import from'} Lytro Desktop.`;

  // The Camera section's state (see setCameraSection).
  const cameraThumbs = new Map();

  // Rows and tiles are built again only when what they show changed (a thumbnail arriving, a rating, the open photo, a busy photo, a name): the others are reused, so
  // drawing a big library after each thumbnail costs only what changed, not the whole list again.
  let listRows = new Map();
  function photoSig(photo, current, url) {
    return JSON.stringify([photo.name, photo.master ? virtualMasterName(photo) : '', url || '', photo === current, !!(state.queueUi && state.queueUi.isPicked(photo)), busy.has(photo.id), photo.rating || 0, photo.flag || '', photo.keywords || []]);
  }

  function renderLibrary() {
    renderAlbums();
    const album = state.lib && state.album ? state.lib.album(state.album) : null;
    const everyone = state.lib ? state.lib.list(state.album) : [];
    const photos = state.marks ? state.marks.applyFilter(everyone) : everyone;
    $('photos-title').textContent = album ? album.name : 'All photos';
    const current = state.current && state.current.photo;
    state.listedPhotos = photos;
    // Rebuilding the list would drop the keyboard focus: put it back on the same row (or its ••• button).
    const focused = document.activeElement && document.activeElement.closest ? document.activeElement.closest('#library-list li') : null;
    const focusId = focused ? focused.dataset.photoId : null;
    const focusMore = !!focused && document.activeElement !== focused;
    const nextRows = new Map();
    $('library-list').replaceChildren(...photos.map((photo) => {
      const url = thumbFor(photo);
      const sig = photoSig(photo, current, url);
      const kept = listRows.get(photo.id);
      if (kept && kept.sig === sig) {
        nextRows.set(photo.id, kept);
        return kept.el;
      }
      const li = document.createElement('li');
      li.className = (photo === current ? 'current' : '') + (selection.has(photo.id) ? ' selected' : '');
      li.dataset.photoId = photo.id;
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      if (state.queueUi && state.queueUi.isPicked(photo)) li.classList.add('picked');
      if (photo.master) li.title = `Virtual copy of ${virtualMasterName(photo)}`;
      li.draggable = true;
      li.ondragstart = (e) => {
        e.dataTransfer.setData(PHOTO_DRAG, photo.id);
        e.dataTransfer.effectAllowed = 'copy';
      };
      const img = url ? Object.assign(document.createElement('img'), { src: url, alt: '' }) : Object.assign(document.createElement('div'), { className: 'noimg' });
      const name = document.createElement('span');
      name.textContent = photo.name;
      const more = Object.assign(document.createElement('button'), { className: 'more', type: 'button', textContent: '•••', title: 'Albums, copy and paste settings, delete' });
      more.setAttribute('aria-label', `Actions for ${photo.name}`);
      more.setAttribute('aria-haspopup', 'menu');
      more.onclick = (e) => {
        e.stopPropagation();
        photoMenu(photo, more);
      };
      const mark = state.marks && state.marks.badge(photo);
      li.append(img, name, more, busyBadge());
      if (busy.has(photo.id)) li.classList.add('busy');
      if (state.marks) li.append(state.marks.rater(photo));
      if (mark) li.append(mark);
      li.onclick = (e) => {
        // (a press that was already acted on when the pointer was released, see below)
        if (performance.now() < state.pressHandledUntil && state.pressHandledId === photo.id) return;
        chooseListedPhoto(photo, e);
      };
      li.onkeydown = (e) => {
        // (the ••• button inside keeps its keys)
        if (e.target !== li || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        li.onclick(e);
      };
      li.oncontextmenu = (e) => {
        e.preventDefault();
        photoMenu(photo, more, { x: e.clientX, y: e.clientY });
      };
      nextRows.set(photo.id, { el: li, sig });
      return li;
    }));
    listRows = nextRows;
    if (focusId) {
      const row = [...$('library-list').children].find((el) => el.dataset.photoId === focusId);
      if (row) (focusMore ? row.querySelector('.more') || row : row).focus({ preventScroll: true });
    }
    if (state.cameraView && !state.cameraSection.note && !state.cameraSection.cam) state.cameraView = false;
    renderCameraSection();
    if (state.cameraView) renderCameraGrid();
    else renderGrid(photos, album);
    renderFilmstrip(photos, current);
    if (state.marks) state.marks.renderKeywordList();
    if (state.queueUi && state.queueView) state.queueUi.render();
    if (state.looks) state.looks.render();
    const empty = $('library-empty');
    empty.hidden = photos.length > 0;
    if (everyone.length && !photos.length) empty.textContent = 'No photos match the filter.';
    else if (album) empty.textContent = 'No photos in this album yet. Drag photos onto the album, or use ••• on a photo.';
    else if (state.lib && !state.lib.persistent) empty.textContent = `${EMPTY_LIBRARY} This browser cannot store a library, so photos are kept until the page is closed.`;
    else empty.textContent = EMPTY_LIBRARY;
  }
  return { thumbs, PHOTO_DRAG, selection, QUEUE_RUNNER, openLibrary, thumbFor, saveThumbnail, EMPTY_LIBRARY, cameraThumbs, photoSig, renderLibrary };
}
