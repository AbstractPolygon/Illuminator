// A helper worker for the CPU path's engine depth (js/costpool.js): makes the cost volume for the rows of pixels it is given, the same way engineCostVolume makes it for all.
import { engineCostVolume } from './core/enginedepth.js';

let job = null;

self.onmessage = (event) => {
  const msg = event.data;
  try {
    if (msg.type === 'init') {
      job = msg;
      self.postMessage({ type: 'ready' });
    } else if (msg.type === 'rows') {
      const volume = engineCostVolume(job.views, job.w, job.h, job.labels, undefined, { y0: msg.y0, y1: msg.y1 });
      self.postMessage({ type: 'rows', y0: msg.y0, y1: msg.y1, volume }, [volume.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};

// A message that cannot be deserialized never reaches onmessage; answer so the pool rejects instead of waiting forever.
self.onmessageerror = () => self.postMessage({ type: 'error', message: 'The helper could not read a message.' });
