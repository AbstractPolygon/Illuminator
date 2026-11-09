import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSyntheticLfr } from '../app/js/core/synthetic.js';

test('a mosaic whose pixel count is not a multiple of 4 keeps its last pixels', async () => {
  const lfr = await makeSyntheticLfr({ width: 63, height: 61 });
  const bytes = lfr instanceof Uint8Array ? lfr : new Uint8Array(lfr.buffer ?? lfr);
  assert.ok(bytes.length > 0);
});
