// A helper worker for the CPU path: renders some of the photo's views (js/viewpool.js sends the photo's data once, then the views to make). Each view is made exactly as
// worker.js makes it on its own: rendered from the sensor, its clipped pixels marked (trust), its channels matched to the center view, and stored as 16 bit.
import { renderView, clipTrust } from './core/render.js';

let photo = null;

// The channels of a view scaled to the center view's means (worker.js equalize).
function equalize(rgb, centerMeans) {
  const m = [0, 0, 0];
  const n = rgb.length / 3;
  for (let i = 0; i < rgb.length; i += 3) {
    m[0] += rgb[i];
    m[1] += rgb[i + 1];
    m[2] += rgb[i + 2];
  }
  const means = m.map((v) => Math.max(1e-6, v / Math.max(1, n)));
  const g = centerMeans.map((c, i) => c / means[i]);
  for (let i = 0; i < rgb.length; i += 3) {
    rgb[i] *= g[0];
    rgb[i + 1] *= g[1];
    rgb[i + 2] *= g[2];
  }
  return rgb;
}

self.onmessage = (event) => {
  const msg = event.data;
  try {
    if (msg.type === 'init') {
      photo = { ...msg, scratch: new Float32Array(msg.sampler.lenses.cx.length * 3) };
      self.postMessage({ type: 'ready' });
    } else if (msg.type === 'view') {
      const { raw, cam, dev, sampler, centerMeans, scratch } = photo;
      const img = renderView(raw, cam, dev, sampler, msg.u, msg.v, scratch);
      const trust = clipTrust(img, dev.clip);
      const rgb = equalize(img, centerMeans);
      if (msg.scale) {
        // views away from the ring are stored as 16 bit to keep dozens of full views affordable in memory
        const q = new Uint16Array(rgb.length);
        for (let k = 0; k < rgb.length; k++) q[k] = Math.min(65535, rgb[k] * msg.scale + 0.5);
        self.postMessage({ type: 'view', index: msg.index, rgb: q, trust }, [q.buffer, trust.buffer]);
      } else {
        self.postMessage({ type: 'view', index: msg.index, rgb, trust }, [rgb.buffer, trust.buffer]);
      }
    }
  } catch (err) {
    self.postMessage({ type: 'error', index: msg.index, message: err && err.message ? err.message : String(err) });
  }
};
