// The picture of a Light L16 photo: the pictures of its cameras merged into one on the reference camera's grid.
//
// Each camera of the reference's group (same focal length) sees the scene from a slightly different place. With the depth known, every pixel of the reference can be looked up in
// the other cameras (calibrated pose, intrinsics and lens distortion), where it is the same point of the scene. The pictures are averaged where they agree (what differs is
// something one camera saw that another did not, an occlusion, or noise too strong to share), which lowers noise by about the square root of the number of cameras, and the
// output is on the undistorted grid, so the lens distortion is corrected on the way.
//
// Each camera is first demosaiced at full size (Malvar, He and Cutler: a 5 x 5 linear filter that follows the missing colors' correlation with the sampled one).
import { decodeFrame } from './lri.js';
import { cameraModel } from './l16geometry.js';
import { relativePose } from './l16depth.js';

// Linear 0..1 full size RGB of a module's frame: black level removed, demosaiced, white balance gains applied. Float32Array(3 * w * h).
// `win` ({ x0, y0, w, h }) limits the work to a window of the frame (returned at that size, from the sensor's pixels around it); `rawCache` (a Map kept by the caller) keeps
// each module's unpacked frame between calls.
export function demosaic(bytes, frame, { black = 42, white = 1023, gains = [1, 1, 1], hot = true } = {}, win = null, rawCache = null) {
  const key = frame.module.id;
  // (on the graphics card, from the file's packed rows: no unpacking here; the processor's below if it fails)
  const packed = prepOnCard ? packedRows(bytes, frame) : null;
  if (packed) {
    const { x: SW, y: SH } = frame.module.sensor_data_surface.size;
    const r = win ? windowRect(SW, SH, win) : { x0: 0, y0: 0, x1: SW, y1: SH, ex0: 0, ey0: 0, ex1: SW, ey1: SH };
    const part = fullOnCard({ packed: { ...packed, x0: r.ex0, y0: r.ey0, black, scale: 1 / (white - black) } }, frame, r.ex1 - r.ex0, r.ey1 - r.ey0, { gains, hot });
    if (part) return win ? cropWindow(part, r) : part;
  }
  let decoded = rawCache && rawCache.get(key);
  if (!decoded) {
    decoded = decodeFrame(bytes, frame);
    if (rawCache) rawCache.set(key, decoded);
  }
  if (win) return demosaicWindow(decoded, frame, { black, white, gains, hot }, win);
  return demosaicRaw(decoded, frame, { black, white, gains, hot });
}

// Hot and dead pixels: a pixel far brighter than every neighbour of its own color (or far darker than all of them) is replaced by their mean. `step` is the distance to the neighbours of the same
// color (2 on a Bayer mosaic, 1 on the monochrome sensor). Without this a hot pixel becomes a colored square after the demosaic, and the telephoto detail would copy it into the picture.
function removeSpecks(px, W, H, step) {
  const out = [];
  const at = (x, y) => px[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];
  const test = (i, v, a, b, c, d, e, f, g, h) => {
    let hi = a > b ? a : b;
    let lo = a < b ? a : b;
    for (const n of [c, d, e, f, g, h]) {
      if (n > hi) hi = n;
      if (n < lo) lo = n;
    }
    if (v > hi * 1.5 + 0.03 || (lo > 0.12 && v < lo * 0.3)) out.push(i, (a + b + c + d) / 4);
  };
  // The edge rows and columns (neighbours past the edge are the edge's pixels), then the inside, where every neighbour is in the picture: read straight, with no
  // bounds to check (most of the time of this step was the checks).
  const edge = (x, y) => test(y * W + x, px[y * W + x], at(x - step, y), at(x + step, y), at(x, y - step), at(x, y + step), at(x - step, y - step), at(x + step, y - step), at(x - step, y + step), at(x + step, y + step));
  for (let y = 0; y < H; y++) {
    if (y < step || y >= H - step) {
      for (let x = 0; x < W; x++) edge(x, y);
      continue;
    }
    for (let x = 0; x < Math.min(step, W); x++) edge(x, y);
    const up = -step * W;
    const dn = step * W;
    for (let x = step, i = y * W + step; x < W - step; x++, i++) {
      const v = px[i];
      const a = px[i - step];
      const b = px[i + step];
      const c = px[i + up];
      const d = px[i + dn];
      // (most pixels pass at once: a hot pixel is brighter than 1.5 times its brightest side neighbour and more, a dead one darker than 0.3 times its darkest; only the
      // rest are tested against all eight)
      const m4 = a > b ? (a > c ? (a > d ? a : d) : c > d ? c : d) : b > c ? (b > d ? b : d) : c > d ? c : d;
      const n4 = a < b ? (a < c ? (a < d ? a : d) : c < d ? c : d) : b < c ? (b < d ? b : d) : c < d ? c : d;
      if (v <= m4 * 1.5 + 0.03 && v >= n4 * 0.3) continue;
      test(i, v, a, b, c, d, px[i + up - step], px[i + up + step], px[i + dn - step], px[i + dn + step]);
    }
    for (let x = Math.max(step, W - step); x < W; x++) edge(x, y);
  }
  // (replaced after the search, so one pixel's fix is not another's neighbour)
  for (let i = 0; i < out.length; i += 2) px[out[i]] = out[i + 1];
}

