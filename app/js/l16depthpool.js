// Helper workers (js/l16depthworker.js) that make the depth steps of a Light L16 photo's depth side by side (core/l16depth.js measureDepthPooled): each step is
// an independent pass over the camera pictures, so they are shared out, and the depth is the same as when one worker makes them in turn. Each helper gets a
// copy of the reduced camera pictures (about 16 MB); they are shut down when the depth is done.

// How many helpers for this many processor cores: none with fewer than 3, otherwise one less than the cores, at most 6.
export function l16DepthHelperCount(cores) {
  return cores >= 3 ? Math.min(6, cores - 1) : 0;
}

// Starts `count` helpers. Returns { run(job, steps, onSlice), close() }, or null when they cannot be made.
export function createL16DepthPool(count) {
  if (!(count > 0) || typeof Worker === 'undefined') return null;
  const workers = [];
  try {
    const url = new URL('./l16depthworker.js', import.meta.url);
    for (let i = 0; i < count; i++) workers.push(new Worker(url, { type: 'module' }));
  } catch {
    for (const w of workers) w.terminate();
    return null;
  }
  const close = () => {
    for (const w of workers) w.terminate();
  };
  return {
    // Makes depth steps 0 .. steps - 1 of `job`, calling onSlice(zi, slice) as each comes back.
    run(job, steps, onSlice) {
      return new Promise((resolve, reject) => {
        let next = 0;
        let done = 0;
        let failed = false;
        const fail = (message) => {
          if (failed) return;
          failed = true;
          reject(new Error(message || 'A depth helper failed.'));
        };
        const feed = (w) => {
          if (next < steps) w.postMessage({ type: 'step', zi: next++ });
        };
        for (const w of workers) {
          w.onmessage = (e) => {
            const d = e.data;
            if (d.type === 'error') return fail(d.message);
            if (d.type === 'loaded') return feed(w);
            if (d.type === 'step') {
              onSlice(d.zi, d.slice);
              if (++done >= steps) resolve();
              else feed(w);
            }
          };
          w.onerror = (e) => fail(e && e.message);
          w.postMessage({ type: 'load', job });
        }
      });
    },
    close,
  };
}
