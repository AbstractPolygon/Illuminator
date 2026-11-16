import test from 'node:test';
import assert from 'node:assert/strict';
import { HIST_ZONES, zoneAt, draggedValue } from '../app/js/ui/histedit.js';

test('the histogram is five zones, dark to light, covering it all', () => {
  assert.deepEqual(HIST_ZONES.map((z) => z.name), ['Blacks', 'Shadows', 'Exposure', 'Highlights', 'Whites']);
  for (let i = 1; i < HIST_ZONES.length; i++) assert.equal(HIST_ZONES[i].from, HIST_ZONES[i - 1].to);
  assert.equal(zoneAt(0).id, 'tone-blacks');
  assert.equal(zoneAt(0.5).id, 'ev');
  assert.equal(zoneAt(0.95).id, 'tone-whites');
  assert.equal(zoneAt(1).id, 'tone-whites');
});

test('a drag across the whole width sweeps the whole range, kept to the steps and the ends', () => {
  const tone = { min: '-100', max: '100', step: '1' };
  assert.equal(draggedValue(tone, 0, 0.25), 50);
  assert.equal(draggedValue(tone, 80, 0.5), 100);
  assert.equal(draggedValue(tone, 0, -0.1), -20);
  const ev = { min: '-3', max: '3', step: '0.05' };
  assert.ok(Math.abs(draggedValue(ev, 0, 0.1) - 0.6) < 1e-9);
  assert.ok(Math.abs(draggedValue(ev, 0, 0.012) - 0.05) < 1e-9);
});
