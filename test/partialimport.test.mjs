import test from 'node:test';
import assert from 'node:assert/strict';
import { partialImport } from '../app/js/core/partialimport.js';

test('no imported list: nothing to add', () => {
  assert.deepEqual(partialImport(new Error('x')), { files: [], message: '' });
  assert.deepEqual(partialImport(Object.assign(new Error('x'), { imported: [] })), { files: [], message: '' });
  assert.deepEqual(partialImport(null), { files: [], message: '' });
});

test('described entries and bare paths both become files', () => {
  const err = Object.assign(new Error('x'), { imported: [{ path: '/lib/.incoming/A.LFR', name: 'A.LFR', size: 5 }, '/lib/.incoming/B.LFR'], failedFile: 'C.LFR' });
  const r = partialImport(err);
  assert.equal(r.files.length, 2);
  assert.equal(r.files[1].name, 'B.LFR');
  assert.equal(r.message, '2 photos were copied; C.LFR could not be read from the camera.');
});

test('one photo and no failed name', () => {
  const r = partialImport(Object.assign(new Error('x'), { imported: ['C:\\lib\\.incoming\\A.LFR'] }));
  assert.equal(r.files[0].name, 'A.LFR');
  assert.equal(r.message, '1 photo was copied; one photo could not be read from the camera.');
});
