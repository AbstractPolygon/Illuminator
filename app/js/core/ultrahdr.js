// An HDR photo as a JPEG with a gain map ("Ultra HDR": Google's container format with the Adobe gain map metadata). The file is two JPEGs in one: the ordinary picture (any program shows
// that one) and a small second picture, the gain map, that says by how much each color is brighter than white in the HDR version. A program that understands it shows the highlights
// the picture kept above white; every other program shows the ordinary picture. Pure byte work, so it can be tested without a browser.
//
// How the HDR version is found from the two pictures (the same formula the Adobe and Google specifications give, with no offsets and a gamma of 1):
//   hdr (linear light, white = 1) = sdr (linear light) * 2 ^ (gain * GAIN_LOG2_MAX)      per channel, gain = the gain map's value from 0 to 1
// so a gain map value of 0 leaves a color as it is and 1 makes it 2 ^ GAIN_LOG2_MAX times brighter.

// The most a color can be brighter than white in a file: 3 stops, 8 times. (A brighter highlight is held at 8.)
export const GAIN_LOG2_MAX = 3;

const te = new TextEncoder();
const td = new TextDecoder();

const NS_XMP = 'http://ns.adobe.com/xap/1.0/\0';

// The offset of the first marker segment that is not the JFIF header: where the new segments go (after SOI and a leading APP0).
function insertionPoint(jpeg) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('Not a JPEG file');
  let at = 2;
  if (jpeg[at] === 0xff && jpeg[at + 1] === 0xe0) at += 2 + ((jpeg[at + 2] << 8) | jpeg[at + 3]);
  return at;
}

// A marker segment: FF, the marker, the length (counting itself) and the payload.
function segment(marker, payload) {
  const length = payload.length + 2;
  if (length > 0xffff) throw new Error('A JPEG segment cannot be longer than 65533 bytes');
  const out = new Uint8Array(2 + length);
  out[0] = 0xff;
  out[1] = marker;
  out[2] = length >> 8;
  out[3] = length & 255;
  out.set(payload, 4);
  return out;
}

function xmpSegment(xml) {
  const head = te.encode(NS_XMP);
  const body = te.encode(xml);
  const payload = new Uint8Array(head.length + body.length);
  payload.set(head, 0);
  payload.set(body, head.length);
  return segment(0xe1, payload);
}

const WRAP = (inner) => `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 5.1.2"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">${inner}</rdf:RDF></x:xmpmeta>`;

// The gain map's own metadata (Adobe's hdr-gain-map namespace).
function gainMapXmp() {
  return WRAP(`<rdf:Description rdf:about="" xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0" hdrgm:GainMapMin="0" hdrgm:GainMapMax="${GAIN_LOG2_MAX}" hdrgm:Gamma="1" hdrgm:OffsetSDR="0" hdrgm:OffsetHDR="0" hdrgm:HDRCapacityMin="0" hdrgm:HDRCapacityMax="${GAIN_LOG2_MAX}" hdrgm:BaseRenditionIsHDR="False"/>`);
}

// The ordinary picture's metadata: it lists the two pictures in the file (Google's container directory).
function primaryXmp(gainLength) {
  return WRAP(`<rdf:Description rdf:about="" xmlns:Container="http://ns.google.com/photos/1.0/container/" xmlns:Item="http://ns.google.com/photos/1.0/container/item/" xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0"><Container:Directory><rdf:Seq><rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"/></rdf:li><rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="GainMap" Item:Mime="image/jpeg" Item:Length="${gainLength}"/></rdf:li></rdf:Seq></Container:Directory></rdf:Description>`);
}

