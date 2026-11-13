// scripts/pages/check-site-edit.mjs: the website's edit copy must stay valid JSON, or the page's Edit text button disappears.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkEditCopy } from '../scripts/pages/check-site-edit.mjs';

const page = (copy) => `<body><script id="edit-src" type="application/json">${copy}</script></body>`;

test('a valid edit copy passes; a raw line break inside it, or no copy, is reported', () => {
  assert.equal(checkEditCopy(page('"<p>one</p>\\n<p>two</p>"')).ok, true);
  const broken = checkEditCopy(page('"<p>one</p>\n<p>two</p>"'));
  assert.equal(broken.ok, false);
  assert.match(broken.why, /control character/i);
  assert.equal(checkEditCopy('<body></body>').ok, false);
});
