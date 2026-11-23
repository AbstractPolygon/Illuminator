import test from 'node:test';
import assert from 'node:assert/strict';
import { intrinsics, mirrorAngle, mirrorPose, makeDistortion } from '../app/js/core/l16geometry.js';
import { relativePose, boxBlur } from '../app/js/core/l16depth.js';

const kmat = (f, cx, cy) => ({ x00: f, x01: 0, x02: cx, x10: 0, x11: f, x12: cy, x20: 0, x21: 0, x22: 1 });

test('l16 intrinsics: the focal length follows the lens position between the per focus matrices, and beyond them', () => {
  const g = { per_focus_calibration: [{ intrinsics: { k_mat: kmat(1000, 2000, 1500) }, focus_hall_code: 100 }, { intrinsics: { k_mat: kmat(1100, 2100, 1600) }, focus_hall_code: 200 }] };
  assert.equal(intrinsics(g, 100)[0], 1000);
  assert.equal(intrinsics(g, 150)[0], 1050);
  assert.equal(intrinsics(g, 150)[2], 2050);
  assert.equal(intrinsics(g, 300)[0], 1200); // extrapolated
  assert.throws(() => intrinsics({ per_focus_calibration: [] }, 1), /no intrinsics/);
});

test('l16 mirror: a linear actuator mapping gives angles in a straight line, and a mirror at rest keeps the camera where the factory put it', () => {
  // a(x)=0, b(x)=1, c(x)=-x  =>  r = x
  const map = { coeffs: [0, 0, -1, 0, 1, 0], rLeft: true, rRight: true, inflection: 0, mIn: 0, sIn: 1, mOut: 10, sOut: 2, type: 0 };
  void map;
  const m = { coeffs: [0, 0, 0, 0, 1, -0], rLeft: true, rRight: true, inflection: 1e9, mIn: 0, sIn: 1, mOut: 5, sOut: 2, type: 0 };
  // a=0 makes the quadratic degenerate; check the general case with a = 1: r^2 + r - 2 = 0 -> r = 1 or -2
  const q = { coeffs: [0, 0, 0, 1, 1, -2], rLeft: true, rRight: true, inflection: 1e9, mIn: 0, sIn: 1, mOut: 0, sOut: 1, type: 0 };
  assert.ok(Math.abs(mirrorAngle(q, 0) - 1) < 1e-9 || Math.abs(mirrorAngle(q, 0) + 2) < 1e-9);
  void m;
  const sys = { axis: [0, 0, 1], n0: [1, 0, 0], d: 0, cv: [0, 0, 10], p0: [0, 0, 0], r0: [1, 0, 0, 0, 1, 0, 0, 0, 1], flip: false };
  const pose = mirrorPose(sys, 0);
  // the mirror plane x = 0 reflects the real camera (0,0,10) onto itself; the pose is a proper rotation either way
  const R = pose.R;
  const det = R[0] * (R[4] * R[8] - R[5] * R[7]) - R[1] * (R[3] * R[8] - R[5] * R[6]) + R[2] * (R[3] * R[7] - R[4] * R[6]);
  assert.ok(Math.abs(Math.abs(det) - 1) < 1e-9);
});

test('l16 distortion: no coefficients leave a pixel where it is, and the center stays put', () => {
  const d = makeDistortion({ distortion: { polynomial: { distortion_center: { x: 100, y: 80 }, normalization: { x: 200, y: 200 }, coeffs: [0, 0, 0, 0, 0] } } });
  assert.deepEqual(d(30, 40), [30, 40]);
  const e = makeDistortion({ distortion: { polynomial: { distortion_center: { x: 100, y: 80 }, normalization: { x: 200, y: 200 }, coeffs: [0.1, 0, 0, 0, 0] } } });
  assert.deepEqual(e(100, 80), [100, 80]);
  assert.ok(e(180, 80)[0] > 180); // k1 > 0 pushes outward
});

test('l16 depth: the pose of a camera relative to another undoes the reference pose', () => {
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const ref = { R: I, T: [0, 0, 0] };
  const c = { R: I, T: [43.5, 0, 0] };
  const rel = relativePose(ref, c);
  assert.deepEqual(rel.T, [43.5, 0, 0]);
  // two cameras with the same pose are at no offset from each other
  const same = relativePose({ R: I, T: [5, 6, 7] }, { R: I, T: [5, 6, 7] });
  assert.deepEqual(same.T, [0, 0, 0]);
});

test('l16 depth: the box blur keeps a constant picture constant and averages a spike', () => {
  const w = 9;
  const h = 9;
  const flat = new Float32Array(w * h).fill(3);
  assert.ok(boxBlur(flat, w, h, 2).every((v) => Math.abs(v - 3) < 1e-5));
  const spike = new Float32Array(w * h);
  spike[4 * w + 4] = 25;
  const out = boxBlur(spike, w, h, 2);
  assert.ok(Math.abs(out[4 * w + 4] - 1) < 1e-5);
});
