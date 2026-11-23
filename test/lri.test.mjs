import test from 'node:test';
import assert from 'node:assert/strict';
import { LRI_SCHEMA } from '../app/js/core/lri-schema.js';
import { decodeMessage, mergeMessage } from '../app/js/core/protobuf.js';
import { isLri, parseLri, decodeFrame } from '../app/js/core/lri.js';

// A tiny protobuf writer, enough to build the messages of a Light L16 file.
const varint = (n) => {
  const out = [];
  let v = BigInt(n);
  while (v > 0x7fn) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return out;
};
const tag = (num, wire) => varint((num << 3) | wire);
const vField = (num, n) => [...tag(num, 0), ...varint(n)];
const lField = (num, bytes) => [...tag(num, 2), ...varint(bytes.length), ...bytes];
const f32 = (num, x) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, x, true);
  return [...tag(num, 5), ...b];
};
const point2i = (x, y) => [...vField(1, x), ...vField(2, y)];

// 8 x 2 pixels, 10 bit: 4 pixels in 5 bytes
function pack10(values) {
  const out = [];
  for (let i = 0; i < values.length; i += 4) {
    const [a, b, c, d] = values.slice(i, i + 4);
    out.push(a & 255, ((a >> 8) & 3) | ((b & 63) << 2), ((b >> 6) & 15) | ((c & 15) << 4), ((c >> 4) & 63) | ((d & 3) << 6), d >> 2);
  }
  return out;
}

function makeFile() {
  const pixels = [0, 1, 2, 3, 1023, 512, 256, 100, 7, 8, 9, 10, 11, 12, 13, 1000];
  const data = pack10(pixels);
  const surface = [...lField(1, point2i(0, 0)), ...lField(2, point2i(8, 2)), ...vField(3, 7), ...vField(4, 10), ...vField(5, 0)]; // data_offset patched below
  const buildModule = (offset, id, frameIndex) => {
    const s = [...lField(1, point2i(0, 0)), ...lField(2, point2i(8, 2)), ...vField(3, 7), ...vField(4, 10), ...vField(5, offset)];
    return [...vField(2, id), ...vField(5, 1500), ...f32(7, 1.5), ...vField(8, 5000), ...lField(9, s), ...vField(15, frameIndex)];
  };
  void surface;
  const msgFor = (offset) => [...lField(12, buildModule(offset, 0, 0)), ...vField(5, 0), ...lField(8, [...new TextEncoder().encode('L16')])];
  // block 0: header (32), frame data, then the message at the end, as the camera writes it
  const dataStart = 32;
  const msg = msgFor(dataStart);
  const block = new Uint8Array(32 + data.length + msg.length);
  block.set([0x4c, 0x45, 0x4c, 0x52]);
  const dv = new DataView(block.buffer);
  dv.setUint32(4, block.length, true);
  dv.setUint32(12, 32 + data.length, true);
  dv.setUint32(20, msg.length, true);
  block[24] = 0;
  block.set(data, 32);
  block.set(msg, 32 + data.length);
  return { bytes: block, pixels };
}

test('protobuf: numbers, signs, strings, nested messages and packed floats', () => {
  const schema = {
    enums: { E: { 0: 'ZERO', 1: 'ONE' } },
    messages: {
      Inner: { 1: ['v', 'sint32', 0, 0] },
      M: { 1: ['i32', 'int32', 0, 0], 2: ['u64', 'uint64', 0, 0], 3: ['s', 'string', 0, 0], 4: ['inner', 'm:Inner', 0, 0], 5: ['rep', 'm:Inner', 1, 0], 6: ['pf', 'float', 1, 1], 7: ['e', 'e:E', 0, 0], 8: ['neg64', 'int64', 0, 0] },
    },
  };
  const neg = new Uint8Array([...tag(1, 0), 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]); // int32 -1 as ten bytes
  assert.equal(decodeMessage(schema, 'M', neg).i32, -1);
  const packed = new Uint8Array(8);
  new DataView(packed.buffer).setFloat32(0, 0.5, true);
  new DataView(packed.buffer).setFloat32(4, -2, true);
  const bytes = new Uint8Array([
    ...vField(2, 4294967296 * 3 + 5), ...lField(3, [...new TextEncoder().encode('Light')]), ...lField(4, vField(1, 3)), // sint32 zigzag 3 = -2
    ...lField(5, vField(1, 4)), ...lField(5, vField(1, 1)), ...lField(6, packed), ...vField(7, 1), ...[...tag(8, 0), 0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01],
  ]);
  const m = decodeMessage(schema, 'M', bytes);
  assert.equal(m.u64, 4294967296 * 3 + 5);
  assert.equal(m.s, 'Light');
  assert.equal(m.inner.v, -2);
  assert.deepEqual(m.rep.map((r) => r.v), [2, -1]);
  assert.deepEqual([...m.pf], [0.5, -2]);
  assert.equal(m.e, 'ONE');
  assert.equal(m.neg64, -2);
});

test('protobuf: merging partial messages appends repeated fields and replaces single ones', () => {
  const a = { n: 1, list: [1], inner: { x: 1, y: 2 } };
  mergeMessage(a, { n: 2, list: [2], inner: { y: 5 } });
  assert.deepEqual(a, { n: 2, list: [1, 2], inner: { x: 1, y: 5 } });
});

test('lri: a file is told by its LELR block, its header and module frame are read, and 10 bit pixels unpack', () => {
  const { bytes, pixels } = makeFile();
  assert.ok(isLri(bytes));
  assert.ok(!isLri(new Uint8Array(40)));
  const r = parseLri(bytes);
  assert.equal(r.header.device_model_name, 'L16');
  assert.equal(r.blocks.length, 1);
  const frame = r.modules.A1[0];
  assert.equal(frame.module.lens_position, 1500);
  assert.equal(frame.module.sensor_analog_gain, 1.5);
  assert.equal(frame.module.sensor_data_surface.format, 'RAW_PACKED_10BPP');
  const f = decodeFrame(bytes, frame);
  assert.equal(f.width, 8);
  assert.equal(f.height, 2);
  assert.deepEqual([...f.data], pixels);
});

test('lri: a file that is cut short, or is not an L16 file, says so', () => {
  const { bytes } = makeFile();
  assert.throws(() => parseLri(bytes.subarray(0, bytes.length - 3)), /cut short/);
  assert.throws(() => parseLri(new Uint8Array(64)), /not a Light L16/);
  assert.ok(LRI_SCHEMA.messages.LightHeader);
});
