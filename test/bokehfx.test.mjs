// Lens effects round bright points (core/bokehfx.js): streaks run along the row, spikes in as many directions as asked, ghosts lie across the frame's center, fog and dirt
// glow round the light, and nothing is added with no bright light or no effect on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fxOptions, applyBokehFx, dirtMap, DIRT_SIZE, brightParts } from '../app/js/core/bokehfx.js';

const W = 200;
const H = 120;
function scene() {
  const rgb = new Float32Array(W * H * 3).fill(0.05);
  for (let y = 58; y < 62; y++) for (let x = 98; x < 102; x++) rgb.fill(1.2, 3 * (y * W + x), 3 * (y * W + x) + 3);
  return rgb;
}
const added = (out, rgb, x, y) => out[3 * (y * W + x) + 1] - rgb[3 * (y * W + x) + 1];

test('no effect, no change; the settings are read and kept in range', () => {
  assert.equal(fxOptions({}), null);
  assert.equal(fxOptions({ fxStreak: 0, fxStar: 0 }), null);
  const rgb = scene();
  assert.equal(applyBokehFx(rgb, W, H, null, 1), rgb);
  assert.equal(fxOptions({ fxSpikes: 99, fxStar: 1 }).spikes, 16);
  assert.equal(fxOptions({ fxSpikes: 1, fxStar: 1 }).spikes, 3);
  // without bright light, the effects add nothing
  const dim = new Float32Array(W * H * 3).fill(0.3);
  const out = applyBokehFx(dim, W, H, fxOptions({ fxStreak: 1, fxStar: 1, fxGhosts: 1, fxFog: 1, fxDirt: 1 }), 1);
  assert.ok(out.every((v, i) => Math.abs(v - dim[i]) < 1e-6));
  assert.ok(brightParts(scene(), W, H, 1).some((v) => v > 0));
});

test('streaks run along the row, spikes in their directions, ghosts across the center', () => {
  const rgb = scene();
  const streak = applyBokehFx(rgb, W, H, fxOptions({ fxStreak: 1 }), 1);
  assert.ok(added(streak, rgb, 140, 60) > 0.02, 'light along the row');
  assert.ok(added(streak, rgb, 140, 60) > 8 * Math.abs(added(streak, rgb, 140, 90)), 'and little off it');
  // bluish
  assert.ok(streak[3 * (60 * W + 140) + 2] - rgb[3 * (60 * W + 140) + 2] > streak[3 * (60 * W + 140)] - rgb[3 * (60 * W + 140)]);
  // six spikes: along the angles 0, 60, 120 ... degrees (the pixel grid's y runs down)
  const star = applyBokehFx(rgb, W, H, fxOptions({ fxStar: 1, fxSpikes: 6 }), 1);
  const onSpike = added(star, rgb, 100 + 30, 60);
  const offSpike = added(star, rgb, 100 + Math.round(30 * Math.cos(Math.PI / 6)), 60 + Math.round(30 * Math.sin(Math.PI / 6)));
  assert.ok(onSpike > 5 * Math.abs(offSpike), `${onSpike} ${offSpike}`);
  // a different number of spikes keeps about the same light
  const sum = (o) => o.reduce((a, v, i) => a + (v - rgb[i]), 0);
  const s3 = sum(applyBokehFx(rgb, W, H, fxOptions({ fxStar: 1, fxSpikes: 3 }), 1));
  const s12 = sum(applyBokehFx(rgb, W, H, fxOptions({ fxStar: 1, fxSpikes: 12 }), 1));
  assert.ok(s3 / s12 > 0.6 && s3 / s12 < 1.7, `${s3} ${s12}`);
  // ghosts: a light off the center of the frame has ghosts along the line through the center
  const bright = new Float32Array(W * H * 3).fill(0.05);
  for (let y = 38; y < 44; y++) for (let x = 138; x < 144; x++) bright.fill(1.3, 3 * (y * W + x), 3 * (y * W + x) + 3);
  const ghosts = applyBokehFx(bright, W, H, fxOptions({ fxGhosts: 1 }), 1);
  // the light at (141, 41) is (41, -19) from the center (100, 60): a ghost at -0.6 of that, (75.4, 71.4)
  assert.ok(added(ghosts, bright, 75, 71) > 0.01, 'a ghost across the center');
  assert.ok(added(ghosts, bright, 30, 100) < 0.2 * added(ghosts, bright, 75, 71), 'and none far from the ghosts');
});

test('fog and dirt glow round the light; the dirt is a fixed pattern', () => {
  const rgb = scene();
  const fog = applyBokehFx(rgb, W, H, fxOptions({ fxFog: 1 }), 1);
  assert.ok(added(fog, rgb, 112, 60) > 0.01 && added(fog, rgb, 112, 60) > added(fog, rgb, 10, 10));
  const dirt = applyBokehFx(rgb, W, H, fxOptions({ fxDirt: 1 }), 1);
  const spread = [];
  for (let x = 90; x < 112; x += 2) spread.push(added(dirt, rgb, x, 66));
  assert.ok(Math.max(...spread) > 0 && Math.max(...spread) > 1.3 * Math.min(...spread), 'a pattern, not a plain glow');
  const m = dirtMap();
  assert.equal(m.length, DIRT_SIZE * DIRT_SIZE);
  assert.ok(Math.min(...m) >= 0 && Math.max(...m) <= 1);
  assert.equal(dirtMap(), m, 'the same every time');
});

test('a streak is smooth along its row at any length, and only points brighter than its threshold streak', () => {
  // (a streak that stepped showed as vertical bands: along the row it falls off smoothly, by the same factor each pixel)
  const rgb = scene();
  for (const len of [0.2, 0.6, 1]) {
    const out = applyBokehFx(rgb, W, H, fxOptions({ fxStreak: 1, fxStreakLen: len }), 1);
    const row = [];
    for (let x = 112; x < 190; x++) row.push(added(out, rgb, x, 60));
    for (let i = 1; i < row.length; i++) {
      assert.ok(row[i] <= row[i - 1] + 1e-6, `length ${len}: rises at ${112 + i}`);
      assert.ok(row[i] > 0.85 * row[i - 1], `length ${len}: steps at ${112 + i}: ${row[i - 1]} -> ${row[i]}`);
    }
    // it is thin: little light a few rows off
    assert.ok(added(out, rgb, 140, 66) < 0.2 * added(out, rgb, 140, 60));
  }
  // a dim light (80% of white) streaks only when the threshold lets it
  const dim = new Float32Array(W * H * 3).fill(0.05);
  for (let y = 58; y < 62; y++) for (let x = 98; x < 102; x++) dim.fill(0.9, 3 * (y * W + x), 3 * (y * W + x) + 3);
  const at = (th) => added(applyBokehFx(dim, W, H, fxOptions({ fxStreak: 1, fxStreakThreshold: th }), 1), dim, 125, 60);
  assert.equal(fxOptions({ fxStreak: 1 }).streakThreshold, 0.7);
  assert.equal(fxOptions({ fxStreak: 1, fxStreakThreshold: 5 }).streakThreshold, 1);
  assert.ok(at(0.3) > at(0.7) && at(0.7) > 0 && at(0.97) === 0, `${at(0.3)} ${at(0.7)} ${at(0.97)}`);
});
