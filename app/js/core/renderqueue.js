// The render queue: jobs (a picture or a video of a library photo, with the settings it had when it was added) that run one after another in the background, in a
// hidden second copy of the app, while editing goes on (ui/queue.js). This is the list and its rules; it does no rendering.
//
// A job: { id, kind ('photo' | 'video'), title, status ('waiting' | 'running' | 'done' | 'failed' | 'cancelled'), spec, error, output, added, started, finished }

export const STATUS = ['waiting', 'running', 'done', 'failed', 'cancelled'];

export class RenderQueue {
  constructor({ onChange = () => {} } = {}) {
    this.jobs = [];
    this.nextId = 1;
    this.paused = true;
    this.onChange = onChange;
  }

  add(spec, { kind = 'photo', title = '' } = {}) {
    const job = { id: this.nextId++, kind, title: title || (spec && spec.name) || `Job ${this.nextId - 1}`, status: 'waiting', spec, error: null, output: null, added: Date.now(), started: null, finished: null };
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

  finish(job, output = null) {
    if (job.status !== 'running') return;
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
