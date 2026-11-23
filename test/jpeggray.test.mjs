import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decodeGrayJpeg } from '../app/js/core/jpeggray.js';
import { decodeFrame } from '../app/js/core/lri.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures-bjpg.json', import.meta.url), 'utf8'));
const planes = fixture.planes.map((b) => new Uint8Array(Buffer.from(b, 'base64')));

test('a baseline gray JPEG decodes to what a reference decoder gives (within rounding)', () => {
  const r = decodeGrayJpeg(planes[0]);
  assert.equal(r.width, 16);
  assert.equal(r.height, 8);
  let worst = 0;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) worst = Math.max(worst, Math.abs(r.data[y * 16 + x] - fixture.ref[0][y][x]));
  assert.ok(worst <= 1, `worst difference ${worst}`);
});

test('other kinds of JPEG are refused', () => {
  assert.throws(() => decodeGrayJpeg(new Uint8Array([1, 2, 3, 4])), /not a JPEG/);
  const progressive = Uint8Array.from(planes[0]);
  for (let i = 0; i + 1 < progressive.length; i++) if (progressive[i] === 0xff && progressive[i + 1] === 0xc0) progressive[i + 1] = 0xc2;
  assert.throws(() => decodeGrayJpeg(progressive), /baseline/);
});

// The container of a RAW_BAYER_JPEG surface: 'BJPG', version, four plane sizes, 'QDQT', 0, quant and dequant table sizes, the tables, the planes
function surface(version, dequant) {
  const u32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24];
  const quant = new Uint8Array(1024);
  const dq = new Uint8Array(dequant.length * 2);
  dequant.forEach((v, i) => {
    dq[2 * i] = v & 255;
    dq[2 * i + 1] = v >> 8;
  });
  const sizes = version === 0 ? planes.map((p) => p.length) : [planes[0].length, 0, 0, 0];
  const body = version === 0 ? planes : [planes[0]];
  const head = [0x42, 0x4a, 0x50, 0x47, ...u32(version), ...sizes.flatMap(u32), 0x51, 0x44, 0x51, 0x54, ...u32(0), ...u32(quant.length), ...u32(dq.length)];
  const parts = [Uint8Array.from(head), quant, dq, ...body];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

test('a stacked capture frame (RAW_BAYER_JPEG, four planes) is put back on the sensor grid and made 10 bit', () => {
  const dequant = Array.from({ length: 256 }, (_, i) => i * 4);
  const payload = surface(0, dequant);
  const bytes = new Uint8Array(100 + payload.length);
  bytes.set(payload, 100);
  const frame = { blockStart: 0, module: { sensor_data_surface: { format: 'RAW_BAYER_JPEG', size: { x: 32, y: 16 }, data_offset: 100 } } };
  const { width, height, data } = decodeFrame(bytes, frame);
  assert.equal(width, 32);
  assert.equal(height, 16);
  // plane 0 is site (0,0), 1 is (0,1), 2 is (1,0), 3 is (1,1) of each 2 x 2 cell
  for (let plane = 0; plane < 4; plane++) {
    const rowOff = plane >> 1;
    const colOff = plane & 1;
    const got = decodeGrayJpeg(planes[plane]);
    for (let y = 0; y < 8; y += 3) for (let x = 0; x < 16; x += 5) assert.equal(data[(rowOff + 2 * y) * 32 + colOff + 2 * x], dequant[got.data[y * 16 + x]]);
  }
});

test('a single plane frame (version 1) and a wrong size are handled', () => {
  const dequant = Array.from({ length: 256 }, (_, i) => i);
  const payload = surface(1, dequant);
  const bytes = new Uint8Array(payload.length);
  bytes.set(payload, 0);
  const frame = { blockStart: 0, module: { sensor_data_surface: { format: 'RAW_BAYER_JPEG', size: { x: 16, y: 8 }, data_offset: 0 } } };
  const { data } = decodeFrame(bytes, frame);
  assert.equal(data[0], decodeGrayJpeg(planes[0]).data[0]);
  const wrong = { blockStart: 0, module: { sensor_data_surface: { format: 'RAW_BAYER_JPEG', size: { x: 20, y: 8 }, data_offset: 0 } } };
  assert.throws(() => decodeFrame(bytes, wrong), /damaged|size/);
});
