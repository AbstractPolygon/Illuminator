// Checks that the website artifact's edit copy (the JSON in <script id="edit-src">, which the page's "Edit text" button works from) is valid, so the button shows.
//
//   node scripts/pages/check-site-edit.mjs PAGE.html
//
// A raw line break or an unescaped quote in that copy makes the page's edit script fail silently and the button disappears. Run it on a page before publishing it.
import fs from 'node:fs';

export function checkEditCopy(html) {
  const m = html.match(/<script id="edit-src"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return { ok: false, why: 'no edit-src script in the page' };
  try {
    const src = JSON.parse(m[1]);
    return typeof src === 'string' ? { ok: true, length: src.length } : { ok: false, why: 'the edit copy is not a string' };
  } catch (err) {
    return { ok: false, why: err.message };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node scripts/pages/check-site-edit.mjs PAGE.html');
    process.exit(2);
  }
  const r = checkEditCopy(fs.readFileSync(file, 'utf8'));
  console.log(r.ok ? `edit copy ok (${r.length} characters)` : `EDIT COPY BROKEN: ${r.why}`);
  process.exit(r.ok ? 0 : 1);
}
