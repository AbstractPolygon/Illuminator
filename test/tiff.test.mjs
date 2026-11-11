// The HDR TIFF writer (core/tiff.js): the file is read back here with Node's own zlib and an independent little TIFF reader, and the floats must come out bit for bit, with and
// without the compression, in one strip and in several. (The file was also read with libtiff-based tools when this was written: see the notes in the commit.)
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { encodeTiffFloat, predictFloatRow } from '../app/js/core/tiff.js';
import { iccProfile } from '../app/js/core/colorspace.js';

// A small reader: the first IFD's entries, and the strips decoded back to floats.
function readTiff(file) {
  const v = new DataView(file.buffer, file.byteOffset, file.length);
  assert.equal(v.getUint16(0, true), 0x4949, 'little endian');
  assert.equal(v.getUint16(2, true), 42);
  const ifd = v.getUint32(4, true);
  const count = v.getUint16(ifd, true);
  const tags = {};
  const SIZE = { 3: 2, 4: 4, 7: 1 };
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + 12 * i;
    const tag = v.getUint16(e, true);
    const type = v.getUint16(e + 2, true);
    const n = v.getUint32(e + 4, true);
    const bytes = SIZE[type] * n;
    const at = bytes <= 4 ? e + 8 : v.getUint32(e + 8, true);
    const values = [];
    for (let k = 0; k < n; k++) {
      if (type === 3) values.push(v.getUint16(at + 2 * k, true));
      else if (type === 4) values.push(v.getUint32(at + 4 * k, true));
      else values.push(file[at + k]);
    }
    tags[tag] = values;
  }
  assert.equal(v.getUint32(ifd + 2 + 12 * count, true), 0, 'one image');
  const [width] = tags[256];
  const [height] = tags[257];
  const rowsPerStrip = tags[278][0];
  const compression = tags[259][0];
  const out = new Float32Array(width * height * 3);
  const rowBytes = width * 3 * 4;
  tags[273].forEach((offset, s) => {
    let data = file.subarray(offset, offset + tags[279][s]);
    const rows = Math.min(rowsPerStrip, height - s * rowsPerStrip);
    if (compression === 8) {
      data = new Uint8Array(zlib.inflateSync(data));
      assert.equal(tags[317][0], 3, 'floating-point predictor');
      for (let r = 0; r < rows; r++) {
        const row = data.subarray(r * rowBytes, (r + 1) * rowBytes);
        for (let j = 3; j < row.length; j++) row[j] = (row[j] + row[j - 3]) & 255; // undo the differences (3 values per pixel, a byte each)
        const n = width * 3;
        const dv = new DataView(out.buffer, (s * rowsPerStrip + r) * rowBytes, rowBytes);
        for (let i = 0; i < n; i++) dv.setUint32(i * 4, ((row[i] << 24) | (row[n + i] << 16) | (row[2 * n + i] << 8) | row[3 * n + i]) >>> 0, true);
      }
    } else {
      assert.equal(data.length, rows * rowBytes);
      new Uint8Array(out.buffer, s * rowsPerStrip * rowBytes, rows * rowBytes).set(data);
    }
  });
  return { tags, width, height, out };
}

function picture(w, h) {
  const rgb = new Float32Array(w * h * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = Math.fround(Math.sin(i * 0.37) * 3 + (i % 7 === 0 ? 5.5 : 0.25)); // negatives, large and tiny values
  rgb[0] = 0;
  rgb[1] = -0;
  rgb[2] = 65504.5; // a very bright value
  return rgb;
}

test('the floats come back bit for bit: compressed or not, one strip or several', async () => {
  for (const [w, h] of [[5, 3], [700, 400], [1, 1], [3, 1]]) {
    const rgb = picture(w, h);
    for (const compress of [true, false]) {
      const file = await encodeTiffFloat(rgb, w, h, { icc: iccProfile('srgb', { linear: true }), compress });
      const r = readTiff(file);
      assert.equal(r.width, w);
      assert.equal(r.height, h);
      assert.deepEqual(new Uint8Array(r.out.buffer), new Uint8Array(rgb.buffer), `${w}x${h} ${compress ? 'deflate' : 'raw'}`);
    }
  }
});

test('the entries say what the picture is: 32-bit float RGB, one plane, with the profile', async () => {
  const w = 700;
  const h = 400;
  const icc = iccProfile('srgb', { linear: true });
  const r = readTiff(await encodeTiffFloat(picture(w, h), w, h, { icc }));
  assert.deepEqual(r.tags[258], [32, 32, 32]);
  assert.deepEqual(r.tags[339], [3, 3, 3], 'IEEE floating point samples');
  assert.deepEqual(r.tags[262], [2], 'RGB');
  assert.deepEqual(r.tags[277], [3]);
  assert.deepEqual(r.tags[284], [1], 'chunky');
  assert.ok(r.tags[273].length > 1, 'several strips');
  assert.equal(r.tags[273].length, r.tags[279].length);
  assert.deepEqual(r.tags[34675], [...icc], 'the profile is stored as it was given');
  // tags in ascending order, as TIFF requires
  const order = Object.keys(r.tags).map(Number);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test('a smooth picture compresses well and the file size matches the strips', async () => {
  const w = 300;
  const h = 200;
  const rgb = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgb.set([x / w, y / h, 0.5 + 4 * (x / w)], (y * w + x) * 3);
  const file = await encodeTiffFloat(rgb, w, h, {});
  assert.ok(file.length < w * h * 12 * 0.5, `${file.length} bytes for ${w * h * 12} raw`);
});

test('the predictor splits the bytes into planes, most significant first, then takes differences', () => {
  const row = new Uint8Array(new Float32Array([1, 1, 1, 2, 2, 2]).buffer); // two pixels of three values
  const out = predictFloatRow(row, 6, 3);
  // 1.0 = 0x3F800000 and 2.0 = 0x40000000: four planes of six bytes (all the high bytes, then the next, ...)
  const planes = [0x3f, 0x3f, 0x3f, 0x40, 0x40, 0x40, 0x80, 0x80, 0x80, 0, 0, 0, ...new Array(12).fill(0)];
  // then each byte minus the byte three places before it (the same channel of the previous pixel), over the whole row of planes
  const expected = planes.map((b, j) => (j < 3 ? b : (b - planes[j - 3]) & 255));
  assert.deepEqual([...out], expected);
});

test('a picture of the wrong size is refused', async () => {
  await assert.rejects(encodeTiffFloat(new Float32Array(5), 2, 2, {}), /does not match/);
});
