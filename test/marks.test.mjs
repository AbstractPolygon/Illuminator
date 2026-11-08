import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKeywords, normalizeMarks, toXmp, parseXmp, matchesFilter, isFiltering, allKeywords, hasMarks, stars } from '../app/js/core/marks.js';

test('keywords are split, trimmed and not repeated', () => {
  assert.deepEqual(parseKeywords(' beach, Sunset ;beach\n  dog  walk ,, '), ['beach', 'Sunset', 'dog walk']);
  assert.deepEqual(parseKeywords(''), []);
  assert.equal(parseKeywords(Array.from({ length: 80 }, (_, i) => `k${i}`).join(',')).length, 50);
});

test('marks are kept in range', () => {
  assert.deepEqual(normalizeMarks({ rating: 9, flag: 'maybe', keywords: 'a, b' }), { rating: 5, flag: null, keywords: ['a', 'b'] });
  assert.deepEqual(normalizeMarks({ rating: -3, flag: 'pick' }), { rating: 0, flag: 'pick', keywords: [] });
  assert.deepEqual(normalizeMarks(), { rating: 0, flag: null, keywords: [] });
  assert.equal(hasMarks(normalizeMarks()), false);
  assert.equal(stars(3), '★★★');
});

test('the XMP sidecar round-trips and says what other programs expect', () => {
  const marks = { rating: 4, flag: 'pick', keywords: ['beach', 'R&D <test>'] };
  const xmp = toXmp(marks);
  assert.match(xmp, /xmp:Rating="4"/);
  assert.match(xmp, /xmpDM:pick="1"/);
  assert.match(xmp, /<rdf:li>R&amp;D &lt;test&gt;<\/rdf:li>/);
  assert.deepEqual(parseXmp(xmp), normalizeMarks(marks));
  // A rejected photo is rating -1 and pick -1, and comes back rejected.
  const rejected = toXmp({ rating: 3, flag: 'reject' });
  assert.match(rejected, /xmp:Rating="-1"/);
  assert.match(rejected, /xmpDM:pick="-1"/);
  assert.equal(parseXmp(rejected).flag, 'reject');
  // No marks at all: a plain rating 0.
  assert.match(toXmp({}), /xmp:Rating="0"/);
  assert.equal(parseXmp('<x:xmpmeta></x:xmpmeta>'), null);
  // Another program's element form.
  assert.equal(parseXmp('<xmp:Rating>2</xmp:Rating>').rating, 2);
});

test('the library filter', () => {
  const photos = [
    { name: 'IMG_1', rating: 5, flag: 'pick', keywords: ['beach'] },
    { name: 'IMG_2', rating: 2, flag: 'reject', keywords: ['beach', 'dog'] },
    { name: 'Sunset', rating: 0, keywords: [] },
  ];
  const names = (f) => photos.filter((p) => matchesFilter(p, f)).map((p) => p.name);
  assert.deepEqual(names({}), ['IMG_1', 'IMG_2', 'Sunset']);
  assert.deepEqual(names({ minRating: 3 }), ['IMG_1']);
  assert.deepEqual(names({ flag: 'pick' }), ['IMG_1']);
  assert.deepEqual(names({ flag: 'notreject' }), ['IMG_1', 'Sunset']);
  assert.deepEqual(names({ flag: 'none' }), ['Sunset']);
  assert.deepEqual(names({ text: 'DOG' }), ['IMG_2']);
  assert.deepEqual(names({ text: 'sun' }), ['Sunset']);
  assert.deepEqual(names({ minRating: 1, text: 'beach', flag: 'notreject' }), ['IMG_1']);
  assert.equal(isFiltering({}), false);
  assert.equal(isFiltering({ text: ' ' }), false);
  assert.equal(isFiltering({ minRating: 1 }), true);
  assert.deepEqual(allKeywords(photos), ['beach', 'dog']);
});
