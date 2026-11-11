// Color spaces for saved photos: converts a picture made in sRGB to another
// RGB space (Display P3, Adobe RGB, Rec. 2020, ProPhoto) and builds the ICC
// profile that goes into the file, so other software reads the colors right.
// The picture itself is made in sRGB: converting it does not add colors
// beyond sRGB's range, it re-encodes the same colors and tags them.

const D65 = [0.3127, 0.329];
const D50 = [0.3457, 0.3585];

// Primaries (CIE xy), white point and transfer curve of each space.
// curve: 'srgb' (the sRGB curve, which Display P3 uses too), 'rec2020'
// (the BT.2020 curve), or a plain gamma.
export const COLOR_SPACES = {
  srgb: { label: 'sRGB', description: 'sRGB IEC61966-2.1', primaries: [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]], white: D65, curve: 'srgb' },
  p3: { label: 'Display P3', description: 'Display P3', primaries: [[0.68, 0.32], [0.265, 0.69], [0.15, 0.06]], white: D65, curve: 'srgb' },
  adobe: { label: 'Adobe RGB (1998)', description: 'Adobe RGB (1998)', primaries: [[0.64, 0.33], [0.21, 0.71], [0.15, 0.06]], white: D65, curve: 563 / 256 },
  rec2020: { label: 'Rec. 2020', description: 'Rec. ITU-R BT.2020', primaries: [[0.708, 0.292], [0.17, 0.797], [0.131, 0.046]], white: D65, curve: 'rec2020' },
  prophoto: { label: 'ProPhoto RGB', description: 'ProPhoto RGB', primaries: [[0.7347, 0.2653], [0.1596, 0.8404], [0.0366, 0.0001]], white: D50, curve: 1.8 },
};

export const COLOR_SPACE_IDS = Object.keys(COLOR_SPACES);

// ---------------------------------------------------------------- matrices

const xyzOf = ([x, y]) => [x / y, 1, (1 - x - y) / y];
const mul = (A, B) => A.map((row, i) => B[0].map((_, j) => row.reduce((s, v, k) => s + v * B[k][j], 0)));
const apply = (M, v) => M.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);

function invert3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

// RGB (linear) -> XYZ with the space's own white point.
function rgbToXyz(space) {
  const P = space.primaries.map(xyzOf); // columns
  const M = [0, 1, 2].map((r) => [P[0][r], P[1][r], P[2][r]]);
  const S = apply(invert3(M), xyzOf(space.white));
  return M.map((row) => row.map((v, j) => v * S[j]));
}

// Bradford adaptation between two white points (CIE xy).
const BRADFORD = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];
function adaptation(from, to) {
  if (from[0] === to[0] && from[1] === to[1]) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const a = apply(BRADFORD, xyzOf(from));
  const b = apply(BRADFORD, xyzOf(to));
  const S = [[b[0] / a[0], 0, 0], [0, b[1] / a[1], 0], [0, 0, b[2] / a[2]]];
  return mul(invert3(BRADFORD), mul(S, BRADFORD));
}

// The space's colorants as seen from the D50 connection space (the ICC way).
export function colorantsD50(id) {
  const s = COLOR_SPACES[id];
  return mul(adaptation(s.white, D50), rgbToXyz(s));
}

// Linear sRGB -> linear RGB of the space.
export function fromSrgbMatrix(id) {
  const toXyz = colorantsD50('srgb');
  return mul(invert3(colorantsD50(id)), toXyz);
}

// ---------------------------------------------------------------- curves

const srgbDecode = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const REC_A = 1.09929682680944;
const REC_B = 0.018053968510807;

function encodeValue(space, l) {
  if (!(l > 0)) return 0;
  if (l >= 1) return 1;
  if (space.curve === 'srgb') return l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055;
  if (space.curve === 'rec2020') return l < REC_B ? 4.5 * l : REC_A * l ** 0.45 - (REC_A - 1);
  return l ** (1 / space.curve);
}

// Encoded value for a linear one, looked up by its square root (fine near
// black, where the curves change fastest).
const ENCODE_STEPS = 65535;
const encodeTables = {};
function encodeTable(id) {
  if (!encodeTables[id]) {
    const t = new Float32Array(ENCODE_STEPS + 1);
    for (let i = 0; i <= ENCODE_STEPS; i++) t[i] = encodeValue(COLOR_SPACES[id], (i / ENCODE_STEPS) ** 2);
    encodeTables[id] = t;
  }
  return encodeTables[id];
}

const decode8 = new Float32Array(256).map((_, i) => srgbDecode(i / 255));
let decode16 = null;

// ---------------------------------------------------------------- conversion

