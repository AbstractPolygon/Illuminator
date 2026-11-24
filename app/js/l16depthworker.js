// A helper worker for a Light L16 photo's depth (js/l16depthpool.js): makes depth steps of the cost volume with the same function the single worker uses
// (core/l16depth.js depthCostStep), so the depth is the same.
import { depthCostStep } from './core/l16depth.js';

let job = null;

self.onmessage = (event) => {
  const msg = event.data;
  try {
    if (msg.type === 'load') {
      job = msg.job;
      self.postMessage({ type: 'loaded' });
    } else if (msg.type === 'step') {
      const slice = depthCostStep(job, msg.zi);
      self.postMessage({ type: 'step', zi: msg.zi, slice }, [slice.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};

// A message that cannot be read never reaches onmessage; answer so the pool stops instead of waiting forever.
self.onmessageerror = () => self.postMessage({ type: 'error', message: 'The helper could not read a message.' });
