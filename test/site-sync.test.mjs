// scripts/pages/site-sync.mjs: edits made in the website artifact carried into site/index.html, which differs from the page in its version
// placeholder, its gallery files and the page's edit-src copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pageLines, changedBlocks, applyBlocks, pageVersion } from '../scripts/pages/site-sync.mjs';

const page = (body) => `<!doctype html><html><head><meta charset=utf8></head><body>\n${body}\n<script id="edit-src" type="application/json">"copy ${Math.random()}"</script>\n</body></html>`;
const site = [
  '<a class="btn" href="#download">Download<span class="btn-ver">{{version}} beta</span></a>',
  '<p>Video as WebM or MP4; photos as PNG (8 or 16-bit) or JPEG.</p>',
  '<img src="gallery/a1-thumb.jpg">',
  '<ul>',
  '  <li>One</li>',
  '  <li>Two</li>',
  '</ul>',
].join('\n');
const before = [
  '<a class="btn" href="#download">Download<span class="btn-ver">0.6.5 beta</span></a>',
  '<p>Video as WebM or MP4; photos as PNG (8 or 16-bit) or JPEG.</p>',
  '<img src="data:image/jpeg;base64,AAAA">',
  '<ul>',
  '  <li>One</li>',
  '  <li>Two</li>',
  '</ul>',
];

const sync = (after) => {
  const a = page(before.join('\n'));
  const b = page(after.join('\n'));
  return applyBlocks(site, changedBlocks(pageLines(a), pageLines(b)), pageVersion(b));
};

test('a changed sentence, a removed line and an added line reach the site; the edit-src copy does not count as a change', () => {
  const after = [...before];
  after[1] = '<p>Video as WebM or MP4; photos as PNG or JPEG.</p>';
  after.splice(5, 1);
  after.splice(4, 0, '  <li>Zero</li>');
  const { site: out, failed } = sync(after);
  assert.deepEqual(failed, []);
  assert.match(out, /photos as PNG or JPEG\.<\/p>/);
  assert.match(out, /<ul>\n {2}<li>Zero<\/li>\n {2}<li>One<\/li>\n<\/ul>/);
  assert.match(out, /gallery\/a1-thumb\.jpg/, 'the gallery file reference stays');
});

test('text beside the version number is placed with the site\'s {{version}}', () => {
  const after = [...before];
  after[0] = '<a class="btn" href="#download">Get Illuminator<span class="btn-ver">0.6.5 beta</span></a>';
  const { site: out, failed } = sync(after);
  assert.deepEqual(failed, []);
  assert.match(out, /Get Illuminator<span class="btn-ver">\{\{version\}\} beta/);
});

test('an edit touching an embedded image is reported, not guessed', () => {
  const after = [...before];
  after[2] = '<img alt="x" src="data:image/jpeg;base64,AAAA">';
  const { failed } = sync(after);
  assert.equal(failed.length, 1);
  assert.match(failed[0].why, /embedded image/);
});
