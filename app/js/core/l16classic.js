// Classic Depth for a Light L16 photo: depth measured the way the camera's desktop software measures it.
//
// The modules of the reference's group are made into half size pictures in the reference's color space (brightness, gamma encoded, and two color axes, 8 bits each),
// each through its lens's distortion into a pinhole view, matched to the reference's colors, and smoothed by a 3 x 3 box. A series of depth planes, equal steps of
// inverse depth as fine as the longest baseline needs, is swept: the cost of a plane at a reference pixel is the capped difference of its 3 x 3 block from the module's
// block where that plane puts it (to the nearest half pixel), summed over the modules. The costs are smoothed along eight directions (two passes of four) with a small
// penalty for a step of one plane and a large one, falling with the change of the picture's color, for a jump; each pixel takes the plane of least cost. This is done
// coarse to fine over five layers (every 32nd, 16th, 8th, 4th, then every 2nd half size pixel): each layer only searches the planes round the depth the layer before
// found, and the last one measures a quarter of its pixels and lets the smoothing carry the depth to the rest.

import { halfSize } from './l16fusion.js';
import { cameraModel } from './l16geometry.js';
import { relativePose, depthGroup } from './l16depth.js';

const NEAR = 200;
const FAR = 640000;
const DENSITY = 2;
const ALIGN = 8;
const P1 = 1;
const P2_SCALE = 500;
// (the change of the picture between neighbors that lowers the jump penalty, per channel: brightness, then the two color axes)
const GUIDE = [0.4809 / 6, 0.4809 / 16, 0.4809 / 16];
const CAPS = [2, 6, 6];
const WEIGHT_COLOR = [8160, 680, 680];
const WEIGHT_GRAY = [12240, 0, 0];
const SCALES = [32, 16, 8, 4, 2];
// (brightness from linear red, green and blue)
const LUMA = [0.309, 0.2926, 0.3984];

const gamma = (v) => (v < 0 ? -255 * Math.pow(-v, 1 / 2.2) : 255 * Math.pow(v, 1 / 2.2));
const byte = (v) => (v !== v ? 0 : v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));

// The two color axes: at right angles to the brightness and to each other, each as long as the brightness's.
function colorAxes() {
  const [a, b, c] = LUMA;
  const s = a + c;
  const u = [b * -b - s * c, (a - c) * b, s * a + b * b];
  const v = [-b, s, -b];
  const ly = Math.hypot(a, b, c);
  const lu = Math.hypot(...u);
  const lv = Math.hypot(...v);
  return [u.map((x) => (x * ly) / lu), v.map((x) => (x * ly) / lv)];
}

// A module's half size picture in the reference's pinhole view geometry (its own K, no distortion): brightness and color axes before the 8 bits, NaN outside its frame.
function viewPicture(bytes, frame, cam, opts) {
  const pic = halfSize(bytes, frame, opts);
  const { width: w, height: h, rgb } = pic;
  const mono = (frame.module.sensor_bayer_red_override || { x: 0 }).x < 0;
  const [U, V] = colorAxes();
  const out = new Float32Array(3 * w * h).fill(NaN);
  const d = cam.distort.params;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // (the pixel's ideal place on the sensor, then where the lens puts it)
      const X = (x + 0.5) * 2;
      const Y = (y + 0.5) * 2;
      let sx;
      let sy;
      if (d) {
        const u = (X - d.cx) / d.nx;
        const v = (Y - d.cy) / d.ny;
        const rr = u * u + v * v;
        const uv2 = 2 * u * v;
        const k = 1 + ((d.k3 * rr + d.k2) * rr + d.k1) * rr;
        sx = d.cx + d.nx * (d.p1 * uv2 + d.p2 * (rr + 2 * u * u) + k * u);
        sy = d.cy + d.ny * (d.p2 * uv2 + d.p1 * (rr + 2 * v * v) + k * v);
      } else [sx, sy] = cam.distort(X, Y);
      const bx = sx / 2 - 0.5;
      const by = sy / 2 - 0.5;
      if (!(bx >= 0 && by >= 0 && bx < w - 1 && by < h - 1)) continue;
      const xi = bx | 0;
      const yi = by | 0;
      const fx = bx - xi;
      const fy = by - yi;
      const q = yi * w + xi;
      const lerp = (c) => (rgb[3 * q + c] * (1 - fx) + rgb[3 * q + 3 + c] * fx) * (1 - fy) + (rgb[3 * (q + w) + c] * (1 - fx) + rgb[3 * (q + w) + 3 + c] * fx) * fy;
      const r = lerp(0);
      const g = lerp(1);
      const b = lerp(2);
      const o = 3 * (y * w + x);
      if (mono) {
        out[o] = gamma((r + g + b) / 3);
        out[o + 1] = out[o + 2] = 0;
      } else {
        out[o] = gamma(LUMA[0] * r + LUMA[1] * g + LUMA[2] * b);
        out[o + 1] = gamma(U[0] * r + U[1] * g + U[2] * b);
        out[o + 2] = gamma(V[0] * r + V[1] * g + V[2] * b);
      }
    }
  }
  return { w, h, yuv: out, mono };
}

