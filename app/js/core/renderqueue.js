// The render queue: jobs (a picture or a video of a library photo, with the settings it had when it was added) that run one after another in the background, in a
// hidden second copy of the app, while editing goes on (ui/queue.js). This is the list and its rules; it does no rendering.
//
// A job: { id, kind ('photo' | 'video'), title, status ('waiting' | 'running' | 'done' | 'failed' | 'cancelled'), progress (0..1), stage (what it is doing), spec, error, output, added, started, finished }

import { COLOR_SPACES } from './colorspace.js';
import { VIDEO_FORMATS, VIDEO_CODECS } from './video-format.js';

export const STATUS = ['waiting', 'running', 'done', 'failed', 'cancelled'];

export class RenderQueue {
  constructor({ onChange = () => {} } = {}) {
    this.jobs = [];
    this.nextId = 1;
    this.paused = true;
    this.onChange = onChange;
  }

  add(spec, { kind = 'photo', title = '' } = {}) {
    const job = { id: this.nextId++, kind, title: title || (spec && spec.name) || `Job ${this.nextId - 1}`, status: 'waiting', progress: 0, stage: '', spec, error: null, output: null, added: Date.now(), started: null, finished: null };
    this.jobs.push(job);
    this.onChange();
    return job;
  }

  get(id) {
    return this.jobs.find((j) => j.id === id) || null;
  }

  get running() {
    return this.jobs.find((j) => j.status === 'running') || null;
  }

  // The next job to run: the first waiting one, unless paused or one is running.
  next() {
    if (this.paused || this.running) return null;
    return this.jobs.find((j) => j.status === 'waiting') || null;
  }

  start(job) {
    job.status = 'running';
    job.started = Date.now();
    this.onChange();
    return job;
  }

  // How far a running job has come (0..1, never backwards) and what it is doing.
  setProgress(job, fraction, stage = job.stage) {
    if (job.status !== 'running') return;
    job.progress = Math.max(job.progress, Math.min(1, Math.max(0, fraction || 0)));
    job.stage = stage;
    this.onChange();
  }

  finish(job, output = null) {
    if (job.status !== 'running') return;
    job.progress = 1;
    job.stage = '';
    job.status = 'done';
    job.output = output;
    job.finished = Date.now();
    this.onChange();
  }

  fail(job, error) {
    if (job.status === 'cancelled') return;
    job.status = 'failed';
    job.error = error && error.message ? error.message : String(error);
    job.finished = Date.now();
    this.onChange();
  }

  // A waiting job is dropped; a running one is marked cancelled (the runner stops it).
  cancel(id) {
    const job = this.get(id);
    if (!job) return false;
    if (job.status === 'waiting' || job.status === 'running') {
      job.status = 'cancelled';
      job.finished = Date.now();
      this.onChange();
      return true;
    }
    return false;
  }

  remove(id) {
    const job = this.get(id);
    if (!job || job.status === 'running') return false;
    this.jobs.splice(this.jobs.indexOf(job), 1);
    this.onChange();
    return true;
  }

  clearFinished() {
    this.jobs = this.jobs.filter((j) => j.status === 'waiting' || j.status === 'running');
    this.onChange();
  }

  // Moves a waiting job one place earlier (-1) or later (+1) among the waiting ones.
  move(id, by) {
    const job = this.get(id);
    if (!job || job.status !== 'waiting') return false;
    const i = this.jobs.indexOf(job);
    let j = i + by;
    while (j >= 0 && j < this.jobs.length && this.jobs[j].status !== 'waiting') j += by;
    if (j < 0 || j >= this.jobs.length) return false;
    [this.jobs[i], this.jobs[j]] = [this.jobs[j], this.jobs[i]];
    this.onChange();
    return true;
  }

  setPaused(paused) {
    this.paused = !!paused;
    this.onChange();
  }

  counts() {
    const c = Object.fromEntries(STATUS.map((s) => [s, 0]));
    for (const j of this.jobs) c[j.status]++;
    return c;
  }

  // One line saying where the queue stands.
  summary() {
    const c = this.counts();
    if (!this.jobs.length) return 'Nothing queued';
    const parts = [];
    if (c.running) parts.push('1 running');
    if (c.waiting) parts.push(`${c.waiting} waiting`);
    if (c.done) parts.push(`${c.done} done`);
    if (c.failed) parts.push(`${c.failed} failed`);
    if (c.cancelled) parts.push(`${c.cancelled} cancelled`);
    return `${parts.join(', ')}${this.paused && c.waiting ? ' (paused)' : ''}`;
  }
}

// A file name for a job's output that does not take one already used: "IMG_0001.png", then "IMG_0001 (2).png".
export function uniqueName(name, used) {
  if (!used.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n++) {
    const next = `${stem} (${n})${ext}`;
    if (!used.has(next)) return next;
  }
}


// The share of a job each step has, for the progress bar: [{ name, weight }] (weights add up to 1).
export function phasesFor(spec) {
  if (spec.kind === 'video') return [{ name: 'open', weight: 0.1 }, { name: 'export', weight: 0.9 }];
  if (spec.fullSensor) return [{ name: 'open', weight: 0.2 }, { name: 'render', weight: 0.6 }, { name: 'export', weight: 0.2 }];
  return [{ name: 'open', weight: 0.4 }, { name: 'export', weight: 0.6 }];
}

const F_STOPS = [22, 16, 11, 8, 5.6, 4, 2.8, 2, 1.4, 1, 0.7, 0.5];
const PHOTO_FORMATS = { png: 'PNG', png16: 'PNG 16-bit', jpeg: 'JPEG' };

// The export settings of a job as short phrases, for its card: what is made, in what format and size, and how.
export function describeSettings(spec) {
  const out = [];
  const edits = spec.edits || {};
  const camera = edits.camera || {};
  const rendering = edits.rendering || {};
  if (spec.kind === 'video') {
    const format = rendering['video-format'];
    const codec = rendering['video-codec'];
    out.push([VIDEO_FORMATS[format] && VIDEO_FORMATS[format].name, VIDEO_CODECS[codec] && VIDEO_CODECS[codec].name].filter(Boolean).join(' · ') || 'Video');
    const size = String(rendering['video-size'] ?? '');
    if (/^\d+x\d+$/.test(size)) out.push(size.replace('x', ' × '));
    else if (/^\d+$/.test(size) && +size) out.push(`${size}p`);
    else if (size) out.push(size);
    if (Number.isFinite(+rendering['video-quality']) && rendering['video-quality'] !== undefined) out.push(`${+rendering['video-quality']} Mbit/s`);
  } else {
    const e = spec.export || {};
    out.push(`${PHOTO_FORMATS[e.format] || 'PNG'}${e.format === 'jpeg' && Number.isFinite(e.quality) ? ` ${e.quality}%` : ''}`);
    if (e.colorSpace && e.colorSpace !== 'srgb' && COLOR_SPACES[e.colorSpace]) out.push(COLOR_SPACES[e.colorSpace].label);
    out.push(e.size && e.size !== 1 ? `${e.size}×` : 'Native size');
  }
  if (spec.fullSensor) out.push(`Full sensor ${spec.fullSensor.scale}×${spec.fullSensor.passes ? `, recovery ${spec.fullSensor.passes}` : ''}`);
  const f = F_STOPS[+camera.fstop];
  if (f) out.push(`f/${f}`);
  return out;
}
