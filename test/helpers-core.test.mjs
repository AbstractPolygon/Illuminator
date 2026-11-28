import test from 'node:test';
import assert from 'node:assert/strict';
import { boxBlur, bilinear3, clamp, clamp01, crc32, concatBytes, deflate, inflate, l16Luma, parkMiller, smoothstep, smoothstepSafe } from '../app/js/core/helpers.js';

// The plain definition: the mean over the (2r + 1) square, the edge pixels repeated.
function boxMeanDirect(src, w, h, r, channels, stride) {
  const out = new Float64Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < channels; c++) {
        let s = 0;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) s += src[(Math.min(h - 1, Math.max(0, y + dy)) * w + Math.min(w - 1, Math.max(0, x + dx))) * stride + c];
        }
        out[(y * w + x) * stride + c] = s / (2 * r + 1) ** 2;
      }
    }
  }
  return out;
}

test('boxBlur is the mean over a square with the edges repeated, for one value a pixel, RGB and RGBA', () => {
  let seed = 5;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  for (const [channels, stride] of [[1, 1], [3, 3], [3, 4]]) {
    for (const [w, h, r] of [[7, 5, 1], [9, 4, 2], [3, 3, 6], [1, 1, 2]]) {
      const src = Float32Array.from({ length: w * h * stride }, rnd);
      const out = boxBlur(src, w, h, r, { channels, stride });
      assert.ok(out instanceof Float32Array);
      assert.equal(out.length, w * h * stride);
      const want = boxMeanDirect(src, w, h, r, channels, stride);
      for (let i = 0; i < out.length; i++) {
        if (stride > channels && i % stride >= channels) assert.equal(out[i], 0, 'a value not blurred comes out 0');
        else assert.ok(Math.abs(out[i] - want[i]) < 1e-5, `${channels}/${stride} ${w}x${h} r ${r} at ${i}: ${out[i]} vs ${want[i]}`);
      }
    }
  }
});

test('boxBlur: a flat picture stays flat, passes repeat the blur, the source is not changed', () => {
  const flat = new Float32Array(6 * 4).fill(2.5);
  assert.ok(boxBlur(flat, 6, 4, 2).every((v) => v === 2.5));
  const src = Float32Array.from({ length: 3 * 8 * 6 }, (_, i) => (i * 7919) % 13);
  const copy = Float32Array.from(src);
  assert.deepEqual(boxBlur(src, 8, 6, 1, { channels: 3, passes: 2 }), boxBlur(boxBlur(src, 8, 6, 1, { channels: 3 }), 8, 6, 1, { channels: 3 }));
  assert.deepEqual(src, copy);
  // one value a pixel: w * h values, even from a longer array
  assert.equal(boxBlur(new Float32Array(30), 4, 5, 1).length, 20);
});

test('smoothstep, smoothstepSafe, clamp and clamp01', () => {
  assert.equal(smoothstep(0, 1, -1), 0);
  assert.equal(smoothstep(0, 1, 2), 1);
  assert.equal(smoothstep(0, 1, 0.5), 0.5);
  assert.equal(smoothstep(2, 4, 3), 0.5);
  assert.ok(Number.isNaN(smoothstep(1, 1, 1)));
  assert.equal(smoothstepSafe(1, 1, 1), 0);
  assert.equal(smoothstepSafe(1, 1, 2), 1);
  assert.equal(smoothstepSafe(0, 2, 1), smoothstep(0, 2, 1));
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-5, 0, 3), 0);
  assert.equal(clamp(1.5, 0, 3), 1.5);
  assert.equal(clamp01(-0.2), 0);
  assert.equal(clamp01(1.2), 1);
  assert.equal(clamp01(0.25), 0.25);
  assert.ok(Number.isNaN(clamp01(NaN)));
});

test('l16Luma, bilinear3 and parkMiller', () => {
  assert.equal(l16Luma(1, 1, 1), 0.3 + 0.55 + 0.15);
  // a 2 x 2 RGB picture: its center is the mean of the four pixels
  const img = Float32Array.from([0, 10, 20, 2, 12, 22, 4, 14, 24, 6, 16, 26]);
  const o = [0, 0, 0];
  assert.equal(bilinear3(img, 2, 2, 1, 1, o), true);
  assert.deepEqual(o, [3, 13, 23]);
  assert.equal(bilinear3(img, 2, 2, 0.5, 0.5, o), true);
  assert.deepEqual(o, [0, 10, 20]);
  const kept = [9, 9, 9];
  assert.equal(bilinear3(img, 2, 2, 0.4, 1, kept), false);
  assert.equal(bilinear3(img, 2, 2, 1.5, 1, kept), false);
  assert.deepEqual(kept, [9, 9, 9]);
  const a = parkMiller(12345);
  const b = parkMiller(12345);
  const seq = Array.from({ length: 5 }, a);
  assert.deepEqual(Array.from({ length: 5 }, b), seq);
  assert.equal(seq[0], (12345 * 16807) / 2147483647);
  assert.ok(seq.every((v) => v > 0 && v < 1));
});

test('crc32, concatBytes, deflate and inflate', async () => {
  const text = new TextEncoder().encode('123456789');
  assert.equal(crc32(text), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
  assert.equal(crc32(text.subarray(4), crc32(text.subarray(0, 4))), 0xcbf43926);
  assert.deepEqual(concatBytes([text.subarray(0, 2), new Uint8Array(0), text.subarray(2)]), text);
  assert.equal(concatBytes([]).length, 0);
  const big = new Uint8Array(10000).map((_, i) => i % 7);
  const packed = await deflate(big);
  assert.ok(packed.length < big.length);
  assert.deepEqual(await inflate(packed), big);
  assert.deepEqual(await inflate(packed, big.length), big);
  assert.equal(await inflate(packed, big.length - 1), null);
});
