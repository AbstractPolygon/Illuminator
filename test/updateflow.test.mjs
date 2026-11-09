// The update flow: what the GitHub releases/latest answer means for a computer, including answers that are broken or hostile.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { interpretRelease, fetchLatestRelease, RELEASE_DOWNLOAD_PREFIX, RELEASES_PAGE } from '../app/js/ui/updates.js';

const dl = (tag, name) => `${RELEASE_DOWNLOAD_PREFIX}${tag}/${name}`;
const asset = (tag, name, size = 150e6) => ({ url: `https://api.github.com/repos/AbstractPolygon/Illuminator/releases/assets/1`, id: 1, name, content_type: 'application/octet-stream', state: 'uploaded', size, browser_download_url: dl(tag, name) });
const NAMES = ['Illuminator-0.9.0-win-x64.exe', 'Illuminator-0.9.0-win-arm64.exe', 'Illuminator-0.9.0-mac-arm64.dmg', 'Illuminator-0.9.0-mac-x64.dmg', 'Illuminator-0.9.0-linux-amd64.deb', 'Illuminator-0.9.0-linux-x86_64.AppImage', 'latest.yml', 'Illuminator-0.9.0-win-x64.exe.blockmap'];
const notes = fs.readFileSync(new URL('../docs/release-notes/0.5.96.md', import.meta.url), 'utf8');
const release = (over = {}) => ({
  url: 'https://api.github.com/repos/AbstractPolygon/Illuminator/releases/1', tag_name: 'v0.9.0', name: 'Illuminator 0.9.0', draft: false, prerelease: false,
  body: `## What's new\n\n${notes.replace(/^#.*\n/, '')}\n\n## Downloads\n- stuff`, assets: NAMES.map((n) => asset('v0.9.0', n)), ...over,
});
const opts = (o) => ({ current: '0.5.96', ...o });

test('a newer release lists this platform and architecture only, with its news', () => {
  const r = interpretRelease(release(), opts({ os: 'win', arch: 'x64' }));
  assert.equal(r.status, 'available');
  assert.equal(r.latest, '0.9.0');
  assert.deepEqual(r.files.map((f) => [f.name, f.arch]), [['Windows', 'x64']]);
  assert.equal(r.files[0].href, dl('v0.9.0', 'Illuminator-0.9.0-win-x64.exe'));
  assert.equal(r.files[0].mine, true);
  assert.ok(r.news.length >= 1 && r.news.length <= 5);
  assert.ok(r.news.every((n) => typeof n.text === 'string'));
});

test('Linux lists both packages; macOS arm64 picks the dmg', () => {
  const linux = interpretRelease(release(), opts({ os: 'linux', arch: 'x64' }));
  assert.deepEqual(linux.files.map((f) => f.detail).sort(), ['.deb for Debian and Ubuntu', 'AppImage for other distributions']);
  const mac = interpretRelease(release(), opts({ os: 'mac', arch: 'arm64' }));
  assert.deepEqual(mac.files.map((f) => f.href.split('/').pop()), ['Illuminator-0.9.0-mac-arm64.dmg']);
});

test('an unknown platform and architecture lists every build, none marked as this computer', () => {
  const r = interpretRelease(release(), opts());
  assert.equal(r.files.length, 6);
  assert.ok(r.files.every((f) => !f.mine));
});

test('the same version or an older one is up to date', () => {
  assert.equal(interpretRelease(release({ tag_name: 'v0.5.96' }), opts({ os: 'win' })).status, 'uptodate');
  assert.equal(interpretRelease(release({ tag_name: '0.5.20' }), opts({ os: 'win' })).status, 'uptodate');
});

test('a draft, a prerelease, a missing or non-object release is not offered', () => {
  for (const bad of [release({ draft: true }), release({ prerelease: true }), null, undefined, 'x', 5, [], {}]) {
    assert.equal(interpretRelease(bad, opts({ os: 'win' })).status, 'invalid');
  }
});

test('a tag that is not a version string is invalid', () => {
  for (const tag of [5, null, {}, ['0.9.0'], '', 'nightly', '0.9.0<img src=x onerror=alert(1)>', '../../etc', '1e9']) {
    assert.equal(interpretRelease(release({ tag_name: tag }), opts({ os: 'win' })).status, 'invalid', String(JSON.stringify(tag)));
  }
});

