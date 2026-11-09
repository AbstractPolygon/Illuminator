// updates: moved out of main.js. initUpdates() runs where the section used to, with what it uses from the rest of the page.
import { VERSION } from '../version.js';
import { releaseHighlights } from '../core/releasenotes.js';

// Whether version `a` is newer than version `b` (dotted numbers).
export function newerVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

// Whether the automatic checks are on (Settings > Check for updates): on unless it was turned off.
export function updateCheckOn() {
  try {
    return localStorage.getItem('illuminator.checkUpdates') !== '0';
  } catch {
    return true;
  }
}

// Release files are served from this address; a link from the API response that points anywhere else is not shown as a download.
export const RELEASE_DOWNLOAD_PREFIX = 'https://github.com/AbstractPolygon/Illuminator/releases/download/';
export const RELEASES_PAGE = 'https://github.com/AbstractPolygon/Illuminator/releases';
export function downloadHref(url) {
  return typeof url === 'string' && url.startsWith(RELEASE_DOWNLOAD_PREFIX) ? url : RELEASES_PAGE;
}

const RELEASES_API = 'https://api.github.com/repos/AbstractPolygon/Illuminator/releases/latest';
const BUILDS = [
  { re: /-win-x64\.exe$/, os: 'win', arch: 'x64', name: 'Windows', detail: 'Intel and AMD' },
  { re: /-win-arm64\.exe$/, os: 'win', arch: 'arm64', name: 'Windows', detail: 'ARM, such as Snapdragon' },
  { re: /-mac-arm64\.dmg$/, os: 'mac', arch: 'arm64', name: 'macOS', detail: 'Apple Silicon' },
  { re: /-mac-x64\.dmg$/, os: 'mac', arch: 'x64', name: 'macOS', detail: 'Intel' },
  { re: /-linux-amd64\.deb$/, os: 'linux', arch: 'x64', name: 'Linux', detail: '.deb for Debian and Ubuntu' },
  { re: /-linux-x86_64\.AppImage$/, os: 'linux', arch: 'x64', name: 'Linux', detail: 'AppImage for other distributions' },
];

// A release body is read line by line for its "What's new" list; a hostile or runaway one is cut so it cannot stall the page.
const MAX_NOTES = 100000;
const VERSION_TAG = /^v?\d+(\.\d+){0,3}$/;

// What the latest-release answer (the parsed JSON of GitHub's releases/latest) means for this computer: { status, latest, files, news }.
// status is 'invalid' (not a usable release: a draft, a prerelease, a tag that is not a version), 'uptodate', 'nofiles' (newer, but nothing for this computer is attached yet)
// or 'available'. Each file is { name, os, arch, detail, href, size, mine } with `href` always a release download link (downloadHref) and `mine` for this platform.
// `os` is 'win', 'mac', 'linux' or '' (not known: every platform is listed), `arch` 'x64', 'arm64' or '' (not known).
export function interpretRelease(release, { os = '', arch = '', current = VERSION } = {}) {
  const none = { status: 'invalid', latest: '', files: [], news: [] };
  if (!release || typeof release !== 'object' || Array.isArray(release)) return none;
  if (release.draft === true || release.prerelease === true) return none;
  if (typeof release.tag_name !== 'string' || !VERSION_TAG.test(release.tag_name.trim())) return none;
  const latest = release.tag_name.trim().replace(/^v/, '');
  if (!newerVersion(latest, current)) return { ...none, status: 'uptodate', latest };
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const files = assets
    .map((a) => ({ a, b: a && typeof a.name === 'string' ? BUILDS.find((b) => b.re.test(a.name)) : null }))
    // Only this computer's platform and this app's architecture (all of them when they cannot be told: an app built before the architecture was passed on).
    .filter((x) => x.b && (!os || x.b.os === os) && (!arch || x.b.arch === arch))
    .map(({ a, b }) => ({
      name: b.name, os: b.os, arch: b.arch, detail: b.detail, mine: b.os === os,
      href: downloadHref(a.browser_download_url),
      size: Number.isFinite(a.size) && a.size > 0 ? a.size : 0,
    }));
  if (!files.length) return { status: 'nofiles', latest, files, news: [] };
  const body = typeof release.body === 'string' ? release.body.slice(0, MAX_NOTES) : '';
  return { status: 'available', latest, files, news: releaseHighlights(body) };
}