// ----- lateral chromatic aberration
// Each camera's lens draws red and blue a little larger or smaller than green (the calibration has one distortion for all three). It is measured on the camera's picture
// itself, once a photo: the shift of red and of blue against green over tiles of the picture, along the radius, fitted as a shift growing in proportion to the distance from the
// center ({ r, b }: pixels at the corner, of the picture it was measured on). Kept per camera frame.
const chromaOf = new WeakMap();
export const chromaFor = (frame) => chromaOf.get(frame) || null;
// The tiles the shift is measured over (n x n pixels each, at x0, y0), in the order the fit takes them.
export function chromaTiles(W, H) {
  const n = Math.max(16, Math.round(W / 16));
  const tiles = [];
  for (let ty = 1; ty < 11; ty++) {
    for (let tx = 1; tx < 15; tx++) {
      const x0 = Math.round((tx * W) / 16);
      const y0 = Math.round((ty * H) / 12);
      if (x0 + n >= W - 1 || y0 + n >= H - 1) continue;
      tiles.push([x0, y0]);
    }
  }
  return { n, tiles };
}
// A tile's sums, for red (c 0) or blue (c 2) against green: [green, the channel (both over the tile), and over its inside (the green gradient gx, gy, the channel v and
// green g): gx gx, gx gy, gy gy, gx v, gx g, gy v, gy g].
export const CHROMA_SUMS = 9;
function tileSums(rgb, W, c, x0, y0, n) {
  let mg = 0;
  let mv = 0;
  for (let y = y0; y < y0 + n; y++) for (let x = x0; x < x0 + n; x++) {
    mg += rgb[3 * (y * W + x) + 1];
    mv += rgb[3 * (y * W + x) + c];
  }
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sxv = 0;
  let sxg = 0;
  let syv = 0;
  let syg = 0;
  for (let y = y0 + 1; y < y0 + n - 1; y++) {
    for (let x = x0 + 1; x < x0 + n - 1; x++) {
      const i = y * W + x;
      const gx = (rgb[3 * (i + 1) + 1] - rgb[3 * (i - 1) + 1]) / 2;
      const gy = (rgb[3 * (i + W) + 1] - rgb[3 * (i - W) + 1]) / 2;
      const v = rgb[3 * i + c];
      const g = rgb[3 * i + 1];
      sxx += gx * gx;
      sxy += gx * gy;
      syy += gy * gy;
      sxv += gx * v;
      sxg += gx * g;
      syv += gy * v;
      syg += gy * g;
    }
  }
  return [mg, mv, sxx, sxy, syy, sxv, sxg, syv, syg];
}
// The shift of the channel against green over a tile, from its sums (least squares of the channel, scaled to green's level, against green moved by the shift), or null
// where the tile has too little detail or the shift found is implausible.
function shiftFromSums([mg, mv, sxx, sxy, syy, sxv, sxg, syv, syg], n) {
  if (!(mv > 1e-6) || !(mg > 1e-6)) return null;
  const k = mg / mv;
  const sxt = k * sxv - sxg;
  const syt = k * syv - syg;
  const det = sxx * syy - sxy * sxy;
  const mean = mg / (n * n);
  if (det < 1e-12 || (sxx + syy) / (n * n) < 1e-4 * mean * mean) return null;
  const dx = (syy * sxt - sxy * syt) / det;
  const dy = (sxx * syt - sxy * sxt) / det;
  return Math.hypot(dx, dy) < 3 ? [dx, dy] : null;
}
// `sumsOf(c, tiles, n)`: every tile's sums for channel c (CHROMA_SUMS each, in order), here or on the graphics card.
function measureChroma(rgb, W, H, sumsOf = null) {
  const out = {};
  const R = Math.hypot(W / 2, H / 2);
  const { n, tiles } = chromaTiles(W, H);
  for (const [key, c] of [['r', 0], ['b', 2]]) {
    const sums = sumsOf ? sumsOf(c, tiles, n) : null;
    // shift = s * (position - middle) / R + t, fitted over the tiles in both directions (s: the spread, pixels at the corner; t: where the lens's center is, in effect)
    let suu = 0;
    let su = 0;
    let sv = 0;
    let rs = 0;
    let rx = 0;
    let ry = 0;
    let used = 0;
    tiles.forEach(([x0, y0], t) => {
      const d = shiftFromSums(sums ? Array.from(sums.subarray(t * CHROMA_SUMS, (t + 1) * CHROMA_SUMS)) : tileSums(rgb, W, c, x0, y0, n), n);
      if (!d) return;
      const u = (x0 + n / 2 - W / 2) / R;
      const v = (y0 + n / 2 - H / 2) / R;
      suu += u * u + v * v;
      su += u;
      sv += v;
      rs += u * d[0] + v * d[1];
      rx += d[0];
      ry += d[1];
      used++;
    });
    if (used < 30) {
      out[key] = { s: 0, tx: 0, ty: 0 };
      continue;
    }
    // (least squares of dx = s u + tx, dy = s v + ty: t eliminated)
    const den = suu - (su * su + sv * sv) / used;
    const s = den > 1e-9 ? (rs - (su * rx + sv * ry) / used) / den : 0;
    const clamp = (x) => Math.max(-3, Math.min(3, x));
    out[key] = { s: clamp(s), tx: clamp((rx - su * s) / used), ty: clamp((ry - sv * s) / used) };
  }
  return out;
}
// Channel c of rgb (W x H) where the lens drew it shifted by m ({ s, tx, ty }, pixels, as measureChroma fits; times `k` for a picture k times as large): looked up there, so it
// lines up with green.
function unshiftChannel(rgb, W, H, c, m, k = 1) {
  if (!m || (!m.s && !m.tx && !m.ty)) return;
  const src = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) src[i] = rgb[3 * i + c];
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.hypot(cx, cy);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      // (the channel at a point shows what green has at the point plus the shift: it is looked up at the point minus the shift)
      const sx = Math.min(W - 1.001, Math.max(0, px - k * (m.s * ((px - cx) / R) + m.tx) - 0.5));
      const sy = Math.min(H - 1.001, Math.max(0, py - k * (m.s * ((py - cy) / R) + m.ty) - 0.5));
      const x0 = sx | 0;
      const y0 = sy | 0;
      const ax = sx - x0;
      const ay = sy - y0;
      const i = y0 * W + x0;
      rgb[3 * (y * W + x) + c] = (src[i] * (1 - ax) + src[i + 1] * ax) * (1 - ay) + (src[i + W] * (1 - ax) + src[i + W + 1] * ax) * ay;
    }
  }
}
// The picture's red and blue lined up with green (`scale`: pixels of this picture per pixel of the half size one, for the measured amounts).
// `card`: the picture on the graphics card (gpu/l16prep.js), which makes the shifted pictures there.
function correctChroma(frame, rgb, W, H, scale, measureHere, card = null) {
  let ca = chromaOf.get(frame);
  if (card) {
    if (!ca && measureHere) {
      const add = (p, q) => ({ s: p.s + q.s, tx: p.tx + q.tx, ty: p.ty + q.ty });
      ca = { r: { s: 0, tx: 0, ty: 0 }, b: { s: 0, tx: 0, ty: 0 } };
      // (measured on the card too, on the picture as it stands after each round; read back once at the end)
      for (let round = 0; round < 3; round++) {
        const m = measureChroma(null, W, H, card.chromaSums);
        ca = { r: add(ca.r, m.r), b: add(ca.b, m.b) };
        card.unshift(ca, scale, false);
        if (Math.max(...[m.r, m.b].flatMap((q) => [q.s, q.tx, q.ty].map(Math.abs))) < 0.02) break;
      }
      chromaOf.set(frame, ca);
      rgb.set(card.current());
      return;
    }
    if (ca) rgb.set(card.unshift(ca, scale));
    return;
  }
  if (!ca && measureHere) {
    // (measured, taken out, and what is left measured again, a few rounds: one measure of a shift this small comes out short)
    const orig = Float32Array.from(rgb);
    const add = (p, q) => ({ s: p.s + q.s, tx: p.tx + q.tx, ty: p.ty + q.ty });
    ca = { r: { s: 0, tx: 0, ty: 0 }, b: { s: 0, tx: 0, ty: 0 } };
    for (let round = 0; round < 3; round++) {
      const m = measureChroma(rgb, W, H);
      ca = { r: add(ca.r, m.r), b: add(ca.b, m.b) };
      rgb.set(orig);
      unshiftChannel(rgb, W, H, 0, ca.r, scale);
      unshiftChannel(rgb, W, H, 2, ca.b, scale);
      if (Math.max(...[m.r, m.b].flatMap((q) => [q.s, q.tx, q.ty].map(Math.abs))) < 0.02) break;
    }
    chromaOf.set(frame, ca);
    return;
  }
  if (!ca) return;
  unshiftChannel(rgb, W, H, 0, ca.r, scale);
  unshiftChannel(rgb, W, H, 2, ca.b, scale);
}


