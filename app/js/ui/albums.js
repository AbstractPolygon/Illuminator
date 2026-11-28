// libraries and the albums list: moved out of main.js. initAlbums() runs where the section used to, with what it uses from the rest of the page.
import { listLibraries, switchLibrary, librariesAreFolders, addLibrary, renameLibrary, removeLibrary } from '../library/libraries.js';

export function initAlbums({ $, editName, showError, flushSave, flushProcessed, state, closePhoto, setSelectMode, openLibrary, sendCalibrations, showGrid, confirmInMenu, showMenu, albumMenu, PHOTO_DRAG, renderLibrary }) {

  // The albums list can be folded away (kept for the next start).
  const ALBUMS_COLLAPSED_KEY = 'illuminator.albumsCollapsed';
  let albumsCollapsed = (() => {
    try {
      return localStorage.getItem(ALBUMS_COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  })();

  function showAlbumsToggle() {
    const b = $('albums-toggle');
    b.setAttribute('aria-expanded', String(!albumsCollapsed));
    const label = albumsCollapsed ? 'Show the albums' : 'Collapse the albums';
    b.title = label;
    b.setAttribute('aria-label', label);
  }

  $('albums-toggle').onclick = () => {
    albumsCollapsed = !albumsCollapsed;
    try {
      localStorage.setItem(ALBUMS_COLLAPSED_KEY, albumsCollapsed ? '1' : '0');
    } catch {
      // (not kept)
    }
    showAlbumsToggle();
    renderAlbums();
  };
  showAlbumsToggle();

  // Which libraries there are (library/libraries.js), for the name at the top of the sidebar and its menu.
  let libraryInfo = null;

  async function renderLibraryHead() {
    try {
      libraryInfo = await listLibraries();
    } catch (err) {
      console.warn('Could not list the libraries', err);
      libraryInfo = null;
    }
    const cur = libraryInfo && libraryInfo.list.find((l) => l.id === libraryInfo.current);
    $('library-name').textContent = cur ? cur.name : 'Library';
    $('library-switch').title = cur && cur.detail ? `${cur.detail}\nLibraries: switch, add or rename. Each is a separate set of photos and albums` : 'Libraries: switch, add or rename. Each is a separate set of photos and albums';
  }

  // A text field in the sidebar's heading, for the name of a library (restored when done).
  function askLibraryName(value, label, onName) {
    const head = $('library-head');
    const kids = [...head.childNodes];
    editName(head, value, async (name) => {
      head.replaceChildren(...kids);
      if (name) {
        try {
          await onName(name);
        } catch (err) {
          showError(err);
        }
      }
    }, label);
  }

  // Another library takes the place of this one: everything of this photo and library is written first, so nothing of it lands in the next.
  async function useLibrary(change) {
    await flushSave();
    await flushProcessed();
    if (state.lib) await state.lib.close().catch((err) => console.warn('Could not close the library', err));
    const result = await change();
    if (result === null) return; // (cancelled: this library stays in use)
    closePhoto();
    setSelectMode(false);
    state.album = null;
    state.cameraView = false;
    state.libReady = openLibrary();
    state.calReady = state.libReady.then(() => sendCalibrations()).catch(() => {});
    await state.libReady;
    showGrid(true);
  }

  function libraryMenu() {
    renderLibraryHead().then(() => {
      const info = libraryInfo;
      if (!info) return;
      const memory = state.lib && state.lib.store.kind === 'memory';
      const items = [];
      if (memory) {
        items.push({ label: 'This browser cannot keep several libraries', disabled: true, action: () => {} });
      } else {
        for (const l of info.list) {
          items.push({ label: l.name, checked: l.id === info.current, action: () => useLibrary(() => (l.id === info.current ? null : switchLibrary(l.id))).catch((err) => showError(err)) });
        }
        items.push('-');
        items.push({
          label: librariesAreFolders() ? 'Add library folder…' : 'New library…',
          action: () => {
            if (librariesAreFolders()) return useLibrary(() => addLibrary()).catch((err) => showError(err));
            askLibraryName('', 'Library name', (name) => useLibrary(() => addLibrary(name)));
          },
        });
        const cur = info.list.find((l) => l.id === info.current);
        if (cur) items.push({ label: 'Rename this library…', action: () => askLibraryName(cur.name, 'Library name', async (name) => { await renameLibrary(cur.id, name); await renderLibraryHead(); }) });
        for (const l of info.list.filter((x) => x.id !== info.current)) {
          const folders = librariesAreFolders();
          items.push({
            label: folders ? `Remove “${l.name}” from the list…` : `Delete library “${l.name}”…`,
            danger: true,
            action: () => confirmInMenu(
              folders ? `Remove “${l.name}” from the list? Its folder and photos stay where they are.` : `Delete the library “${l.name}” and all its photos from this browser?`,
              folders ? 'Remove' : 'Delete',
              async () => {
                await removeLibrary(l.id);
                await renderLibraryHead();
              },
            ),
          });
        }
      }
      showMenu($('library-switch'), items);
    });
  }
  $('library-switch').onclick = () => libraryMenu();

  function renderAlbums() {
    const list = $('album-list');
    if (!state.lib) {
      list.replaceChildren();
      return;
    }
    const rows = [{ id: null, name: 'All photos', count: state.lib.photos.length }, ...state.lib.albums.map((a) => ({ id: a.id, name: a.name, count: a.photos.length }))];
    list.replaceChildren(...rows.map((row) => {
      const li = document.createElement('li');
      li.classList.toggle('current', !state.cameraView && state.album === row.id);
      // Collapsed, the list keeps All photos and the album being shown.
      li.hidden = albumsCollapsed && row.id !== null && state.album !== row.id;
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'album' });
      const name = Object.assign(document.createElement('span'), { className: 'name', textContent: row.name });
      const count = Object.assign(document.createElement('span'), { className: 'count', textContent: row.count });
      b.append(name, count);
      b.onclick = () => {
        state.album = row.id;
        state.cameraView = false;
        showGrid(true);
      };
      li.append(b);
      if (row.id) {
        const more = Object.assign(document.createElement('button'), { className: 'more', type: 'button', textContent: '•••', title: 'Rename, delete' });
        more.setAttribute('aria-label', `Actions for album ${row.name}`);
        more.setAttribute('aria-haspopup', 'menu');
        more.onclick = () => albumMenu(row.id, li, more);
        li.append(more);
        // Photos dragged from the list are added to the album.
        li.ondragover = (e) => {
          if (![...e.dataTransfer.types].includes(PHOTO_DRAG)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          li.classList.add('drop');
        };
        li.ondragleave = () => li.classList.remove('drop');
        li.ondrop = async (e) => {
          const id = e.dataTransfer.getData(PHOTO_DRAG);
          li.classList.remove('drop');
          if (!id) return;
          e.preventDefault();
          e.stopPropagation();
          await state.lib.addToAlbum(row.id, [id]);
          renderLibrary();
        };
      }
      return li;
    }));
  }
  return { renderLibraryHead, useLibrary, renderAlbums };
}
