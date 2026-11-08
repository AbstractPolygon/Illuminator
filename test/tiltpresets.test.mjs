import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TILT_PRESETS, TILT_PRESET_IDS, tiltPreset } from '../app/js/core/tiltpresets.js';
import { SETTABLE } from '../app/js/ui/api.js';

const html = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');

test('every preset sets real, in-range controls', () => {
  const ranges = {};
  for (const m of html.matchAll(/<input id="([^"]+)" type="range" min="(-?\d+)" max="(-?\d+)"/g)) ranges[m[1]] = [+m[2], +m[3]];
  for (const id of TILT_PRESET_IDS) {
    const p = TILT_PRESETS[id];
    assert.ok(p.name && p.help, id);
    for (const [key, v] of Object.entries(p.values)) {
      if (key === 'fNumber') {
        assert.ok([22, 16, 11, 8, 5.6, 4, 2.8, 2, 1.4, 1, 0.7, 0.5].includes(v), `${id}: f/${v}`);
        continue;
      }
      assert.ok(SETTABLE.has(key), `${id}: ${key} is a saved setting`);
      if (typeof v === 'number') assert.ok(ranges[key] && v >= ranges[key][0] && v <= ranges[key][1], `${id}: ${key}=${v} within ${ranges[key]}`);
    }
  }
});

test('the page offers exactly the presets', () => {
  const offered = [...html.slice(html.indexOf('id="tilt-preset"')).split('</select>')[0].matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]).filter(Boolean);
  assert.deepEqual(offered.sort(), [...TILT_PRESET_IDS].sort());
  assert.equal(tiltPreset('nope'), null);
});