// Mean and covariance of the channels `n` (1 or 3) over the pixels inside the frame.
function stats(yuv, n) {
  const mean = [0, 0, 0];
  const cov = new Float64Array(9);
  let count = 0;
  for (let i = 0; i < yuv.length; i += 3) {
    if (yuv[i] !== yuv[i]) continue;
    count++;
    for (let a = 0; a < n; a++) mean[a] += yuv[i + a];
  }
  for (let a = 0; a < n; a++) mean[a] /= Math.max(1, count);
  for (let i = 0; i < yuv.length; i += 3) {
    if (yuv[i] !== yuv[i]) continue;
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) cov[3 * a + b] += (yuv[i + a] - mean[a]) * (yuv[i + b] - mean[b]);
  }
  for (let k = 0; k < 9; k++) cov[k] = cov[k] / Math.max(1, count) + (k % 4 === 0 ? 0.001 : 0);
  return { mean, cov };
}

// Lower triangular L with L L' = m (3 x 3).
function cholesky(m) {
  const L = new Float64Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j <= i; j++) {
      let s = m[3 * i + j];
      for (let k = 0; k < j; k++) s -= L[3 * i + k] * L[3 * j + k];
      L[3 * i + j] = i === j ? Math.sqrt(Math.max(s, 1e-9)) : s / L[3 * j + j];
    }
  }
  return L;
}

function inverseLower(L) {
  const I = new Float64Array(9);
  for (let i = 0; i < 3; i++) {
    I[3 * i + i] = 1 / L[3 * i + i];
    for (let j = 0; j < i; j++) {
      let s = 0;
      for (let k = j; k < i; k++) s -= L[3 * i + k] * I[3 * k + j];
      I[3 * i + j] = s / L[3 * i + i];
    }
  }
  return I;
}

// The module's colors brought to the reference's: the linear map that gives its pixels the reference's mean and covariance (brightness alone for the monochrome module).
function matchColors(pic, ref) {
  const n = pic.mono ? 1 : 3;
  const sw = stats(pic.yuv, n);
  const sr = stats(ref.yuv, n);
  const A = transferOf(sw, sr, n);
  const y = pic.yuv;
  for (let i = 0; i < y.length; i += 3) {
    if (y[i] !== y[i]) continue;
    const d0 = y[i] - sw.mean[0];
    const d1 = y[i + 1] - sw.mean[1];
    const d2 = y[i + 2] - sw.mean[2];
    for (let a = 0; a < n; a++) y[i + a] = A[3 * a] * d0 + A[3 * a + 1] * d1 + A[3 * a + 2] * d2 + sr.mean[a];
  }
}

// The map (3 x 3) that gives pixels of mean and covariance `sw` the mean and covariance `sr`: A = L_ref L_work^-1 (brightness alone for n = 1).
function transferOf(sw, sr, n) {
  let A;
  if (n === 1) A = [Math.sqrt(sr.cov[0] / sw.cov[0]), 0, 0, 0, 0, 0, 0, 0, 0];
  else {
    const Lr = cholesky(sr.cov);
    const Lwi = inverseLower(cholesky(sw.cov));
    A = new Float64Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) A[3 * i + j] += Lr[3 * i + k] * Lwi[3 * k + j];
  }
  return A;
}

