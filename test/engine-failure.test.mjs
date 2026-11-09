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

test('the page sends openSeq with the open request and ignores older echoes', () => {
  const src = readFileSync(new URL('../app/js/main.js', import.meta.url), 'utf8');
  assert.match(src, /engine\.request\('open', \{ \.\.\.args, openSeq: my \}/);
  assert.match(src, /staleSeq\(msg\.openSeq\)/);
});
