import test from 'node:test';
import assert from 'node:assert/strict';
import { Timings, speedLimits, reportText, formatDuration } from '../app/js/core/speedreport.js';

test('durations read plainly', () => {
  assert.equal(formatDuration(3.21), '3.2 ms');
  assert.equal(formatDuration(240), '240 ms');
  assert.equal(formatDuration(2500), '2.5 s');
  assert.equal(formatDuration(24000), '24 s');
  assert.equal(formatDuration(135000), '2 min 15 s');
  assert.equal(formatDuration(NaN), '–');
});

test('timings keep the last, best and count of each named stage', () => {
  const t = new Timings();
  t.record('view', 300);
  t.record('view', 120, 'graphics card');
  t.record('view', 200);
  t.record('nonsense', 5);
  t.record('depth', -1);
  const rows = t.rows();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].name, rows[0].count, rows[0].last, rows[0].best, rows[0].where], ['Camera view', 3, 200, 120, 'graphics card']);
});

test('limits name a missing or software graphics card, fallbacks, few cores and the slowest stage', () => {
  const rows = [{ name: 'Full sensor render', count: 1, last: 24000, best: 24000, total: 24000 }];
  const cpu = speedLimits({ renderer: 'CPU', cores: 2, memoryGB: 4 }, rows).map((l) => l.text);
  assert.match(cpu[0], /No graphics card/);
  assert.ok(cpu.some((t) => /Only 2 processor cores/.test(t)));
  assert.ok(cpu.some((t) => /4 GB/.test(t)));
  assert.ok(cpu.some((t) => /slowest stage.*Full sensor render.*24 s/.test(t)));
  const soft = speedLimits({ renderer: 'GPU (SwiftShader)', hardware: false, cores: 8 }, []);
  assert.match(soft[0].text, /software renderer \(SwiftShader\)/);
  const fell = speedLimits({ renderer: 'GPU (RTX)', hardware: true, cores: 8, fallbacks: [['The depth solver', 'out of memory']] }, []);
  assert.match(fell[0].text, /The depth solver stopped on the graphics card.*out of memory/);
  const fine = speedLimits({ renderer: 'GPU (RTX)', hardware: true, cores: 8, memoryGB: 8 }, [{ name: 'Camera view', count: 3, last: 90, best: 80, total: 270 }]);
  assert.deepEqual(fine.map((l) => l.level), ['ok']);
});

test('the report text carries the facts, the stages and the limits', () => {
  const t = new Timings();
  t.record('superRes', 24000, 'graphics card');
  const text = reportText({ version: '0.5.87', platform: 'Linux x86_64', facts: { renderer: 'GPU (RTX 4070)', hardware: true, cores: 16, memoryGB: 8 }, rows: t.rows(), gpuMs: 4.2, photo: 'IMG_0001.lfp' });
  for (const want of ['Illuminator 0.5.87 speed report', 'Rendering: GPU (RTX 4070)', 'Processor cores: 16', 'Full sensor render: 24 s, 24 s, 1×, on the graphics card', 'Graphics time per camera view: 4.2 ms', 'What limits it']) assert.ok(text.includes(want), want);
});
