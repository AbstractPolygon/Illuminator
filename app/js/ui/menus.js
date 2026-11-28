// menus: moved out of main.js. initMenus() runs where the section used to, with what it uses from the rest of the page.
import { EDITS_FORMAT, EDITS_VERSION } from '../edits.js';
import { native } from '../platform.js';

export function initMenus({ state, showError, flushSave, currentEdits, defaultEdits, applyEdits, scheduleSave, $, renderLibrary, editName, showNotice, openItem, selection, resetPhotoSettings, newAlbum, removePhotos, deletionWhere, exportAlbum, showProgress, thumbs, hideProgress }) {

  let menuButton = null;
  let menuAt = null;

  function closeMenu() {
    if (!state.menuEl) return;
    state.menuEl.remove();
    state.menuEl = null;
    if (menuButton) menuButton.setAttribute('aria-expanded', 'false');
    menuButton = null;
  }

  function placeMenu(anchor, at = null) {
    const r = at ? { left: at.x, top: at.y, bottom: at.y } : anchor.getBoundingClientRect();
    const m = state.menuEl;
    const left = Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8));
    let top = r.bottom + 4;
    if (top + m.offsetHeight > innerHeight - 8) top = Math.max(8, r.top - m.offsetHeight - 4);
    m.style.left = `${left}px`;
    m.style.top = `${top}px`;
  }

  // items: { label, action, checked?, danger? } | { heading } | '-'. An action
  // that returns true keeps the menu open.
  // at: { x, y } to open at the pointer (right-click) instead of below anchor.
  function showMenu(anchor, items, at = null) {
    closeMenu();
    const m = document.createElement('div');
    m.className = 'menu';
    m.setAttribute('role', 'menu');
    state.menuEl = m;
    menuButton = anchor;
    menuAt = at;
    anchor.setAttribute('aria-expanded', 'true');
    fillMenu(items);
    document.body.append(m);
    placeMenu(anchor, at);
    const first = m.querySelector('button');
    if (first) first.focus();
  }

  function fillMenu(items) {
    state.menuEl.replaceChildren(...items.map((it) => {
      if (it === '-') return document.createElement('hr');
      if (it.heading) return Object.assign(document.createElement('p'), { className: 'menu-heading', textContent: it.heading });
      const b = Object.assign(document.createElement('button'), { type: 'button' });
      b.setAttribute('role', it.checked === undefined ? 'menuitem' : 'menuitemcheckbox');
      if (it.checked !== undefined) b.setAttribute('aria-checked', String(it.checked));
      if (it.danger) b.classList.add('danger');
      if (it.disabled) b.disabled = true;
      if (it.checked !== undefined) b.append(Object.assign(document.createElement('span'), { className: 'tick', textContent: it.checked ? '✓' : '' }));
      b.append(document.createTextNode(it.label));
      b.onclick = async (e) => {
        e.stopPropagation();
        let keepOpen = false;
        try {
          keepOpen = (await it.action()) === true;
        } catch (err) {
          showError(err);
        } finally {
          if (!keepOpen) closeMenu();
        }
      };
      return b;
    }));
  }

  // Replaces the menu with a question and two buttons.
  function confirmInMenu(text, label, onYes) {
    const p = Object.assign(document.createElement('p'), { textContent: text });
    const row = Object.assign(document.createElement('div'), { className: 'menu-row' });
    const no = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Cancel' });
    const yes = Object.assign(document.createElement('button'), { type: 'button', textContent: label, className: 'danger' });
    no.onclick = closeMenu;
    yes.onclick = async () => {
      closeMenu();
      try {
        await onYes();
      } catch (err) {
        showError(err);
      }
    };
    row.append(no, yes);
    state.menuEl.replaceChildren(p, row);
    placeMenu(menuButton, menuAt);
    yes.focus();
    return true;
  }

  document.addEventListener('pointerdown', (e) => {
    if (state.menuEl && !state.menuEl.contains(e.target) && e.target !== menuButton) closeMenu();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (state.menuEl && e.key === 'Escape') {
      e.stopPropagation();
      const b = menuButton;
      closeMenu();
      if (b) b.focus();
    }
  }, true);
  window.addEventListener('resize', closeMenu);

  // Copy settings / Paste settings (a photo's ••• menu): every setting of one
  // photo onto another, except where it was focused by clicking and its
  // viewpoint, which belong to the scene.
  let copiedSettings = null;
  async function copySettings(photo) {
    let edits;
    if (state.current && state.current.photo === photo && state.info) {
      flushSave();
      edits = currentEdits();
    } else {
      edits = await state.lib.loadEdits(photo);
      if (edits && edits.reset) edits = null;
    }
    copiedSettings = { id: photo.id, name: photo.name, edits: edits ? JSON.parse(JSON.stringify(edits)) : null };
  }
  async function pasteSettings(photo) {
    if (!copiedSettings) return;
    const open = state.current && state.current.photo === photo && state.info;
    const { view, focusPoint, ...rest } = copiedSettings.edits || { format: EDITS_FORMAT, version: EDITS_VERSION };
    const mine = open ? { view: { ...state.camera }, focusPoint: { ...state.focusPoint } } : (await state.lib.loadEdits(photo)) || {};
    const edits = { ...rest, photo: { id: photo.id, name: photo.name }, view: mine.view, focusPoint: mine.focusPoint, modified: new Date().toISOString() };
    if (!copiedSettings.edits) {
      // Copied from a photo never edited: its defaults.
      for (const group of Object.keys(defaultEdits() || {})) edits[group] = defaultEdits()[group];
    }
    if (open) {
      await flushSave();
      await applyEdits(state.info, edits);
      // One undo step, saved like any change.
      scheduleSave();
    } else {
      await state.lib.saveEdits(photo, edits);
    }
  }

  // Rename (a photo's ••• menu): the name is typed in the photo's row or tile; Enter keeps it, Escape leaves the old one.
  function renamePhoto(photo) {
    const row = [...$('library-list').children].find((el) => el.dataset.photoId === photo.id)
      || [...$('photo-grid').children].find((el) => el.dataset.id === photo.id);
    const done = async (name) => {
      if (name && (await state.lib.renamePhoto(photo, name)) && state.current && state.current.photo === photo) state.current.name = photo.name;
      renderLibrary();
    };
    if (row) editName(row, photo.name, done, 'Photo name');
    else done(window.prompt('Photo name', photo.name));
  }

  // The name of the photo a virtual copy was made from.
  function virtualMasterName(photo) {
    const m = state.lib.get(photo.master);
    return m ? m.name : photo.name;
  }

  // Create virtual copy (a photo's ••• menu): another entry for the same photo (the same light field files, stored once) with settings of its own, starting from the photo's
  // current settings. The copy is opened so it can be changed at once.
  async function createVirtualCopy(photo) {
    // What is open has not been saved yet: the copy starts from what is on the screen.
    if (state.current && state.current.photo === photo && state.info) await flushSave();
    let copy = null;
    try {
      copy = await state.lib.createVirtualCopy(photo);
    } catch (err) {
      console.warn('Could not create the virtual copy', err);
      return showNotice('The virtual copy could not be created.');
    }
    if (!copy) return;
    renderLibrary();
    openItem(copy);
  }

  function photoMenu(photo, button, at = null) {
    // ••• on one of several picked photos acts on all of them
    if (selection.size > 1 && selection.has(photo.id)) {
      const group = state.lib.photos.filter((p) => selection.has(p.id));
      if (group.length > 1) return photoGroupMenu(group, button, at);
    }
    const items = [];
    items.push({ label: 'Rename…', action: () => renamePhoto(photo) });
    // Settings first, so they stay in view however many albums there are.
    items.push({ label: 'Rating, flag and keywords…', action: () => state.marks.openMarks(photo) });
    items.push({ label: 'Copy settings', action: () => copySettings(photo) });
    items.push({ label: 'Create virtual copy', action: () => createVirtualCopy(photo) });
    items.push({
      label: copiedSettings ? `Paste settings from ${copiedSettings.name}…` : 'Paste settings',
      disabled: !copiedSettings || copiedSettings.id === photo.id,
      action: () => confirmInMenu(`Replace the settings of ${photo.name} with those copied from ${copiedSettings.name}?`, 'Paste', () => pasteSettings(photo)),
    });
    items.push({
      label: 'Reset settings…',
      action: () => confirmInMenu(`Reset every setting of ${photo.name}? Its adjustments, keyframes and local adjustments go back to how a newly opened photo starts.`, 'Reset', () => resetPhotoSettings(photo)),
    });
    // Desktop only: the photo's folder in the library, in the system's file manager.
    if (native && native.library && native.library.open) {
      const fileManager = /Mac/i.test(navigator.platform) ? 'Finder' : /Win/i.test(navigator.platform) ? 'Explorer' : 'file manager';
      items.push({ label: `Open in ${fileManager}`, action: () => native.library.open(`Photos/${photo.master || photo.id}`).catch((err) => console.warn('Could not open the photo folder', err)) });
    }
    items.push('-');
    items.push({ heading: 'Albums' });
    for (const a of state.lib.albums) {
      const inside = a.photos.includes(photo.id);
      items.push({
        label: a.name,
        checked: inside,
        action: async () => {
          if (inside) await state.lib.removeFromAlbum(a.id, [photo.id]);
          else await state.lib.addToAlbum(a.id, [photo.id]);
          renderLibrary();
        },
      });
    }
    items.push({ label: 'New album…', action: () => newAlbum([photo.id]) });
    items.push('-');
    const where = state.lib.store.kind === 'folder'
      ? 'Its folder (the photo and its edits) is moved to the trash.'
      : 'The photo and its edits are deleted from this browser’s storage.';
    items.push({
      label: state.lib.persistent ? 'Delete from library…' : 'Remove from list',
      danger: true,
      action: () => {
        const remove = () => removePhotos([photo]);
        if (!state.lib.persistent) return remove();
        const copies = state.lib.photos.filter((p) => p.master === photo.id).length;
        const withCopies = copies ? ` Its ${copies === 1 ? 'virtual copy is' : `${copies} virtual copies are`} deleted too.` : '';
        return confirmInMenu(`Delete ${photo.name} from the library? ${where}${withCopies}`, 'Delete', remove);
      },
    });
    showMenu(button, items, at);
  }

  // The ••• menu for several picked photos: paste or reset their settings, put them in an album or take them out, delete them.
  function photoGroupMenu(group, button, at = null) {
    const n = group.length;
    const ids = group.map((p) => p.id);
    const items = [{ heading: `${n} photos` }];
    items.push({
      label: copiedSettings ? `Paste settings from ${copiedSettings.name}…` : 'Paste settings',
      disabled: !copiedSettings,
      action: () => confirmInMenu(`Replace the settings of ${n} photos with those copied from ${copiedSettings.name}?`, 'Paste', async () => {
        for (const p of group) if (p.id !== copiedSettings.id) await pasteSettings(p);
      }),
    });
    items.push({
      label: 'Reset settings…',
      action: () => confirmInMenu(`Reset every setting of ${n} photos? Their adjustments, keyframes and local adjustments go back to how a newly opened photo starts.`, 'Reset', async () => {
        for (const p of group) await resetPhotoSettings(p);
      }),
    });
    items.push('-');
    items.push({ heading: 'Albums' });
    for (const a of state.lib.albums) {
      const all = ids.every((id) => a.photos.includes(id));
      items.push({
        label: a.name,
        checked: all,
        action: async () => {
          if (all) await state.lib.removeFromAlbum(a.id, ids);
          else await state.lib.addToAlbum(a.id, ids.filter((id) => !a.photos.includes(id)));
          renderLibrary();
        },
      });
    }
    items.push({ label: 'New album…', action: () => newAlbum(ids) });
    items.push('-');
    items.push({
      label: state.lib.persistent ? `Delete ${n} from library…` : `Remove ${n} from list`,
      danger: true,
      action: () => {
        const remove = () => removePhotos(group);
        if (!state.lib.persistent) return remove();
        return confirmInMenu(`Delete ${n} photos from the library? ${deletionWhere()}`, 'Delete', remove);
      },
    });
    showMenu(button, items, at);
  }

  function albumMenu(id, li, button) {
    const album = state.lib.album(id);
    if (!album) return;
    showMenu(button, [
      {
        label: 'Rename…',
        action: () => editName(li, album.name, async (name) => {
          if (name) await state.lib.renameAlbum(id, name);
          renderLibrary();
        }),
      },
      {
        label: 'Export album…',
        action: () => exportAlbum(id),
      },
      {
        label: 'Delete album…',
        danger: true,
        action: () => confirmInMenu(`Delete the album “${album.name}”? Its photos stay in the library.`, 'Delete', async () => {
          await state.lib.deleteAlbum(id);
          if (state.album === id) state.album = null;
          renderLibrary();
        }),
      },
    ]);
  }

  // Copies photos (scan.js entries) into the library, adding them to the
  // album being shown. Returns the library photos.
  async function importPhotos(entries, { album = state.album, replace = false } = {}) {
    await state.libReady;
    if (!entries.length) return [];
    let added = [];
    const before = new Map(state.lib.photos.map((p) => [p.id, p.added]));
    try {
      added = await state.lib.add(entries, {
        replace,
        onProgress: (e, i, n) => {
          if (e) showProgress(n > 1 ? `Adding ${e.name} to the library (${i + 1} of ${n})` : `Adding ${e.name} to the library`, i / n);
        },
      });
      // Replaced photos: their thumbnails are new, and an open one opens again
      // from its new files.
      const replaced = added.filter((p) => before.has(p.id) && before.get(p.id) !== p.added);
      for (const p of replaced) {
        const url = thumbs.get(p.id);
        if (url) URL.revokeObjectURL(url);
        thumbs.delete(p.id);
      }
      const open = state.current && state.current.photo;
      if (open && replaced.includes(open)) openItem(open);
      if (album && state.lib.album(album)) await state.lib.addToAlbum(album, added.map((p) => p.id));
    } catch (err) {
      showError(err);
    } finally {
      hideProgress();
      renderLibrary();
    }
    return added;
  }
  return { closeMenu, showMenu, confirmInMenu, virtualMasterName, photoMenu, albumMenu, importPhotos };
}
