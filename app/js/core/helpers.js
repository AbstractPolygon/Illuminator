// Small helpers that several core modules use, kept in one place. Each gives exactly the numbers (or bytes) of the copies it replaced, for every input: where those
// copies differed (edge handling, rounding, the guard for an empty span), the difference is an option or a function of its own.

// ---------------------------------------------------------------- numbers

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const clamp01 = (v) => Math.min(1, Math.max(0, v));

// 0 below a, 1 above b, the smooth cubic between.
export function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
// The same with a and b equal treated as a span of 1e-6 (a step at a), not a division by zero.
export function smoothstepSafe(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-6)));
  return t * t * (3 - 2 * t);
}

// The brightness the Light L16 merge compares cameras on (its weights, not Rec. 709's).
export const l16Luma = (r, g, b) => 0.3 * r + 0.55 * g + 0.15 * b;

// A fixed sequence of numbers in 0..1 from `seed` (the Park-Miller generator): the same seed gives the same picture every time.
export function parkMiller(seed) {
  return () => (seed = (seed * 16807) % 2147483647) / 2147483647;
}

// A picture of 3 values a pixel (w x h) sampled bilinearly at (sx, sy), pixel centers at half pixels, into o[0..2]. False (o untouched) where the four pixels around it
// are not all inside the picture.
export function bilinear3(img, w, h, sx, sy, o) {
  const x = sx - 0.5;
  const y = sy - 0.5;
  if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return false;
  const x0 = x | 0;
  const y0 = y | 0;
  const fx = x - x0;
  const fy = y - y0;
  const i = 3 * (y0 * w + x0);
  for (let c = 0; c < 3; c++) o[c] = (img[i + c] * (1 - fx) + img[i + 3 + c] * fx) * (1 - fy) + (img[i + 3 * w + c] * (1 - fx) + img[i + 3 * w + 3 + c] * fx) * fy;
  return true;
}

// Box blur of radius r (the mean over a (2r + 1) square, the edge pixels repeated), `passes` times (two are close to a Gaussian), as running sums: along the rows,
// then down the columns. `channels` values a pixel are blurred, of `stride` stored (RGBA: channels 3, stride 4; the others come out 0). Returns a new Float32Array:
// w * h values for one value a pixel, else as long as src.
export function boxBlur(src, w, h, r, { channels = 1, stride = channels, passes = 1 } = {}) {
  let a = src;
  for (let p = 0; p < passes; p++) a = boxBlurOnce(a, w, h, r, channels, stride);
  return a;
}

function boxBlurOnce(src, w, h, r, channels, stride) {
  const len = stride === 1 ? w * h : src.length;
  const tmp = new Float32Array(len);
  const out = new Float32Array(len);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < channels; c++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += src[(y * w + Math.min(w - 1, Math.max(0, k))) * stride + c];
      for (let x = 0; x < w; x++) {
        tmp[(y * w + x) * stride + c] = acc / n;
        const add = Math.min(w - 1, x + r + 1);
        const sub = Math.max(0, x - r);
        acc += src[(y * w + add) * stride + c] - src[(y * w + sub) * stride + c];
      }
    }
  }
  // (the columns together, row by row: the sums are the same as one column at a time, and memory is read in order)
  const row = w * stride;
  const acc = new Float64Array(row);
  for (let k = -r; k <= r; k++) {
    const at = Math.min(h - 1, Math.max(0, k)) * row;
    for (let i = 0; i < row; i++) acc[i] += tmp[at + i];
  }
  for (let y = 0; y < h; y++) {
    const o = y * row;
    const add = Math.min(h - 1, y + r + 1) * row;
    const sub = Math.max(0, y - r) * row;
    for (let i = 0; i < row; i++) {
      out[o + i] = acc[i] / n;
      acc[i] += tmp[add + i] - tmp[sub + i];
    }
  }
  return out;
}

// ---------------------------------------------------------------- bytes

let crcTable = null;
// The CRC-32 of `bytes` (as PNG and zip use it); `crc` continues one over several pieces.
export function crc32(bytes, crc = 0) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// The pieces one after the other, in one Uint8Array.
export function concatBytes(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// zlib (RFC 1950) compression of `bytes`.
export async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// The bytes zlib data unpacks to. `limit` stops a decompression bomb: the stream is cancelled once it yields more than that, and the result is null.
export async function inflate(bytes, limit = Infinity) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  return concatBytes(parts);
}