// A frame's packed rows in the file ({ bytes, start, stride }), for the graphics card to unpack, or null (another format, or a file cut short).
function packedRows(bytes, frame) {
  const s = frame.module.sensor_data_surface;
  if (s.format !== 'RAW_PACKED_10BPP') return null;
  const start = frame.blockStart + s.data_offset;
  if (start + (s.size.y - 1) * s.row_stride + (s.size.x / 4) * 5 > bytes.length) return null;
  return { bytes, start, stride: s.row_stride };
}

// Every pixel of a W x H part of the sensor demosaiced on the graphics card (input: { plane } or { packed }, as gpu/l16prep.js takes them), with the lens's color fringes
// taken out (as measured on the half size picture); null if the card fails (it is not used again).
function fullOnCard(input, frame, W, H, { gains, hot }) {
  const o = frame.module.sensor_bayer_red_override || { x: 0, y: 0 };
  const mono = o.x < 0;
  let card = null;
  try {
    card = prepOnCard({ ...input, W, H, w: W >> 1, h: H >> 1, red: o, mono, hot, gains, full: true });
    const out = card.rgb;
    if (!mono) correctChroma(frame, out, W, H, 2, false, card);
    return { width: W, height: H, rgb: out };
  } catch (e) {
    console.warn('L16 camera picture on the graphics card failed; using the processor', e);
    prepOnCard = null;
    return null;
  } finally {
    if (card) card.release();
  }
}

