// A TIFF with 32-bit floating-point RGB (the HDR TIFF): light as it is, white = 1, highlights above 1 kept. Written here because the browser has no TIFF encoder. Little endian, one
// plane (RGBRGB...), in strips of about a megabyte, each compressed with Deflate and the floating-point predictor (Adobe Technical Note 3), which makes smooth pictures much smaller;
// the ICC profile (linear sRGB) is in the file so a program reads the numbers right. Read by Photoshop, Affinity, Krita, Blender, DaVinci Resolve, libtiff and others.

const T = { SHORT: 3, LONG: 4, UNDEFINED: 7 };
const STRIP_BYTES = 1 << 20;

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// One row of floats made ready for Deflate (Technical Note 3): the bytes of all the values split into four planes, most significant byte first, then each byte
// replaced by its difference from the same byte of the previous pixel.
export function predictFloatRow(row, samples, perPixel) {
  const n = samples; // values in the row
  const view = new DataView(row.buffer, row.byteOffset, n * 4);
  const planes = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const bits = view.getUint32(i * 4, true);
    planes[i] = bits >>> 24;
    planes[n + i] = (bits >>> 16) & 255;
    planes[2 * n + i] = (bits >>> 8) & 255;
    planes[3 * n + i] = bits & 255;
  }
  for (let j = planes.length - 1; j >= perPixel; j--) planes[j] = (planes[j] - planes[j - perPixel]) & 255;
  return planes;
}

// `rgb`: Float32Array width * height * 3, the first row the top. `icc`: the profile bytes (or none). Returns the file as a Uint8Array.
export async function encodeTiffFloat(rgb, width, height, { icc = null, compress = true } = {}) {
  if (rgb.length !== width * height * 3) throw new Error('encodeTiffFloat: the picture does not match its size');
  const rowFloats = width * 3;
  const rowsPerStrip = Math.max(1, Math.min(height, Math.floor(STRIP_BYTES / (rowFloats * 4))));
  const strips = [];
  for (let y = 0; y < height; y += rowsPerStrip) {
    const rows = Math.min(rowsPerStrip, height - y);
    let data;
    if (compress) {
      data = new Uint8Array(rows * rowFloats * 4);
      for (let r = 0; r < rows; r++) {
        const row = new Uint8Array(rgb.buffer, rgb.byteOffset + (y + r) * rowFloats * 4, rowFloats * 4);
        data.set(predictFloatRow(row, rowFloats, 3), r * rowFloats * 4);
      }
      data = await deflate(data);
    } else {
      data = new Uint8Array(rgb.buffer.slice(rgb.byteOffset + y * rowFloats * 4, rgb.byteOffset + (y + rows) * rowFloats * 4));
    }
    strips.push(data);
  }
  // layout: header, the strips, the values that do not fit in an entry, the entries
  const pad2 = (n) => (n + 1) & ~1;
  let at = 8;
  const stripOffsets = strips.map((s) => {
    const o = at;
    at += pad2(s.length);
    return o;
  });
  const bitsAt = at; // BitsPerSample (3 shorts) then SampleFormat (3 shorts)
  at += 12;
  const stripTablesAt = at; // StripOffsets and StripByteCounts when there is more than one strip
  if (strips.length > 1) at += strips.length * 8;
  const iccAt = at;
  if (icc) at += pad2(icc.length);
  const ifdAt = at;
  const entries = [
    [256, T.LONG, 1, width],
    [257, T.LONG, 1, height],
    [258, T.SHORT, 3, bitsAt],
    [259, T.SHORT, 1, compress ? 8 : 1],
    [262, T.SHORT, 1, 2],
    [273, T.LONG, strips.length, strips.length > 1 ? stripTablesAt : stripOffsets[0]],
    [277, T.SHORT, 1, 3],
    [278, T.LONG, 1, rowsPerStrip],
    [279, T.LONG, strips.length, strips.length > 1 ? stripTablesAt + strips.length * 4 : strips[0].length],
    [284, T.SHORT, 1, 1],
    ...(compress ? [[317, T.SHORT, 1, 3]] : []),
    [339, T.SHORT, 3, bitsAt + 6],
    ...(icc ? [[34675, T.UNDEFINED, icc.length, iccAt]] : []),
  ];
  const total = ifdAt + 2 + entries.length * 12 + 4;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  out[0] = 0x49; // 'II'
  out[1] = 0x49;
  v.setUint16(2, 42, true);
  v.setUint32(4, ifdAt, true);
  strips.forEach((s, i) => out.set(s, stripOffsets[i]));
  for (let i = 0; i < 3; i++) {
    v.setUint16(bitsAt + 2 * i, 32, true);
    v.setUint16(bitsAt + 6 + 2 * i, 3, true); // IEEE floating point
  }
  if (strips.length > 1) {
    strips.forEach((s, i) => {
      v.setUint32(stripTablesAt + 4 * i, stripOffsets[i], true);
      v.setUint32(stripTablesAt + strips.length * 4 + 4 * i, s.length, true);
    });
  }
  if (icc) out.set(icc, iccAt);
  v.setUint16(ifdAt, entries.length, true);
  entries.forEach(([tag, type, count, value], i) => {
    const e = ifdAt + 2 + 12 * i;
    v.setUint16(e, tag, true);
    v.setUint16(e + 2, type, true);
    v.setUint32(e + 4, count, true);
    if (type === T.SHORT && count === 1) v.setUint16(e + 8, value, true);
    else v.setUint32(e + 8, value, true);
  });
  return out;
}
