// Light L16 photo files (.lri): a chain of blocks, each a 32 byte header (the letters LELR, u64 block length, u64 message offset, u32 message length, u8 type, padding)
// followed by a protobuf message (core/lri-schema.js, read by core/protobuf.js) and, in the blocks that carry them, the raw frames of the camera modules.
// Type 0 messages are (partial) LightHeaders that merge into one; type 1 is ViewPreferences, type 2 GPSData. A module's frame sits at blockStart + surface.data_offset.
// The layout follows the format as the L16 community has documented it.
import { LRI_SCHEMA } from './lri-schema.js';
import { decodeMessage, mergeMessage } from './protobuf.js';

const MAGIC = [0x4c, 0x45, 0x4c, 0x52]; // LELR
const HEADER_BYTES = 32;

import { decodeGrayJpeg } from './jpeggray.js';

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
// The other raw encoding a file can carry (RAW_BAYER_JPEG, used by stacked captures) is baseline gray JPEG planes with a table that gives the 10 bit values back (decodeBayerJpeg).
export function decodeFrame(bytes, frame) {
  const s = frame.module.sensor_data_surface;
  const width = s.size.x;
  const height = s.size.y;
  if (s.format === 'RAW_BAYER_JPEG') return decodeBayerJpeg(bytes, frame.blockStart + s.data_offset, width, height);
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

// A RAW_BAYER_JPEG surface: 'BJPG', a version (0: four planes of half the size, one for each site of the 2 x 2 cell, in the order (0,0) (0,1) (1,0) (1,1); 1: one plane of the full size),
// the four plane sizes, 'QDQT' with a table that turns the 8 bit JPEG codes into 10 bit sensor values, then the JPEG planes one after another.
function decodeBayerJpeg(bytes, at, width, height) {
  const u32 = (o) => (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0;
  if (at + 40 > bytes.length || u32(at) !== 0x47504a42) throw new Error('A camera frame of this photo is damaged (no JPEG header)');
  const version = u32(at + 4);
  if (version > 1) throw new Error('This photo stores its frames in a JPEG variant that is not supported');
  const sizes = [u32(at + 8), u32(at + 12), u32(at + 16), u32(at + 20)];
  if (u32(at + 24) !== 0x54514451 || u32(at + 28) !== 0) throw new Error('This photo stores its frames with a JPEG table that is not supported');
  const quantBytes = u32(at + 32);
  const dequantBytes = u32(at + 36);
  if (quantBytes >= 0x1000) throw new Error('A camera frame of this photo is damaged (JPEG table)');
  const dqAt = at + 40 + quantBytes;
  const dequant = new Uint16Array(dequantBytes >> 1);
  for (let i = 0; i < dequant.length; i++) dequant[i] = bytes[dqAt + 2 * i] | (bytes[dqAt + 2 * i + 1] << 8);
  let p = dqAt + dequantBytes;
  const out = new Uint16Array(width * height);
  const planes = version === 0 ? 4 : 1;
  for (let plane = 0; plane < planes; plane++) {
    const gray = decodeGrayJpeg(bytes, p, sizes[plane]);
    p += sizes[plane];
    if (version === 0) {
      if (gray.width * 2 !== width || gray.height * 2 !== height) throw new Error('A camera frame of this photo is damaged (plane size)');
      const rowOff = plane >> 1;
      const colOff = plane & 1;
      for (let y = 0; y < gray.height; y++) {
        const o = (rowOff + 2 * y) * width + colOff;
        for (let x = 0; x < gray.width; x++) out[o + 2 * x] = dequant[gray.data[y * gray.width + x]];
      }
    } else {
      if (gray.width !== width || gray.height !== height) throw new Error('A camera frame of this photo is damaged (plane size)');
      for (let i = 0; i < out.length; i++) out[i] = dequant[gray.data[i]];
    }
  }
  return { width, height, data: out };
}
