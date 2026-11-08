import test from 'node:test';
import assert from 'node:assert/strict';
import { RenderQueue, uniqueName } from '../app/js/core/renderqueue.js';

test('jobs run one at a time, in order, once started', () => {
  let changes = 0;
  const q = new RenderQueue({ onChange: () => changes++ });
  const a = q.add({ name: 'A' });
  const b = q.add({ name: 'B' }, { kind: 'video', title: 'B video' });
  assert.equal(q.next(), null, 'paused until started');
  q.setPaused(false);
  assert.equal(q.next(), a);
  q.start(a);
  assert.equal(q.next(), null, 'one runs at a time');
  assert.equal(q.running, a);
  q.finish(a, { name: 'A.png' });
  assert.equal(a.status, 'done');
  assert.equal(q.next(), b);
  q.start(b);
  q.fail(b, new Error('no depth'));
  assert.deepEqual([b.status, b.error], ['failed', 'no depth']);
  assert.equal(q.next(), null);
  assert.ok(changes >= 6);
  assert.equal(q.summary(), '1 done, 1 failed');
});

test('cancel, remove, reorder and clear', () => {
  const q = new RenderQueue();
  q.setPaused(false);
  const [a, b, c] = ['A', 'B', 'C'].map((name) => q.add({ name }));
  assert.equal(q.move(c.id, -1), true);
  assert.deepEqual(q.jobs.map((j) => j.spec.name), ['A', 'C', 'B']);
  assert.equal(q.move(a.id, -1), false);
  q.start(a);
  assert.equal(q.remove(a.id), false, 'a running job is cancelled, not removed');
  assert.equal(q.cancel(a.id), true);
  q.fail(a, 'ignored after a cancel');
  assert.equal(a.status, 'cancelled');
  assert.equal(q.cancel(b.id), true);
  assert.equal(q.remove(c.id), true);
  assert.deepEqual(q.counts(), { waiting: 0, running: 0, done: 0, failed: 0, cancelled: 2 });
  q.clearFinished();
  assert.equal(q.jobs.length, 0);
  assert.equal(q.summary(), 'Nothing queued');
});

test('output names do not collide', () => {
  const used = new Set(['IMG_1.png']);
  assert.equal(uniqueName('IMG_2.png', used), 'IMG_2.png');
  assert.equal(uniqueName('IMG_1.png', used), 'IMG_1 (2).png');
  used.add('IMG_1 (2).png');
  assert.equal(uniqueName('IMG_1.png', used), 'IMG_1 (3).png');
});

test('progress only moves forward and a finished job is whole', async () => {
  const q = new RenderQueue();
  q.setPaused(false);
  const j = q.add({ name: 'A' });
  q.setProgress(j, 0.5, 'x');
  assert.equal(j.progress, 0, 'only a running job has progress');
  q.start(j);
  q.setProgress(j, 0.5, 'Measuring depth');
  q.setProgress(j, 0.2, 'Rendering');
  assert.deepEqual([j.progress, j.stage], [0.5, 'Rendering']);
  q.setProgress(j, 7);
  assert.equal(j.progress, 1);
  const k = q.add({ name: 'B' });
  q.start(k);
  q.setProgress(k, 0.4);
  q.finish(k, 'B.png');
  assert.deepEqual([k.progress, k.status], [1, 'done']);
});

test('a job card describes its export settings', async () => {
  const { describeSettings, phasesFor } = await import('../app/js/core/renderqueue.js');
  const photo = { kind: 'photo', edits: { camera: { fstop: 6 }, rendering: {} }, export: { format: 'jpeg', quality: 85, colorSpace: 'p3', size: 2 }, fullSensor: { scale: 2, passes: 1 } };
  assert.deepEqual(describeSettings(photo), ['JPEG 85%', 'Display P3', '2×', 'Full sensor 2×, recovery 1', 'f/2.8']);
  assert.deepEqual(describeSettings({ kind: 'photo', edits: {}, export: { format: 'png', colorSpace: 'srgb', size: 1 }, fullSensor: null }), ['PNG', 'Native size']);
  const video = { kind: 'video', edits: { rendering: { 'video-format': 'mp4', 'video-codec': 'h264', 'video-size': '1080x1920', 'video-quality': 16 } } };
  assert.deepEqual(describeSettings(video), ['MP4 · H.264', '1080 × 1920', '16 Mbit/s']);
  assert.deepEqual(describeSettings({ kind: 'video', edits: { rendering: { 'video-size': '2160' } } }), ['Video', '2160p']);
  for (const spec of [photo, video, { kind: 'photo' }]) assert.ok(Math.abs(phasesFor(spec).reduce((n, p) => n + p.weight, 0) - 1) < 1e-9);
});
