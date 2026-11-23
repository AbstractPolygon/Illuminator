// A baseline JPEG decoder for the one kind of picture the Light L16's stacked captures carry: one 8-bit gray component, 1 x 1 sampling, Huffman coded (core/lri.js decodeFrame). It reads the
// quantization and Huffman tables the file gives and the restart interval, and returns the samples. Progressive, arithmetic coded, 12-bit and color pictures are refused.

const ZIGZAG = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];

// The inverse DCT cosines: C[x][u] = c(u) / 2 * cos((2x + 1) u pi / 16)
const COS = (() => {
  const c = new Float64Array(64);
  for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) c[x * 8 + u] = ((u === 0 ? Math.SQRT1_2 : 1) / 2) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  return c;
})();

function buildHuffman(counts, symbols) {
  // canonical codes by length: for each length, the first code, the index of its first symbol, and how many there are
  const first = new Int32Array(17);
  const index = new Int32Array(17);
  const count = new Int32Array(17);
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    first[len] = code;
    index[len] = k;
    count[len] = counts[len - 1];
    code = (code + counts[len - 1]) << 1;
    k += counts[len - 1];
  }
  return { first, index, count, symbols };
}

// Decodes the JPEG in bytes[start, start + length). Returns { width, height, data: Uint8Array (row major) }.
export function decodeGrayJpeg(bytes, start = 0, length = bytes.length - start) {
  const end = start + length;
  let p = start;
  if (bytes[p] !== 0xff || bytes[p + 1] !== 0xd8) throw new Error('This is not a JPEG picture');
  p += 2;
  const quant = [];
  const dcTables = [];
  const acTables = [];
  let width = 0;
  let height = 0;
  let restart = 0;
  let scanTables = null;
  let quantId = 0;
  while (p + 4 <= end) {
    if (bytes[p] !== 0xff) throw new Error('The JPEG picture is damaged');
    const marker = bytes[p + 1];
    if (marker === 0xff) {
      p++;
      continue;
    }
    const len = (bytes[p + 2] << 8) | bytes[p + 3];
    const seg = p + 4;
    if (marker === 0xdb) {
      let q = seg;
      while (q < p + 2 + len) {
        const pq = bytes[q] >> 4;
        const id = bytes[q] & 15;
        q++;
        const table = new Int32Array(64);
        for (let i = 0; i < 64; i++) {
          table[ZIGZAG[i]] = pq ? (bytes[q] << 8) | bytes[q + 1] : bytes[q];
          q += pq ? 2 : 1;
        }
        quant[id] = table;
      }
    } else if (marker === 0xc0) {
      if (bytes[seg] !== 8) throw new Error('Only 8-bit JPEG pictures are supported');
      height = (bytes[seg + 1] << 8) | bytes[seg + 2];
      width = (bytes[seg + 3] << 8) | bytes[seg + 4];
      if (bytes[seg + 5] !== 1) throw new Error('Only gray JPEG pictures are supported');
      if (bytes[seg + 7] !== 0x11) throw new Error('Only JPEG pictures without subsampling are supported');
      quantId = bytes[seg + 8];
    } else if (marker === 0xc1 || marker === 0xc2 || (marker >= 0xc3 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)) {
      throw new Error('Only baseline JPEG pictures are supported');
    } else if (marker === 0xc4) {
      let q = seg;
      while (q < p + 2 + len) {
        const cls = bytes[q] >> 4;
        const id = bytes[q] & 15;
        q++;
        const counts = bytes.subarray(q, q + 16);
        q += 16;
        const total = counts.reduce((a, b) => a + b, 0);
        const table = buildHuffman(counts, bytes.subarray(q, q + total));
        q += total;
        (cls ? acTables : dcTables)[id] = table;
      }
    } else if (marker === 0xdd) {
      restart = (bytes[seg] << 8) | bytes[seg + 1];
    } else if (marker === 0xda) {
      if (bytes[seg] !== 1) throw new Error('Only gray JPEG pictures are supported');
      scanTables = { dc: dcTables[bytes[seg + 2] >> 4], ac: acTables[bytes[seg + 2] & 15] };
      p = p + 2 + len;
      break;
    }
    p += 2 + len;
  }
  if (!scanTables || !width || !height) throw new Error('The JPEG picture has no scan');
  const q = quant[quantId];
  if (!q || !scanTables.dc || !scanTables.ac) throw new Error('The JPEG picture is missing a table');

  // the entropy coded data: bits MSB first, 0xFF 0x00 is a 0xFF, a restart marker ends a segment
  let bitBuf = 0;
  let bitCount = 0;
  let marked = false;
  const nextBit = () => {
    if (bitCount === 0) {
      if (p >= end || marked) {
        bitBuf = 0;
      } else {
        const b = bytes[p++];
        if (b === 0xff) {
          const n = bytes[p];
          if (n === 0) p++;
          else {
            marked = true;
            p--;
            bitBuf = 0;
            bitCount = 8;
            return 0;
          }
        }
        bitBuf = b;
      }
      bitCount = 8;
    }
    bitCount--;
    return (bitBuf >> bitCount) & 1;
  };
  const receive = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | nextBit();
    return v;
  };
  const extend = (v, n) => (n === 0 ? 0 : v < 1 << (n - 1) ? v - (1 << n) + 1 : v);
  const decodeSymbol = (t) => {
    let code = 0;
    for (let len = 1; len <= 16; len++) {
      code = (code << 1) | nextBit();
      const off = code - t.first[len];
      if (off >= 0 && off < t.count[len]) return t.symbols[t.index[len] + off];
    }
    throw new Error('The JPEG picture is damaged');
  };

  const bw = (width + 7) >> 3;
  const bh = (height + 7) >> 3;
  const out = new Uint8Array(bw * 8 * bh * 8);
  const stride = bw * 8;
  const block = new Float64Array(64);
  const tmp = new Float64Array(64);
  let pred = 0;
  let done = 0;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      if (restart && done > 0 && done % restart === 0) {
        // skip to the restart marker and start the next segment
        bitCount = 0;
        marked = false;
        while (p + 1 < end && !(bytes[p] === 0xff && bytes[p + 1] >= 0xd0 && bytes[p + 1] <= 0xd7)) p++;
        p += 2;
        pred = 0;
      }
      block.fill(0);
      const s = decodeSymbol(scanTables.dc);
      pred += extend(receive(s), s);
      block[0] = pred * q[0];
      for (let k = 1; k < 64; ) {
        const rs = decodeSymbol(scanTables.ac);
        const r = rs >> 4;
        const sz = rs & 15;
        if (sz === 0) {
          if (r === 15) {
            k += 16;
            continue;
          }
          break;
        }
        k += r;
        if (k > 63) break;
        const z = ZIGZAG[k];
        block[z] = extend(receive(sz), sz) * q[z];
        k++;
      }
      // inverse DCT: rows then columns
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          let sum = 0;
          for (let u = 0; u < 8; u++) sum += COS[x * 8 + u] * block[y * 8 + u];
          tmp[y * 8 + x] = sum;
        }
      }
      for (let x = 0; x < 8; x++) {
        for (let y = 0; y < 8; y++) {
          let sum = 0;
          for (let v = 0; v < 8; v++) sum += COS[y * 8 + v] * tmp[v * 8 + x];
          const val = Math.round(sum + 128);
          out[(by * 8 + y) * stride + bx * 8 + x] = val < 0 ? 0 : val > 255 ? 255 : val;
        }
      }
      done++;
    }
  }
  if (stride === width) return { width, height, data: out.subarray(0, width * height) };
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) data.set(out.subarray(y * stride, y * stride + width), y * width);
  return { width, height, data };
}
