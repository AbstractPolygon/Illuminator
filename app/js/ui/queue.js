// The render queue panel (Render queue, right sidebar): pictures and videos of library photos that are made one after another in the background while editing goes
// on. The renders run in a hidden second copy of the app (an iframe of this page with ?queue), which has its own worker and graphics context, so the live view of the
// photo being edited is not held up. The copy is driven through the scripting interface (ui/api.js). The list and its rules are in core/renderqueue.js.

import { RenderQueue, uniqueName } from '../core/renderqueue.js';
import { download } from '../platform.js';

export function initQueue({ $, state, native, currentEdits, showNotice, showError }) {
  const used = new Set();
  let frame = null;
  let current = null; // { job, abort }
  let folder = null; // desktop: the folder chosen for the files
  const queue = new RenderQueue({ onChange: () => render() });
  queue.paused = true;

  // ---------------------------------------------------------------- what a job is
  const libraryPhoto = () => (state.current && state.current.photo ? state.current.photo : null);

  function specFor(kind) {
    const photo = libraryPhoto();
    const edits = JSON.parse(JSON.stringify(currentEdits()));
    const fullOn = $('fullres-on').checked && state.info && state.info.hasRaw;
    return {
      kind,
      photoId: photo.id,
      name: photo.name,
      edits,
      fullSensor: fullOn ? { scale: +$('still-scale').value, passes: +$('still-passes').value } : null,
      export: { format: $('photo-format').value, quality: +$('photo-quality').value, colorSpace: $('photo-colorspace').value, size: +$('photo-size').value },
    };
  }

  function add(kind) {
    if (!libraryPhoto() || !state.info) return;
    if (kind === 'video' && !$('anim-on').checked) {
      showNotice('Turn on Animation first', 'A video is made from the animation: turn it on in the Animation panel and set it up, then add the video to the queue.');
      return;
    }
    const spec = specFor(kind);
    const what = kind === 'video' ? 'video' : spec.fullSensor ? 'full sensor picture' : 'picture';
    queue.add(spec, { kind, title: `${spec.name}: ${what}` });
    $('queue-panel').open = true;
  }

  // ---------------------------------------------------------------- the hidden copy of the app
  function runnerFrame() {
    if (frame) return frame.ready;
    const el = document.createElement('iframe');
    el.setAttribute('aria-hidden', 'true');
    el.tabIndex = -1;
    el.title = 'Render queue';
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
    await api.open(photo.name, bytes, { edits: job.spec.edits });
    if (job.spec.fullSensor) await api.fullSensor(job.spec.fullSensor);
    const out = job.spec.kind === 'video' ? await api.exportVideo() : await api.export(job.spec.export);
    return save(out);
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

  // ---------------------------------------------------------------- the panel
  const STATUS_TEXT = { waiting: 'Waiting', running: 'Running…', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };

  function button(text, title, onclick, cls = 'link-button') {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: cls, textContent: text, title });
    b.onclick = onclick;
    return b;
  }

  function render() {
    $('queue-list').replaceChildren(...queue.jobs.map((job) => {
      const li = document.createElement('li');
      li.className = `queue-job ${job.status}`;
      const title = Object.assign(document.createElement('span'), { className: 'queue-title', textContent: job.title });
      const status = Object.assign(document.createElement('span'), { className: 'queue-status', textContent: job.status === 'failed' ? `Failed: ${job.error}` : job.status === 'done' && job.output ? `Saved ${typeof job.output === 'string' ? job.output.split(/[\\/]/).pop() : ''}` : STATUS_TEXT[job.status] });
      const actions = document.createElement('span');
      actions.className = 'queue-actions';
      if (job.status === 'waiting') {
        actions.append(button('▲', 'Earlier', () => queue.move(job.id, -1)), button('▼', 'Later', () => queue.move(job.id, 1)));
      }
      if (job.status === 'waiting' || job.status === 'running') actions.append(button('Cancel', 'Cancel this job', () => cancel(job)));
      else actions.append(button('Remove', 'Remove from the list', () => queue.remove(job.id)));
      li.append(title, status, actions);
      return li;
    }));
    $('queue-summary').textContent = queue.summary();
    const running = !queue.paused;
    $('queue-toggle').textContent = running && (queue.running || queue.counts().waiting) ? 'Pause queue' : 'Start queue';
    $('queue-toggle').disabled = !queue.jobs.some((j) => j.status === 'waiting' || j.status === 'running');
    $('queue-clear').disabled = !queue.jobs.some((j) => !['waiting', 'running'].includes(j.status));
    const canAdd = !!libraryPhoto() && !!state.info;
    $('queue-add-photo').disabled = !canAdd;
    $('queue-add-video').disabled = !canAdd;
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

  $('queue-add-photo').onclick = () => add('photo');
  $('queue-add-video').onclick = () => add('video');
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
  return { queue, render, add };
}