// stats() from the sums the graphics card makes: [y, u, v, count, yy, uu, vv, yu, yv, uv].
function statsFromSums(s, n) {
  const N = Math.max(1, s[3]);
  const mean = [0, 0, 0];
  for (let a = 0; a < n; a++) mean[a] = s[a] / N;
  const second = [[s[4], s[7], s[8]], [s[7], s[5], s[9]], [s[8], s[9], s[6]]];
  const cov = new Float64Array(9);
  for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) cov[3 * a + b] = second[a][b] / N - mean[a] * mean[b];
  for (let k = 0; k < 9; k += 4) cov[k] += 0.001;
  return { mean, cov };
}

// 8 bits (the color axes about 128; outside the frame 0), then the 3 x 3 box (the part of it inside the picture).
function filtered(pic) {
  const { w, h, yuv } = pic;
  const b = new Uint8Array(3 * w * h);
  for (let i = 0; i < yuv.length; i += 3) {
    if (yuv[i] !== yuv[i]) continue;
    b[i] = byte(yuv[i]);
    b[i + 1] = pic.mono ? b[i] : byte(yuv[i + 1] + 128);
    b[i + 2] = pic.mono ? b[i] : byte(yuv[i + 2] + 128);
  }
  const out = new Uint8Array(3 * w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(w - 1, x + 1);
      const n = (x1 - x0 + 1) * (y1 - y0 + 1);
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) s += b[3 * (yy * w + xx) + c];
        out[3 * (y * w + x) + c] = Math.round(s / n);
      }
    }
  }
  return out;
}

// The depth planes (mm), far to near, equal steps of inverse depth: as many as the longest baseline moves a pixel over the range, twice over, in whole blocks of ALIGN.
export function depthPlanes(near, far, baseline, focal) {
  let n = Math.floor((1 / near - 1 / far) * DENSITY * baseline * focal);
  n = Math.min(4096, Math.max(2, n));
  n = Math.ceil(n / ALIGN) * ALIGN;
  const step = (1 / near - 1 / far) / (n - 1);
  const planes = new Float32Array(n);
  for (let i = 0; i < n - 1; i++) planes[i] = 1 / (1 / far + i * step);
  planes[n - 1] = near;
  return planes;
}

// Each layer pixel's search range [start, start + count) of planes: all of them on the first layer, else round what the layer before found nearby (a 4 x 4 window of its
// measured pixels' planes, one plane more each way).
function ranges(L, prev, n) {
  const npx = L.w * L.h;
  const start = new Uint16Array(npx);
  const count = new Uint16Array(npx);
  if (!prev) {
    count.fill(n);
    return { start, count };
  }
  const { w: pw, h: ph } = prev;
  // (the plane each previous pixel's depth falls in)
  const bound = new Float32Array(n);
  for (let i = 0; i < n - 1; i++) bound[i] = (1 / L.planes[i + 1] + 1 / L.planes[i]) / 2;
  bound[n - 1] = Infinity;
  const idx = new Uint16Array(pw * ph);
  for (let i = 0; i < pw * ph; i++) {
    const v = 1 / prev.depth[i];
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bound[mid] <= v) lo = mid + 1;
      else hi = mid;
    }
    idx[i] = lo;
  }
  const hmin = new Uint16Array(pw * ph);
  const hmax = new Uint16Array(pw * ph);
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      let mn = 0xffff;
      let mx = 0;
      for (let k = -1; k <= 2; k++) {
        const i = y * pw + Math.min(pw - 1, Math.max(0, x + k));
        if (prev.skip[i]) continue;
        if (idx[i] < mn) mn = idx[i];
        if (idx[i] > mx) mx = idx[i];
      }
      hmin[y * pw + x] = mn;
      hmax[y * pw + x] = mx;
    }
  }
  const fy = (ph - 1) / Math.max(1, L.h - 1);
  const fx = (pw - 1) / Math.max(1, L.w - 1);
  for (let y = 0; y < L.h; y++) {
    const py = Math.floor(y * fy);
    for (let x = 0; x < L.w; x++) {
      const px = Math.floor(x * fx);
      let mn = 0xffff;
      let mx = 0;
      for (let k = -1; k <= 2; k++) {
        const i = Math.min(ph - 1, Math.max(0, py + k)) * pw + px;
        if (hmin[i] < mn) mn = hmin[i];
        if (hmax[i] > mx) mx = hmax[i];
      }
      if (mn > mx) {
        mn = 0;
        mx = n - 1;
      }
      const lo = Math.max(0, mn - 1);
      const hi = Math.min(n - 1, mx + 1);
      const i = y * L.w + x;
      start[i] = lo;
      count[i] = Math.max(1, hi - lo);
    }
  }
  return { start, count };
}

