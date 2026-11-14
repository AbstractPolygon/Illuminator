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

// The files are derived, not listed by hand, so a new module that a worker starts to use cannot be forgotten: everything the three workers that make the cached
// numbers (opening/measuring, depth, cost volume) import, directly or through other modules, plus the files that build the cache keys.
const ROOTS = ['worker.js', 'depthworker.js', 'costworker.js'];
const KEY_FILES = ['core/processed-cache.js', 'core/cacherev.js'];
// Release bookkeeping: they change with every release and cannot change a measured number.
const EXCLUDED = new Set(['version.js', 'releasenotes.js']);

const SPECIFIER = /(?:\bimport\s*(?:[\w$*{}\s,]*?\bfrom\s*)?|\bexport\s*(?:\*|\{[^}]*\})\s*from\s*|\bimport\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

function importClosure(roots) {
  const seen = new Set();
  const todo = [...roots];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f) || EXCLUDED.has(f)) continue;
    seen.add(f);
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of text.matchAll(SPECIFIER)) {
      const dep = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
      assert.ok(fs.existsSync(path.join(root, dep)), `${f} imports ${m[1]}, which does not exist`);
      todo.push(dep);
    }
  }
  return [...seen].sort();
}

const FILES = importClosure([...ROOTS, ...KEY_FILES]);
const EXPECTED = { rev: 6, checksum: '31713688738cacca' };

// Comments and white space do not change a result: they are left out of the checksum.
function checksum() {
  const h = crypto.createHash('sha256');
  for (const f of FILES) {
    const text = fs.readFileSync(path.join(root, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1').replace(/\s+/g, ' ');
    h.update(`${f}\n${text}\n`);
  }
  return h.digest('hex').slice(0, 16);
}

test('the checked files are the import closure of the workers and the cache key files', () => {
  for (const f of [...ROOTS, ...KEY_FILES, 'core/depth.js', 'core/depthmatch.js', 'core/lenslet.js', 'gpu/depthmatch.js']) assert.ok(FILES.includes(f), `${f} is missing from the checked files`);
  assert.ok(!FILES.includes('version.js') && !FILES.includes('releasenotes.js'));
});

// To update after a deliberate change: run `node --test test/cacherev.test.mjs`, read the checksum in the failure message and put it in EXPECTED. Raise CACHE_REV first
// when the change can alter a measured number (then every saved cache is made again).
test('the files that make the saved caches have not changed without a look at CACHE_REV', () => {
  assert.equal(CACHE_REV, EXPECTED.rev, 'CACHE_REV changed: record it in EXPECTED here with the new checksum');
  const actual = checksum();
  assert.equal(actual, EXPECTED.checksum, `a file that makes the saved depth, lens centers or opening data changed (checksum is now ${actual} over ${FILES.length} files). Raise CACHE_REV in app/js/core/cacherev.js if the change can alter what is measured, then put the new checksum in EXPECTED here.`);
});
