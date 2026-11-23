import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverHighlights, makeLook, applyLook } from '../app/js/core/color.js';

test('highlight recovery leaves what is under the knee alone and folds what is above it under white', () => {
  assert.deepEqual(recoverHighlights(0.3, 0.4, 0.2, 0.8), [0.3, 0.4, 0.2]);
  let last = 0;
  for (let m = 0.5; m <= 6; m += 0.25) {
    const [r, g, b] = recoverHighlights(m, m * 0.5, m * 0.4, 1);
    assert.ok(Math.max(r, g, b) <= 1 + 1e-9, `${m} -> ${r}`);
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    assert.ok(luma >= last - 1e-9, 'rising');
    last = luma;
  }
});

test('highlight recovery keeps the hue of what it folds, and takes the color out of what is blown', () => {
  const [r, g, b] = recoverHighlights(0.9, 0.6, 0.3, 1);
  assert.ok(r > g && g > b);
  assert.ok(Math.abs(r / g - 0.9 / 0.6) < 0.2, 'about the same ratios');
  const blown = recoverHighlights(2.4, 1.6, 1.8, 1);
  assert.ok(Math.max(...blown) - Math.min(...blown) < 0.05, 'neutral');
});

test('the amount is the look\'s recovery, and zero changes nothing', () => {
  const look = makeLook({ tone: { recovery: 0.5 } });
  assert.equal(look.recovery, 0.5);
  const px = [1.6, 1.2, 1.0];
  applyLook(px, look);
  assert.ok(Math.max(...px) <= 1.0001);
  assert.equal(makeLook({ tone: { recovery: 0 } }), null);
});
