import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { COLOR_SPACE_IDS, convertRgba8, convertRgb16, iccProfile, colorantsD50, tagPng, tagJpeg } from '../app/js/core/colorspace.js';
import { encodePng16 } from '../app/js/core/png16.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test('sRGB colorants adapted to D50 are the standard ones', () => {
  const m = colorantsD50('srgb');
  const want = [[0.43607, 0.38515, 0.14307], [0.22249, 0.71687, 0.06061], [0.01392, 0.09708, 0.7141]];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) near(m[r][c], want[r][c], 0.0006, `colorant ${r}${c}`);
});

test('white stays white, black stays black, and sRGB is left alone', () => {
  for (const id of COLOR_SPACE_IDS) {
    const px = Uint8ClampedArray.of(255, 255, 255, 255, 0, 0, 0, 255);
    convertRgba8(px, id);
    assert.deepEqual([...px], [255, 255, 255, 255, 0, 0, 0, 255], id);
  }
  const px = Uint8ClampedArray.of(10, 120, 250, 77);
  convertRgba8(px, 'srgb');
  assert.deepEqual([...px], [10, 120, 250, 77]);
});

test('sRGB red in Display P3 is the known value; alpha is untouched', () => {
  const px = Uint8ClampedArray.of(255, 0, 0, 200);
  convertRgba8(px, 'p3');
  near(px[0], 234, 1, 'r');
  near(px[1], 51, 1, 'g');
  near(px[2], 35, 1, 'b');
  assert.equal(px[3], 200);
});

test('grays keep their lightness: a gray in Adobe RGB follows its gamma', () => {
  const px = Uint8ClampedArray.of(128, 128, 128, 255);
  convertRgba8(px, 'adobe');
  const linear = ((128 / 255 + 0.055) / 1.055) ** 2.4;
  near(px[0], 255 * linear ** (1 / (563 / 256)), 1, 'gray');
  assert.equal(px[0], px[1]);
  assert.equal(px[1], px[2]);
});

test('16-bit conversion agrees with 8-bit one', () => {
  const rgb8 = Uint8ClampedArray.of(200, 60, 30, 255, 20, 180, 90, 255);
  const rgb16 = Uint16Array.of(200 * 257, 60 * 257, 30 * 257, 20 * 257, 180 * 257, 90 * 257);
  for (const id of ['p3', 'adobe', 'rec2020', 'prophoto']) {
    const a = Uint8ClampedArray.from(rgb8);
    const b = Uint16Array.from(rgb16);
    convertRgba8(a, id);
    convertRgb16(b, id);
    near(b[0] / 257, a[0], 0.6, `${id} r`);
    near(b[1] / 257, a[1], 0.6, `${id} g`);
    near(b[2] / 257, a[2], 0.6, `${id} b`);
    near(b[3] / 257, a[4], 0.6, `${id} r2`);
    near(b[4] / 257, a[5], 0.6, `${id} g2`);
    near(b[5] / 257, a[6], 0.6, `${id} b2`);
  }
});

test('the ICC profiles are well formed', () => {
  for (const id of COLOR_SPACE_IDS) {
    const p = iccProfile(id);
    const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
    assert.equal(v.getUint32(0), p.length, `${id} size`);
    assert.equal(String.fromCharCode(...p.subarray(36, 40)), 'acsp');
    assert.equal(p.length % 4, 0);
    const n = v.getUint32(128);
    const sigs = [];
    for (let i = 0; i < n; i++) {
      const row = 132 + 12 * i;
      sigs.push(String.fromCharCode(...p.subarray(row, row + 4)));
      assert.ok(v.getUint32(row + 4) + v.getUint32(row + 8) <= p.length, `${id} tag ${i} inside the file`);
    }
    for (const want of ['desc', 'cprt', 'wtpt', 'rXYZ', 'gXYZ', 'bXYZ', 'rTRC', 'gTRC', 'bTRC']) assert.ok(sigs.includes(want), `${id} has ${want}`);
  }
  // The red colorant of sRGB.
  const p = iccProfile('srgb');
  const v = new DataView(p.buffer);
  const row = 132 + 12 * 3;
  const o = v.getUint32(row + 4);
  near(v.getInt32(o + 8) / 65536, 0.43607, 0.0006, 'rXYZ x');
});