// The window of the sensor (W x H) a demosaic of `win` makes: the pixels x0..x1, y0..y1, and the part demosaiced, ex0..ex1, ey0..ey1 (2 pixels round them, edges clamped,
// from an even origin to keep the pattern's phase).
function windowRect(W, H, win) {
  const pad = 2;
  const x0 = Math.max(0, Math.min(W - 1, Math.floor(win.x0)));
  const y0 = Math.max(0, Math.min(H - 1, Math.floor(win.y0)));
  const x1 = Math.min(W, Math.max(x0 + 1, Math.ceil(win.x0 + win.w)));
  const y1 = Math.min(H, Math.max(y0 + 1, Math.ceil(win.y0 + win.h)));
  const ex0 = Math.max(0, x0 - pad - ((x0 - pad) & 1));
  const ey0 = Math.max(0, y0 - pad - ((y0 - pad) & 1));
  return { x0, y0, x1, y1, ex0, ey0, ex1: Math.min(W, x1 + pad), ey1: Math.min(H, y1 + pad) };
}
// The window's pixels from the part demosaiced.
function cropWindow(part, r) {
  const w = r.ex1 - r.ex0;
  const ow = r.x1 - r.x0;
  const oh = r.y1 - r.y0;
  const rgb = new Float32Array(3 * ow * oh);
  for (let y = 0; y < oh; y++) rgb.set(part.rgb.subarray(3 * ((r.y0 - r.ey0 + y) * w + (r.x0 - r.ex0)), 3 * ((r.y0 - r.ey0 + y) * w + (r.x0 - r.ex0) + ow)), 3 * y * ow);
  return { width: ow, height: oh, rgb, x0: r.x0, y0: r.y0 };
}

