// Open-photo sequencing: the page's sequencer, the worker's stale guard, the restoring counter, and the job guard for long worker jobs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenSequencer, createStaleGuard } from '../app/js/core/openseq.js';
import { makeJobGuard } from '../app/js/core/jobguard.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

test('an older seq is stale; equal, newer and missing are accepted', () => {
  const s = createOpenSequencer();
  s.next(); s.next(); s.next();
  assert.equal(s.current(), 3);
  assert.equal(s.isStale(2), true);
  assert.equal(s.isStale(3), false);
  assert.equal(s.isStale(4), false);
  assert.equal(s.isStale(undefined), false);
  assert.equal(s.isStale(null), false);
});

test('overlapping opens: the earlier one sees it is superseded after every await', async () => {
  const s = createOpenSequencer();
  const seen = [];
  async function open(name, steps) {
    const my = s.next();
    for (let i = 0; i < steps; i++) {
      await tick();
      if (s.superseded(my)) { seen.push(`${name}@${i}`); return 'stale'; }
    }
    return 'done';
  }
  const b = open('B', 3);
  await tick();
  const c = open('C', 3);
  assert.deepEqual(await Promise.all([b, c]), ['stale', 'done']);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^B@/);
});

test('closing the photo (next without an open) strands the running open', async () => {
  const s = createOpenSequencer();
  const my = s.next();
  await tick();
  s.next();
  assert.equal(s.superseded(my), true);
});

test('the restoring counter ends only when every restore has ended, and never goes negative', () => {
  const s = createOpenSequencer();
  assert.equal(s.restoring(), 0);
  s.beginRestore(); s.beginRestore();
  assert.equal(s.endRestore(), 1);
  assert.ok(s.restoring() > 0);
  assert.equal(s.endRestore(), 0);
  assert.equal(s.endRestore(), 0);
  assert.equal(s.restoring(), 0);
  assert.equal(s.beginRestore(), 1);
});

test('overlapping restores keep the counter up until the last finishes', async () => {
  const s = createOpenSequencer();
  const states = [];
  const restore = async (n) => { s.beginRestore(); try { await tick(); if (n) await tick(); } finally { s.endRestore(); } };
  const a = restore(1);
  const b = restore(0);
  await b;
  states.push(s.restoring());
  await a;
  states.push(s.restoring());
  assert.deepEqual(states, [1, 0]);
});

test('a failing restore still ends its count', async () => {
  const s = createOpenSequencer();
  await assert.rejects((async () => { s.beginRestore(); try { throw new Error('x'); } finally { s.endRestore(); } })());
  assert.equal(s.restoring(), 0);
});

const STALE = 'This photo was replaced by one opened after it.';

test('the worker refuses an open older than one already received', () => {
  const g = createStaleGuard(STALE);
  g.begin(5);
  assert.throws(() => g.begin(4), { message: STALE });
  assert.equal(g.newest(), 5);
  assert.doesNotThrow(() => g.begin(5));
  assert.doesNotThrow(() => g.begin(6));
});

test('an open without a seq is always accepted and is superseded only by a newer begin', () => {
  const g = createStaleGuard(STALE);
  const a = g.begin(null);
  assert.equal(a.superseded(), false);
  const b = g.begin(null);
  assert.equal(a.superseded(), true);
  assert.throws(() => a.check(), { message: STALE });
  assert.doesNotThrow(() => b.check());
});

test('an open overtaken while it waits stops at its next check', async () => {
  const g = createStaleGuard(STALE);
  const first = g.begin(1);
  await tick();
  const second = g.begin(2);
  assert.throws(() => first.check(), { message: STALE });
  assert.doesNotThrow(() => second.check());
});

test('cache messages for an older seq are dropped by the page', () => {
  const s = createOpenSequencer();
  const applied = [];
  const onCache = (msg) => { if (s.isStale(msg.openSeq)) return; applied.push(msg.photoId); };
  const a = s.next();
  const b = s.next();
  onCache({ photoId: 'A', openSeq: a });
  onCache({ photoId: 'B', openSeq: b });
  onCache({ photoId: 'legacy' });
  assert.deepEqual(applied, ['B', 'legacy']);
});

test('job guard: stale once the live value changes during an awaited promise', async () => {
  const state = { sampler: { id: 1 }, lf: { id: 1 } };
  const job = makeJobGuard(() => state.sampler);
  const lfJob = makeJobGuard(() => state.lf);
  assert.equal(job.stale(), false);
  assert.equal(job.current(), true);
  await Promise.resolve().then(() => { state.sampler = { id: 2 }; });
  assert.equal(job.stale(), true);
  assert.equal(job.current(), false);
  assert.throws(() => job.throwIfStale(), /changed/);
  assert.throws(() => job.throwIfStale('gone'), { message: 'gone' });
  assert.equal(lfJob.stale(), false);
  assert.doesNotThrow(() => lfJob.throwIfStale());
});

test('job guard: a value that is cleared and set back to the same object is not stale; a new object is', () => {
  const lf = {};
  const state = { lf };
  const job = makeJobGuard(() => state.lf);
  state.lf = null;
  assert.equal(job.stale(), true);
  state.lf = lf;
  assert.equal(job.stale(), false);
});
