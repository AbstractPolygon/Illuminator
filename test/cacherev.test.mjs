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
import { L16_CACHE_REV } from '../app/js/core/l16-cache.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app/js');

// The files are derived, not listed by hand, so a new module that a worker starts to use cannot be forgotten: everything the three workers that make the cached
// numbers (opening/measuring, depth, cost volume) import, directly or through other modules, plus the files that build the cache keys.
const ROOTS = ['worker.js', 'depthworker.js', 'costworker.js'];
const KEY_FILES = ['core/processed-cache.js', 'core/cacherev.js'];
// Release bookkeeping: they change with every release and cannot change a measured number.
const EXCLUDED = new Set(['version.js', 'releasenotes.js']);

const SPECIFIER = /(?:\bimport\s*(?:[\w$*{}\s,]*?\bfrom\s*)?|\bexport\s*(?:\*|\{[^}]*\})\s*from\s*|\bimport\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

// Light L16 files make what core/l16-cache.js keeps, under its revision (L16_CACHE_REV, checked below on its own), and app/js/extra/ keeps nothing: neither is part of
// what CACHE_REV covers, so a change there does not ask for a look at it.
const IS_L16 = (f) => /^(core|gpu)\/(l16|lri)/.test(f) || /^l16depth/.test(f);
const IS_EXTRA = (f) => f === 'extra.js' || f.startsWith('extra/');

function importClosure(roots, skip = () => false) {
  const seen = new Set();
  const todo = [...roots];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f) || EXCLUDED.has(f) || skip(f)) continue;
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

const FILES = importClosure([...ROOTS, ...KEY_FILES], (f) => IS_L16(f) || IS_EXTRA(f));
const EXPECTED = { rev: 9, checksum: 'a4dc02b9925b9d74' };
// The Light L16 code (what its cache holds: the depth between the cameras and the merged picture), with core/l16-cache.js itself.
const L16_FILES = importClosure([...ROOTS, 'core/l16-cache.js']).filter(IS_L16);
const L16_EXPECTED = { rev: 7, checksum: '6dfbdd33f447379b' };

// Comments and white space do not change a result: they are left out of the checksum.
function checksum(files = FILES) {
  const h = crypto.createHash('sha256');
  for (const f of files) {
    const text = fs.readFileSync(path.join(root, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, 'f99638540abbdab9').replace(/(^|[^:'"`])\/\/.*$/gm, '$1').replace(/\s+/g, ' ');
    h.update(`${f}\n${text}\n`);
  }
  return h.digest('hex').slice(0, 16);
}

test('the checked files are the import closure of the workers and the cache key files', () => {
  for (const f of [...ROOTS, ...KEY_FILES, 'core/depth.js', 'core/depthmatch.js', 'core/lenslet.js', 'gpu/depthmatch.js']) assert.ok(FILES.includes(f), `${f} is missing from the checked files`);
  assert.ok(!FILES.includes('version.js') && !FILES.includes('releasenotes.js'));
  assert.ok(!FILES.some(IS_L16) && !FILES.some(IS_EXTRA), 'Light L16 and extra files are checked under their own revision, not CACHE_REV');
  for (const f of ['core/l16-cache.js', 'core/l16photo.js', 'core/l16classic.js', 'core/l16fusion.js', 'core/lri.js']) assert.ok(L16_FILES.includes(f), `${f} is missing from the L16 checked files`);
});

// To update after a deliberate change: run `node --test test/cacherev.test.mjs`, read the checksum in the failure message and put it in EXPECTED. Raise CACHE_REV first
// when the change can alter a measured number (then every saved cache is made again).
test('the files that make the saved caches have not changed without a look at CACHE_REV', () => {
  assert.equal(CACHE_REV, EXPECTED.rev, 'CACHE_REV changed: record it in EXPECTED here with the new checksum');
  const actual = checksum();
  assert.equal(actual, EXPECTED.checksum, `a file that makes the saved depth, lens centers or opening data changed (checksum is now ${actual} over ${FILES.length} files). Raise CACHE_REV in app/js/core/cacherev.js if the change can alter what is measured (and L16_CACHE_REV in core/l16-cache.js too if it can alter a Light L16 photo's depth or merged picture), then put the new checksum in EXPECTED here.`);
});

test('the Light L16 files that make its saved cache have not changed without a look at L16_CACHE_REV', () => {
  assert.equal(L16_CACHE_REV, L16_EXPECTED.rev, 'L16_CACHE_REV changed: record it in L16_EXPECTED here with the new checksum');
  const actual = checksum(L16_FILES);
  assert.equal(actual, L16_EXPECTED.checksum, `a Light L16 file that makes the saved depth or merged picture changed (checksum is now ${actual} over ${L16_FILES.length} files). Raise L16_CACHE_REV in app/js/core/l16-cache.js if the change can alter them, then put the new checksum in L16_EXPECTED here.`);
});
