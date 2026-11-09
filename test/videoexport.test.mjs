import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_VIDEO_FRAMES, playOrder, frameTime, frameAtTime, frameWait, recordFrames } from '../app/js/core/videoexport.js';
import { frameCount } from '../app/js/core/keyframes.js';

test('exact frame counts for a duration at 24, 29.97 and 60 fps', () => {
  assert.equal(frameCount({ length: 2 }, 24), 49);
  assert.equal(frameCount({ length: 2 }, 30000 / 1001), 61);
  assert.equal(frameCount({ length: 2 }, 60), 121);
  assert.equal(frameCount({ length: 10 }, 30000 / 1001), 301);
  assert.equal(frameCount({ length: 1 / 24 }, 24), 2);
});

test('first and last frame times', () => {
  for (const fps of [24, 30000 / 1001, 60]) {
    const n = frameCount({ length: 3 }, fps);
    assert.equal(frameTime(0, fps), 0);
    assert.ok(Math.abs(frameTime(n - 1, fps) - 3) < 0.5 / fps, `last frame within half a frame of the end at ${fps}`);
  }
});

test('a keyframe time maps to its frame and back for whole frames', () => {
  for (const fps of [24, 30000 / 1001, 60]) {
    for (const i of [0, 1, 17, 100]) assert.equal(frameAtTime(frameTime(i, fps), fps), i);
  }
  assert.equal(frameAtTime(undefined, 24), 0);
  assert.equal(frameAtTime(null, 24), 0);
  assert.equal(frameAtTime(0.5, 24), 12);
});

test('a zero-length animation is one frame, which is not enough for a video', () => {
  assert.equal(frameCount({ length: 0 }, 24), 1);
  assert.ok(frameCount({ length: 0 }, 24) < MIN_VIDEO_FRAMES);
  assert.deepEqual(playOrder(0, 'loop'), []);
});

test('play order: a loop is forward twice; ping-pong does not repeat the end frames', () => {
  assert.deepEqual(playOrder(3, 'loop'), [0, 1, 2, 0, 1, 2]);
  assert.deepEqual(playOrder(4, 'pingpong'), [0, 1, 2, 3, 2, 1]);
  assert.deepEqual(playOrder(2, 'pingpong'), [0, 1]);
  assert.deepEqual(playOrder(3, undefined), [0, 1, 2, 0, 1, 2]);
});

test('frameWait: on the beat, never negative', () => {
  assert.equal(frameWait(1000, 0, 24, 1000), 0);
  assert.ok(Math.abs(frameWait(1000, 24, 24, 1000) - 1000) < 1e-9);
  assert.equal(frameWait(1000, 1, 24, 5000), 0);
});

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } };
}

test('recordFrames emits every frame once, in order, on the beat', async () => {
  const c = clock();
  const times = [];
  const order = playOrder(3, 'loop');
  const r = await recordFrames(order, { fps: 30000 / 1001, now: c.now, sleep: c.sleep, prepare: async (n, i) => i, emit: (v, n) => times.push([n, v, c.now()]) });
  assert.deepEqual(r, { cancelled: false, emitted: 6 });
  assert.deepEqual(times.map((x) => x[1]), order);
  times.forEach(([n, , t]) => assert.ok(Math.abs(t - (n * 1001) / 30) < 1e-6));
});

test('a slow frame is emitted late without waiting, and the next one is still on the beat', async () => {
  const c = clock();
  const emitted = [];
  await recordFrames([0, 1, 2], { fps: 10, now: c.now, sleep: c.sleep, prepare: async (n) => { if (n === 1) c.advance(250); }, emit: (v, n) => emitted.push([n, c.now()]) });
  assert.deepEqual(emitted, [[0, 0], [1, 250], [2, 250]]);
});

test('cancel before the loop emits nothing and prepares nothing', async () => {
  const c = clock();
  let prepared = 0;
  let emitted = 0;
  const r = await recordFrames([0, 1, 2], { fps: 24, now: c.now, sleep: c.sleep, cancelled: () => true, prepare: async () => { prepared++; }, emit: () => { emitted++; } });
  assert.deepEqual(r, { cancelled: true, emitted: 0 });
  assert.equal(prepared + emitted, 0);
});

test('cancel in the middle stops the loop, and the frame prepared meanwhile is discarded, not emitted', async () => {
  const c = clock();
  let cancel = false;
  const emitted = [];
  const discarded = [];
  const prepared = [];
  const r = await recordFrames([0, 1, 2, 3, 4], {
    fps: 24, now: c.now, sleep: c.sleep, cancelled: () => cancel,
    prepare: async (n) => { prepared.push(n); if (n === 2) cancel = true; return n; },
    emit: (v) => emitted.push(v), discard: (v) => discarded.push(v),
  });
  assert.deepEqual(r, { cancelled: true, emitted: 2 });
  assert.deepEqual(emitted, [0, 1]);
  assert.deepEqual(discarded, [2]);
  assert.deepEqual(prepared, [0, 1, 2]);
});

test('a failing frame rejects without emitting later frames', async () => {
  const c = clock();
  const emitted = [];
  await assert.rejects(recordFrames([0, 1, 2], { fps: 24, now: c.now, sleep: c.sleep, prepare: async (n) => { if (n === 1) throw new Error('decode'); return n; }, emit: (v) => emitted.push(v) }), /decode/);
  assert.deepEqual(emitted, [0]);
});

import { cancelControl } from '../app/js/core/videoexport.js';

test('cancel arriving right at the last frame: the loop reports it done, the control still counts it as stopped', async () => {
  const c = clock();
  const state = {};
  const cancel = cancelControl(state);
  cancel.begin();
  const r = await recordFrames([0, 1, 2], { fps: 24, now: c.now, sleep: c.sleep, cancelled: cancel.isRequested, prepare: async (n) => n, emit: (v) => { if (v === 2) cancel.request(); } });
  assert.deepEqual(r, { cancelled: false, emitted: 3 });
  assert.equal(cancel.stopped(r), true);
});

test('cancel during the last frame wait discards that frame', async () => {
  const c = clock();
  const cancel = cancelControl({});
  const emitted = [];
  const r = await recordFrames([0, 1, 2], { fps: 24, now: c.now, sleep: async (ms) => { c.advance(ms); }, cancelled: cancel.isRequested, prepare: async (n) => { if (n === 2) cancel.request(); return n; }, emit: (v) => emitted.push(v) });
  assert.equal(r.cancelled, true);
  assert.deepEqual(emitted, [0, 1]);
});

test('a cancelled run never reaches the save step; a finished one does', async () => {
  const c = clock();
  const saved = [];
  const run = async (cancelAt) => {
    const cancel = cancelControl(state);
    cancel.begin();
    const r = await recordFrames([0, 1, 2, 3], { fps: 24, now: c.now, sleep: c.sleep, cancelled: cancel.isRequested, prepare: async (n) => { if (n === cancelAt) cancel.request(); return n; }, emit: () => {} });
    if (cancel.stopped(r)) return;
    saved.push('file');
  };
  const state = {};
  await run(1);
  assert.deepEqual(saved, []);
  await run(-1);
  assert.deepEqual(saved, ['file']);
});

test('the flag is cleared when the next run begins', () => {
  const state = { cancelVideo: true };
  const cancel = cancelControl(state);
  assert.equal(cancel.isRequested(), true);
  cancel.begin();
  assert.equal(state.cancelVideo, false);
  assert.equal(cancel.stopped({ cancelled: false }), false);
});