// Which pixels of the layer are measured (0) and which only smoothed into (1): every pixel, or one at random in each 2 x 2 cell (the same pattern in every 64 x 64 tile).
function skipMask(sparse, w, h) {
  const m = new Uint8Array(w * h);
  if (!sparse) return m;
  m.fill(1);
  // (a fixed pattern: a small linear congruential generator with a fixed seed)
  const pattern = [];
  let s = 5489;
  for (let k = 0; k < 64 * 64; k++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    pattern.push((s >>> 16) & 3);
  }
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const r = pattern[((y & 63) >> 1) * 32 + ((x & 63) >> 1)];
      const xx = x + (r & 1);
      const yy = y + (r >> 1);
      if (xx < w && yy < h) m[yy * w + xx] = 0;
    }
  }
  return m;
}

// The raw cost (0..255) of planes [start, start + count) at the reference pixel (x, y) of the half size pictures, into raw[0 .. count).
function matchCost(ctx, x, y, start, count, raw, sum) {
  const { ref, W, H, others, planes, K } = ctx;
  sum.fill(0, 0, count);
  // (the reference's 3 x 3 block, clamped to the picture)
  const rb = ctx.block;
  for (let r = -1, k = 0; r <= 1; r++) {
    const yy = Math.min(H - 1, Math.max(0, y + r));
    for (let c = -1; c <= 1; c++, k += 3) {
      const o = 3 * (yy * W + Math.min(W - 1, Math.max(0, x + c)));
      rb[k] = ref[o];
      rb[k + 1] = ref[o + 1];
      rb[k + 2] = ref[o + 2];
    }
  }
  const X0 = ((x + 0.5) * 2 - K[2]) / K[0];
  const Y0 = ((y + 0.5) * 2 - K[5]) / K[4];
  for (const m of others) {
    const { img, iw, ih, R, T, k0, k2, k4, k5, wq } = m;
    // (the ray of the reference pixel in the module's frame: P(z) = z * a + T)
    const ax = R[0] * X0 + R[1] * Y0 + R[2];
    const ay = R[3] * X0 + R[4] * Y0 + R[5];
    const az = R[6] * X0 + R[7] * Y0 + R[8];
    let lix = -1;
    let liy = 0;
    let lhx = 0;
    let lhy = 0;
    let last = 0;
    let have = false;
    for (let d = 0; d < count; d++) {
      const z = planes[start + d];
      const pz = z * az + T[2];
      const u = (k0 * (z * ax + T[0])) / pz + k2;
      const v = (k4 * (z * ay + T[1])) / pz + k5;
      // (to the half size picture, then to the nearest half pixel)
      let fx = u / 2 - 0.5 + 0.25;
      let fy = v / 2 - 0.5 + 0.25;
      if (d === 0) {
        fx = Math.min(Math.max(fx, 1), iw - 3);
        fy = Math.min(Math.max(fy, 1), ih - 3);
      }
      const ix = Math.floor(fx);
      const iy = Math.floor(fy);
      const hx = Math.floor(fx * 2) & 1;
      const hy = Math.floor(fy * 2) & 1;
      if (d > 0 && ((have && ix === lix && iy === liy && hx === lhx && hy === lhy) || !(ix >= 1 && ix < iw - 2 && iy >= 1 && iy < ih - 2) || pz <= 0)) {
        sum[d] += last;
        continue;
      }
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      for (let r = 0, k = 0; r < 3; r++) {
        const row = (iy - 1 + r) * iw;
        for (let c = 0; c < 3; c++, k += 3) {
          const o = 3 * (row + ix - 1 + c);
          for (let ch = 0; ch < 3; ch++) {
            let t = img[o + ch];
            if (hy) {
              const t2 = img[o + ch + 3 * iw];
              if (hx) t = (((t + img[o + ch + 3] + 1) >> 1) + ((t2 + img[o + ch + 3 * iw + 3] + 1) >> 1) + 1) >> 1;
              else t = (t + t2 + 1) >> 1;
            } else if (hx) t = (t + img[o + ch + 3] + 1) >> 1;
            const dd = t > rb[k + ch] ? t - rb[k + ch] : rb[k + ch] - t;
            const capped = dd < CAPS[ch] ? dd : CAPS[ch];
            if (ch === 0) s0 += capped;
            else if (ch === 1) s1 += capped;
            else s2 += capped;
          }
        }
      }
      const cost = ((s0 * wq[0] + 16) >> 5) + ((s1 * wq[1] + 16) >> 5) + ((s2 * wq[2] + 16) >> 5);
      sum[d] += cost;
      lix = ix;
      liy = iy;
      lhx = hx;
      lhy = hy;
      last = cost;
      have = true;
    }
  }
  const f = 1 / 27 / others.length;
  for (let d = 0; d < count; d++) raw[d] = Math.min(255, Math.floor(sum[d] * f));
}

