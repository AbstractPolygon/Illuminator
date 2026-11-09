import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFrameRate } from '../app/js/ui/framerate.js';

test('parseFrameRate accepts decimals, comma decimals and fractions', () => {
  assert.equal(parseFrameRate('24'), 24);
  assert.equal(parseFrameRate('29,97'), 29.97);
  assert.equal(parseFrameRate(' 30000/1001 '), 30000 / 1001);
  assert.ok(Number.isNaN(parseFrameRate('abc')));
  assert.ok(Number.isNaN(parseFrameRate('1/0')));
  assert.ok(Number.isNaN(parseFrameRate('')));
});