// The demosaic of an unpacked frame (the whole frame, or a window of it cut out with the pattern's phase kept).
function demosaicRaw(decoded, frame, { black, white, gains, hot = true }) {
  const { width: W, height: H, data } = decoded;
  const o = frame.module.sensor_bayer_red_override || { x: 0, y: 0 };
  const rgb = new Float32Array(3 * W * H);
  const scale = 1 / (white - black);
  if (prepOnCard) {
    // (on the graphics card, gpu/l16prep.js: the same steps; the processor's below if it fails)
    const plane = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) plane[i] = Math.max(0, (data[i] - black) * scale);
    const done = fullOnCard({ plane }, frame, W, H, { gains, hot });
    if (done) return done;
  }
  if (o.x < 0) {
    // the monochrome module: one value for all three
    const mv = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) mv[i] = Math.max(0, (data[i] - black) * scale);
    if (hot) removeSpecks(mv, W, H, 1);
    for (let i = 0; i < W * H; i++) rgb[3 * i] = rgb[3 * i + 1] = rgb[3 * i + 2] = mv[i];
    return { width: W, height: H, rgb };
  }
  const px = new Float32Array(W * H);
  for (let i = 0; i < px.length; i++) px[i] = Math.max(0, (data[i] - black) * scale);
  if (hot) removeSpecks(px, W, H, 2);
  const at = (x, y) => px[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];
  const rx = o.x;
  const ry = o.y;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = 3 * (y * W + x);
      const c = px[y * W + x];
      // the site's kind: red, blue, or green with red on its row (greenR) or on its column (greenB)
      const cx = (x & 1) === rx;
      const cy = (y & 1) === ry;
      let r;
      let g;
      let b;
      const c4 = 4 * c;
      if (cx && cy) {
        // red site
        r = c;
        g = (2 * (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1)) + c4 - (at(x - 2, y) + at(x + 2, y) + at(x, y - 2) + at(x, y + 2))) / 8;
        b = (2 * (at(x - 1, y - 1) + at(x + 1, y - 1) + at(x - 1, y + 1) + at(x + 1, y + 1)) + 6 * c - 1.5 * (at(x - 2, y) + at(x + 2, y) + at(x, y - 2) + at(x, y + 2))) / 8;
      } else if (!cx && !cy) {
        // blue site
        b = c;
        g = (2 * (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1)) + c4 - (at(x - 2, y) + at(x + 2, y) + at(x, y - 2) + at(x, y + 2))) / 8;
        r = (2 * (at(x - 1, y - 1) + at(x + 1, y - 1) + at(x - 1, y + 1) + at(x + 1, y + 1)) + 6 * c - 1.5 * (at(x - 2, y) + at(x + 2, y) + at(x, y - 2) + at(x, y + 2))) / 8;
      } else {
        g = c;
        const horizontalIsRed = cy; // a green site on the red row has red beside it
        // the MHC kernels for green sites: the color along the row from the row's neighbours, the other along the column
        const rowKernel = (5 * c - at(x - 1, y - 1) - at(x + 1, y - 1) - at(x - 1, y + 1) - at(x + 1, y + 1) - at(x - 2, y) - at(x + 2, y) + 0.5 * (at(x, y - 2) + at(x, y + 2)) + 4 * (at(x - 1, y) + at(x + 1, y))) / 8;
        const colKernel = (5 * c - at(x - 1, y - 1) - at(x + 1, y - 1) - at(x - 1, y + 1) - at(x + 1, y + 1) - at(x, y - 2) - at(x, y + 2) + 0.5 * (at(x - 2, y) + at(x + 2, y)) + 4 * (at(x, y - 1) + at(x, y + 1))) / 8;
        if (horizontalIsRed) {
          r = rowKernel;
          b = colKernel;
        } else {
          b = rowKernel;
          r = colKernel;
        }
      }
      rgb[i] = Math.max(0, r) * gains[0];
      rgb[i + 1] = Math.max(0, g) * gains[1];
      rgb[i + 2] = Math.max(0, b) * gains[2];
    }
  }
  // (the lens's lateral chromatic aberration, as measured on the half size picture: twice the pixels here)
  correctChroma(frame, rgb, W, H, 2, false);
  return { width: W, height: H, rgb };
}


// The same demosaic over a window: the raw window is cut out with 2 pixels around it (edges clamped), the filter run on it, and the margin dropped.
function demosaicWindow(decoded, frame, opts, win) {
  const { width: W, data } = decoded;
  const r = windowRect(W, decoded.height, win);
  const w = r.ex1 - r.ex0;
  const h = r.ey1 - r.ey0;
  const sub = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) sub.set(data.subarray((r.ey0 + y) * W + r.ex0, (r.ey0 + y) * W + r.ex0 + w), y * w);
  return cropWindow(demosaicRaw({ width: w, height: h, data: sub }, frame, opts), r);
}

// The merge on the graphics card (gpu/l16fuse.js l16FuseGpu's), or null for the processor's: set by the worker that has the card.
let fuseOnCard = null;
export function setL16FuseGpu(f) {
  fuseOnCard = f || null;
}

// The camera pictures' preparation on the graphics card (gpu/l16prep.js l16PrepGpu's function), or null for the processor's: set by the worker that has the card.
let prepOnCard = null;
export function setL16PrepGpu(fn) {
  prepOnCard = fn || null;
}