// The Multi-Picture Format segment (APP2): where the second picture starts. All numbers big endian. `primaryLength`: the whole ordinary picture (with the segments added
// here); `gainOffset`: where the gain map starts, counted from the first byte after "MPF\0".
function mpfSegment(primaryLength, gainLength, gainOffset) {
  const out = new Uint8Array(4 + 8 + 2 + 3 * 12 + 4 + 2 * 16);
  const v = new DataView(out.buffer);
  out.set(te.encode('MPF\0'), 0);
  let p = 4; // the MP header starts here: the offsets below count from this byte
  v.setUint16(p, 0x4d4d); // 'MM': big endian
  v.setUint16(p + 2, 0x002a);
  v.setUint32(p + 4, 8); // the first (only) IFD follows the 8 byte header
  p += 8;
  v.setUint16(p, 3); // three tags
  p += 2;
  const tag = (id, type, count, value) => {
    v.setUint16(p, id);
    v.setUint16(p + 2, type);
    v.setUint32(p + 4, count);
    if (typeof value === 'string') out.set(te.encode(value), p + 8);
    else v.setUint32(p + 8, value);
    p += 12;
  };
  tag(0xb000, 7, 4, '0100'); // MP format version
  tag(0xb001, 4, 1, 2); // number of pictures
  tag(0xb002, 7, 32, 8 + 2 + 3 * 12 + 4); // the MP entries, right after this IFD (offset from the MP header)
  v.setUint32(p, 0); // no next IFD
  p += 4;
  // MP entries: attribute, size, offset, two dependent image numbers.
  v.setUint32(p, 0x20030000); // the representative (ordinary) picture, baseline JPEG
  v.setUint32(p + 4, primaryLength);
  v.setUint32(p + 8, 0);
  p += 16;
  v.setUint32(p, 0x00000000); // the second picture
  v.setUint32(p + 4, gainLength);
  v.setUint32(p + 8, gainOffset);
  return segment(0xe2, out);
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of parts) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}

// The file from the two JPEGs: `base`, the ordinary picture (sRGB, 8 bits), and `gain`, the gain map (a JPEG as big as `base` or smaller; its three channels are the gain of red,
// green and blue, 0 to 255 for 0 to 1). Returns the file as a Uint8Array.
export function buildUltraHdr(base, gain) {
  const gainAt = insertionPoint(gain);
  const gainFile = concat([gain.subarray(0, gainAt), xmpSegment(gainMapXmp()), gain.subarray(gainAt)]);
  const at = insertionPoint(base);
  const xmp = xmpSegment(primaryXmp(gainFile.length));
  const mpfLength = 4 + 4 + 8 + 2 + 3 * 12 + 4 + 2 * 16; // marker, length and payload of the MPF segment
  const primaryLength = base.length + xmp.length + mpfLength;
  const mpfStart = at + xmp.length; // where the MPF segment starts in the file
  const mpHeader = mpfStart + 2 + 2 + 4; // the first byte after "MPF\0"
  const mpf = mpfSegment(primaryLength, gainFile.length, primaryLength - mpHeader);
  if (mpf.length !== mpfLength) throw new Error('The Multi-Picture segment has an unexpected size');
  return concat([base.subarray(0, at), xmp, mpf, base.subarray(at), gainFile]);
}