// One layer: the raw costs of its measured pixels, the smoothing along eight directions, and each pixel's plane of least cost.
function runLayer(ctx, L, onRow) {
  const { w, h, start, count, skip } = L;
  const n = ctx.planes.length;
  const npx = w * h;
  const cap = new Uint16Array(npx);
  const off = new Uint32Array(npx + 1);
  let minLo = n;
  let maxHi = 0;
  for (let i = 0; i < npx; i++) {
    cap[i] = Math.ceil(count[i] / ALIGN) * ALIGN;
    off[i + 1] = off[i] + cap[i];
    if (start[i] < minLo) minLo = start[i];
    if (start[i] + cap[i] > maxHi) maxHi = start[i] + cap[i];
  }
  let raw = null;
  let fromCard = false;
  const agg = new Uint16Array(off[npx]);
  const sc = L.scale;
  if (ctx.card) {
    // (on the graphics card, gpu/l16classic.js: the same costs; here if it fails)
    try {
      raw = ctx.card.costs({ w, scale: sc, start, count, skip, off });
      fromCard = true;
      if (onRow) onRow(0.6);
    } catch (e) {
      console.warn('Classic Depth costs on the graphics card failed; measuring here', e);
      try {
        ctx.card.close();
      } catch {
        // (already gone with the card)
      }
      ctx.card = null;
      if (!ctx.others[0].img) ctx.picturesHere();
      raw = null;
    }
  }
  // the raw costs (0 for a pixel only smoothed into; 255 past a pixel's planes)
  const sum = new Uint32Array(n);
  const tmp = new Uint8Array(n);
  if (!raw) raw = new Uint8Array(off[npx]);
  for (let y = 0; y < h && !fromCard; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const o = off[i];
      for (let k = count[i]; k < cap[i]; k++) raw[o + k] = 255;
      if (skip[i]) continue;
      const xi = Math.min(sc * x + (sc >> 1), ctx.W - 1);
      const yi = Math.min(sc * y + (sc >> 1), ctx.H - 1);
      matchCost(ctx, xi, yi, start[i], count[i], tmp, sum);
      raw.set(tmp.subarray(0, count[i]), o);
    }
    if (onRow) onRow((0.6 * (y + 1)) / h);
  }
  // the guide: the reference's filtered picture at each layer pixel
  const guide = new Float32Array(3 * npx);
  for (let y = 0; y < h; y++) {
    const yi = Math.min(sc * y + (sc >> 1), ctx.H - 1);
    for (let x = 0; x < w; x++) {
      const xi = Math.min(sc * x + (sc >> 1), ctx.W - 1);
      for (let c = 0; c < 3; c++) guide[3 * (y * w + x) + c] = ctx.ref[3 * (yi * ctx.W + xi) + c];
    }
  }
  // (on the graphics card, gpu/l16classicsgm.js: the same smoothing and each pixel's least plane; here if it fails)
  if (smoothOnCard) {
    try {
      const r = smoothOnCard({ w, h, start, count, cap, off, raw, guide, gw: GUIDE });
      const depth = new Float32Array(npx);
      const confidence = new Float32Array(npx);
      for (let i = 0; i < npx; i++) {
        depth[i] = ctx.planes[start[i] + r.arg[i]];
        const second = r.second[i];
        confidence[i] = second < 0xffff && second > 0 ? Math.max(0, Math.min(1, 1 - r.best[i] / second)) : 1;
      }
      if (onRow) onRow(1);
      return { depth, confidence };
    } catch (e) {
      console.warn('Classic Depth smoothing on the graphics card failed; smoothing here', e);
      smoothOnCard = null;
    }
  }
  // the smoothing: two passes (down and up the picture), each along four directions (the pixel before in the row, and the three above it, or below on the way up)
  const NB = maxHi - minLo + 2;
  const BIG = 2000;
  const slots = w + 2;
  const lineBuf = [0, 1].map(() => [0, 1, 2, 3].map(() => new Uint16Array(slots * NB)));
  const minBuf = [0, 1].map(() => [0, 1, 2, 3].map(() => new Uint16Array(slots)));
  const rangeS = [new Int32Array(slots), new Int32Array(slots)];
  const rangeC = [new Int32Array(slots), new Int32Array(slots)];
  const pix = [new Float32Array(3 * slots), new Float32Array(3 * slots)];
  for (const dir of [1, -1]) {
    for (const half of [0, 1]) {
      for (const p of [0, 1, 2, 3]) {
        lineBuf[half][p].fill(BIG);
        minBuf[half][p].fill(BIG);
      }
      rangeS[half].fill(0);
      rangeC[half].fill(0);
      pix[half].fill(0);
    }
    for (let r = 0; r < h; r++) {
      const y = dir > 0 ? r : h - 1 - r;
      const cur = r & 1;
      const other = 1 - cur;
      for (let c = 0; c < w; c++) {
        const x = dir > 0 ? c : w - 1 - c;
        const i = y * w + x;
        const slot = x + 1;
        const g0 = guide[3 * i];
        const g1 = guide[3 * i + 1];
        const g2 = guide[3 * i + 2];
        pix[cur][3 * slot] = g0;
        pix[cur][3 * slot + 1] = g1;
        pix[cur][3 * slot + 2] = g2;
        const s = start[i];
        const cp = cap[i];
        const o = off[i];
        const q = s - minLo + 1;
        const sp = rangeS[cur][slot];
        const spc = rangeC[cur][slot];
        for (let p = 0; p < 4; p++) {
          const Lc = lineBuf[cur][p];
          // (the values left in this slot from two rows before go)
          if (spc) Lc.fill(BIG, slot * NB + sp - minLo + 1, slot * NB + sp - minLo + 1 + spc);
          const ns = slot + (p === 2 ? 0 : p === 3 ? dir : -dir);
          const hf = p === 0 ? cur : other;
          const Ln = lineBuf[hf][p];
          const minPrev = minBuf[hf][p][ns];
          const pn = pix[hf];
          const S = Math.abs(g0 - pn[3 * ns]) * GUIDE[0] + Math.abs(g1 - pn[3 * ns + 1]) * GUIDE[1] + Math.abs(g2 - pn[3 * ns + 2]) * GUIDE[2];
          const P2 = Math.floor(P1 * P2_SCALE * Math.pow(2, -Math.min(126, S)));
          const P2p = Math.min(65535, P2 + minPrev);
          let runMin = 0xffff;
          const nb = ns * NB + q;
          const wb = slot * NB + q;
          for (let k = 0; k < cp; k++) {
            const Lm = Ln[nb + k - 1] + P1;
            const L0 = Ln[nb + k];
            const Lp = Ln[nb + k + 1] + P1;
            let m = Lm < L0 ? Lm : L0;
            if (Lp < m) m = Lp;
            if (P2p < m) m = P2p;
            let lc = (skip[i] ? (k < count[i] ? 0 : 255) : raw[o + k]) + m - minPrev;
            if (lc > 65535) lc = 65535;
            if (lc < 0) lc = 0;
            Lc[wb + k] = lc;
            if (lc < runMin) runMin = lc;
            const a = agg[o + k] + lc;
            agg[o + k] = a > 65535 ? 65535 : a;
          }
          minBuf[cur][p][slot] = runMin;
        }
        rangeS[cur][slot] = s;
        rangeC[cur][slot] = cp;
      }
      if (onRow) onRow(0.6 + (0.2 * (r + 1)) / h + (dir < 0 ? 0.2 : 0));
    }
  }
  // each pixel's plane of least cost (the first if two tie), and how much better it is than the best one not next to it
  const depth = new Float32Array(npx);
  const confidence = new Float32Array(npx);
  for (let i = 0; i < npx; i++) {
    const o = off[i];
    let best = 0xffff;
    let arg = 0;
    for (let k = 0; k < count[i]; k++) {
      if (agg[o + k] < best) {
        best = agg[o + k];
        arg = k;
      }
    }
    let second = 0xffff;
    for (let k = 0; k < count[i]; k++) if ((k < arg - 1 || k > arg + 1) && agg[o + k] < second) second = agg[o + k];
    depth[i] = ctx.planes[start[i] + arg];
    confidence[i] = second < 0xffff && second > 0 ? Math.max(0, Math.min(1, 1 - best / second)) : 1;
  }
  return { depth, confidence };
}