test('a PNG gets the profile in an iCCP chunk instead of sRGB', async () => {
  const png = await encodePng16(new Uint16Array(4 * 4 * 3).fill(30000), 4, 4);
  const types = (bytes) => {
    const out = [];
    const v = new DataView(bytes.buffer, bytes.byteOffset);
    for (let at = 8; at < bytes.length; at += 12 + v.getUint32(at)) out.push(String.fromCharCode(...bytes.subarray(at + 4, at + 8)));
    return out;
  };
  assert.ok(types(png).includes('sRGB'));
  const tagged = await tagPng(png, 'p3');
  assert.deepEqual(types(tagged), ['IHDR', 'iCCP', 'IDAT', 'IEND']);
  // The chunk holds the deflated profile.
  const v = new DataView(tagged.buffer, tagged.byteOffset);
  const at = 8 + 12 + 13;
  const len = v.getUint32(at);
  const data = tagged.subarray(at + 8, at + 8 + len);
  const nameEnd = data.indexOf(0);
  assert.equal(String.fromCharCode(...data.subarray(0, nameEnd)), 'Display P3');
  assert.deepEqual([...zlib.inflateSync(data.subarray(nameEnd + 2))], [...iccProfile('p3')]);
  // sRGB is left as it was.
  assert.equal(await tagPng(png, 'srgb'), png);
});

test('a JPEG gets the profile in an APP2 segment after the JFIF header, replacing one it had', () => {
  const old = [0xff, 0xe2, 0, 18, 0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0, 1, 1, 9, 9];
  const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 6, 1, 2, 3, 4, 0xff, 0xdb, 0, 2, 0xff, 0xda, 0, 2, 0xff, 0xd9);
  for (const input of [jpeg, Uint8Array.of(...jpeg.subarray(0, 10), ...old, ...jpeg.subarray(10))]) {
    const tagged = tagJpeg(input, 'adobe');
    assert.deepEqual([...tagged.subarray(0, 10)], [...jpeg.subarray(0, 10)]);
    assert.equal(tagged[10], 0xff);
    assert.equal(tagged[11], 0xe2);
    const len = (tagged[12] << 8) | tagged[13];
    assert.equal(String.fromCharCode(...tagged.subarray(14, 25)), 'ICC_PROFILE');
    assert.equal(len, 2 + 12 + 2 + iccProfile('adobe').length);
    // Everything after is the rest of the file: one profile only.
    assert.deepEqual([...tagged.subarray(10 + 2 + len)], [...jpeg.subarray(10)]);
  }
  assert.equal(tagJpeg(jpeg, 'srgb'), jpeg);
});

test('the linear profile has a straight curve and the same colorants', () => {
  const tag = (profile, sig) => {
    const v = new DataView(profile.buffer, profile.byteOffset);
    for (let i = 0; i < v.getUint32(128); i++) {
      const row = 132 + 12 * i;
      if (String.fromCharCode(...profile.subarray(row, row + 4)) === sig) return profile.subarray(v.getUint32(row + 4), v.getUint32(row + 4) + v.getUint32(row + 8));
    }
    return null;
  };
  const normal = iccProfile('srgb');
  const linear = iccProfile('srgb', { linear: true });
  assert.deepEqual([...tag(linear, 'rXYZ')], [...tag(normal, 'rXYZ')], 'same colorants');
  // a 'curv' with one entry: gamma 1.0 is 256 / 256 (u8Fixed8)
  const curve = tag(linear, 'rTRC');
  assert.equal(String.fromCharCode(...curve.subarray(0, 4)), 'curv');
  const cv = new DataView(curve.buffer, curve.byteOffset);
  assert.equal(cv.getUint32(8), 1);
  assert.equal(cv.getUint16(12), 256);
  assert.equal(String.fromCharCode(...tag(normal, 'rTRC').subarray(0, 4)), 'para', 'the usual profile keeps the sRGB curve');
  assert.match(String.fromCharCode(...tag(linear, 'desc').subarray(12, 60)), /linear/);
});
