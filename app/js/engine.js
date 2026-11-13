// Promise wrapper around the decoding worker.

export class Engine {
  constructor() {
    this.nextId = 1;
    this.nextJob = 1;
    this.pending = new Map();
    this.worker = null;
    this.start();
  }

  // Test hook: ?cpu on the page renders without the GPU.
  start() {
    const cpu = typeof location !== 'undefined' && new URLSearchParams(location.search).has('cpu');
    const worker = new Worker(new URL(`./worker.js${cpu ? '?cpu' : ''}`, import.meta.url), { type: 'module' });
    this.worker = worker;
    worker.onmessage = (event) => { if (worker === this.worker) this.dispatch(event.data); };
    worker.onerror = (event) => this.fail(worker, event.message || 'The rendering worker stopped', event);
    worker.onmessageerror = (event) => this.fail(worker, 'The rendering worker sent a message that could not be read', event);
  }

  // The worker died or broke: every request waiting for it fails now (nothing else would answer it), and the next request starts a fresh worker. The photo that was open
  // lived in the old worker, so the page is told (`onWorkerLost`) and shows that it must be opened again.
  fail(worker, message, event) {
    if (worker !== this.worker) return;
    console.error('Worker error', message, event);
    this.worker = null;
    try { worker.terminate(); } catch { /* already gone */ }
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const p of waiting) p.reject(new Error(message));
    if (this.onWorkerLost) this.onWorkerLost(message);
  }

  dispatch(msg) {
    if (msg.type === 'notice') {
      if (this.onNotice) this.onNotice(msg.message);
      return;
    }
    if (msg.type === 'cache') {
      if (this.onCache) this.onCache(msg);
      return;
    }
    // The worker kept a full sensor picture (to save next to the photo), or wants one it may have saved (answered with a 'stillData' request).
    if (msg.type === 'stillKept') {
      if (this.onStillKept) this.onStillKept(msg);
      return;
    }
    if (msg.type === 'stillWant') {
      if (this.onStillWant) this.onStillWant(msg);
      else this.request('stillData', { nonce: msg.nonce, bytes: null });
      return;
    }
    // How long a stage took, for the speed report.
    if (msg.type === 'timing') {
      if (this.onTiming) this.onTiming(msg);
      return;
    }
    if (msg.type === 'depthReady') {
      if (this.onDepthReady) this.onDepthReady(msg);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.type === 'progress') {
      if (p.onProgress) p.onProgress(msg.stage, msg.progress);
    } else if (msg.type === 'frame') {
      if (p.onFrame) p.onFrame(msg);
    } else if (msg.type === 'error') {
      this.pending.delete(msg.id);
      p.reject(new Error(msg.message));
    } else {
      this.pending.delete(msg.id);
      p.resolve('result' in msg ? msg.result : msg);
    }
  }

  request(type, args = {}, { onProgress, onFrame, transfer, quick } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        this.start();
        if (this.onRecreate) this.onRecreate();
      }
      this.pending.set(id, { resolve, reject, onProgress, onFrame, type, quick });
      try {
        this.worker.postMessage({ id, type, ...args }, transfer || []);
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  // Long running jobs of one kind replace each other: starting a new one
  // stops the previous at its next frame.
  job(type, kind, args, handlers) {
    const job = this.nextJob++;
    return { job, promise: this.request(type, { ...args, job }, handlers) };
  }

  cancel(kind) {
    return this.request('cancel', { kind });
  }
}

// A worker picture: an ImageBitmap (GPU path) or RGBA bytes (CPU path).
// Both can be drawn and passed to createImageBitmap.
export function toImageData(msg) {
  if (msg.bitmap) return msg.bitmap;
  return new ImageData(new Uint8ClampedArray(msg.pixels), msg.width, msg.height);
}
