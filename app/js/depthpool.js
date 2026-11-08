// Helper workers (js/depthworker.js) that score the CPU path's trial depths side by side: each trial depth is an independent pass over the views, so they are shared out
// and the scores are the same as when one worker makes them one after the other. Each helper gets a copy of the views' detail images, so a few are used (see
// depthHelperCount), and they are shut down when the measurement is done. Any problem leaves the measurement to the caller.

// How many helpers to use for `viewCount` views of `pixels` pixels: none for few cores, at most 3, and fewer when the copies would take too much memory (256 MB in all).
export function depthHelperCount(cores, viewCount, pixels) {
  if (!(cores >= 3) || viewCount < 5) return 0;
  const perHelper = (viewCount + 3) * pixels * 4; // the detail images, the level, the guide and the filter's working arrays
  return Math.max(0, Math.min(3, cores - 1, Math.floor((256 * 1024 * 1024) / Math.max(1, perHelper))));
}

// Starts `count` helpers. Returns { load(shared), run(alphas, onScore), close() } or null when they cannot be made.
export async function createDepthPool(count) {
  const workers = [];
  try {
    const url = new URL('./depthworker.js', import.meta.url);
    for (let i = 0; i < count; i++) workers.push(new Worker(url, { type: 'module' }));
  } catch {
    for (const w of workers) w.terminate();
    return null;
  }
  const close = () => {
    for (const w of workers) w.terminate();
  };
  return {
    // The picture the next scores are for (sent to every helper).
    async load(shared) {
      await Promise.all(workers.map((w) => new Promise((resolve, reject) => {
        w.onmessage = (e) => (e.data.type === 'loaded' ? resolve() : reject(new Error(e.data.message || 'helper failed')));
        w.onerror = (e) => reject(new Error((e && e.message) || 'helper failed'));
        w.postMessage({ type: 'load', ...shared });
      })));
    },
    // Scores every trial depth in `alphas`, calling onScore(k, score) as each is done.
    async run(alphas, onScore) {
      let next = 0;
      let done = 0;
      await new Promise((resolve, reject) => {
        const feed = (w) => {
          if (next >= alphas.length) {
            if (done >= alphas.length) resolve();
            return;
          }
          const k = next++;
          w.postMessage({ type: 'score', k, alpha: alphas[k] });
        };
        for (const w of workers) {
          w.onmessage = (e) => {
            if (e.data.type === 'error') return reject(new Error(e.data.message));
            onScore(e.data.k, e.data.score);
            done++;
            feed(w);
          };
          w.onerror = (e) => reject(new Error((e && e.message) || 'helper failed'));
          feed(w);
        }
      });
    },
    close,
  };
}