// Converts RGBA bytes (sRGB) in place to the space; alpha is left alone.
export function convertRgba8(data, id) {
  if (id === 'srgb' || !COLOR_SPACES[id]) return data;
  const [[a, b, c], [d, e, f], [g, h, i]] = fromSrgbMatrix(id);
  const enc = encodeTable(id);
  for (let p = 0; p < data.length; p += 4) {
    const r = decode8[data[p]];
    const gr = decode8[data[p + 1]];
    const bl = decode8[data[p + 2]];
    const x = a * r + b * gr + c * bl;
    const y = d * r + e * gr + f * bl;
    const z = g * r + h * gr + i * bl;
    data[p] = Math.round(255 * enc[Math.round(Math.sqrt(x > 0 ? (x < 1 ? x : 1) : 0) * ENCODE_STEPS)]);
    data[p + 1] = Math.round(255 * enc[Math.round(Math.sqrt(y > 0 ? (y < 1 ? y : 1) : 0) * ENCODE_STEPS)]);
    data[p + 2] = Math.round(255 * enc[Math.round(Math.sqrt(z > 0 ? (z < 1 ? z : 1) : 0) * ENCODE_STEPS)]);
  }
  return data;
}

// Converts 16-bit RGB (sRGB, three values per pixel) in place.
export function convertRgb16(rgb, id) {
  if (id === 'srgb' || !COLOR_SPACES[id]) return rgb;
  if (!decode16) decode16 = new Float32Array(65536).map((_, i) => srgbDecode(i / 65535));
  const [[a, b, c], [d, e, f], [g, h, i]] = fromSrgbMatrix(id);
  const enc = encodeTable(id);
  for (let p = 0; p < rgb.length; p += 3) {
    const r = decode16[rgb[p]];
    const gr = decode16[rgb[p + 1]];
    const bl = decode16[rgb[p + 2]];
    const x = a * r + b * gr + c * bl;
    const y = d * r + e * gr + f * bl;
    const z = g * r + h * gr + i * bl;
    rgb[p] = Math.round(65535 * enc[Math.round(Math.sqrt(x > 0 ? (x < 1 ? x : 1) : 0) * ENCODE_STEPS)]);
    rgb[p + 1] = Math.round(65535 * enc[Math.round(Math.sqrt(y > 0 ? (y < 1 ? y : 1) : 0) * ENCODE_STEPS)]);
    rgb[p + 2] = Math.round(65535 * enc[Math.round(Math.sqrt(z > 0 ? (z < 1 ? z : 1) : 0) * ENCODE_STEPS)]);
  }
  return rgb;
}

// ---------------------------------------------------------------- ICC profile

const s15 = (v) => Math.round(v * 65536);

function textTag(str) {
  const bytes = new Uint8Array(8 + str.length + 1);
  bytes.set([0x74, 0x65, 0x78, 0x74], 0); // 'text'
  for (let i = 0; i < str.length; i++) bytes[8 + i] = str.charCodeAt(i);
  return bytes;
}

// 'desc' (textDescriptionType, ICC v2): ASCII text, no Unicode or Mac parts.
function descTag(str) {
  const bytes = new Uint8Array(12 + str.length + 1 + 4 + 4 + 3 + 67);
  const v = new DataView(bytes.buffer);
  bytes.set([0x64, 0x65, 0x73, 0x63], 0); // 'desc'
  v.setUint32(8, str.length + 1);
  for (let i = 0; i < str.length; i++) bytes[12 + i] = str.charCodeAt(i);
  return bytes;
}

function xyzTag(x, y, z) {
  const bytes = new Uint8Array(20);
  const v = new DataView(bytes.buffer);
  bytes.set([0x58, 0x59, 0x5a, 0x20], 0); // 'XYZ '
  v.setInt32(8, s15(x));
  v.setInt32(12, s15(y));
  v.setInt32(16, s15(z));
  return bytes;
}

function curveTag(space) {
  if (typeof space.curve === 'number') {
    const bytes = new Uint8Array(14);
    const v = new DataView(bytes.buffer);
    bytes.set([0x63, 0x75, 0x72, 0x76], 0); // 'curv'
    v.setUint32(8, 1);
    v.setUint16(12, Math.round(space.curve * 256));
    return bytes;
  }
  // parametricCurveType, function 3: (a x + b)^g above d, c x below.
  const rec = space.curve === 'rec2020';
  const p = rec
    ? [1 / 0.45, 1 / REC_A, (REC_A - 1) / REC_A, 1 / 4.5, 4.5 * REC_B]
    : [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045];
  const bytes = new Uint8Array(12 + 20);
  const v = new DataView(bytes.buffer);
  bytes.set([0x70, 0x61, 0x72, 0x61], 0); // 'para'
  v.setUint16(8, 3);
  p.forEach((x, i) => v.setInt32(12 + 4 * i, s15(x)));
  return bytes;
}

