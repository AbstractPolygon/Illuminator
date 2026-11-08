// A few helper workers (js/viewworker.js) that render the CPU path's views side by side. Without a graphics card each of the 29 views takes the sensor's lenses a moment, so
// they are shared out: the same views, made the same way, in a third of the time or less. Each helper gets its own copy of the photo's data (about a sensor's worth), so a
// few are used, not all the computer's cores, and they are shut down when the views are done. Any problem (no nested workers, no memory) leaves the views to the caller.

// How many helpers to use for a photo: none for a small job, at most 3, and fewer on a computer with few cores.
export function helperCount(cores, viewCount, rawBytes) {
  if (!(cores >= 3) || viewCount < 6) return 0;
  const byMemory = Math.floor((256 * 1024 * 1024) / Math.max(1, rawBytes * 2)); // about 2 raw copies' worth per helper (raw and sampler), 256 MB in all
  return Math.max(0, Math.min(3, cores - 1, byMemory));
}

// Renders `jobs` ({ u, v, scale? }, `scale` set for a 16 bit view) with `count` helpers. `photo`: { raw, cam, dev, sampler, centerMeans }. `onView(index, { rgb, trust })` is
// called as each is done; `stillWanted()` says whether to go on. Resolves when all are done, or with false if something failed or it was given up.
export async function renderViews(photo, jobs, count, { onView, stillWanted = () => true } = {}) {
  const workers = [];
  try {
    const url = new URL('./viewworker.js', import.meta.url);
    for (let i = 0; i < count; i++) workers.push(new Worker(url, { type: 'module' }));
    await Promise.all(workers.map((w) => new Promise((resolve, reject) => {
      w.onmessage = (e) => (e.data.type === 'ready' ? resolve() : reject(new Error(e.data.message || 'helper failed')));
      w.onerror = (e) => reject(new Error((e && e.message) || 'helper failed'));
      w.postMessage({ type: 'init', ...photo });
    })));
    let next = 0;
    let done = 0;
    let failed = null;
    await new Promise((resolve) => {
      const feed = (w) => {
        if (failed || !stillWanted() || next >= jobs.length) {
          if (done >= next) resolve();
          return;
        }
        const index = next++;
        w.postMessage({ type: 'view', index, ...jobs[index] });
      };
      for (const w of workers) {
        w.onmessage = (e) => {
          if (e.data.type === 'error') failed = failed || new Error(e.data.message);
          else onView(e.data.index, e.data);
          done++;
          feed(w);
        };
        w.onerror = (e) => {
          failed = failed || new Error((e && e.message) || 'helper failed');
          resolve();
        };
        feed(w);
      }
    });
    return failed ? false : done === jobs.length;
  } catch {
    return false;
  } finally {
    for (const w of workers) w.terminate();
  }
}
