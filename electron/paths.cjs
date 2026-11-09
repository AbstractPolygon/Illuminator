// Path checks for the main process, with the platform as a parameter so the
// Windows rules (drive and share roots, case-insensitive names) can be tested
// on any system. Pure: nothing here touches the disk or requires electron.

const path = require('node:path');

const flavor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

// True when `target` is `root` itself (only if allowSame) or lies below it.
// path.relative instead of a startsWith(root + sep) test: a drive or share
// root ('C:\\', '\\\\srv\\share\\') already ends in a separator, and win32
// names compare without regard to case.
function isInside(root, target, platform = process.platform, allowSame = false) {
  const p = flavor(platform);
  const rel = p.relative(p.resolve(root), p.resolve(target));
  if (rel === '') return allowSame;
  if (p.isAbsolute(rel)) return false; // another drive or share
  // A name that merely starts with dots ('..data') is inside; only a '..' segment climbs out.
  return rel.split(p.sep)[0] !== '..';
}

// A path below `root` from the page's slash separated relative path; throws
// 'Outside the library' for '.' / '..' segments and for anything that ends up
// outside (or on another drive).
function resolveInside(root, rel, platform = process.platform) {
  const p = flavor(platform);
  const base = p.resolve(root);
  const parts = String(rel || '').split(platform === 'win32' ? /[\\/]/ : '/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) throw new Error('Outside the library');
  const target = p.resolve(base, ...parts);
  if (!isInside(base, target, platform, true)) throw new Error('Outside the library');
  return target;
}

const LYTRO_EXTENSIONS = /\.(lfr|lfp|lfx|raw)$/i;

// The Lytro files among command line arguments or open-file paths, as absolute paths (options and other files are left out).
function lytroPathsFrom(args, cwd = process.cwd(), platform = process.platform) {
  const p = flavor(platform);
  return args
    .filter((a) => typeof a === 'string' && a && !a.startsWith('-') && LYTRO_EXTENSIONS.test(a))
    .map((a) => p.resolve(cwd, a));
}

module.exports = { isInside, resolveInside, lytroPathsFrom, LYTRO_EXTENSIONS };
