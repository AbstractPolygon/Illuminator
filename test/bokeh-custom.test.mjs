// Custom bokeh shapes (Camera > Bokeh > Custom image): an image's white is the shape. A single bright point far out of focus spreads into that shape on the
// processor (core/dof.js) and on the graphics card (DOF_GATHER); the preview ball has it too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { starRgba } from './helpers/bokeh.mjs';
import { BOKEH_IMAGE_SIZE, encodeBokehImage, decodeBokehImage, bokehKernel, bokehBall, applyDepthOfField, maskValue } from '../app/js/core/dof.js';

test('a custom shape is kept as text and read back', () => {
  const text = encodeBokehImage(starRgba());
  assert.ok(text.length > 1000);
  const d = decodeBokehImage(text);
  assert.equal(d.mask.length, BOKEH_IMAGE_SIZE * BOKEH_IMAGE_SIZE);
  // the star covers well under the circle's area
  assert.ok(d.area > 0.2 && d.area < 0.6, `area ${d.area}`);
  assert.equal(encodeBokehImage(new Uint8ClampedArray(BOKEH_IMAGE_SIZE * BOKEH_IMAGE_SIZE * 4)), '', 'all black is no shape');
  const k = bokehKernel({ shape: 'custom', image: text });
  assert.equal(k.kind, 3);
  // without an image Custom is a circle
  assert.equal(bokehKernel({ shape: 'custom', image: '' }).kind, 1);
});

// Light at a tip (up, 0.8 of the radius) and in the gap beside it (36 degrees round, 0.8 of the radius).
function tipAndGap(at, cx, cy, r) {
  const tip = at(cx, Math.round(cy - 0.8 * r));
  const a = Math.PI / 5;
  const gap = at(Math.round(cx + Math.sin(a) * 0.8 * r), Math.round(cy - Math.cos(a) * 0.8 * r));
  return { tip, gap };
}

test('the preview ball and the processor blur take the custom shape', () => {
  const k = bokehKernel({ shape: 'custom', image: encodeBokehImage(starRgba()) });
  const size = 81;
  const ball = bokehBall(k, size, 30);
  const p = tipAndGap((x, y) => ball[y * size + x], 40, 40, 30);
  assert.ok(p.tip > 0.5 && p.gap < 0.05, JSON.stringify(p));

  const w = 96;
  const h = 96;
  const rgb = new Float32Array(w * h * 3);
  const c = 48;
  rgb.fill(50, 3 * (c * w + c), 3 * (c * w + c) + 3);
  const depth = new Float32Array(w * h).fill(1);
  const out = applyDepthOfField(rgb, w, h, depth, w, h, 0, 1, 24, { shape: 'custom', image: encodeBokehImage(starRgba()) });
  const q = tipAndGap((x, y) => out[3 * (y * w + x)], c, c, 24);
  assert.ok(q.tip > 10 * q.gap && q.tip > 0, JSON.stringify(q));
});

test('Star and Heart are drawn shapes with their settings', () => {
  const star = bokehKernel({ shape: 'star', points: 6, inner: 0.3 });
  assert.equal(star.kind, 3);
  assert.equal(star.image, 'star:6:0.300');
  // a thinner star has less area
  assert.ok(bokehKernel({ shape: 'star', points: 6, inner: 0.7 }).area > star.area);
  const heart = bokehKernel({ shape: 'heart', width: 1 });
  assert.equal(heart.kind, 3);
  // the heart's two lobes at the top, its notch between them, its point at the bottom
  const v = (x, y) => maskValue(heart, x, y);
  assert.ok(v(-0.45, -0.4) > 0.9 && v(0.45, -0.4) > 0.9, 'lobes');
  assert.ok(v(0, -0.85) < 0.1, 'notch');
  assert.ok(v(0, 0.75) > 0.5 && v(0.5, 0.75) < 0.1, 'point');
  // the widest heart still fits its square: nothing touches the sides
  const wide = bokehKernel({ shape: 'heart', width: 1.4 });
  const N = BOKEH_IMAGE_SIZE;
  let edge = 0;
  for (let y = 0; y < N; y++) edge += wide.mask[y * N] + wide.mask[y * N + N - 1];
  assert.equal(edge, 0);
});

test('onion rings follow the shape, and the onion skin carries irregularity and spots', async () => {
  const { toDisc, onionMap, ONION_SIZE } = await import('../app/js/core/dof.js');
  // a point on the star's outline lands on the round ball's edge, at a tip and at a notch alike
  const star = bokehKernel({ shape: 'star', points: 5, inner: 0.45, onion: 0.5 });
  const onEdge = (x, y) => Math.hypot(...toDisc(star, x, y));
  assert.ok(Math.abs(onEdge(0, -0.97) - 1) < 0.06, `tip ${onEdge(0, -0.97)}`);
  const a = -Math.PI / 2 + Math.PI / 5;
  assert.ok(Math.abs(onEdge(Math.cos(a) * 0.45, Math.sin(a) * 0.45) - 1) < 0.08, 'notch');
  // the oval's rings are ovals
  const oval = bokehKernel({ shape: 'circle', oval: 0.5, onion: 0.5 });
  assert.ok(Math.abs(Math.hypot(...toDisc(oval, oval.aspect, 0)) - 1) < 1e-6);
  // regular rings are the same all round; irregular ones are not; spots darken parts of the ball
  const ringAt = (m, a) => {
    const vals = [];
    for (let i = 0; i < 64; i++) {
      const t = 0.55;
      const x = Math.round(((Math.cos(a + i * 0.098) * t) * 0.5 + 0.5) * ONION_SIZE);
      const y = Math.round(((Math.sin(a + i * 0.098) * t) * 0.5 + 0.5) * ONION_SIZE);
      vals.push(m.map[y * ONION_SIZE + x]);
    }
    return Math.max(...vals) - Math.min(...vals);
  };
  const regular = onionMap({ onion: 0.8, irregular: 0, blur: 0, spots: 0 });
  const uneven = onionMap({ onion: 0.8, irregular: 1, blur: 0, spots: 0 });
  assert.ok(ringAt(uneven, 0) > 3 * ringAt(regular, 0) + 0.01, `${ringAt(uneven, 0)} vs ${ringAt(regular, 0)}`);
  const dusty = onionMap({ onion: 0, irregular: 0, blur: 0, spots: 1 });
  assert.ok(Math.min(...dusty.map) < 0.7, 'spots darken');
  assert.equal(onionMap({ onion: 0, spots: 0 }), null);
});

