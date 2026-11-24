// What opening a Light L16 photo measures, kept next to the photo in the library (l16.illuminator.bin) so opening it again takes seconds instead of half a minute: the depth
// measured between the camera modules (core/l16depth.js) and the cameras merged at half size (core/l16fusion.js), the two slow steps.
//
// Layout: 'IL16', uint32 format version, uint32 header length, the header (JSON, UTF-8, padded to 4 bytes), then the depth's inverse depth and confidence as float32, then the
// merged picture as uint16 (each value v stored as round(sqrt(v / RANGE) * 65535): fine steps in the dark, where they show).
// The header's `key` says what it was made with (L16_CACHE_REV, the photo, Remove hot pixels); one whose key differs from the photo's current one is not used, and is
// written again after the new measurement.

export const L16_CACHE_FILE = 'l16.illuminator.bin';
// Raise when the depth measurement or the merge changes what they make.
export const L16_CACHE_REV = 2;
const MAGIC = 0x36314c49; // 'IL16' read as a little endian uint32
const FORMAT = 1;
const RANGE = 4;

export function l16CacheKey(photoId, hot) {
  return `${L16_CACHE_REV}|${photoId}|${hot ? 'hot' : 'raw'}`;
}

// { key, depth (measureDepth's result), wide ({ width, height, rgb: Float32Array, used }) } -> Uint8Array
export function encodeL16Cache({ key, depth, wide }) {
  const { invZ, confidence, ...depthMeta } = depth;
  const conf = confidence && confidence.length === invZ.length ? confidence : null;
  const header = new TextEncoder().encode(JSON.stringify({
    key,
    depth: { ...depthMeta, K: Array.from(depthMeta.K || []), hasConfidence: !!conf },
    wide: { width: wide.width, height: wide.height, used: wide.used || null },
  }));
  const padded = Math.ceil(header.length / 4) * 4;
  const n = wide.width * wide.height * 3;
  const out = new Uint8Array(12 + padded + (invZ.length + (conf ? conf.length : 0)) * 4 + n * 2);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, FORMAT, true);
  view.setUint32(8, header.length, true);
  out.set(header, 12);
  let at = 12 + padded;
  const put = (a) => {
    out.set(new Uint8Array(a.buffer, a.byteOffset, a.length * 4), at);
    at += a.length * 4;
  };
  put(Float32Array.from(invZ));
  if (conf) put(Float32Array.from(conf));
  const q = new Uint16Array(out.buffer, at, n);
  for (let i = 0; i < n; i++) q[i] = Math.round(Math.sqrt(Math.min(1, Math.max(0, wide.rgb[i] / RANGE))) * 65535);
  return out;
}

// Uint8Array / ArrayBuffer -> { key, depth, wide } or null (not one of these files, or a version this app does not read).
export function decodeL16Cache(bytes) {
  if (!bytes) return null;
  const buf = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (buf.byteLength < 12) return null;
  const view = new DataView(buf);
  if (view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== FORMAT) return null;
  const hl = view.getUint32(8, true);
  let header;
  try {
    header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, hl)));
  } catch {
    return null;
  }
  const { depth: dm, wide: wm } = header;
  if (!dm || !wm) return null;
  let at = 12 + Math.ceil(hl / 4) * 4;
  const nd = dm.width * dm.height;
  const n = wm.width * wm.height * 3;
  if (buf.byteLength < at + nd * 4 * (dm.hasConfidence ? 2 : 1) + n * 2) return null;
  // (copied out, so each part is its own buffer, aligned)
  const invZ = new Float32Array(buf.slice(at, at + nd * 4));
  at += nd * 4;
  let confidence = null;
  if (dm.hasConfidence) {
    confidence = new Float32Array(buf.slice(at, at + nd * 4));
    at += nd * 4;
  }
  const q = new Uint16Array(buf, at, n);
  const rgb = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = q[i] / 65535;
    rgb[i] = s * s * RANGE;
  }
  const { hasConfidence, ...meta } = dm;
  return { key: header.key, depth: { ...meta, invZ, confidence }, wide: { width: wm.width, height: wm.height, rgb, used: wm.used } };
}
