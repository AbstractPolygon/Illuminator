// grid: moved out of main.js. initGrid() runs where the section used to, with what it uses from the rest of the page.
export function initGrid({ state, showPhotoNav, $, setPlaying, renderLibrary, layoutCanvas, selection, thumbFor, photoSig, PHOTO_DRAG, busyBadge, busy, virtualMasterName, photoMenu, openItem, EMPTY_LIBRARY, showMenu, confirmInMenu, cancelSaves, thumbs, closePhoto }) {

  // Choosing an album shows its photos as thumbnails in place of the picture;
  // opening a photo goes back to the picture.
  const THUMB_SIZE_KEY = 'illuminator.thumbSize';

  function showGrid(on) {
    if (on && state.queueUi) state.queueUi.setView(false, { open: false });
    state.grid = on;
    showPhotoNav();
    document.querySelector('.stage').classList.toggle('grid', on);
    $('grid-view').hidden = !on;
    if (on) {
      if (state.playing) setPlaying(false);
      renderLibrary();
    } else {
      layoutCanvas();
    }
  }

  function setThumbSize(px) {
    const input = $('thumb-size');
    const v = Math.min(+input.max, Math.max(+input.min, Math.round(px / 10) * 10));
    input.value = v;
    $('photo-grid').style.setProperty('--thumb', `${v}px`);
    $('thumb-smaller').disabled = v <= +input.min;
    $('thumb-bigger').disabled = v >= +input.max;
    try {
      localStorage.setItem(THUMB_SIZE_KEY, String(v));
    } catch {
      // Storage unavailable: the size is not remembered.
    }
  }

  $('thumb-size').oninput = () => setThumbSize(+$('thumb-size').value);
  $('thumb-smaller').onclick = () => setThumbSize(+$('thumb-size').value / 1.25);
  $('thumb-bigger').onclick = () => setThumbSize(+$('thumb-size').value * 1.25);
  {
    let saved = 180;
    try {
      saved = +(localStorage.getItem(THUMB_SIZE_KEY) || 180);
    } catch {
      // Storage unavailable: default size.
    }
    setThumbSize(saved);
  }

  function renderGrid(photos, album) {
    if (!state.grid) return;
    $('grid-import-all').hidden = true;
    $('grid-camera-choose-row').hidden = true;
    $('grid-title').textContent = album ? album.name : 'All photos';
    $('grid-count').textContent = `${photos.length} photo${photos.length === 1 ? '' : 's'}`;
    const current = state.current && state.current.photo;
    state.gridOrder = photos.map((p) => p.id);
    selection.keepOnly(state.gridOrder);
    const nextTiles = new Map();
    $('photo-grid').replaceChildren(...photos.map((photo) => {
      const url = thumbFor(photo);
      const sig = photoSig(photo, current, url);
      const kept = state.gridTiles.get(photo.id);
      if (kept && kept.sig === sig) {
        nextTiles.set(photo.id, kept);
        return kept.el;
      }
      const tile = document.createElement('div');
      tile.className = (photo === current ? 'tile current' : 'tile') + (selection.has(photo.id) ? ' selected' : '');
      tile.dataset.id = photo.id;
      tile.tabIndex = 0;
      tile.setAttribute('role', 'button');
      tile.setAttribute('aria-label', `Open ${photo.name}`);
      tile.draggable = true;
      tile.ondragstart = (e) => {
        e.dataTransfer.setData(PHOTO_DRAG, photo.id);
        e.dataTransfer.effectAllowed = 'copy';
      };
      const frame = Object.assign(document.createElement('div'), { className: 'frame' });
      frame.append(busyBadge());
      if (busy.has(photo.id)) tile.classList.add('busy');
      const thumb = url ? Object.assign(document.createElement('img'), { src: url, alt: '' }) : null;
      if (thumb) frame.prepend(thumb);
      const name = Object.assign(document.createElement('div'), { className: 'name', textContent: photo.name, title: photo.master ? `Virtual copy of ${virtualMasterName(photo)}` : photo.name });
      const more = Object.assign(document.createElement('button'), { className: 'more', type: 'button', textContent: '•••', title: 'Albums, copy and paste settings, delete' });
      more.setAttribute('aria-label', `Actions for ${photo.name}`);
      more.setAttribute('aria-haspopup', 'menu');
      more.onclick = (e) => {
        e.stopPropagation();
        photoMenu(photo, more);
      };
      const mark = state.marks && state.marks.badge(photo);
      if (state.marks) {
        // The stars and the pick checkbox sit on the picture itself, not on the empty space around it: the layer takes the thumbnail's shape (--ar, width over height).
        const layer = state.marks.rater(photo);
        const shape = () => thumb.naturalWidth && thumb.naturalHeight && layer.style.setProperty('--ar', String(thumb.naturalWidth / thumb.naturalHeight));
        if (thumb) {
          if (thumb.complete) shape();
          else thumb.addEventListener('load', shape);
        }
        frame.append(layer);
      }
      tile.append(frame, name, more);
      if (mark) tile.append(mark);
      tile.onclick = (e) => tileClick(e, photo);
      tile.oncontextmenu = (e) => {
        e.preventDefault();
        photoMenu(photo, more, { x: e.clientX, y: e.clientY });
      };
      tile.onkeydown = (e) => {
        if (e.target === tile && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          if (state.selectMode) {
            selection.toggle(photo.id);
            showSelection();
          } else openItem(photo);
        }
      };
      nextTiles.set(photo.id, { el: tile, sig });
      return tile;
    }));
    state.gridTiles = nextTiles;
    showSelection();
    $('grid-empty').hidden = photos.length > 0;
    $('grid-empty').textContent = album
      ? 'No photos in this album yet. Drag photos onto the album in the sidebar, or use ••• on a photo.'
      : EMPTY_LIBRARY;
  }

  // A click on a photo in the grid: it opens the photo, or (Ctrl/Cmd, Shift, or Select mode on) picks it.
  function tileClick(e, photo) {
    if (e.shiftKey) selection.range(state.gridOrder, photo.id);
    else if (e.ctrlKey || e.metaKey || state.selectMode) selection.toggle(photo.id);
    else {
      if (selection.size) {
        selection.clear();
        showSelection();
      }
      openItem(photo);
      return;
    }
    showSelection();
  }

  // The grid's selection as the page shows it: the tiles, the count and the buttons (the grid itself is not drawn again, so it keeps its scroll).
  function showSelection() {
    const grid = $('photo-grid');
    for (const tile of grid.children) tile.classList.toggle('selected', selection.has(tile.dataset.id));
    // (the sidebar list and the film strip show the same selection)
    for (const row of $('library-list').children) row.classList.toggle('selected', selection.has(row.dataset.photoId));
    for (const item of $('filmstrip-list').children) item.classList.toggle('selected', selection.has(item.dataset.photoId));
    grid.classList.toggle('selecting', state.selectMode || selection.size > 0);
    $('grid-select').setAttribute('aria-pressed', String(state.selectMode));
    $('grid-selection').hidden = !(state.selectMode || selection.size > 0);
    const n = selection.size;
    $('grid-sel-count').textContent = n ? `${n} selected` : 'Click photos to pick them';
    $('grid-delete').disabled = n === 0;
    $('grid-select-all').disabled = state.gridOrder.length === 0 || n === state.gridOrder.length;
  }

  function setSelectMode(on) {
    state.selectMode = on;
    if (!on) selection.clear();
    showSelection();
  }

  $('grid-select').onclick = () => setSelectMode(!state.selectMode);
  $('grid-select-all').onclick = () => {
    selection.selectAll(state.gridOrder);
    showSelection();
  };
  $('grid-delete').onclick = () => deleteSelected();
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    // (the selection's keys work in the grid, and in the sidebar list and the film strip when one of them has the focus)
    const inList = !!(t && t.closest && t.closest('#library-list, #filmstrip-list'));
    if (document.querySelector('dialog[open]') || ($('grid-view').hidden && !inList)) return;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (state.menuEl && !state.menuEl.hidden && state.menuEl.contains(document.activeElement)) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selection.size) {
      e.preventDefault();
      deleteSelected();
    } else if (e.key === 'Escape' && (selection.size || state.selectMode)) {
      setSelectMode(false);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && t && t.closest && (t.closest('#photo-grid') || inList)) {
      e.preventDefault();
      selection.selectAll(inList ? (state.listedPhotos || []).map((p) => p.id) : state.gridOrder);
      showSelection();
    }
  });

  // Where deleted photos go, in words (the same for one photo and for several).
  function deletionWhere() {
    return state.lib.store.kind === 'folder'
      ? 'Their folders (each photo and its edits) are moved to the trash.'
      : 'The photos and their edits are deleted from this browser’s storage.';
  }

  // Asks, by the Delete button, before deleting the picked photos.
  function deleteSelected() {
    const photos = state.lib.photos.filter((p) => selection.has(p.id));
    if (!photos.length) return;
    const n = photos.length;
    const label = state.lib.persistent ? `Delete ${n}` : `Remove ${n}`;
    const anchorEl = !$('grid-view').hidden ? $('grid-delete') : document.activeElement && document.activeElement.closest && document.activeElement.closest('#library-list li, #filmstrip-list .film') || $('library-list');
    showMenu(anchorEl, []);
    confirmInMenu(
      `${state.lib.persistent ? 'Delete' : 'Remove'} ${n} photo${n === 1 ? '' : 's'} from the library? ${state.lib.persistent ? deletionWhere() : 'They go from the list; their files are not touched.'}`,
      label,
      () => removePhotos(photos),
    );
  }

  // Takes photos out of the library, one after the other (a folder that cannot go to the trash is asked about once, then the rest go the same way).
  async function removePhotos(list) {
    let permanent = false;
    for (const photo of list) {
      // (a photo's virtual copies go with it)
      const withCopies = [photo, ...state.lib.photos.filter((p) => p.master === photo.id)];
      // Nothing pending may write the photo's folder again once it is gone (edits are not flushed: the photo is deleted).
      for (const p of withCopies) cancelSaves(p);
      try {
        await state.lib.remove([photo.id], permanent ? { permanent: true } : undefined);
      } catch (err) {
        // The desktop app does not delete for good behind the user's back: when the trash is not available (network drives, some Linux systems) it asks first.
        if (!/could not be moved to the trash/i.test(String((err && err.message) || err))) throw err;
        if (!window.confirm(`${err.message}`)) break;
        permanent = true;
        await state.lib.remove([photo.id], { permanent: true });
      }
      for (const p of withCopies) {
        const url = thumbs.get(p.id);
        if (url) URL.revokeObjectURL(url);
        thumbs.delete(p.id);
        selection.ids.delete(p.id);
        if (state.current && state.current.photo === p) closePhoto();
      }
    }
    renderLibrary();
  }

  // An inline text field in place of `li`'s contents (new album, rename).
  function editName(li, value, onDone, label = 'Album name') {
    const input = Object.assign(document.createElement('input'), { type: 'text', value, maxLength: 80 });
    input.setAttribute('aria-label', label);
    li.replaceChildren(input);
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      onDone(ok ? input.value.trim() : '');
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') {
        e.stopPropagation();
        finish(false);
      }
    };
    input.onblur = () => finish(true);
    input.focus();
    input.select();
  }

  function newAlbum(photoIds = []) {
    if (!state.lib) return;
    const li = document.createElement('li');
    $('album-list').append(li);
    editName(li, '', async (name) => {
      if (name) {
        const album = await state.lib.createAlbum(name);
        if (photoIds.length) await state.lib.addToAlbum(album.id, photoIds);
        else {
          state.album = album.id;
          state.cameraView = false;
        }
      }
      renderLibrary();
    });
  }

  $('album-new').onclick = () => newAlbum();
  return { showGrid, setThumbSize, renderGrid, showSelection, setSelectMode, deletionWhere, removePhotos, editName, newAlbum };
}
