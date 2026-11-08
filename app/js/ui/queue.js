// The Render Queue: pictures and videos of library photos that are made one after another in the background while editing goes on. It has its own view that takes the
// place of the photo (the icon left of Quick export), with a card per job: a thumbnail, how far it has come, and its export settings; and a small section in the right
// sidebar to add the open photo. The renders run in a hidden second copy of the app (an iframe of this page with ?queue), which has its own worker and graphics context,
// so the live view of the photo being edited is not held up; it is driven through the scripting interface (ui/api.js). The list and its rules are in core/renderqueue.js.

import { RenderQueue, uniqueName, describeSettings, phasesFor, pickPhotos, firstChosen } from '../core/renderqueue.js';
import { download } from '../platform.js';

export function initQueue({ $, state, native, currentEdits, showNotice, showError, thumbFor, openPhoto, renderLibrary }) {
  const used = new Set();
  let frame = null;
  let current = null; // { job, abort }
  let folder = null; // desktop: the folder chosen for the files
  let renderTimer = 0;
  let picked = []; // the photos chosen in the library while the view is open (ids)
  let anchor = null;
  const queue = new RenderQueue({ onChange: () => scheduleRender() });
  queue.paused = true;

  // ---------------------------------------------------------------- what a job is
  const libraryPhoto = () => (state.current && state.current.photo ? state.current.photo : null);

  const listed = () => (state.listedPhotos || []).map((p) => p.id);
  const clone = (x) => JSON.parse(JSON.stringify(x));

  // The photos an Add button adds: the ones chosen in the view (in the order listed), otherwise the open one.
  function chosen() {
    const open = libraryPhoto();
    if (!state.queueView) return open ? [open] : [];
    const photos = picked.map((id) => state.lib && state.lib.get(id)).filter(Boolean);
    const order = listed();
    photos.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    return photos.length ? photos : open ? [open] : [];
  }

  // What a job holds: the open photo's settings as they are now, another photo's as saved with it.
  async function specFor(kind, photo) {
    const open = libraryPhoto() === photo && state.info;
    let edits;
    if (open) edits = clone(currentEdits());
    else {
      const saved = await state.lib.loadEdits(photo);
      edits = saved ? clone(saved) : null;
      // The Video settings are the ones in the app now.
      if (edits && kind === 'video') {
        const now = currentEdits().rendering || {};
        edits.rendering = { ...(edits.rendering || {}), ...Object.fromEntries(Object.entries(now).filter(([k]) => k.startsWith('video'))) };
      }
    }
    const fullOn = $('fullres-on').checked && (open ? state.info.hasRaw : true);
    return {
      kind,
      photoId: photo.id,
      name: photo.name,
      edits,
      fullSensor: fullOn ? { scale: +$('still-scale').value, passes: +$('still-passes').value } : null,
      export: { format: $('photo-format').value, quality: +$('photo-quality').value, colorSpace: $('photo-colorspace').value, size: +$('photo-size').value },
    };
  }

  async function add(kind) {
    const photos = chosen().filter((p) => !(p === libraryPhoto() && !state.info));
    if (!photos.length) return;
    if (kind === 'video' && photos.length === 1 && libraryPhoto() === photos[0] && !$('anim-on').checked) {
      showNotice('Turn on Animation first', 'A video is made from the animation: turn it on in the Animation panel and set it up, then add the video to the queue.');
      return;
    }
    let skipped = 0;
    for (const photo of photos) {
      const spec = await specFor(kind, photo);
      const animated = photo === libraryPhoto() && state.info ? $('anim-on').checked : !!(spec.edits && spec.edits.animation && spec.edits.animation['anim-on']);
      if (kind === 'video' && !animated) {
        skipped++;
        continue;
      }
      queue.add(spec, { kind, title: spec.name });
    }
    if (skipped) showNotice('Some photos have no animation', `${skipped} of ${photos.length} ${photos.length === 1 ? 'photo has' : 'photos have'} Animation turned off, so no video was added for ${skipped === 1 ? 'it' : 'them'}. Turn it on in the Animation panel of each photo first.`);
  }

  // A click on a photo in the library: with the view open, Ctrl/Command and Shift choose several without opening any (true: handled); a plain click chooses that one and opens it as usual.
  function pick(photo, event) {
    if (!state.queueView) return false;
    const r = pickPhotos({ selected: picked, anchor }, listed(), photo.id, { shift: event.shiftKey, additive: event.ctrlKey || event.metaKey });
    picked = r.selected;
    anchor = r.anchor;
    if (r.handled) renderLibrary();
    return r.handled;
  }
  const isPicked = (photo) => !!state.queueView && picked.includes(photo.id);

  // ---------------------------------------------------------------- the hidden copy of the app
  function runnerFrame() {
    if (frame) return frame.ready;
    const el = document.createElement('iframe');
    el.setAttribute('aria-hidden', 'true');
    el.tabIndex = -1;
    el.title = 'Render Queue';
    // Off the screen but laid out at a real size (a hidden page would not render).
    el.style.cssText = 'position:fixed;left:-10000px;top:0;width:1200px;height:800px;border:0;pointer-events:none;';
    const base = location.href.split('#')[0].split('?')[0];
    el.src = `${base}?queue`;
    frame = { el, ready: null };
    frame.ready = new Promise((resolve, reject) => {
      const start = performance.now();
      const wait = () => {
        const api = el.contentWindow && el.contentWindow.illuminator;
        if (api) resolve(el);
        else if (performance.now() - start > 60000) reject(new Error('The render queue could not start'));
        else setTimeout(wait, 100);
      };
      document.body.append(el);
      wait();
    });
    return frame.ready;
  }

  // Stops whatever the hidden copy is doing: it is thrown away, a new one starts with the next job.
  function dropRunner() {
    if (frame && frame.el) frame.el.remove();
    frame = null;
  }

  async function save(file) {
    const name = uniqueName(file.name, used);
    used.add(name);
    if (native && native.writeOutput) {
      if (!folder) throw new Error('No folder was chosen for the files');
      return native.writeOutput(folder, name, file.bytes);
    }
    await download(new Blob([file.bytes], { type: file.type }), name);
    return name;
  }

  async function runJob(job) {
    const lib = state.lib;
    const photo = lib && lib.get(job.spec.photoId);
    if (!photo) throw new Error('The photo is no longer in the library');
    const file = await lib.file(photo);
    if (!file) throw new Error(`${photo.name} is missing from the library folder`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const el = await runnerFrame();
    const api = el.contentWindow.illuminator;
    // The bar: each step has its share; inside a step it follows what the hidden copy reports (never backwards).
    const phases = phasesFor(job.spec);
    let phase = 0;
    let within = 0;
    const show = (stage) => queue.setProgress(job, phases.slice(0, phase).reduce((n, p) => n + p.weight, 0) + phases[phase].weight * within, stage);
    const names = { open: 'Opening the photo', render: 'Rendering from the full sensor', export: job.spec.kind === 'video' ? 'Making the video' : 'Saving the picture' };
    const step = (n) => {
      phase = n;
      within = 0;
      show(names[phases[n].name]);
    };
    const off = api.on('progress', ({ stage, progress }) => {
      within = Math.max(within, Math.min(0.98, progress || 0));
      show(stage || names[phases[phase].name]);
    });
    try {
      step(0);
      await api.open(photo.name, bytes, { edits: job.spec.edits });
      if (job.spec.fullSensor) {
        step(phases.findIndex((p) => p.name === 'render'));
        await api.fullSensor(job.spec.fullSensor);
      }
      step(phases.length - 1);
      const out = job.spec.kind === 'video' ? await api.exportVideo() : await api.export(job.spec.export);
      return await save(out);
    } finally {
      off();
    }
  }

  async function pump() {
    const job = queue.next();
    if (!job) return;
    queue.start(job);
    const stopped = new Promise((_, reject) => {
      current = { job, abort: () => reject(new Error('Cancelled')) };
    });
    try {
      const output = await Promise.race([runJob(job), stopped]);
      queue.finish(job, output);
    } catch (err) {
      if (job.status === 'running') queue.fail(job, err);
      else dropRunner();
    } finally {
      current = null;
    }
    // After a failure the copy may be in a bad state: a fresh one for the next job.
    if (job.status === 'failed') dropRunner();
    if (!queue.next()) {
      // Nothing left: the hidden copy gives its memory back.
      dropRunner();
      if (!queue.paused && queue.counts().waiting === 0) queue.setPaused(true);
    }
    pump();
  }

  // ---------------------------------------------------------------- the view
  // `open: false` leaves the photo as it is (the library grid is about to be shown).
  function setView(on, { open = true } = {}) {
    on = !!on;
    if (state.queueView === on) return;
    state.queueView = on;
    document.querySelector('.stage').classList.toggle('queue', on);
    $('queue-view').hidden = !on;
    for (const b of document.querySelectorAll('.queue-view-toggle')) {
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
    if (on && state.playing) $('pause-btn').click();
    if (on) {
      const photo = libraryPhoto();
      picked = photo ? [photo.id] : [];
      anchor = photo ? photo.id : null;
    } else {
      // Back to the photo: only the first of the chosen photos stays chosen, and that is the one shown.
      const first = firstChosen(listed(), picked);
      picked = first ? [first] : [];
      anchor = first;
      const photo = first && state.lib ? state.lib.get(first) : null;
      if (open && photo && photo !== libraryPhoto() && openPhoto) openPhoto(photo);
    }
    render();
    renderLibrary();
  }

  const STATUS_TEXT = { waiting: 'Waiting', running: 'Running…', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };

  function button(text, title, onclick, cls = 'link-button') {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: cls, textContent: text, title });
    b.onclick = onclick;
    return b;
  }

  function card(job) {
    const li = document.createElement('li');
    li.className = `queue-card ${job.status}`;
    const photo = state.lib && state.lib.get(job.spec.photoId);
    const url = photo && thumbFor ? thumbFor(photo) : null;
    const thumb = document.createElement('div');
    thumb.className = 'queue-thumb';
    if (url) thumb.append(Object.assign(document.createElement('img'), { src: url, alt: '' }));
    if (job.kind === 'video') thumb.append(Object.assign(document.createElement('span'), { className: 'queue-badge', textContent: '▶', title: 'Video' }));
    const main = document.createElement('div');
    main.className = 'queue-main';
    const head = document.createElement('div');
    head.className = 'queue-head';
    head.append(
      Object.assign(document.createElement('span'), { className: 'queue-title', textContent: job.title }),
      Object.assign(document.createElement('span'), { className: 'queue-kind', textContent: job.kind === 'video' ? 'Video' : job.spec.fullSensor ? 'Full sensor picture' : 'Picture' }),
    );
    const percent = Math.round(job.progress * 100);
    const bar = document.createElement('div');
    bar.className = 'queue-bar-row';
    const track = document.createElement('div');
    track.className = 'queue-track';
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-valuenow', String(percent));
    track.append(Object.assign(document.createElement('div'), { className: 'queue-fill' }));
    track.firstChild.style.width = `${percent}%`;
    bar.append(track, Object.assign(document.createElement('span'), { className: 'queue-percent', textContent: `${percent}%` }));
    const status = document.createElement('div');
    status.className = 'queue-status';
    status.textContent = job.status === 'failed' ? `Failed: ${job.error}`
      : job.status === 'done' ? `Saved ${typeof job.output === 'string' ? job.output.split(/[\\/]/).pop() : ''}`.trim()
        : job.status === 'running' ? job.stage || STATUS_TEXT.running : STATUS_TEXT[job.status];
    const chips = document.createElement('div');
    chips.className = 'queue-chips';
    for (const text of describeSettings(job.spec)) chips.append(Object.assign(document.createElement('span'), { className: 'queue-chip', textContent: text }));
    main.append(head, bar, status, chips);
    const actions = document.createElement('div');
    actions.className = 'queue-actions';
    if (job.status === 'waiting') actions.append(button('▲', 'Earlier', () => queue.move(job.id, -1)), button('▼', 'Later', () => queue.move(job.id, 1)));
    if (job.status === 'waiting' || job.status === 'running') actions.append(button('Cancel', 'Cancel this job', () => cancel(job)));
    else actions.append(button('Remove', 'Remove from the list', () => queue.remove(job.id)));
    li.append(thumb, main, actions);
    return li;
  }

  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = 0;
      render();
    }, 120);
  }

  function render() {
    const summary = queue.summary();
    const photos = chosen().filter((p) => !(p === libraryPhoto() && !state.info));
    const canAdd = photos.length > 0;
    for (const id of ['queue-add-photo', 'queue-add-video', 'queue-add-photo-view', 'queue-add-video-view']) $(id).disabled = !canAdd;
    const many = state.queueView && photos.length > 1;
    for (const id of ['queue-add-photo-view', 'queue-add-photo']) $(id).textContent = many ? `Add ${photos.length} pictures` : 'Add picture';
    for (const id of ['queue-add-video-view', 'queue-add-video']) $(id).textContent = many ? `Add ${photos.length} videos` : 'Add video';
    $('queue-summary').textContent = summary;
    const active = queue.jobs.filter((j) => j.status === 'waiting' || j.status === 'running').length;
    $('queue-open').textContent = active ? `Open Render Queue (${active} waiting)` : 'Open Render Queue';
    if (!state.queueView) return;
    $('queue-view-summary').textContent = summary;
    $('queue-current').textContent = many ? `Adds from ${photos.length} chosen photos` : canAdd ? `Adds from: ${photos[0].name}` : libraryPhoto() ? 'Opening the photo…' : 'Choose a library photo to add it';
    const list = $('queue-list');
    list.replaceChildren(...queue.jobs.map(card));
    $('queue-empty').hidden = queue.jobs.length > 0;
    const running = !queue.paused;
    $('queue-toggle').textContent = running && (queue.running || queue.counts().waiting) ? 'Pause queue' : 'Start queue';
    $('queue-toggle').disabled = !queue.jobs.some((j) => j.status === 'waiting' || j.status === 'running');
    $('queue-clear').disabled = !queue.jobs.some((j) => !['waiting', 'running'].includes(j.status));
    $('queue-folder-row').hidden = !(native && native.chooseOutputFolder);
    $('queue-folder').textContent = folder ? folder : 'No folder chosen';
  }

  function cancel(job) {
    const wasRunning = job.status === 'running';
    queue.cancel(job.id);
    if (wasRunning && current && current.job === job) current.abort();
  }

  async function chooseFolder() {
    const chosen = await native.chooseOutputFolder();
    if (chosen) folder = chosen;
    render();
    return !!folder;
  }

  for (const [id, kind] of [['queue-add-photo', 'photo'], ['queue-add-video', 'video'], ['queue-add-photo-view', 'photo'], ['queue-add-video-view', 'video']]) {
    $(id).onclick = () => add(kind).catch(showError);
  }
  for (const b of document.querySelectorAll('.queue-view-toggle')) b.onclick = () => setView(!state.queueView);
  $('queue-open').onclick = () => setView(true);
  $('queue-clear').onclick = () => queue.clearFinished();
  $('queue-folder-btn').onclick = () => chooseFolder();
  $('queue-toggle').onclick = async () => {
    if (!queue.paused) {
      // Pause: the running job finishes, nothing new starts.
      queue.setPaused(true);
      return;
    }
    if (native && native.chooseOutputFolder && !folder && !(await chooseFolder())) return;
    queue.setPaused(false);
    pump().catch(showError);
  };

  render();
  return { queue, render, add, setView, pick, isPicked };
}