// Fetches the latest release; throws with a readable message when the network or GitHub fails or answers with something that is not JSON.
export async function fetchLatestRelease(fetchImpl = fetch) {
  const r = await fetchImpl(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
  return r.json();
}

export function initUpdates({ showNotice, $ }) {
  // Desktop app: on startup, the newest release on GitHub is compared with
  // this version; when it is newer, a popup lists that release's files with
  // direct download links, this computer's first. "Don't remind me" skips
  // that version.


  function thisOs() {
    const p = `${navigator.userAgentData?.platform || navigator.platform || ''} ${navigator.userAgent}`.toLowerCase();
    return p.includes('win') ? 'win' : p.includes('mac') ? 'mac' : p.includes('linux') ? 'linux' : '';
  }

  // manual: from Help > Check for Updates, which says what it found; the automatic checks (at start, then every few hours) stay silent unless there is a new release.

  async function checkForUpdate(manual = false) {
    if (!window.lytroNative || (!manual && !updateCheckOn())) return;
    let release;
    try {
      release = await fetchLatestRelease();
    } catch (e) {
      if (manual) showNotice('Could not check for a new release', `${e && e.message ? e.message : e}. Check the internet connection and try again.`);
      return;
    }
    const os = thisOs();
    const arch = window.lytroNative.arch || '';
    const { status, latest, files, news } = interpretRelease(release, { os, arch });
    if (status === 'invalid') {
      if (manual) showNotice('Could not check for a new release', 'GitHub sent a release this app could not read. Try again later.');
      return;
    }
    if (status === 'uptodate') {
      if (manual) showNotice('Illuminator is up to date', `Version ${VERSION} is the latest release.`);
      return;
    }
    // "Don't remind me" only stops the pop-up at start: the Update available!
    // message in the toolbar stays, and opens the same pop-up.
    let skipped = false;
    try {
      skipped = localStorage.getItem('illuminator.skipVersion') === latest;
    } catch {
      // No storage: ask every time.
    }
    if (status === 'nofiles') {
      if (manual) showNotice(`Illuminator ${latest} is available`, 'No download for this computer is attached to the release yet. Try again later.');
      return;
    }
    $('update-title').textContent = `Illuminator ${latest} is available`;
    $('update-note').replaceChildren(
      `A new release is available (current: ${VERSION} | available: ${latest}).`,
      document.createElement('br'),
      'Download and install for the latest features.',
    );
    // The release's short "What's new" list (core/releasenotes.js), shown above the downloads.
    $('update-news').replaceChildren(...news.map(({ lead, text }) => {
      const li = document.createElement('li');
      if (lead) li.append(Object.assign(document.createElement('strong'), { textContent: lead }), ' ');
      li.append(text);
      return li;
    }));
    $('update-news-head').hidden = $('update-news').hidden = !news.length;
    $('update-links').replaceChildren(...files.map((f) => {
      const li = document.createElement('li');
      if (f.mine) li.className = 'mine';
      const name = Object.assign(document.createElement('span'), { className: 'name', textContent: f.name });
      const detail = Object.assign(document.createElement('span'), { className: 'size', textContent: `${f.arch} · ${f.detail}` });
      const spacer = Object.assign(document.createElement('span'), { className: 'spacer' });
      li.append(name, detail);
      const button = Object.assign(document.createElement('a'), { className: 'download-btn', href: f.href, target: '_blank', rel: 'noopener', textContent: `Download (${Math.round(f.size / 1e6)} MB)` });
      li.append(spacer, button);
      return li;
    }));
    $('update-skip').checked = false;
    $('update-dialog').onclose = () => {
      try {
        if ($('update-skip').checked) localStorage.setItem('illuminator.skipVersion', latest);
      } catch {
        // Ignore: the reminder comes back next time.
      }
    };
    const open = () => {
      $('update-skip').checked = false;
      if (!$('update-dialog').open) $('update-dialog').showModal();
    };
    $('update-btn').textContent = `Update available! ${latest}`;
    $('update-btn').onclick = open;
    $('update-btn').hidden = false;
    if (!skipped || manual) open();
  }
  setTimeout(checkForUpdate, 3000);
  // A long session hears about a release too.
  setInterval(checkForUpdate, 6 * 3600 * 1000);
  const checkNow = () => checkForUpdate(true); // Help > Check for Updates
  return { checkNow };
}