// The costs on the graphics card (gpu/l16classic.js l16ClassicGpu's), or null for the processor's: set by the worker that has the card.
let costOnCard = null;
export function setL16ClassicGpu(c) {
  costOnCard = c || null;
}

// The smoothing on the graphics card (gpu/l16classicsgm.js l16ClassicSgmGpu's), or null for the processor's: set by the worker that has the card.
let smoothOnCard = null;
export function setL16ClassicSmoothGpu(f) {
  smoothOnCard = f || null;
}

// Classic Depth: { width, height, scale, ref, modules, focalPx, K, invZ (1 / mm), confidence, steps, near, far }, as core/l16depth.js measureDepth's.
// options: { ref, modules, black, white, gains }.
export function classicDepth(bytes, parsed, options = {}, onProgress = () => {}) {
  const refId = options.ref || parsed.header.image_reference_camera;
  const group = options.modules || depthGroup(parsed, refId);
  if (!group.length) throw new Error('No other camera module of the same kind to measure depth with');
  const opts = { black: options.black ?? 42, white: options.white ?? 1023, gains: options.gains || [1, 1, 1], hot: options.hot ?? true };
  onProgress('Reading the camera pictures', 0);
  const ids = [refId, ...group];
  const frames = ids.map((id) => parsed.modules[id][0]);
  const cams = frames.map((f) => cameraModel(parsed.header, f));
  const monoOf = (f) => (f.module.sensor_bayer_red_override || { x: 0 }).x < 0;
  const refCam = cams[0];
  // the cameras' poses and numbers for the cost, and the longest baseline
  let baseline = 0;
  const others = group.map((id, k) => {
    const cam = cams[k + 1];
    const { R, T } = relativePose(refCam, cam);
    // (the module's center in the reference's frame: -R' T)
    const cx = -(R[0] * T[0] + R[3] * T[1] + R[6] * T[2]);
    const cy = -(R[1] * T[0] + R[4] * T[1] + R[7] * T[2]);
    const cz = -(R[2] * T[0] + R[5] * T[1] + R[8] * T[2]);
    baseline = Math.max(baseline, Math.hypot(cx, cy, cz));
    return { img: null, iw: 0, ih: 0, R, T, k0: cam.K[0], k2: cam.K[2], k4: cam.K[4], k5: cam.K[5], wq: monoOf(frames[k + 1]) ? WEIGHT_GRAY : WEIGHT_COLOR };
  });
  const K = refCam.K;
  const planes = depthPlanes(NEAR, FAR, baseline, K[0] / 2);
  // The pictures: on the graphics card where there is one (gpu/l16classic.js: the views, their colors matched and filtered there, and kept there for the costs; only the
  // reference's comes back, for the smoothing's guide), else here.
  let ref = null;
  let W = 0;
  let H = 0;
  let card = null;
  if (costOnCard && costOnCard.views) {
    try {
      const [U, V] = colorAxes();
      const pics = frames.map((f, k) => {
        const pic = halfSize(bytes, f, opts);
        onProgress('Reading the camera pictures', (0.1 * (k + 1)) / frames.length);
        return { rgb: pic.rgb, w: pic.width, h: pic.height, dist: cams[k].distort.params || null, mono: monoOf(f), luma: LUMA, axisU: U, axisV: V };
      });
      const v = costOnCard.views(pics);
      const transforms = pics.map((pic, k) => {
        if (k === 0) return { A: [1, 0, 0, 0, 1, 0, 0, 0, 1], from: [0, 0, 0], to: [0, 0, 0] };
        const n = pic.mono ? 1 : 3;
        const sw = statsFromSums(v.stats[k].sums, n);
        const sr = statsFromSums(v.stats[0].sums, n);
        return { A: Array.from(transferOf(sw, sr, n)), from: sw.mean, to: sr.mean };
      });
      const made = v.filter(transforms);
      ref = made.ref;
      W = pics[0].w;
      H = pics[0].h;
      for (const o of others) {
        o.iw = W;
        o.ih = H;
      }
      card = made.open({ mods: others, planes, K });
    } catch (e) {
      console.warn('Classic Depth pictures on the graphics card failed; making them here', e);
      card = null;
    }
  }
  // (here: also when a step on the card fails later and the costs are made here)
  const picturesHere = () => {
    const refPic = viewPicture(bytes, frames[0], refCam, opts);
    W = refPic.w;
    H = refPic.h;
    ref = filtered(refPic);
    others.forEach((o, k) => {
      const pic = viewPicture(bytes, frames[k + 1], cams[k + 1], opts);
      matchColors(pic, refPic);
      o.img = filtered(pic);
      o.iw = pic.w;
      o.ih = pic.h;
      onProgress('Reading the camera pictures', (0.1 * (k + 1)) / others.length);
    });
  };
  if (!card) {
    picturesHere();
    if (costOnCard) {
      try {
        card = costOnCard.open({ ref, W, H, mods: others, planes, K });
      } catch (e) {
        console.warn('Classic Depth on the graphics card could not start; measuring here', e);
      }
    }
  }
  const ctx = { ref, W, H, others, planes, K, block: new Uint8Array(27), card, picturesHere: () => {
    picturesHere();
    ctx.ref = ref;
  } };
  let prev = null;
  let result = null;
  SCALES.forEach((sc, li) => {
    const L = { scale: sc, w: Math.ceil(W / sc), h: Math.ceil(H / sc), planes };
    L.skip = skipMask(sc <= 2, L.w, L.h);
    Object.assign(L, ranges(L, prev, planes.length));
    const share = sc === 2 ? [0.3, 0.7] : [0.1 + 0.05 * li, 0.05];
    result = runLayer(ctx, L, (p) => onProgress('Measuring depth', share[0] + share[1] * p));
    prev = { w: L.w, h: L.h, depth: result.depth, skip: L.skip };
  });
  if (ctx.card) ctx.card.close();
  const w = prev.w;
  const h = prev.h;
  const invZ = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) invZ[i] = 1 / result.depth[i];
  onProgress('Depth measured', 1);
  return { width: w, height: h, scale: 4, ref: refId, modules: group, focalPx: K[0], K, invZ, confidence: result.confidence, steps: planes.length, near: NEAR, far: FAR, style: 'classic' };
}
