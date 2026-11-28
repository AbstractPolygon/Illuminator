// What a photo's open in the real worker gives, recorded as fingerprints (helpers/workerdriver.mjs) and checked against the record, for cache-results.test.mjs and
// real-photos.test.mjs.
//
// The numbers kept with a photo (the 'cache' message: depth, what opening worked out, lens centers; and a Light L16 photo's depth and merged picture) are recorded with
// the cache revision they were made under. If they change while the revision is the same, a saved cache from before would be used although the app now measures
// something else: the test fails and asks for the revision to be raised (CACHE_REV in core/cacherev.js, L16_CACHE_REV in core/l16-cache.js). If the revision was
// raised, the test fails until the new numbers are recorded. The camera view is recorded too: it is not cached, but a change in it is worth a look.
//
// To record again after a deliberate change: UPDATE_RECORDS=1 node --test test/<the test>.
import fs from 'node:fs';
import { fingerprint, compareFingerprints } from './workerdriver.mjs';

export const UPDATE = !!process.env.UPDATE_RECORDS;

// The fingerprints of what openInWorker returned, by part: { lytro: {...}, l16: {...}, view: {...} }.
export function fingerprints(out) {
  const lytro = {};
  // (the last cache message has everything measured by then)
  const c = out.caches.at(-1);
  if (c) {
    if (c.alpha.length) lytro.depth = fingerprint(c.alpha, c.w, c.h);
    if (c.open) {
      lytro.openScale = fingerprint(c.open.scale || []);
      if (c.open.wb) lytro.openWb = fingerprint([...c.open.wb.gains, ...c.open.wb.rel, c.open.wb.cct ?? NaN]);
    }
    if (c.lens) {
      lytro.lensDx = fingerprint(c.lens.dx);
      lytro.lensDy = fingerprint(c.lens.dy);
    }
    for (const e of c.extra) {
      const style = JSON.parse(e.key).style || 'other';
      lytro[`${style}Depth`] = fingerprint(e.alpha, e.w, e.h);
      lytro[`${style}Confidence`] = fingerprint(e.confidence, e.w, e.h);
    }
  }
  const l16 = {};
  if (out.l16Cache) {
    const { depth, wide } = out.l16Cache;
    l16.invZ = fingerprint(depth.invZ, depth.width, depth.height);
    l16.confidence = fingerprint(depth.confidence, depth.width, depth.height);
    l16.wide = fingerprint(wide.rgb, wide.width, wide.height);
  }
  const view = out.view ? { size: `${out.view.width}x${out.view.height}`, rgba: fingerprint(out.view.rgba, 64, 48) } : null;
  return { lytro, l16, view };
}

// Checks `now` (fingerprints) against `rec` (the record: { cacheRev, l16CacheRev, lytro, l16, view }). Returns the problems as readable lines.
export function checkRecord(name, rec, now, { cacheRev, l16CacheRev }) {
  const out = [];
  const part = (label, want, got, rev, recRev, revName) => {
    const keys = [...new Set([...Object.keys(want || {}), ...Object.keys(got || {})])];
    if (!keys.length) return;
    const diffs = keys.flatMap((k) => compareFingerprints(`${name} ${label} ${k}`, (want || {})[k], (got || {})[k]));
    if (recRev !== rev) out.push(`${name}: ${label} was recorded under ${revName} ${recRev}, it is ${rev} now: record it again (UPDATE_RECORDS=1)`);
    else if (diffs.length) out.push(`${name}: what is kept with the photo (${label}) changed under the same ${revName} ${rev}. Raise ${revName} (a cache saved before would be used and be wrong), then record again (UPDATE_RECORDS=1). If the change is only machine noise, say so in the tolerance.\n    ${diffs.join('\n    ')}`);
  };
  part('cache', rec.lytro, now.lytro, cacheRev, rec.cacheRev, 'CACHE_REV');
  part('L16 cache', rec.l16, now.l16, l16CacheRev, rec.l16CacheRev, 'L16_CACHE_REV');
  if (rec.view || now.view) {
    if (!rec.view || !now.view || rec.view.size !== now.view.size) out.push(`${name}: the camera view is ${now.view ? now.view.size : 'missing'} now, ${rec.view ? rec.view.size : 'not recorded'} when recorded (UPDATE_RECORDS=1 if that is meant)`);
    else {
      // (eight-bit pictures: a little more room than the cached numbers, as the software renderer's rounding may differ between browser versions)
      const d = compareFingerprints(`${name} view`, rec.view.rgba, now.view.rgba, 0.01);
      if (d.length) out.push(`${name}: the camera view changed (not a cache, but worth a look; UPDATE_RECORDS=1 if it is meant):\n    ${d.join('\n    ')}`);
    }
  }
  return out;
}

export function readRecords(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function writeRecords(file, records) {
  const sorted = Object.fromEntries(Object.entries(records).sort(([a], [b]) => a.localeCompare(b)));
  // (lists of numbers on one line each)
  const text = JSON.stringify(sorted, null, 1).replace(/\[\s*([-0-9.e+,\snul]*?)\s*\]/g, (m, inner) => `[${inner.split(/,\s*/).join(', ')}]`);
  fs.writeFileSync(file, `${text}\n`);
}
