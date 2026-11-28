// The numbers kept with a photo, checked by what they are rather than by the code that makes them (test/cacherev.test.mjs checks the code): two made-up light field
// photos are opened in the app's real worker in headless Chromium, and what the worker hands the page to keep (the depth, its confidence) and the camera view are
// compared with test/cache-results.json. See helpers/records.mjs for what a difference asks for. The made-up photos have no Lytro metadata, so the Lytro engine's
// depth, white balance and lens centers are not in them; those are checked on real photos (test/real-photos.test.mjs) where the photos are on hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gpuPage } from './helpers/gpupage.mjs';
import { openInWorker } from './helpers/workerdriver.mjs';
import { UPDATE, fingerprints, checkRecord, readRecords, writeRecords } from './helpers/records.mjs';
import { CACHE_REV } from '../app/js/core/cacherev.js';
import { L16_CACHE_REV } from '../app/js/core/l16-cache.js';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cache-results.json');
// (small sensors, so the test takes seconds; the second has a turned, shifted lens grid)
const PHOTOS = {
  'synthetic 1600x1200': { width: 1600, height: 1200 },
  'synthetic 1400x1100 turned': { width: 1400, height: 1100, rotation: 0.004, offsetX: -5.2, offsetY: 4.4 },
};

test('what is kept with a photo is what was recorded under this cache revision', async (t) => {
  const page = await gpuPage(t, { timeout: 300000 });
  if (!page) return;
  const records = readRecords(FILE);
  const problems = [];
  for (const [name, synthetic] of Object.entries(PHOTOS)) {
    const out = await openInWorker(page, { synthetic });
    const now = fingerprints(out);
    assert.ok(Object.keys(now.lytro).length, `${name}: the worker kept nothing with the photo`);
    if (UPDATE) records[name] = { cacheRev: CACHE_REV, l16CacheRev: L16_CACHE_REV, ...now };
    else if (!records[name]) problems.push(`${name}: not recorded yet (UPDATE_RECORDS=1 node --test test/cache-results.test.mjs)`);
    else problems.push(...checkRecord(name, records[name], now, { cacheRev: CACHE_REV, l16CacheRev: L16_CACHE_REV }));
  }
  if (UPDATE) writeRecords(FILE, records);
  assert.deepEqual(problems, []);
});
