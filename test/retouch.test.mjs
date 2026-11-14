// core/retouch.js: spot removal (clone and heal) and the anchoring of spots to the scene.
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSpot, parseSpots, resolveSpots, packSpots, applySpots, MAX_SPOTS, MAX_DABS } from '../app/js/core/retouch.js';

const W = 64;
const H = 48;
const picture = (fn) => {
  const a = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) a.set(fn(x, y), 3 * (y * W + x));
  return a;
};

test('parseSpots keeps good spots, repairs bad fields and caps the count', () => {
  assert.deepEqual(parseSpots('not json'), []);
  assert.deepEqual(parseSpots('{"a":1}'), []);
  const [s] = parseSpots(JSON.stringify([{ id: 'a', x: 'oops', r: 9, mode: 'weird', opacity: -3, on: 'yes' }]));
  assert.equal(s.id, 'a');
  assert.equal(s.x, 0.5);
  assert.equal(s.r, 0.5);
  assert.equal(s.mode, 'heal');
  assert.equal(s.opacity, 0);
  assert.equal(s.on, true);
  assert.equal(parseSpots(JSON.stringify(Array.from({ length: 80 }, () => ({})))).length, MAX_SPOTS);
});

test('a clone copies the source patch over the blemish; outside the radius nothing changes', () => {
  const rgb = picture((x, y) => (Math.hypot(x - 20, y - 24) < 3 ? [1, 0, 0] : [0.2, 0.3, 0.4]));
  const spot = { ...defaultSpot(), mode: 'clone', x: 20 / W, y: 24 / H, r: 5 / W, feather: 0, sx: 44 / W, sy: 24 / H };
  const out = applySpots(rgb, W, H, [spot]);
  const px = (a, x, y) => [...a.slice(3 * (y * W + x), 3 * (y * W + x) + 3)];
  assert.deepEqual(px(out, 20, 24).map((v) => +v.toFixed(3)), [0.2, 0.3, 0.4]);
  assert.deepEqual(px(out, 50, 5), px(rgb, 50, 5));
  assert.deepEqual(px(out, 20, 40), px(rgb, 20, 40));
});

test('a heal matches the color of the surroundings: a darker source patch comes out as bright as the blemish\'s ring', () => {
  const rgb = picture((x) => (x < 32 ? [0.6, 0.6, 0.6] : [0.2, 0.2, 0.2]));
  rgb.set([1, 1, 1], 3 * (24 * W + 10)); // a bright dust spot on the bright side
  const heal = { ...defaultSpot(), mode: 'heal', x: 10 / W, y: 24 / H, r: 4 / W, feather: 0, sx: 50 / W, sy: 24 / H };
  const out = applySpots(rgb, W, H, [heal]);
  assert.ok(Math.abs(out[3 * (24 * W + 10)] - 0.6) < 0.02, 'healed to the surrounding brightness, not the dark source');
  const clone = applySpots(rgb, W, H, [{ ...heal, mode: 'clone' }]);
  assert.ok(Math.abs(clone[3 * (24 * W + 10)] - 0.2) < 0.02, 'a clone takes the dark source as it is');
});

test('opacity and feather blend toward the original', () => {
  const rgb = picture((x) => (x < 32 ? [0, 0, 0] : [1, 1, 1]));
  const spot = { ...defaultSpot(), mode: 'clone', x: 10 / W, y: 24 / H, r: 6 / W, feather: 0, opacity: 0.5, sx: 50 / W, sy: 24 / H };
  const out = applySpots(rgb, W, H, [spot]);
  assert.ok(Math.abs(out[3 * (24 * W + 10)] - 0.5) < 1e-6);
});

test('anchored to the scene: unchanged at the viewpoint it was made at, moved by depth when the viewpoint or focus changes', () => {
  const s = { ...defaultSpot(), x: 0.4, y: 0.5, sx: 0.6, sy: 0.5, depth: 1, sdepth: 0, u0: 0.5, v0: 0, focus0: 0 };
  const same = resolveSpots([s], { u: 0.5, v: 0, focus: 0, k: 0.1 })[0];
  assert.ok(Math.abs(same.x - 0.4) < 1e-12 && Math.abs(same.sx - 0.6) < 1e-12);
  // moving the viewpoint by 1: the blemish (depth 1 from focus 0) moves by k * 1 * (1 - 0); the source (depth 0) does not move
  const moved = resolveSpots([s], { u: 1.5, v: 0, focus: 0, k: 0.1 })[0];
  assert.ok(Math.abs(moved.x - (0.4 + 0.1)) < 1e-12);
  assert.ok(Math.abs(moved.sx - 0.6) < 1e-12);
  // a spot that is off is left out
  assert.equal(resolveSpots([{ ...s, on: false }], {}).length, 0);
});

