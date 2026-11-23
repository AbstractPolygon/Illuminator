// Light L16 photo files (.lri): a chain of blocks, each a 32 byte header (the letters LELR, u64 block length, u64 message offset, u32 message length, u8 type, padding)
// followed by a protobuf message (core/lri-schema.js, read by core/protobuf.js) and, in the blocks that carry them, the raw frames of the camera modules.
// Type 0 messages are (partial) LightHeaders that merge into one; type 1 is ViewPreferences, type 2 GPSData. A module's frame sits at blockStart + surface.data_offset.
// The layout is the one the Lux project (github.com/mprovenz/lux) documents for this format.
import { LRI_SCHEMA } from './lri-schema.js';
import { decodeMessage, mergeMessage } from './protobuf.js';

const MAGIC = [0x4c, 0x45, 0x4c, 0x52]; // LELR
const HEADER_BYTES = 32;

export function isLri(bytes) {
  return bytes.length >= HEADER_BYTES && MAGIC.every((b, i) => bytes[i] === b);
}

const u64 = (view, at) => view.getUint32(at + 4, true) * 4294967296 + view.getUint32(at, true);

// Reads the block headers and messages of a whole file. Returns
//   { header, modules: { A1: [frame 0, frame 1, ...], ... }, viewPreferences, gps, stackFrames, blocks }
// where each frame is { module, blockStart } (module is the CameraModule message), `header` the merged LightHeader.
export function parseLri(bytes) {
  if (!isLri(bytes)) throw new Error('This is not a Light L16 (.lri) file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = {};
  const perModule = new Map();
  const blocks = [];
  const frameIndices = new Set();
  let viewPreferences = null;
  let gps = null;
  let off = 0;
  while (off + HEADER_BYTES <= bytes.length && MAGIC.every((b, i) => bytes[off + i] === b)) {
    const blockLen = u64(view, off + 4);
    const msgOff = u64(view, off + 12);
    const msgLen = view.getUint32(off + 20, true);
    const type = bytes[off + 24];
    const at = off + msgOff;
    if (at + msgLen > bytes.length) throw new Error('The file ends inside a block: it is cut short');
    blocks.push({ start: off, length: blockLen, type, msgLen });
    if (type === 0) {
      const part = decodeMessage(LRI_SCHEMA, 'LightHeader', bytes, at, at + msgLen);
      for (const m of part.modules || []) {
        const id = m.id;
        if (!perModule.has(id)) perModule.set(id, new Map());
        perModule.get(id).set(m.frame_index || 0, { module: m, blockStart: off });
        frameIndices.add(m.frame_index || 0);
      }
      mergeMessage(header, part);
    } else if (type === 1) {
      const part = decodeMessage(LRI_SCHEMA, 'ViewPreferences', bytes, at, at + msgLen);
      viewPreferences = viewPreferences ? mergeMessage(viewPreferences, part) : part;
    } else if (type === 2) {
      const part = decodeMessage(LRI_SCHEMA, 'GPSData', bytes, at, at + msgLen);
      gps = gps ? mergeMessage(gps, part) : part;
    }
    if (blockLen === 0) break;
    off += blockLen;
  }
  const modules = {};
  for (const [id, byFrame] of perModule) modules[id] = [...byFrame.keys()].sort((a, b) => a - b).map((k) => byFrame.get(k));
  return { header, modules, viewPreferences, gps, stackFrames: Math.max(frameIndices.size, 1), blocks };
}

// Unpacks one module frame to a row-major Uint16Array of sensor values (width * height). RAW_PACKED_10BPP stores 4 pixels in 5 bytes, rows `row_stride` bytes apart.
// The other raw encoding a file can carry (RAW_BAYER_JPEG, used by stacked captures) is reported as not supported yet.
export function decodeFrame(bytes, frame) {
  const s = frame.module.sensor_data_surface;
  const width = s.size.x;
  const height = s.size.y;
  if (s.format !== 'RAW_PACKED_10BPP') throw new Error(`This photo stores its frames as ${s.format}, which is not supported yet`);
  const start = frame.blockStart + s.data_offset;
  const stride = s.row_stride;
  if (start + (height - 1) * stride + (width / 4) * 5 > bytes.length) throw new Error('The file ends inside a camera frame: it is cut short');
  const out = new Uint16Array(width * height);
  const groups = width >> 2;
  for (let y = 0; y < height; y++) {
    let o = start + y * stride;
    let p = y * width;
    for (let g = 0; g < groups; g++, o += 5, p += 4) {
      const b1 = bytes[o + 1];
      const b2 = bytes[o + 2];
      const b3 = bytes[o + 3];
      out[p] = bytes[o] | ((b1 & 0x3) << 8);
      out[p + 1] = (b1 >> 2) | ((b2 & 0xf) << 6);
      out[p + 2] = (b2 >> 4) | ((b3 & 0x3f) << 4);
      out[p + 3] = (b3 >> 6) | (bytes[o + 4] << 2);
    }
  }
  return { width, height, data: out };
}
