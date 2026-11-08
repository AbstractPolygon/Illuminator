// The engine's cost volume (core/enginedepth.js engineCostVolume), the largest step of the CPU path's engine depth, made by a few helper workers (js/costworker.js) that take
// bands of rows each. The pixels are independent, so the bands together are exactly the volume one worker makes. Each helper gets a copy of the nine views.

// How many helpers: none for few cores or a small job, at most 3, fewer when copies of the views would take too much memory (256 MB in all).
export function costHelperCount(cores, pixels) {
  if (!(cores >= 3) || pixels < 20000) return 0;
  const perHelper = 9 * pixels * 3 * 4;
  return Math.max(0, Math.min(3, cores - 1, Math.floor((256 * 1024 * 1024) / Math.max(1, perHelper))));
}

// The volume for `views`, `labels` (layout ((y * w + x) * L + l)), or null if the helpers could not do it.
export async function pooledCostVolume(views, w, h, labels, count, onProgress = () => {}) {
  const workers = [];
  try {
    const url = new URL('./costworker.js', import.meta.url);
    for (let i = 0; i < count; i++) workers.push(new Worker(url, { type: 'module' }));
    await Promise.all(workers.map((wk) => new Promise((resolve, reject) => {
      wk.onmessage = (e) => (e.data.type === 'ready' ? resolve() : reject(new Error(e.data.message || 'helper failed')));
      wk.onerror = (e) => reject(new Error((e && e.message) || 'helper failed'));
      wk.postMessage({ type: 'init', views, w, h, labels });
    })));
    const L = labels.length;
    const out = new Float32Array(w * h * L);
    // bands of about 8 rows: the helpers take the next one when they are done, so a slow band does not hold the rest up
    const band = Math.max(1, Math.min(16, Math.ceil(h / (count * 8))));
    let next = 0;
    let done = 0;
    const total = Math.ceil(h / band);
    await new Promise((resolve, reject) => {
      const feed = (wk) => {
        if (next >= h) {
          if (done >= total) resolve();
          return;
        }
        const y0 = next;
        next = Math.min(h, next + band);
        wk.postMessage({ type: 'rows', y0, y1: next });
      };
      for (const wk of workers) {
        wk.onmessage = (e) => {
          if (e.data.type === 'error') return reject(new Error(e.data.message));
          out.set(e.data.volume, e.data.y0 * w * L);
          done++;
          onProgress(done / total);
          feed(wk);
        };
        wk.onerror = (e) => reject(new Error((e && e.message) || 'helper failed'));
        feed(wk);
      }
    });
    return out;
  } catch {
    return null;
  } finally {
    for (const wk of workers) wk.terminate();
  }
}
