// Ratings, flags and keywords in the library: the filter bar, the marks on photos, the dialog and the keys (Shift+1 to 5 rate, Shift+0 clears the rating,
// Shift+P picks, Shift+X rejects, Shift+U clears the flag, for the open photo). The data and the XMP sidecar are in core/marks.js and library/library.js.

import { marksOf, stars, parseKeywords, matchesFilter, isFiltering, allKeywords, hasMarks } from '../core/marks.js';

export function initMarks({ $, state, renderLibrary, typing }) {
  state.filter = { minRating: 0, flag: '', text: '' };

  // The photos that pass the filter.
  const applyFilter = (photos) => (isFiltering(state.filter) ? photos.filter((p) => matchesFilter(p, state.filter)) : photos);

  // What a photo shows in the library: its stars and flag.
  function badge(photo) {
    const m = marksOf(photo);
    if (!hasMarks(m)) return null;
    const span = document.createElement('span');
    span.className = `marks${m.flag ? ` ${m.flag}` : ''}`;
    const flag = m.flag === 'pick' ? '⚑ ' : m.flag === 'reject' ? '⊘ ' : '';
    span.textContent = `${flag}${stars(m.rating)}`.trim();
    span.title = [m.rating ? `${m.rating} star${m.rating === 1 ? '' : 's'}` : '', m.flag === 'pick' ? 'Picked' : m.flag === 'reject' ? 'Rejected' : '', m.keywords.join(', ')].filter(Boolean).join(' · ');
    return span;
  }

  async function change(photo, patch) {
    if (!state.lib || !photo) return;
    await state.lib.setMarks(photo, { ...marksOf(photo), ...patch });
    renderKeywordList();
    renderLibrary();
  }

  const setRating = (photo, rating) => change(photo, { rating });
  const setFlag = (photo, flag) => change(photo, { flag });

  // ------------------------------------------------------------ dialog
  let editing = null;
  let draftRating = 0;

  function showStars() {
    for (const b of document.querySelectorAll('#marks-stars button')) b.classList.toggle('on', +b.dataset.n <= draftRating);
  }

  function openMarks(photo) {
    const m = marksOf(photo);
    editing = photo;
    draftRating = m.rating;
    $('marks-title').textContent = `Rating, flag and keywords: ${photo.name}`;
    $('marks-flag').value = m.flag || '';
    $('marks-keywords').value = m.keywords.join(', ');
    showStars();
    renderKeywordList();
    $('marks-dialog').showModal();
    $('marks-keywords').focus();
  }

  for (const b of document.querySelectorAll('#marks-stars button')) {
    b.onclick = () => {
      draftRating = draftRating === +b.dataset.n ? 0 : +b.dataset.n;
      showStars();
    };
  }
  $('marks-clear-rating').onclick = () => {
    draftRating = 0;
    showStars();
  };
  $('marks-dialog').addEventListener('close', async () => {
    const photo = editing;
    editing = null;
    if (!photo || $('marks-dialog').returnValue !== 'ok') return;
    await change(photo, { rating: draftRating, flag: $('marks-flag').value || null, keywords: parseKeywords($('marks-keywords').value) });
  });

  // ------------------------------------------------------------ filter
  function renderKeywordList() {
    const words = state.lib ? allKeywords(state.lib.photos) : [];
    $('keyword-list').replaceChildren(...words.map((w) => Object.assign(document.createElement('option'), { value: w })));
  }

  const readFilter = () => {
    state.filter = { minRating: +$('filter-rating').value, flag: $('filter-flag').value, text: $('filter-text').value };
    $('filter-clear').hidden = !isFiltering(state.filter);
    renderLibrary();
  };
  $('filter-rating').onchange = readFilter;
  $('filter-flag').onchange = readFilter;
  $('filter-text').oninput = readFilter;
  $('filter-clear').onclick = () => {
    $('filter-rating').value = '0';
    $('filter-flag').value = '';
    $('filter-text').value = '';
    readFilter();
  };

  // ------------------------------------------------------------ keys
  document.addEventListener('keydown', (e) => {
    if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || typing(document.activeElement)) return;
    if (document.querySelector('dialog[open]')) return;
    const photo = state.current && state.current.photo;
    if (!photo) return;
    const digit = /^Digit([0-5])$/.exec(e.code);
    if (digit) setRating(photo, +digit[1]);
    else if (e.code === 'KeyP') setFlag(photo, marksOf(photo).flag === 'pick' ? null : 'pick');
    else if (e.code === 'KeyX') setFlag(photo, marksOf(photo).flag === 'reject' ? null : 'reject');
    else if (e.code === 'KeyU') setFlag(photo, null);
    else return;
    e.preventDefault();
  });

  return { applyFilter, badge, openMarks, renderKeywordList, isFiltering: () => isFiltering(state.filter) };
}