// Each 2 x 2 sensor cell as one pixel (red, the mean of the greens, blue; the monochrome module's mean for all three): a quarter-size picture, quick to make.
// `crop` ({ x, y, w, h }, in pixels of the half size picture): only that part is made (the returned picture is that part, at ox, oy of the whole).
export function halfSize(bytes, frame, { black = 42, white = 1023, gains = [1, 1, 1], hot = true } = {}, rawCache = null, crop = null) {
  const key = frame.module.id;
  let decoded = rawCache && rawCache.get(key);
  const decode = () => {
    if (!decoded) {
      decoded = decodeFrame(bytes, frame);
      if (rawCache) rawCache.set(key, decoded);
    }
    return decoded;
  };
  const { x: SW, y: SH } = frame.module.sensor_data_surface.size;
  const o = frame.module.sensor_bayer_red_override || { x: 0, y: 0 };
  const mono = o.x < 0;
  const cx = crop ? Math.min((SW >> 1) - 1, Math.max(0, Math.floor(crop.x))) : 0;
  const cy = crop ? Math.min((SH >> 1) - 1, Math.max(0, Math.floor(crop.y))) : 0;
  const w = crop ? Math.max(1, Math.min((SW >> 1) - cx, Math.ceil(crop.w))) : SW >> 1;
  const h = crop ? Math.max(1, Math.min((SH >> 1) - cy, Math.ceil(crop.h))) : SH >> 1;
  // (the sensor pixels under it: W x H from sx0, sy0)
  const sx0 = 2 * cx;
  const sy0 = 2 * cy;
  const W = 2 * w;
  const H = 2 * h;
  const rgb = new Float32Array(3 * w * h);
  const scale = 1 / (white - black);
  // (hot and dead pixels out first: binned, one would be a bright dot in the picture)
  const planeOf = () => {
    const { data } = decode();
    const plane = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) plane[y * W + x] = Math.max(0, (data[(y + sy0) * SW + x + sx0] - black) * scale);
    return plane;
  };
  if (prepOnCard) {
    // (on the graphics card, gpu/l16prep.js: the same steps, from the file's packed rows where it can; the processor's below if it fails)
    let card = null;
    try {
      const packed = packedRows(bytes, frame);
      const input = packed ? { packed: { ...packed, x0: sx0, y0: sy0, black, scale } } : { plane: planeOf() };
      card = prepOnCard({ ...input, W, H, w, h, red: o, mono, hot, gains });
      const out = card.rgb;
      if (!crop && !mono) correctChroma(frame, out, w, h, 1, true, card);
      return crop ? { width: w, height: h, rgb: out, ox: cx, oy: cy } : { width: w, height: h, rgb: out };
    } catch (e) {
      console.warn('L16 camera picture on the graphics card failed; using the processor', e);
      prepOnCard = null;
    } finally {
      if (card) card.release();
    }
  }
  const plane = planeOf();
  if (hot) removeSpecks(plane, W, H, mono ? 1 : 2);
  if (mono) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const j = 2 * y * W + 2 * x;
        rgb[3 * (y * w + x)] = rgb[3 * (y * w + x) + 1] = rgb[3 * (y * w + x) + 2] = (plane[j] + plane[j + 1] + plane[j + W] + plane[j + W + 1]) / 4;
      }
    }
  } else {
    // Every color at the 2 x 2 block's center: the full demosaic (Malvar-He-Cutler) of the block's four sites, averaged. Taking red and blue from their own corners instead
    // leaves them half a sensor pixel off green in opposite directions, which colors every edge (an orange and a cyan fringe); interpolating them on their own gives a
    // green and magenta speckle. Done on a padded copy so the kernels need no bounds checks.
    const P = 2;
    const PW = W + 2 * P;
    const PH = H + 2 * P;
    const pad = new Float32Array(PW * PH);
    for (let y = 0; y < PH; y++) {
      // (mirrored by two, keeping each site's color)
      let sy = y - P;
      if (sy < 0) sy += 2;
      else if (sy >= H) sy -= 2;
      for (let x = 0; x < PW; x++) {
        let sx = x - P;
        if (sx < 0) sx += 2;
        else if (sx >= W) sx -= 2;
        pad[y * PW + x] = plane[sy * W + sx];
      }
    }
    const rx = o.x;
    const ry = o.y;
    const sum = [0, 0, 0];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        sum[0] = sum[1] = sum[2] = 0;
        for (let k = 0; k < 4; k++) {
          const X = 2 * x + (k & 1);
          const Y = 2 * y + (k >> 1);
          const j = (Y + P) * PW + X + P;
          const c = pad[j];
          const n4 = pad[j - 1] + pad[j + 1] + pad[j - PW] + pad[j + PW];
          const d4 = pad[j - PW - 1] + pad[j - PW + 1] + pad[j + PW - 1] + pad[j + PW + 1];
          const h2 = pad[j - 2] + pad[j + 2];
          const v2 = pad[j - 2 * PW] + pad[j + 2 * PW];
          const isR = (X & 1) === rx;
          const isRrow = (Y & 1) === ry;
          if (isR === isRrow) {
            // a red or blue site: green and the opposite color
            // (each value held to what a site can record, 0 to the white level: the kernels overshoot at a clipped edge, which white balance would turn pink)
            const g = Math.min(1, Math.max(0, (2 * n4 + 4 * c - (h2 + v2)) / 8));
            const opp = Math.min(1, Math.max(0, (2 * d4 + 6 * c - 1.5 * (h2 + v2)) / 8));
            if (isR) {
              sum[0] += c;
              sum[2] += opp;
            } else {
              sum[2] += c;
              sum[0] += opp;
            }
            sum[1] += g;
          } else {
            const row = Math.min(1, Math.max(0, (5 * c - d4 - h2 + 0.5 * v2 + 4 * (pad[j - 1] + pad[j + 1])) / 8));
            const col = Math.min(1, Math.max(0, (5 * c - d4 - v2 + 0.5 * h2 + 4 * (pad[j - PW] + pad[j + PW])) / 8));
            sum[1] += c;
            // (a green site on the red row has red beside it)
            if (isRrow) {
              sum[0] += row;
              sum[2] += col;
            } else {
              sum[2] += row;
              sum[0] += col;
            }
          }
        }
        const i = 3 * (y * w + x);
        rgb[i] = Math.max(0, sum[0] / 4) * gains[0];
        rgb[i + 1] = Math.max(0, sum[1] / 4) * gains[1];
        rgb[i + 2] = Math.max(0, sum[2] / 4) * gains[2];
      }
    }
  }
  // (lateral chromatic aberration: measured on the whole picture, once a photo, and taken out of it; a part, made for lining the cameras up, needs only the brightness)
  if (!crop && !mono) correctChroma(frame, rgb, w, h, 1, true);
  return crop ? { width: w, height: h, rgb, ox: cx, oy: cy } : { width: w, height: h, rgb };
}

