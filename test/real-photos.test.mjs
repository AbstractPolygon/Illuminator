// Real photos, kept outside git (they are large, and they are the owner's): each Lytro (.lfr, .lfp) and Light L16 (.lri) file in the folder ILLUMINATOR_PHOTOS is opened
// in the app's real worker in headless Chromium, and what is kept with it (the Lytro engine's depth, what opening worked out, lens centers, the Illuminator depth; an L16
// photo's depth and merged picture) and its camera view are compared with test/real-photos.json, recorded by the file's checksum. See helpers/records.mjs for what a
// difference asks for. Without the folder the test is skipped. Each photo takes 2 to 6 minutes on a software renderer.
//
//   ILLUMINATOR_PHOTOS=/path/to/photos node --test test/real-photos.test.mjs
//   UPDATE_RECORDS=1 ILLUMINATOR_PHOTOS=/path/to/photos node --test test/real-photos.test.mjs   (records the photos in the folder; others' records are kept)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { gpuPage } from './helpers/gpupage.mjs';
import { openInWorker } from './helpers/workerdriver.mjs';
import { UPDATE, fingerprints, checkRecord, readRecords, writeRecords } from './helpers/records.mjs';
import { CACHE_REV } from '../app/js/core/cacherev.js';
import { L16_CACHE_REV } from '../app/js/core/l16-cache.js';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'real-photos.json');
const DIR = process.env.ILLUMINATOR_PHOTOS;
const photos = DIR && fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => /\.(lfr|lfp|lri)$/i.test(f)).sort() : [];

test('real photos: what is kept with each is what was recorded under this cache revision', { skip: photos.length ? false : 'no photos (set ILLUMINATOR_PHOTOS to a folder of .lfr, .lfp or .lri files)', timeout: 3600000 }, async (t) => {
  const records = readRecords(FILE);
  const problems = [];
  for (const name of photos) {
    const sum = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIR, name))).digest('hex').slice(0, 16);
    // (a fresh browser for each photo: the big ones hold a lot of memory)
    await t.test(name, async (tt) => {
      const page = await gpuPage(tt, { timeout: 1200000, photos: DIR });
      if (!page) return;
      const now = fingerprints(await openInWorker(page, { url: `/photos/${encodeURIComponent(name)}` }));
      const id = `${sum} ${name}`;
      const key = Object.keys(records).find((k) => k.startsWith(`${sum} `));
      if (UPDATE) {
        if (key) delete records[key];
        records[id] = { cacheRev: CACHE_REV, l16CacheRev: L16_CACHE_REV, ...now };
      } else if (!key) problems.push(`${name}: not recorded yet (UPDATE_RECORDS=1)`);
      else problems.push(...checkRecord(name, records[key], now, { cacheRev: CACHE_REV, l16CacheRev: L16_CACHE_REV }));
    });
  }
  if (UPDATE) writeRecords(FILE, records);
  assert.deepEqual(problems, []);
});
