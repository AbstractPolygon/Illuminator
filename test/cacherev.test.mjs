// The caches saved next to a photo (measured depth, lens centers, what opening works out) are keyed on CACHE_REV (app/js/core/cacherev.js), not on the app's version, so a
// release keeps them. That is only right while the code that makes those numbers is unchanged: this test fails when one of its files changes, so that someone decides.
// If the change can alter what is measured, raise CACHE_REV (every saved cache is then made again); if it cannot (a refactor, a speed-up with the same result), only update
// the checksum below.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CACHE_REV } from '../app/js/core/cacherev.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app/js');
const FILES = [
  'core/depth.js', 'core/depthcombine.js', 'core/depthguide.js', 'core/depthmatch.js', 'core/enginedepth.js', 'core/objects.js', 'core/userdepth.js', 'core/segments.js',
  'core/enginewb.js', 'core/enginewb-tables.js', 'core/enginemod.js', 'core/enginemod-tables.js', 'core/lensshift.js', 'core/lens.js', 'core/lenslet.js', 'core/raywarp.js',
  'gpu/depthmatch.js', 'gpu/enginecost.js', 'gpu/regions.js', 'gpu/lytroengine.js', 'gpu/enginemod.js',
];
const EXPECTED = { rev: 1, checksum: '9d6442b153e37da1' };

// Comments and white space do not change a result: they are left out of the checksum.
function checksum() {
  const h = crypto.createHash('sha256');
  for (const f of FILES) {
    const text = fs.readFileSync(path.join(root, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1').replace(/\s+/g, ' ');
    h.update(`${f}\n${text}\n`);
  }
  return h.digest('hex').slice(0, 16);
}

test('the files that make the saved caches have not changed without a look at CACHE_REV', () => {
  assert.equal(CACHE_REV, EXPECTED.rev, 'CACHE_REV changed: record it in EXPECTED here with the new checksum');
  assert.equal(checksum(), EXPECTED.checksum, 'a file that makes the saved depth, lens centers or opening data changed: raise CACHE_REV in app/js/core/cacherev.js if it can change what is measured, then update EXPECTED here');
});
