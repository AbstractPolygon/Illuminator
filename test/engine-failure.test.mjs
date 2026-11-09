// The engine when its worker breaks: waiting requests fail at once, the page is told, and the next request starts a new worker.
import { createOpenSequencer } from '../app/js/core/openseq.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const made = [];
globalThis.Worker = class {
  constructor() {
    this.posted = [];
    this.terminated = false;
    made.push(this);
  }
  postMessage(msg) { this.posted.push(msg); }
  terminate() { this.terminated = true; }
};
const { Engine } = await import('../app/js/engine.js');

test('a worker error rejects every pending request and tells the page', async () => {
  made.length = 0;
  const engine = new Engine();
  let lost = null;
  engine.onWorkerLost = (m) => { lost = m; };
  const a = engine.request('open', {});
  const b = engine.request('view', {});
  made[0].onerror({ message: 'boom' });
  await assert.rejects(a, /boom/);
  await assert.rejects(b, /boom/);
  assert.equal(engine.pending.size, 0);
  assert.equal(lost, 'boom');
  assert.ok(made[0].terminated);
});

test('a message error does the same, and the next request recreates the worker', async () => {
  made.length = 0;
  const engine = new Engine();
  let recreated = 0;
  engine.onRecreate = () => { recreated++; };
  const a = engine.request('open', {});
  made[0].onmessageerror({});
  await assert.rejects(a, /could not be read/);
  const b = engine.request('view', { x: 1 });
  assert.equal(made.length, 2);
  assert.equal(recreated, 1);
  assert.equal(made[1].posted[0].type, 'view');
  // (the old worker's late messages are ignored)
  made[0].onmessage({ data: { id: 2, type: 'result', result: 'stale' } });
  made[1].onmessage({ data: { id: made[1].posted[0].id, type: 'result', result: 'ok' } });
  assert.equal(await b, 'ok');
});

test('the engine hands the open request to the worker with its openSeq, and messages of the worker carry it back', () => {
  made.length = 0;
  const engine = new Engine();
  engine.request('open', { bytes: null, openSeq: 7 });
  assert.equal(made[0].posted[0].type, 'open');
  assert.equal(made[0].posted[0].openSeq, 7);
});

// The page's openSeq counter is core/openseq.js (behavior tests in test/openseq.test.mjs); this keeps main.js wired to it and sending the number with the open request.
test('the page treats an older openSeq as stale and accepts equal, newer and missing ones', () => {
  const src = readFileSync(new URL('../app/js/main.js', import.meta.url), 'utf8');
  assert.match(src, /^const staleSeq = \(n\) => openSeq\.isStale\(n\);$/m);
  const seq = createOpenSequencer();
  for (let i = 0; i < 5; i++) seq.next();
  assert.equal(seq.isStale(4), true);
  assert.equal(seq.isStale(0), true);
  assert.equal(seq.isStale(5), false);
  assert.equal(seq.isStale(6), false);
  assert.equal(seq.isStale(undefined), false);
  assert.equal(seq.isStale(null), false);
  assert.match(src, /engine\.request\('open', \{ \.\.\.args, openSeq: my \}/);
});
