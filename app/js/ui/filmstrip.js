// film strip and the way back to the thumbnails: moved out of main.js. initFilmstrip() runs where the section used to, with what it uses from the rest of the page.
export function initFilmstrip({ state, $, thumbFor, selection, chooseListedPhoto, photoMenu, showGrid }) {

  // The film strip under the picture (the photos of the list, as the sidebar has them) can be folded away; the choice is kept for the next start.
  const FILMSTRIP_KEY = 'illuminator.filmstrip';
  let filmstripCollapsed = (() => {
    try {
      return localStorage.getItem(FILMSTRIP_KEY) === '0';
    } catch {
      return false;
    }
  })();
  let filmstripCentered = null;
  // The items of the strip as drawn last, by photo id (renderFilmstrip).
  let filmItems = new Map();

  // With a library photo open (not the thumbnails): the strip and the button back to the thumbnails show.
  function showPhotoNav() {
    const open = !!(state.lib && state.current && state.current.photo && !state.grid);
    $('grid-back-btn').hidden = !open;
    $('filmstrip').hidden = !(open && state.listedPhotos && state.listedPhotos.length);
    $('filmstrip').classList.toggle('collapsed', filmstripCollapsed);
    const t = $('filmstrip-toggle');
    t.setAttribute('aria-expanded', String(!filmstripCollapsed));
    t.title = filmstripCollapsed ? 'Show the film strip' : 'Hide the film strip';
  }

  function renderFilmstrip(photos, current) {
    showPhotoNav();
    const strip = $('filmstrip');
    if (strip.hidden) {
      filmstripCentered = null;
      filmItems = new Map();
      return;
    }
    const list = $('filmstrip-list');
    const scroll = list.scrollLeft;
    // An item is built again only when what it shows changed (a thumbnail arriving, a rating, the open photo): the rest are reused, so a big album costs no more than the
    // few that changed each time the library is drawn.
    const kept = new Map();
    list.replaceChildren(...photos.map((photo) => {
      const url = thumbFor(photo);
      const sig = JSON.stringify([photo.name, photo.master || '', url || '', photo === current, photo.rating || 0, photo.flag || '', photo.keywords || []]);
      const old = filmItems.get(photo.id);
      if (old && old.sig === sig) {
        kept.set(photo.id, old);
        return old.el;
      }
      // (an item holds the thumbnail button, which opens the photo, and the pick box and stars over it: ui/marks.js)
      const item = document.createElement('div');
      item.className = (photo === current ? 'film current' : 'film') + (selection.has(photo.id) ? ' selected' : '');
      item.dataset.photoId = photo.id;
      item.title = photo.master ? `${photo.name} (virtual copy)` : photo.name;
      item.setAttribute('role', 'listitem');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'film-open';
      b.setAttribute('aria-label', photo.name);
      if (photo === current) b.setAttribute('aria-current', 'true');
      if (url) b.append(Object.assign(document.createElement('img'), { src: url, alt: '', draggable: false }));
      b.onclick = (e) => chooseListedPhoto(photo, e);
      item.append(b);
      const mark = state.marks && state.marks.badge(photo);
      if (mark) {
        mark.classList.add('film-marks');
        item.append(mark);
      }
      if (state.marks) item.append(state.marks.rater(photo));
      // The same ••• menu as the list and the grid have, at the top right (also on a right-click).
      const more = Object.assign(document.createElement('button'), { className: 'more', type: 'button', textContent: '•••', title: 'Rename, copy and paste settings, albums, delete' });
      more.setAttribute('aria-label', `Actions for ${photo.name}`);
      more.setAttribute('aria-haspopup', 'menu');
      more.onclick = (e) => {
        e.stopPropagation();
        photoMenu(photo, more);
      };
      item.oncontextmenu = (e) => {
        e.preventDefault();
        photoMenu(photo, more, { x: e.clientX, y: e.clientY });
      };
      item.append(more);
      kept.set(photo.id, { el: item, sig });
      return item;
    }));
    filmItems = kept;
    // The photo that is open comes into view when it changes; otherwise the strip stays where the user scrolled it.
    const here = current ? current.id : null;
    if (here !== filmstripCentered) {
      filmstripCentered = here;
      const el = list.querySelector('.film.current');
      if (el) el.scrollIntoView({ inline: 'center', block: 'nearest' });
    } else list.scrollLeft = scroll;
  }

  $('filmstrip-toggle').onclick = () => {
    filmstripCollapsed = !filmstripCollapsed;
    try {
      localStorage.setItem(FILMSTRIP_KEY, filmstripCollapsed ? '0' : '1');
    } catch {
      // Storage unavailable: the choice is not kept.
    }
    showPhotoNav();
  };
  $('grid-back-btn').onclick = () => showGrid(true);
  return { showPhotoNav, renderFilmstrip };
}
