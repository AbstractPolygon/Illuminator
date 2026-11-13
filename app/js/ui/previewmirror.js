// A second rendering worker for quick previews.
//
// The engine runs on one thread, so while it renders something long (a full sensor picture, Detail recovery, a preview's frames) a newer quick preview, made while the time slider
// or playhead is dragged, waits for it. This keeps a second engine (worker) with the same photo and settings, only while Animation is enabled; quick previews go to it whenever the
// main engine is busy, and to the main engine otherwise (which has the depth and kept pictures already). It is a mirror: every request that changes what the worker holds (opening
// the photo, settings, the LUT, calibrations, memory limits) is repeated on it, in order, and the main engine stays the one the page works with.
import { Engine } from '../engine.js';

// The requests that change what a worker holds.
const MIRRORED = new Set(['open', 'prepare', 'setCalibrations', 'memoryLimits', 'setGrid', 'settings', 'setLut']);
// What keeps the main engine busy for a long time (a quick request is marked `quick` and does not count).
const HEAVY = new Set(['superRes', 'superResPreview', 'lytroEdof', 'refocusFrames', 'frames', 'open', 'prepare', 'depthMap', 'depthHistogram']);

export class PreviewMirror {
  constructor(primary, { onLog = () => {} } = {}) {
    this.primary = primary;
    this.log = onLog;
    this.engine = null;
    this.wanted = false;
    this.ready = false;
    this.queued = 0;
    this.chain = Promise.resolve();
    this.last = new Map(); // the latest arguments of each mirrored request, to repeat them on a fresh worker
    this.openBlob = null;
    this.openRest = null;
    this.generation = 0;
    const original = primary.request.bind(primary);
    primary.request = (type, args = {}, opts) => {
      if (MIRRORED.has(type)) this.observe(type, args);
      const promise = original(type, args, opts);
      if (type === 'open') promise.then(() => this.begin(), () => {});
      return promise;
    };
  }

  // Whether the mirror should exist (Animation enabled and a photo open).
  want(on) {
    this.wanted = !!on;
    if (!this.wanted) this.stop();
    else if (this.hasOpen && !this.engine) this.begin();
  }

  stop() {
    this.generation++;
    this.ready = false;
    this.queued = 0;
    this.chain = Promise.resolve();
    const e = this.engine;
    this.engine = null;
    if (e && e.worker) {
      try { e.worker.terminate(); } catch { /* already gone */ }
      e.worker = null;
    }
  }

  // A mirrored request was made on the main engine: keep what is needed to repeat it, and repeat it now when the mirror runs.
  observe(type, args) {
    if (type === 'open') {
      this.stop();
      const { bytes, ...rest } = args;
      // (the bytes are transferred to the main worker: keep a copy as a Blob, which the browser stores economically)
      this.openBlob = bytes ? new Blob([bytes]) : null;
      this.openRest = { ...copy(rest) };
      this.hasOpen = !!bytes || !!args.synthetic;
      return;
    }
    const cloned = copy(args);
    this.last.set(type, cloned);
    if (this.engine) this.enqueue(type, cloned, this.generation);
  }

  // Repeats a request on the mirror after the ones before it.
  enqueue(type, args, generation) {
    this.queued++;
    this.ready = false;
    this.chain = this.chain.then(async () => {
      if (generation !== this.generation || !this.engine) return;
      await this.engine.request(type, copy(args));
    }).catch((err) => {
      if (generation === this.generation) {
        this.log('Preview worker stopped', err);
        this.stop();
      }
    }).finally(() => {
      if (generation !== this.generation) return;
      this.queued--;
      if (this.queued === 0 && this.engine) this.ready = true;
    });
  }

  // Starts the mirror: a fresh worker that opens the photo and repeats the settings.
  async begin() {
    if (!this.wanted || !this.hasOpen) return;
    this.stop();
    const generation = this.generation;
    const e = new Engine();
    this.engine = e;
    // (the open request needs the photo's bytes, read back from the Blob; requests that come meanwhile wait for it on the chain)
    this.queued = 1;
    this.chain = (async () => {
      try {
        const bytes = this.openBlob ? await this.openBlob.arrayBuffer() : undefined;
        if (generation !== this.generation) return;
        const info = await e.request('open', { ...copy(this.openRest), ...(bytes ? { bytes } : {}) }, { transfer: bytes ? [bytes] : [] });
        if (generation !== this.generation) return;
        if (info && info.hasRaw === false && !info.processed) throw new Error('no light field image');
        for (const type of ['memoryLimits', 'setCalibrations', 'setLut', 'setGrid', 'settings']) {
          if (!this.last.has(type)) continue;
          if (generation !== this.generation) return;
          await e.request(type, copy(this.last.get(type)));
        }
        if (info && info.hasRaw) await e.request('prepare').catch(() => {});
      } catch (err) {
        if (generation === this.generation) {
          this.log('Preview worker stopped', err);
          this.stop();
        }
        return;
      }
      if (generation !== this.generation) return;
      this.queued--;
      this.ready = this.queued === 0;
    })();
  }

  // Whether the main engine is working on something long.
  primaryBusy() {
    for (const p of this.primary.pending.values()) if (HEAVY.has(p.type) && !p.quick) return true;
    return false;
  }

  // The engine for a quick preview: the mirror when it is in step and the main engine is busy, else the main engine.
  quick() {
    return this.engine && this.ready && this.primaryBusy() ? this.engine : this.primary;
  }
}

// A copy of a request's arguments (structured clone; what cannot be copied is passed as it is).
function copy(args) {
  if (args == null) return args;
  try {
    return structuredClone(args);
  } catch {
    return args;
  }
}