// A matrix/TRC display profile (ICC v2.1) for the space, as bytes.
// `linear`: the same primaries with a straight (gamma 1) curve, for pictures that hold light as it is (the HDR TIFF).
export function iccProfile(id, { linear = false } = {}) {
  const base = COLOR_SPACES[id];
  if (!base) throw new Error(`Unknown color space ${id}`);
  const space = linear ? { ...base, curve: 1, description: `${base.description} (linear)` } : base;
  const m = colorantsD50(id);
  const curve = curveTag(space);
  const tags = [
    ['cprt', textTag('No copyright, use freely')],
    ['desc', descTag(space.description)],
    ['wtpt', xyzTag(0.9642, 1, 0.8249)],
    ['rXYZ', xyzTag(m[0][0], m[1][0], m[2][0])],
    ['gXYZ', xyzTag(m[0][1], m[1][1], m[2][1])],
    ['bXYZ', xyzTag(m[0][2], m[1][2], m[2][2])],
    ['rTRC', curve],
    ['gTRC', curve],
    ['bTRC', curve],
  ];
  const pad4 = (n) => (n + 3) & ~3;
  const tableEnd = 128 + 4 + 12 * tags.length;
  // The three curves share one block.
  let at = tableEnd;
  const place = new Map();
  const offsets = tags.map(([, data]) => {
    if (place.has(data)) return place.get(data);
    place.set(data, at);
    const o = at;
    at += pad4(data.length);
    return o;
  });
  const out = new Uint8Array(at);
  const v = new DataView(out.buffer);
  v.setUint32(0, at);
  v.setUint32(8, 0x02100000); // version 2.1.0
  out.set([0x6d, 0x6e, 0x74, 0x72], 12); // 'mntr'
  out.set([0x52, 0x47, 0x42, 0x20], 16); // 'RGB '
  out.set([0x58, 0x59, 0x5a, 0x20], 20); // 'XYZ '
  v.setUint16(24, 2023);
  v.setUint16(26, 1);
  v.setUint16(28, 1);
  out.set([0x61, 0x63, 0x73, 0x70], 36); // 'acsp'
  v.setInt32(68, s15(0.9642)); // the D50 illuminant
  v.setInt32(72, s15(1));
  v.setInt32(76, s15(0.8249));
  v.setUint32(128, tags.length);
  const written = new Set();
  tags.forEach(([sig, data], i) => {
    const row = 132 + 12 * i;
    for (let k = 0; k < 4; k++) out[row + k] = sig.charCodeAt(k);
    v.setUint32(row + 4, offsets[i]);
    v.setUint32(row + 8, data.length);
    if (!written.has(data)) {
      out.set(data, offsets[i]);
      written.add(data);
    }
  });
  return out;
}

// ---------------------------------------------------------------- embedding

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// The PNG 'iCCP' chunk (profile name, a zero, method 0, the deflated profile) as chunk bytes.
export async function pngProfileChunk(id) {
  const name = COLOR_SPACES[id].description.slice(0, 79);
  const packed = await deflate(iccProfile(id));
  const data = new Uint8Array(name.length + 2 + packed.length);
  for (let i = 0; i < name.length; i++) data[i] = name.charCodeAt(i);
  data[name.length + 1] = 0;
  data.set(packed, name.length + 2);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set([0x69, 0x43, 0x43, 0x50], 4); // 'iCCP'
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// A PNG file with the space's profile in it (any sRGB, gAMA, cHRM or iCCP chunk it had is replaced).
export async function tagPng(png, id) {
  if (id === 'srgb' || !COLOR_SPACES[id]) return png;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const parts = [png.subarray(0, 8)];
  const profile = await pngProfileChunk(id);
  let at = 8;
  while (at + 12 <= png.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(png[at + 4], png[at + 5], png[at + 6], png[at + 7]);
    const chunk = png.subarray(at, at + 12 + len);
    if (!['sRGB', 'gAMA', 'cHRM', 'iCCP'].includes(type)) parts.push(chunk);
    if (type === 'IHDR') parts.push(profile);
    at += 12 + len;
  }
  return concat(parts);
}

// A JPEG file with the space's profile in an APP2 segment, after the JFIF
// header. A profile the file already has (browsers write sRGB's) is taken out.
export function tagJpeg(jpeg, id) {
  if (id === 'srgb' || !COLOR_SPACES[id]) return jpeg;
  const profile = iccProfile(id);
  const seg = new Uint8Array(4 + 12 + 2 + profile.length);
  seg[0] = 0xff;
  seg[1] = 0xe2;
  new DataView(seg.buffer).setUint16(2, 2 + 12 + 2 + profile.length);
  seg.set([0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0], 4); // 'ICC_PROFILE\0'
  seg[16] = 1; // chunk 1 of 1
  seg[17] = 1;
  seg.set(profile, 18);
  const isIcc = (at) => jpeg[at + 1] === 0xe2 && String.fromCharCode(...jpeg.subarray(at + 4, at + 15)) === 'ICC_PROFILE';
  const parts = [jpeg.subarray(0, 2)];
  let at = 2;
  let placed = false;
  // Header segments up to the scan: all kept but the old profile, ours after the JFIF one (or first).
  while (at + 4 <= jpeg.length && jpeg[at] === 0xff && jpeg[at + 1] !== 0xda) {
    const end = at + 2 + ((jpeg[at + 2] << 8) | jpeg[at + 3]);
    if (!placed && jpeg[at + 1] !== 0xe0) {
      parts.push(seg);
      placed = true;
    }
    if (!isIcc(at)) parts.push(jpeg.subarray(at, end));
    at = end;
  }
  if (!placed) parts.push(seg);
  parts.push(jpeg.subarray(at));
  return concat(parts);
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
