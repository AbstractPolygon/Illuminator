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
