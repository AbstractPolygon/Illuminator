// Running render queue jobs: success, failure, cancel while running (nothing is saved), and the order of several jobs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RenderQueue } from '../app/js/core/renderqueue.js';
import { runNext, assertRunning } from '../app/js/core/queuerun.js';

const started = () => { const q = new RenderQueue(); q.setPaused(false); return q; };
const tick = () => new Promise((r) => setTimeout(r, 0));

test('a job that works is done with its output', async () => {
  const q = started();
  const j = q.add({ name: 'A' });
  const r = await runNext(q, async () => ({ name: 'A.png' }));
  assert.equal(r.job, j);
  assert.deepEqual([j.status, j.output, j.progress], ['done', { name: 'A.png' }, 1]);
  assert.equal(r.failed, false);
});

test('a job that throws is failed with the message, and the queue goes on to the next', async () => {
  const q = started();
  const [a, b] = ['A', 'B'].map((name) => q.add({ name }));
  const r1 = await runNext(q, async () => { throw new Error('no depth'); });
  assert.deepEqual([a.status, a.error, r1.failed], ['failed', 'no depth', true]);
  const r2 = await runNext(q, async () => 'ok');
  assert.equal(r2.job, b);
  assert.equal(b.status, 'done');
});

test('nothing starts when paused, empty, or while one runs', async () => {
  const q = new RenderQueue();
  q.add({ name: 'A' });
  assert.equal(await runNext(q, async () => 1), null, 'paused');
  q.setPaused(false);
  let release;
  const first = runNext(q, () => new Promise((r) => { release = r; }));
  q.add({ name: 'B' });
  assert.equal(await runNext(q, async () => 1), null, 'one at a time');
  release('x');
  await first;
  assert.equal((await runNext(q, async () => 2)).job.spec.name, 'B');
  assert.equal(await runNext(q, async () => 3), null, 'empty');
});

test('cancel while running ends the wait at once, marks it cancelled, and the work that runs on saves nothing', async () => {
  const q = started();
  const j = q.add({ name: 'A' });
  const saved = [];
  let abort = null;
  let finishWork;
  const run = async (job) => {
    await new Promise((r) => { finishWork = r; });
    assertRunning(job);
    saved.push(job.id);
    return 'file';
  };
  const p = runNext(q, run, (fn) => { abort = fn; });
  await tick();
  assert.equal(typeof abort, 'function');
  assert.equal(q.cancel(j.id), true);
  abort();
  const r = await p;
  assert.equal(r.cancelled, true);
  assert.equal(j.status, 'cancelled');
  assert.equal(j.output, null);
  finishWork();
  await tick();
  await tick();
  assert.deepEqual(saved, [], 'the cancelled job did not save');
  assert.equal(j.status, 'cancelled');
});

test('the abort hook is set while running and cleared after', async () => {
  const q = started();
  q.add({ name: 'A' });
  const seen = [];
  await runNext(q, async () => 1, (fn) => seen.push(typeof fn));
  assert.deepEqual(seen, ['function', 'object']);
});

test('a cancel that arrives after the work finished does not undo a done job', async () => {
  const q = started();
  const j = q.add({ name: 'A' });
  await runNext(q, async () => 'out');
  assert.equal(q.cancel(j.id), false);
  assert.equal(j.status, 'done');
});

test('a cancelled waiting job is never started; removing and reordering waiting jobs', async () => {
  const q = started();
  const [a, b, c] = ['A', 'B', 'C'].map((name) => q.add({ name }));
  q.cancel(a.id);
  q.move(c.id, -1);
  const order = [];
  while (await runNext(q, async (job) => { order.push(job.spec.name); })) { /* run all */ }
  assert.deepEqual(order, ['C', 'B']);
  assert.equal(q.remove(a.id), true);
  assert.equal(q.remove(b.id), true);
  assert.deepEqual(q.jobs.map((x) => x.spec.name), ['C']);
});

test('assertRunning throws unless the job is running', () => {
  assert.throws(() => assertRunning({ status: 'cancelled' }), /Cancelled/);
  assert.throws(() => assertRunning({ status: 'waiting' }), /Cancelled/);
  assert.doesNotThrow(() => assertRunning({ status: 'running' }));
});