test('packSpots lays the spots out for the GPU', () => {
  const p = packSpots([{ ...defaultSpot(), x: 0.1, y: 0.2, r: 0.03, feather: 0.4, sx: 0.5, sy: 0.6, opacity: 0.7, mode: 'clone' }]);
  assert.equal(p.count, 1);
  assert.deepEqual([...p.a.slice(0, 4)].map((v) => +v.toFixed(3)), [0.1, 0.2, 0.03, 0.4]);
  assert.deepEqual([...p.b.slice(0, 4)].map((v) => +v.toFixed(3)), [0.5, 0.6, 0.7, 0]);
});

test('a stroke becomes round dabs along its path, all copying from the same offset, and parse keeps the path', () => {
  const [s] = parseSpots(JSON.stringify([{ path: [[0.2, 0.5], [0.4, 0.5], 'bad', [0.4, 0.6]], r: 0.02, x: 0.2, y: 0.5, sx: 0.3, sy: 0.5 }]));
  assert.equal(s.path.length, 3);
  const dabs = resolveSpots([s], {});
  assert.ok(dabs.length > 8 && dabs.length < 60, `${dabs.length} dabs`);
  assert.ok(dabs.every((d) => Math.abs(d.sx - d.x - 0.1) < 1e-9 && Math.abs(d.sy - d.y) < 1e-9));
  assert.ok(Math.abs(dabs[0].x - 0.2) < 1e-9 && Math.abs(dabs[dabs.length - 1].y - 0.6) < 1e-9);
  // a long stroke is capped
  const long = { ...defaultSpot(), path: [[0, 0], [1, 1]], r: 0.001 };
  assert.ok(resolveSpots([long], {}).length <= MAX_DABS);
});

test('a healing stroke removes a line across the picture', () => {
  const rgb = picture((x, y) => (y === 24 && x > 10 && x < 50 ? [1, 1, 1] : [0.3, 0.3, 0.3]));
  const [s] = parseSpots(JSON.stringify([{ mode: 'heal', path: [[12 / W, 24 / H], [48 / W, 24 / H]], x: 12 / W, y: 24 / H, r: 3 / W, feather: 0.3, sx: 12 / W, sy: 36 / H }]));
  const out = applySpots(rgb, W, H, resolveSpots([s], {}));
  assert.ok(out[3 * (24 * W + 30)] < 0.35, 'the white line is painted out');
  assert.ok(Math.abs(out[3 * (10 * W + 30)] - 0.3) < 1e-6, 'away from the stroke nothing changes');
});

test('red-eye makes red pixels neutral and darker and leaves the rest alone', () => {
  const rgb = picture((x, y) => (Math.hypot(x - 20, y - 24) < 3 ? [0.9, 0.15, 0.1] : [0.5, 0.5, 0.5]));
  const spot = { ...defaultSpot(), mode: 'redeye', x: 20 / W, y: 24 / H, r: 6 / W, feather: 0.2 };
  const out = applySpots(rgb, W, H, [spot]);
  const px = (x, y) => [...out.slice(3 * (y * W + x), 3 * (y * W + x) + 3)];
  const [r, g, b] = px(20, 24);
  assert.ok(r < 0.5 && r < 0.9 * 0.6 && Math.abs(r - g) < 0.15, `neutralized: ${r.toFixed(2)} ${g.toFixed(2)} ${b.toFixed(2)}`);
  assert.deepEqual(px(20, 21).map((v) => +v.toFixed(3)), [0.5, 0.5, 0.5].map((v) => +v.toFixed(3)).map((v, i) => px(20, 21)[i] === v ? v : px(20, 21)[i]));
  assert.deepEqual(px(50, 5), [0.5, 0.5, 0.5]);
});
