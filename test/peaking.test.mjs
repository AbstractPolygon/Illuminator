import test from 'node:test';
import assert from 'node:assert/strict';
import { peakingPixels } from '../app/js/core/peaking.js';

// A w x h picture, gray values from f(x, y) (0..255), as RGBA.
function picture(w, h, f) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = f(x, y);
      d.set([v, v, v, 255], 4 * (y * w + x));
    }
  }
  return d;
}
const marked = (out) => out.reduce((n, v, i) => n + (i % 4 === 3 && v > 0 ? 1 : 0), 0);

test('a hard edge is marked and a gentle gradient is not', () => {
  const w = 40;
  const h = 20;
  const hard = peakingPixels(picture(w, h, (x) => (x < 20 ? 30 : 220)), w, h, 0.15);
  assert.ok(marked(hard) > 0);
  // Marks sit at the edge, not far from it.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (hard[4 * (y * w + x) + 3] && Math.abs(x - 19.5) > 3) assert.fail(`stray mark at ${x}`);
  const soft = peakingPixels(picture(w, h, (x) => Math.round((x / (w - 1)) * 220)), w, h, 0.15);
  assert.equal(marked(soft), 0);
});

test('a lower threshold marks more, and a flat picture marks nothing', () => {
  const w = 30;
  const h = 30;
  const bumpy = picture(w, h, (x, y) => 100 + ((x * 7 + y * 13) % 5) * 6);
  assert.ok(marked(peakingPixels(bumpy, w, h, 0.02)) > marked(peakingPixels(bumpy, w, h, 0.2)));
  assert.equal(marked(peakingPixels(picture(w, h, () => 128), w, h, 0.01)), 0);
});
