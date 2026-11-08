import test from 'node:test';
import assert from 'node:assert/strict';
import { CAMERA_MOVES, cameraMove } from '../app/js/core/camerapresets.js';
import { emptyAnimation, setKey, valueAt, sample, hasKeys } from '../app/js/core/keyframes.js';
import fs from 'node:fs';

test('every move in the list makes keyframes of the right length, and the panel offers each of them', () => {
  const html = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
  for (const m of CAMERA_MOVES) {
    const a = cameraMove(m.id, { radius: 4, length: 5 });
    assert.ok(a, m.id);
    assert.equal(a.length, 5);
    assert.ok(hasKeys(a), m.id);
    for (const track of ['view', 'zoom', 'panX', 'panY']) for (const k of a.tracks[track]) assert.ok(k.t >= 0 && k.t <= 5 + 1e-9, `${m.id} ${track} ${k.t}`);
    assert.ok(html.includes(`<option value="${m.id}">${m.name}</option>`), `the list in the panel has ${m.id}`);
  }
  assert.equal(cameraMove('nonsense'), null);
});

test('the viewpoint stays within the photo\'s range, and the looping moves end where they start', () => {
  const radius = 4.5;
  for (const m of CAMERA_MOVES) {
    const a = cameraMove(m.id, { radius, length: 4 });
    for (const k of a.tracks.view) assert.ok(Math.hypot(k.v[0], k.v[1]) <= radius * 0.85 + 1e-9, `${m.id} view ${k.v}`);
  }
  for (const id of ['orbit', 'parallax', 'float']) {
    const a = cameraMove(id, { radius, length: 4 });
    const first = valueAt(a, 'view', 0);
    const last = valueAt(a, 'view', 4);
    assert.ok(Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6, `${id} loops`);
  }
});

test('push and pull zoom in opposite directions, pan moves the pan track, and only the camera tracks are replaced', () => {
  const push = cameraMove('push', { length: 4 });
  const pull = cameraMove('pull', { length: 4 });
  assert.ok(valueAt(push, 'zoom', 4) > valueAt(push, 'zoom', 0));
  assert.ok(valueAt(pull, 'zoom', 4) < valueAt(pull, 'zoom', 0));
  const pan = cameraMove('pan', { length: 4 });
  assert.ok(valueAt(pan, 'panX', 4) > valueAt(pan, 'panX', 0));
  // another track of the animation is kept; the camera tracks it had are replaced
  const base = emptyAnimation();
  setKey(base, 'aperture', 1, 3);
  setKey(base, 'zoom', 2, 2.5);
  const made = cameraMove('orbit', { length: 4, base });
  assert.equal(made.tracks.aperture.length, 1);
  assert.equal(valueAt(made, 'zoom', 2), 1);
  // the frames of an orbit sample into a circle
  const frames = sample(made, 24);
  assert.ok(frames.length >= 96 && frames.every((f) => Array.isArray(f.view)));
});
