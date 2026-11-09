import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadHref, RELEASES_PAGE } from '../app/js/ui/updates.js';

test('only release files on the project\'s GitHub are linked as downloads', () => {
  const ok = 'https://github.com/AbstractPolygon/Illuminator/releases/download/v1.0.0/Illuminator-win-x64.exe';
  assert.equal(downloadHref(ok), ok);
  for (const bad of ['javascript:alert(1)', 'https://evil.example/x.exe', 'https://github.com/other/repo/releases/download/v1/x', null, undefined, 42]) {
    assert.equal(downloadHref(bad), RELEASES_PAGE);
  }
});