test("the ball's character: edge, bubble, hot spot and hole keep the light, and the preview and the processor draw them", async () => {
  const { profileGain, bubbleTint, catEyeAt, ballRGB, bokehBall } = await import('../app/js/core/dof.js');
  const mean = (k, side = 0) => {
    let sum = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      sum += (2 * t * profileGain(k, t, side)) / n;
    }
    return sum;
  };
  for (const opt of [{ edge: 0.8 }, { edge: -0.8 }, { bubble: 1 }, { hot: 1 }, { hole: 0.5 }, { edge: 0.4, edgeFB: 0.5, hot: 0.5 }]) {
    const k = bokehKernel({ shape: 'circle', ...opt });
    assert.ok(Math.abs(mean(k, 1) - 1) < 0.02 && Math.abs(mean(k, -1) - 1) < 0.03, `${JSON.stringify(opt)} keeps the light: ${mean(k, 1)}`);
  }
  const edge = bokehKernel({ shape: 'circle', edge: 0.8 });
  assert.ok(profileGain(edge, 0.97) > 1.4 * profileGain(edge, 0.5), 'a bright rim');
  const dark = bokehKernel({ shape: 'circle', edge: -0.8 });
  assert.ok(profileGain(dark, 0.97) < 0.7 * profileGain(dark, 0.5), 'a dark edge');
  const fb = bokehKernel({ shape: 'circle', edgeFB: 1 });
  assert.ok(profileGain(fb, 0.97, 1) > 1.4 && profileGain(fb, 0.97, -1) < 0.7, 'more rim behind the focus, less in front');
  const hole = bokehKernel({ shape: 'circle', hole: 0.5 });
  assert.ok(profileGain(hole, 0.2) < 0.01 && profileGain(hole, 0.8) > 1, 'a hole');
  // the smooth shape and Optical have none of it
  assert.equal(bokehKernel({ shape: 'smooth', hole: 0.5, catEye: 1 }).hole, 0);
  assert.equal(bokehKernel({ shape: 'optical', edge: 1 }).edge, 0);
  // the soap bubble's rim is colored, its center is not
  const t = bubbleTint(bokehKernel({ shape: 'circle', bubble: 1 }), [0.95, 0], 0.95);
  assert.ok(Math.max(...t) - Math.min(...t) > 0.3, `rainbow rim ${t}`);
  assert.deepEqual(bubbleTint(bokehKernel({ shape: 'circle', bubble: 1 }), [0, 0], 0), [1, 1, 1].map((v, i) => bubbleTint(bokehKernel({ shape: 'circle', bubble: 1 }), [0, 0], 0)[i]));
  // the cat's-eye is none at the center of the frame, and a lens narrow along the direction to the center near the corner
  const cat = bokehKernel({ shape: 'circle', catEye: 1 });
  assert.equal(catEyeAt(cat, 0, 0).c, 0);
  const lens = catEyeAt(cat, 1, 0);
  assert.ok(lens.c > 0.5 && lens.ratio < 0.4 && Math.abs(lens.ux - 1) < 1e-9);
  const size = 81;
  const ball = bokehBall(cat, size, 30, { d: 1, ang: 0 });
  assert.ok(ball[40 * size + 40 + 25] < 0.2 && ball[(40 + 20) * size + 40] > 0.8, 'narrow along the direction to the center (x), long across it (y)');
  // the processor's blur shows the hole: a point of light far out of focus is dark at the center of its ball and lit around it
  const w = 128;
  const rgb = new Float32Array(w * w * 3);
  rgb.fill(50, 3 * (64 * w + 64), 3 * (64 * w + 64) + 3);
  const out = applyDepthOfField(rgb, w, w, new Float32Array(w * w).fill(1), w, w, 0, 1, 40, { shape: 'circle', hole: 0.5 });
  assert.ok(out[3 * (64 * w + 64)] < 0.2 * out[3 * (64 * w + 64 + 30)] && out[3 * (64 * w + 64 + 30)] > 0, 'dark center, lit ring');
  // and the preview's colors: a fringe and a bubble have different channels at the rim
  const rgbBall = ballRGB(bokehKernel({ shape: 'circle', fringe: 1 }), 121, 50, null, 1);
  const edgeIdx = 3 * (60 * 121 + 60 + 48);
  assert.ok(rgbBall[edgeIdx + 1] > 1.5 * rgbBall[edgeIdx], 'green past the rim of red and blue, behind the focus');
});
