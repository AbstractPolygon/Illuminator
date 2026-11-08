// A helper worker for the CPU path's depth measurement (js/depthpool.js): scores trial depths for the picture it was given, through the same scoreStep the sequential
// measurement uses, so the scores are the same.
import { scoreStep } from './core/depth.js';

let job = null;

self.onmessage = (event) => {
  const msg = event.data;
  try {
    if (msg.type === 'load') {
      job = msg;
      self.postMessage({ type: 'loaded' });
    } else if (msg.type === 'score') {
      const { lums, views, level, minLevel, guide, w, h, win, occl, guided } = job;
      const score = scoreStep({ lums, views, w, h, alpha: msg.alpha, minLevel, level, occl, guide, win, guided });
      self.postMessage({ type: 'score', k: msg.k, score }, [score.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
