import test from 'node:test';
import assert from 'node:assert/strict';
import { gradeParams, applyGrade, zoneWeights, ZONES } from '../app/js/core/grade.js';
import { makeLook, applyLook } from '../app/js/core/color.js';

const zone = (hue = 0, sat = 0, lum = 0) => ({ hue, sat, lum });
const graded = (zones, extra = {}) => gradeParams({ zones, blend: 0.5, balance: 0, ...extra });
const grade = (px, g) => {
  const p = [...px];
  applyGrade(p, g);
  return p;
};
const luma = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];

test('nothing is graded until a wheel has a color or a brightness', () => {
  assert.equal(gradeParams(null), null);
  assert.equal(graded([zone(120, 0, 0), zone(), zone()]), null);
  assert.ok(graded([zone(0, 0.5), zone(), zone()]));
  assert.ok(graded([zone(), zone(0, 0, 0.3), zone()]));
});

test('the zone weights add up to 1, shadows at the dark end, highlights at the bright end', () => {
  const g = graded([zone(0, 1), zone(0, 1), zone(0, 1)]);
  for (const x of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1]) {
    const w = zoneWeights(g, x);
    assert.ok(Math.abs(w[0] + w[1] + w[2] - 1) < 1e-9);
    assert.ok(w.every((v) => v >= -1e-9));
  }
  assert.ok(zoneWeights(g, 0)[0] > 0.99);
  assert.ok(zoneWeights(g, 1)[2] > 0.99);
  assert.ok(zoneWeights(g, 0.5)[1] > 0.9);
});

test('a blue shadow wheel tints dark pixels blue and leaves bright ones alone', () => {
  const g = graded([zone(240, 1), zone(), zone()]);
  const dark = grade([0.02, 0.02, 0.02], g);
  assert.ok(dark[2] > dark[0] * 1.3, `dark ${dark}`);
  const bright = grade([0.8, 0.8, 0.8], g);
  assert.ok(Math.abs(bright[2] - bright[0]) < 0.01, `bright ${bright}`);
});

test('a warm highlight wheel tints bright pixels and not dark ones', () => {
  const g = graded([zone(), zone(), zone(30, 1)]);
  const bright = grade([0.8, 0.8, 0.8], g);
  assert.ok(bright[0] > bright[2], `bright ${bright}`);
  const dark = grade([0.02, 0.02, 0.02], g);
  assert.ok(Math.abs(dark[0] - dark[2]) < 0.002, `dark ${dark}`);
});

test('the tint keeps the light: brightness stays about the same', () => {
  const g = graded([zone(), zone(200, 1), zone()]);
  const mid = [0.18, 0.18, 0.18];
  assert.ok(Math.abs(luma(grade(mid, g)) - luma(mid)) / luma(mid) < 0.08);
});

test('luminance brightens or darkens only its zone', () => {
  const g = graded([zone(0, 0, 0.5), zone(), zone()]);
  assert.ok(luma(grade([0.02, 0.02, 0.02], g)) > 0.02 * 1.5);
  assert.ok(Math.abs(luma(grade([0.8, 0.8, 0.8], g)) - 0.8) < 0.01);
  const dim = graded([zone(), zone(), zone(0, 0, -0.5)]);
  assert.ok(luma(grade([0.8, 0.8, 0.8], dim)) < 0.8);
});

test('balance leans the split: positive makes more of the picture count as highlights', () => {
  const zones = [zone(), zone(), zone(0, 1)];
  const x = 0.55;
  const up = zoneWeights(graded(zones, { balance: 1 }), x)[2];
  const down = zoneWeights(graded(zones, { balance: -1 }), x)[2];
  assert.ok(up > down);
});

test('blending widens the runs between zones', () => {
  const zones = [zone(0, 1), zone(), zone()];
  const soft = zoneWeights(graded(zones, { blend: 1 }), 0.45)[0];
  const hard = zoneWeights(graded(zones, { blend: 0 }), 0.45)[0];
  assert.ok(soft > hard);
});

test('the look takes the grade, and applyLook applies it', () => {
  assert.equal(makeLook({ grade: { zones: [zone(), zone(), zone()], blend: 0.5, balance: 0 } }), null);
  const look = makeLook({ grade: { zones: [zone(240, 1), zone(), zone()], blend: 0.5, balance: 0 } });
  assert.ok(look && look.grade);
  const p = [0.02, 0.02, 0.02];
  applyLook(p, look);
  assert.ok(p[2] > p[0]);
  assert.equal(ZONES.length, 3);
});