test('a newer release with no assets, or none for this computer, is "nofiles"', () => {
  assert.equal(interpretRelease(release({ assets: [] }), opts({ os: 'win', arch: 'x64' })).status, 'nofiles');
  assert.equal(interpretRelease(release({ assets: undefined }), opts({ os: 'win' })).status, 'nofiles');
  assert.equal(interpretRelease(release({ assets: 'x' }), opts({ os: 'win' })).status, 'nofiles');
  assert.equal(interpretRelease(release({ assets: [asset('v0.9.0', 'Illuminator-0.9.0-mac-x64.dmg')] }), opts({ os: 'win', arch: 'x64' })).status, 'nofiles');
});

test('hostile assets are skipped or never linked', () => {
  const evil = [null, 5, {}, { name: 5 }, { name: 'a-win-x64.exe', browser_download_url: 'javascript:alert(1)', size: 'big' },
    { name: 'b-win-x64.exe', browser_download_url: 'https://evil.example/releases/download/x.exe', size: -5 },
    { name: 'c-win-x64.exe', browser_download_url: 'https://github.com/AbstractPolygon/Illuminator/releases/downloadx/c', size: NaN },
    { name: 'd-win-x64.exe', browser_download_url: { toString: () => RELEASE_DOWNLOAD_PREFIX }, size: Infinity }];
  const r = interpretRelease(release({ assets: evil }), opts({ os: 'win', arch: 'x64' }));
  assert.equal(r.status, 'available');
  assert.equal(r.files.length, 4);
  for (const f of r.files) {
    assert.equal(f.href, RELEASES_PAGE);
    assert.equal(f.size, 0);
  }
});

test('a download inside the release path is linked as given', () => {
  const r = interpretRelease(release(), opts({ os: 'win', arch: 'arm64' }));
  assert.ok(r.files[0].href.startsWith(RELEASE_DOWNLOAD_PREFIX));
});

test('html and script in the notes stay plain text, and a huge or non-string body is survivable', () => {
  const body = `## What's new\n- **<img src=x onerror=alert(1)>.** <script>alert(2)</script> done\n- [link](javascript:alert(3)) plain\n`;
  const r = interpretRelease(release({ body }), opts({ os: 'win', arch: 'x64' }));
  assert.equal(r.news.length, 2);
  assert.equal(r.news[0].lead.includes('<img'), true, 'kept as text for textContent, never as markup by the flow');
  const huge = `## What's new\n${'- **Lead.** text\n'.repeat(2e5)}`;
  const t0 = Date.now();
  const big = interpretRelease(release({ body: huge }), opts({ os: 'win', arch: 'x64' }));
  assert.ok(big.news.length <= 5);
  assert.ok(Date.now() - t0 < 2000);
  for (const b of [null, 5, {}, ['x'], undefined]) assert.deepEqual(interpretRelease(release({ body: b }), opts({ os: 'win', arch: 'x64' })).news, []);
  const late = `${'x\n'.repeat(60000)}## What's new\n- **Late.** Beyond the cut.\n`;
  assert.deepEqual(interpretRelease(release({ body: late }), opts({ os: 'win', arch: 'x64' })).news, []);
});

test('fetchLatestRelease returns the parsed JSON, and throws on a bad status or a network failure', async () => {
  const seen = [];
  const ok = await fetchLatestRelease(async (url, init) => { seen.push([url, init.headers.Accept]); return { ok: true, json: async () => ({ tag_name: 'v1.0.0' }) }; });
  assert.equal(ok.tag_name, 'v1.0.0');
  assert.match(seen[0][0], /^https:\/\/api\.github\.com\/repos\/AbstractPolygon\/Illuminator\/releases\/latest$/);
  await assert.rejects(fetchLatestRelease(async () => ({ ok: false, status: 403 })), /GitHub answered 403/);
  await assert.rejects(fetchLatestRelease(async () => { throw new TypeError('Failed to fetch'); }), /Failed to fetch/);
  await assert.rejects(fetchLatestRelease(async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } })), SyntaxError);
});