// ---------------------------------------------------------------- reading (for tests, and to check a file just written)
function segments(jpeg) {
  const out = [];
  let at = 2;
  while (at + 4 <= jpeg.length && jpeg[at] === 0xff) {
    const marker = jpeg[at + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const length = (jpeg[at + 2] << 8) | jpeg[at + 3];
    out.push({ marker, start: at, payload: jpeg.subarray(at + 4, at + 2 + length) });
    at += 2 + length;
  }
  return out;
}

// { primary, gain, gainMeta } from a file made by buildUltraHdr (or another Ultra HDR file with the same layout); throws when it is not one.
export function readUltraHdr(file) {
  const parts = segments(file);
  const mpf = parts.find((s) => s.marker === 0xe2 && td.decode(s.payload.subarray(0, 4)) === 'MPF\0');
  if (!mpf) throw new Error('No Multi-Picture segment');
  const view = new DataView(mpf.payload.buffer, mpf.payload.byteOffset + 4, mpf.payload.length - 4);
  const little = view.getUint16(0) === 0x4949;
  const count = view.getUint16(view.getUint32(4, little), little);
  let entries = null;
  let ifd = view.getUint32(4, little) + 2;
  for (let i = 0; i < count; i++, ifd += 12) {
    if (view.getUint16(ifd, little) === 0xb002) entries = view.getUint32(ifd + 8, little);
  }
  if (entries == null) throw new Error('No Multi-Picture entries');
  const pictures = [];
  for (let i = 0; i < 2; i++) {
    const size = view.getUint32(entries + 16 * i + 4, little);
    const offset = view.getUint32(entries + 16 * i + 8, little);
    const start = i === 0 ? 0 : mpf.start + 8 + offset;
    pictures.push(file.subarray(start, start + size));
  }
  const gainParts = segments(pictures[1]);
  const xmp = gainParts.filter((s) => s.marker === 0xe1).map((s) => td.decode(s.payload)).find((t) => t.includes('hdrgm:GainMapMax'));
  if (!xmp) throw new Error('No gain map metadata');
  const num = (name) => +new RegExp(`hdrgm:${name}="([^"]*)"`).exec(xmp)[1];
  return { primary: pictures[0], gain: pictures[1], gainMeta: { min: num('GainMapMin'), max: num('GainMapMax'), gamma: num('Gamma'), capacityMax: num('HDRCapacityMax') } };
}

// The linear value of the HDR picture from the ordinary picture's linear value `sdr` and the gain map value `gain` (0 to 255): what a viewer computes.
export function applyGain(sdr, gain, meta = { min: 0, max: GAIN_LOG2_MAX, gamma: 1 }) {
  const g = Math.pow(gain / 255, 1 / meta.gamma);
  return sdr * Math.pow(2, meta.min + g * (meta.max - meta.min));
}

// The gain map value (0 to 255) for a channel that is `linear` (white = 1) in the HDR picture: 0 up to white, then log2 over the range, capped at the most a file holds.
export function gainByte(linear) {
  if (!(linear > 1)) return 0;
  return Math.round(255 * Math.min(1, Math.log2(linear) / GAIN_LOG2_MAX));
}

// ---------------------------------------------------------------- the HDR picture as linear light (for the HDR TIFF)
let DECODE = null;
// sRGB value (16 bits) -> linear light, as a table.
function decodeTable() {
  if (DECODE) return DECODE;
  DECODE = new Float32Array(65536);
  for (let i = 0; i < 65536; i++) {
    const v = i / 65535;
    DECODE[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  return DECODE;
}

// The HDR picture in linear light, white = 1 (values above 1 are the highlights), as Float32Array RGB: the saved picture `rgb` (16-bit sRGB, width x height) times its gain map `gain`
// (8-bit, three channels, gainW x gainH: smaller than the picture is fine, it is read in between its pixels).
export function hdrLinearRgb(rgb, width, height, gain, gainW, gainH) {
  if (rgb.length !== width * height * 3) throw new Error('hdrLinearRgb: the picture does not match its size');
  if (gain.length !== gainW * gainH * 3) throw new Error('hdrLinearRgb: the gain map does not match its size');
  const table = decodeTable();
  const out = new Float32Array(rgb.length);
  const boost = new Float32Array(256); // 2 ^ (gain * stops)
  for (let g = 0; g < 256; g++) boost[g] = Math.pow(2, (g / 255) * GAIN_LOG2_MAX);
  const same = gainW === width && gainH === height;
  const sx = gainW / width;
  const sy = gainH / height;
  for (let y = 0; y < height; y++) {
    // (the gain map's pixel centers: the picture pixel (x, y) is at ((x + 0.5) * sx - 0.5, ...) in the map)
    const fy = Math.min(gainH - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(gainH - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      if (same) {
        for (let c = 0; c < 3; c++) out[o + c] = table[rgb[o + c]] * boost[gain[o + c]];
        continue;
      }
      const fx = Math.min(gainW - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(gainW - 1, x0 + 1);
      const wx = fx - x0;
      for (let c = 0; c < 3; c++) {
        // (interpolated in the stops, which is how the map is read by a viewer too)
        const a = gain[(y0 * gainW + x0) * 3 + c] * (1 - wx) + gain[(y0 * gainW + x1) * 3 + c] * wx;
        const b = gain[(y1 * gainW + x0) * 3 + c] * (1 - wx) + gain[(y1 * gainW + x1) * 3 + c] * wx;
        const g = a * (1 - wy) + b * wy;
        out[o + c] = table[rgb[o + c]] * Math.pow(2, (g / 255) * GAIN_LOG2_MAX);
      }
    }
  }
  return out;
}
