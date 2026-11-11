// Carries edits made in the website artifact (the owner edits its text in the page) into the repo's site/index.html, which GitHub Pages serves.
//
//   node scripts/pages/site-sync.mjs BEFORE.html AFTER.html [site/index.html]
//
// BEFORE and AFTER are two versions of the artifact page (Artifact read saves each one). The pages differ from site/index.html in ways an
// edit never touches (gallery images inlined as data URIs, the released version where the site has {{version}}, the page's edit-src copy),
// so the whole page is not copied: the lines that changed between BEFORE and AFTER are found, and each changed block is replaced in the site
// where its old text occurs exactly once (as it is, or with the version number as {{version}}). Blocks that cannot be placed that way are
// printed and the exit code is 1; the site file is written only when every block was placed.
import fs from 'node:fs';


// The page's lines as edits see them: the publish skeleton's head merged away, the edit-src copy dropped, data URIs replaced by a marker.
export function pageLines(html) {
  let s = html.replace(/^<!doctype html>.*?<body>\n?/is, '').replace(/<\/body><\/html>\s*$/i, '');
  s = s.replace(/<script id="edit-src"[^>]*>[\s\S]*?<\/script>\n?/, '');
  s = s.replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, 'DATA-URI');
  return s.split('\n');
}

// Changed blocks between two line lists: [{ old: [...lines], new: [...lines] }], from a longest common subsequence of lines.
export function changedBlocks(a, b) {
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const blocks = [];
  let cur = null;
  let i = 0;
  let j = 0;
  const flush = () => {
    if (cur) blocks.push(cur);
    cur = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else {
      cur ??= { old: [], new: [], before: a[i - 1] ?? null };
      if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) cur.new.push(b[j++]);
      else cur.old.push(a[i++]);
    }
  }
  flush();
  return blocks;
}

// The released version the page shows (the download button), which the site writes as {{version}}.
export function pageVersion(html) {
  const m = html.match(/class="btn-ver">(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

export function applyBlocks(site, blocks, version) {
  const failed = [];
  const asSite = (t) => (version ? t.replaceAll(`btn-ver">${version}`, 'btn-ver">{{version}}').replaceAll(`Illuminator ${version}<`, 'Illuminator {{version}}<') : t);
  for (const blk of blocks) {
    const oldText = blk.old.join('\n');
    const newText = blk.new.join('\n');
    // (blank lines that only gained or lost spaces change nothing on the page)
    if (!(oldText + newText).trim()) continue;
    if (/DATA-URI/.test(oldText + newText)) {
      failed.push({ ...blk, why: 'touches an embedded image' });
      continue;
    }
    // A pure insertion is placed after the line before it; a pure deletion takes its lines' line breaks with it.
    const [from, to] = !blk.old.length ? [blk.before, `${blk.before}\n${newText}`] : !blk.new.length ? [`\n${oldText}`, ''] : [oldText, newText];
    let done = false;
    for (const [f, t] of [[from, to], [asSite(from), asSite(to)]]) {
      if (f != null && site.split(f).length === 2) {
        site = site.replace(f, () => t);
        done = true;
        break;
      }
    }
    if (!done) failed.push({ ...blk, why: 'its old text is not found once in the site' });
  }
  return { site, failed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [beforePath, afterPath, sitePath = 'site/index.html'] = process.argv.slice(2);
  if (!beforePath || !afterPath) {
    console.error('usage: node scripts/pages/site-sync.mjs BEFORE.html AFTER.html [site/index.html]');
    process.exit(2);
  }
  const before = fs.readFileSync(beforePath, 'utf8');
  const after = fs.readFileSync(afterPath, 'utf8');
  const blocks = changedBlocks(pageLines(before), pageLines(after));
  const { site, failed } = applyBlocks(fs.readFileSync(sitePath, 'utf8'), blocks, pageVersion(after));
  console.log(`${blocks.length} changed block(s), ${blocks.length - failed.length} placed`);
  for (const f of failed) console.log(`NOT PLACED (${f.why}):\n  - ${f.old.join('\n  - ').slice(0, 400)}\n  + ${f.new.join('\n  + ').slice(0, 400)}`);
  if (failed.length) process.exit(1);
  if (blocks.length) fs.writeFileSync(sitePath, site);
}
