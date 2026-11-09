// The engine when its worker breaks: waiting requests fail at once, the page is told, and the next request starts a new worker.
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

// staleSeq lives inside main.js (it closes over the page's openSeq counter and the module cannot be imported without the whole page), so its text is taken from the
// source and run here: the behavior is tested, not just the wording. Moving it to a small module (for example app/js/core/openseq.js exporting staleSeq(n, current))
// would let this import it; worker.js's guards (newestOpenSeq, superseded in open()) are inside the worker file in the same way and have no pure helper to test.
test('the page treats an older openSeq as stale and accepts equal, newer and missing ones', () => {
  const src = readFileSync(new URL('../app/js/main.js', import.meta.url), 'utf8');
  const m = src.match(/^const staleSeq = (\(n\) => [^;\n]+);$/m);
  assert.ok(m, 'staleSeq was not found in main.js in the expected one-line form');
  const make = (openSeq) => new Function('openSeq', `return ${m[1]};`)(openSeq);
  const stale = make(5);
  assert.equal(stale(4), true);
  assert.equal(stale(0), true);
  assert.equal(stale(5), false);
  assert.equal(stale(6), false);
  assert.equal(stale(undefined), false);
  assert.equal(stale(null), false);
  assert.match(src, /engine\.request\('open', \{ \.\.\.args, openSeq: my \}/);
});