// The depth in mm at every pixel of a w x h grid, from the depth map (1 / mm, dw x dh): bilinear in inverse depth.
function depthGrid(invZ, dw, dh, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(dh - 1.001, Math.max(0, ((y + 0.5) * dh) / h - 0.5));
    const y0 = fy | 0;
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(dw - 1.001, Math.max(0, ((x + 0.5) * dw) / w - 0.5));
      const x0 = fx | 0;
      const tx = fx - x0;
      const a = invZ[y0 * dw + x0] * (1 - tx) + invZ[y0 * dw + x0 + 1] * tx;
      const b = invZ[(y0 + 1) * dw + x0] * (1 - tx) + invZ[(y0 + 1) * dw + x0 + 1] * tx;
      out[y * w + x] = 1 / Math.max(1e-7, a * (1 - ty) + b * ty);
    }
  }
  return out;
}

const luma = (r, g, b) => 0.3 * r + 0.55 * g + 0.15 * b;

// Merges the cameras. `depth` is core/l16depth.js measureDepth's result for the reference; the cameras merged are the reference and all of depth.modules (the monochrome one adds brightness, its color is the reference's). Returns { width, height, rgb (linear, white balanced), used: how many cameras, merged: per camera id the share of pixels that agreed }.
// `grid` 1 merges at full size (every sensor pixel demosaiced); 2 at half size (each 2 x 2 sensor cell is one pixel: a quarter of the work and memory, for the quick views).
// `corrections`: each camera's registration corrected for the capture (core/l16hires.js estimateCorrections), or null.
export function fuse(bytes, parsed, depth, { black = 42, white = 1023, gains = [1, 1, 1], hot = true } = {}, onProgress = () => {}, { grid = 1, corrections = null } = {}) {
  const refId = depth.ref;
  const refFrame = parsed.modules[refId][0];
  const refCam = cameraModel(parsed.header, refFrame);
  const opts = { black, white, gains, hot };
  onProgress('Developing the pictures', 0.02);
  const S = grid;
  const load = (frame) => (S === 1 ? demosaic(bytes, frame, opts) : halfSize(bytes, frame, opts));
  const ref = load(refFrame);
  const { width: W, height: H } = ref;
  // the output grid is the reference's undistorted picture: the value at ideal pixel (x, y) is the sensor picture at distort(x, y)
  const out = new Float32Array(3 * W * H);
  const weight = new Float32Array(W * H);
  const z = depthGrid(depth.invZ, depth.width, depth.height, W, H);
  const K = refCam.K;
  const bilinear = (img, w, h, sx, sy, o) => {
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
  };
  // the reference on the undistorted grid
  const refUnd = new Float32Array(3 * W * H);
  const tmp = [0, 0, 0];
  const valid = new Uint8Array(W * H);
  // (on the graphics card where there is one, gpu/l16fuse.js: the same steps; here if it fails)
  let card = fuseOnCard;
  const failed = (e) => {
    console.warn('L16 merge on the graphics card failed; merging here', e);
    fuseOnCard = card = null;
  };
  if (card) {
    try {
      card.reference({ img: ref, W, H, S, dist: refCam.distort, refUnd, valid });
    } catch (e) {
      failed(e);
    }
  }
  if (!card) for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [sx, sy] = refCam.distort((x + 0.5) * S, (y + 0.5) * S);
      if (bilinear(ref.rgb, W, H, sx / S, sy / S, tmp)) {
        const i = y * W + x;
        refUnd[3 * i] = tmp[0];
        refUnd[3 * i + 1] = tmp[1];
        refUnd[3 * i + 2] = tmp[2];
        valid[i] = 1;
      }
    }
  }
  for (let i = 0; i < W * H; i++) {
    out[3 * i] = refUnd[3 * i];
    out[3 * i + 1] = refUnd[3 * i + 1];
    out[3 * i + 2] = refUnd[3 * i + 2];
    weight[i] = valid[i];
  }
  // every camera of the group, the monochrome one too (it adds brightness only: its color is the reference's)
  const donors = depth.modules;
  const isMono = (id) => (parsed.modules[id][0].module.sensor_bayer_red_override || { x: 0 }).x < 0;
  const merged = {};
  let n = 0;
  for (const id of donors) {
    onProgress('Merging the cameras', 0.1 + (0.85 * n) / Math.max(1, donors.length));
    n++;
    const cam = cameraModel(parsed.header, parsed.modules[id][0]);
    const rel = relativePose(refCam, cam);
    const corr = corrections && corrections[id];
    const R = rel.R;
    const T = rel.T;
    const img = load(parsed.modules[id][0]);
    const mono = isMono(id);
    // gains that match this camera's colors to the reference's, from the pixels both see (sampled)
    const sumR = [0, 0, 0];
    const sumD = [0, 0, 0];
    const sample = [0, 0, 0];
    const at = (x, y) => {
      const Z = z[y * W + x];
      const X = (((x + 0.5) * S - K[2]) / K[0]) * Z;
      const Y = (((y + 0.5) * S - K[5]) / K[4]) * Z;
      const Pz = R[6] * X + R[7] * Y + R[8] * Z + T[2];
      if (Pz <= 1) return false;
      const ix = (cam.K[0] * (R[0] * X + R[1] * Y + R[2] * Z + T[0])) / Pz + cam.K[2];
      const iy = (cam.K[4] * (R[3] * X + R[4] * Y + R[5] * Z + T[1])) / Pz + cam.K[5];
      let [sx, sy] = cam.distort(ix, iy);
      if (corr) {
        const u = sx / 4160;
        const v = sy / 3120;
        sx += corr.ax[0] + corr.ax[1] * u + corr.ax[2] * v;
        sy += corr.ay[0] + corr.ay[1] * u + corr.ay[2] * v;
      }
      return bilinear(img.rgb, img.width, img.height, sx / S, sy / S, sample);
    };
    for (let y = 8; y < H; y += 23) {
      for (let x = 8; x < W; x += 23) {
        if (!valid[y * W + x] || !at(x, y)) continue;
        const i = 3 * (y * W + x);
        for (let c = 0; c < 3; c++) {
          sumR[c] += refUnd[i + c];
          sumD[c] += sample[c];
        }
      }
    }
    const g = sumD.map((v, c) => (v > 1e-6 ? sumR[c] / v : 1));
    // the monochrome camera: one brightness gain, from the reference's brightness over its own
    const mg = mono ? luma(sumR[0], sumR[1], sumR[2]) / Math.max(1e-9, sumD[1]) : 1;
    let agreed = 0;
    let done = false;
    if (card) {
      // (the shares are added to out and weight only once the whole camera is done, so a failure part way leaves them as they were)
      const share = new Float32Array(3 * W * H);
      const wshare = new Float32Array(W * H);
      try {
        agreed = card.camera({ img, W, H, S, K, cam, rel, corr, gain: g, mono, mg, z, refUnd, valid, out: share, weight: wshare });
        for (let i = 0; i < W * H; i++) {
          if (!wshare[i]) continue;
          out[3 * i] += share[3 * i];
          out[3 * i + 1] += share[3 * i + 1];
          out[3 * i + 2] += share[3 * i + 2];
          weight[i] += wshare[i];
        }
        done = true;
      } catch (e) {
        failed(e);
        agreed = 0;
      }
    }
    if (!done) for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!valid[i] || !at(x, y)) continue;
        const rl = luma(refUnd[3 * i], refUnd[3 * i + 1], refUnd[3 * i + 2]);
        // (the monochrome camera's brightness on the reference's color)
        const q = mono ? (sample[1] * mg) / Math.max(1e-4, rl) : 0;
        const r = mono ? refUnd[3 * i] * q : sample[0] * g[0];
        const gr = mono ? refUnd[3 * i + 1] * q : sample[1] * g[1];
        const b = mono ? refUnd[3 * i + 2] * q : sample[2] * g[2];
        const dl = luma(r, gr, b);
        // agree: the difference is within what noise (growing with brightness) and a small misregistration allow
        const sigma = 0.012 + 0.07 * Math.sqrt(Math.max(rl, 0)) * 0.35;
        const d = (dl - rl) / sigma;
        const w = Math.exp(-0.5 * d * d);
        if (w < 0.02) continue;
        out[3 * i] += r * w;
        out[3 * i + 1] += gr * w;
        out[3 * i + 2] += b * w;
        weight[i] += w;
        if (w > 0.5) agreed++;
      }
    }
    merged[id] = agreed / (W * H);
  }
  onProgress('Merging the cameras', 0.97);
  for (let i = 0; i < W * H; i++) {
    const w = weight[i];
    if (w > 0) {
      out[3 * i] /= w;
      out[3 * i + 1] /= w;
      out[3 * i + 2] /= w;
    }
  }
  return { width: W, height: H, rgb: out, used: donors.length + 1, merged };
}
