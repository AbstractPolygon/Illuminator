// progress: moved out of main.js. initProgress() runs where the section used to, with what it uses from the rest of the page.
import { createOpenSequencer } from '../core/openseq.js';

export function initProgress({ $, state, canvas, showNotice, startNoticeTimer }) {

  // Animation > Preview: its controls, and whether a preview is rendering.
  const PREVIEW_IDS = ['pv-res', 'pv-render', 'pv-first', 'pv-prev', 'pv-stop', 'pv-play', 'pv-next', 'pv-last', 'pv-loop', 'pv-scrub'];

  // Photos being processed (opened and prepared for the first time): their rows and tiles show a spinner, and the picture area says what is going on.
  const busy = new Map(); // photo id -> { stage, progress }

  function showBusy() {
    const mark = (el, id) => {
      const b = busy.get(id);
      el.classList.toggle('busy', !!b);
      if (b) el.setAttribute('aria-busy', 'true');
      else el.removeAttribute('aria-busy');
      const badge = el.querySelector('.busy-badge');
      if (badge) badge.title = b ? `${b.stage}…` : '';
    };
    for (const li of $('library-list').children) mark(li, li.dataset.photoId);
    for (const tile of $('photo-grid').children) mark(tile, tile.dataset.id);
  }

  // A spinner on a row or tile (shown while the photo is busy).
  const busyBadge = () => {
    const b = Object.assign(document.createElement('span'), { className: 'busy-badge' });
    b.setAttribute('aria-hidden', 'true');
    return b;
  };

  function beginProcessing(photo, my) {
    endProcessing();
    state.processing = { photo, my, drawn: false, prepared: false };
    busy.set(photo.id, { stage: 'Opening', progress: null });
    showBusy();
    showProgress(`Opening ${photo.name}`, null);
    // With no picture on show yet the area would stay blank until the first one is drawn.
    if (!state.info || canvas.classList.contains('hidden')) {
      const ph = $('placeholder');
      ph.hidden = false;
      const text = Object.assign(document.createElement('p'), { textContent: `Opening ${photo.name}…` });
      ph.replaceChildren(Object.assign(document.createElement('div'), { className: 'spinner' }), text);
    }
  }

  function updateProcessing(my, stage, p) {
    if (!state.processing || state.processing.my !== my) return;
    busy.set(state.processing.photo.id, { stage, progress: p });
    showBusy();
  }

  // `what`: 'drawn' (the first picture is on screen) or 'prepared' (the background preparation is done). The mark goes when both are.
  const FIRST_PICTURE = 'Processing';
  function processingStep(my, what) {
    if (!state.processing || state.processing.my !== my) return;
    state.processing[what] = true;
    if (what === 'drawn') {
      if ($('progress-text').textContent === FIRST_PICTURE) hideProgress();
      if ($('placeholder').querySelector('.spinner')) $('placeholder').hidden = true;
    }
    if (state.processing.drawn && state.processing.prepared) endProcessing(my);
  }

  function endProcessing(my) {
    if (!state.processing || (my != null && state.processing.my !== my)) return;
    busy.delete(state.processing.photo.id);
    state.processing = null;
    showBusy();
  }

  function showProgress(stage, p) {
    state.emitEvent('progress', { stage, progress: p ?? 0 });
    $('progress').hidden = false;
    // No known amount (opening): a moving bar rather than an empty one.
    $('progress').classList.toggle('indeterminate', p == null);
    $('progress-text').textContent = stage;
    $('progress-fill').style.width = p == null ? '' : `${Math.round(p * 100)}%`;
    // (how far along, as a number, when it is known)
    $('progress-pct').hidden = p == null;
    $('progress-pct').textContent = p == null ? '' : `${Math.round(Math.min(1, Math.max(0, p)) * 100)}%`;
  }

  // A change that is slow to show (another depth method, the high quality depth): its message stays up from the change until the next picture is drawn (draw()),
  // with the worker's own stages over it as they come.
  let busyNote = '';
  let busyTimer = 0;
  function noteBusy(text) {
    busyNote = text;
    showProgress(text, null);
    // (never left up for good if no picture comes: an error, the lenslets view)
    clearTimeout(busyTimer);
    busyTimer = setTimeout(clearBusy, 180000);
  }
  function clearBusy() {
    if (!busyNote) return;
    busyNote = '';
    hideProgress();
  }

  function hideProgress() {
    if (busyNote) {
      showProgress(busyNote, null);
      return;
    }
    $('progress').hidden = true;
  }

  // Every open (a library photo, a dropped file, a script) takes the next number; a request, render or save that belongs to an earlier number is stale and must not
  // touch what is on show now. The worker echoes the number it was sent with (`openSeq` on the open request and on its cache messages).
  const openSeq = createOpenSequencer();
  const staleSeq = (n) => openSeq.isStale(n);
  // A progress callback for work that began at generation `gen`: it stays silent once another photo is on its way in.
  const progressFor = (gen) => (stage, p) => { if (!openSeq.superseded(gen)) showProgress(stage, p); };

  // A failure that leaves the photo as it was (export, look, import, render, settings): a notice over the picture.
  function showError(err, title = 'Something went wrong') {
    hideProgress();
    console.error(err);
    showNotice(title, (err && err.message) || String(err));
    startNoticeTimer();
  }

  // A photo that could not be opened: the placeholder says so (openWith and closePhoto put it back).
  function showOpenError(err) {
    hideProgress();
    console.error(err);
    $('placeholder').hidden = false;
    $('placeholder').innerHTML = '<p>Could not open this file.</p><p class="hint"></p>';
    $('placeholder').querySelector('.hint').textContent = err.message || String(err);
  }
  return { PREVIEW_IDS, busy, busyBadge, beginProcessing, updateProcessing, FIRST_PICTURE, processingStep, endProcessing, showProgress, noteBusy, clearBusy, hideProgress, openSeq, staleSeq, progressFor, showError, showOpenError };
}
