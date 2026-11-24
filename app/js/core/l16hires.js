// A region of a Light L16 photo at a higher resolution than the wide cameras have: the telephoto cameras (the 70 mm B group, 2.5 times the wide cameras' focal length, and the
// 150 mm C group, 5.4 times) see the same scene with that many more pixels per degree, and their pictures can be laid on the wide picture's grid through the depth, at a finer
// pixel spacing. Where a telephoto camera saw a place, it supplies the fine detail; the wide cameras' merged picture supplies the low frequencies (color, exposure and vignetting
// differ between cameras), and where the two do not agree (occlusions, a wrong depth, a camera out of focus) the wide picture alone is used.
//
// The output pixel (X, Y) of a region at `scale` is the point (x0 + (X + 0.5) / scale, y0 + (Y + 0.5) / scale) of the wide reference picture's undistorted grid (the grid of
// core/l16fusion.js). The depth there gives the 3D point, which each camera's calibration projects to its sensor.
import { cameraModel } from './l16geometry.js';
import { relativePose } from './l16depth.js';
import { demosaic, halfSize } from './l16fusion.js';

const gauss = (src, w, h, sigma) => {
  // separable gaussian blur of a 3 channel float picture (edges clamped)
  const r = Math.max(1, Math.ceil(sigma * 2.5));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let i = -r; i <= r; i++) acc += src[3 * (y * w + Math.min(w - 1, Math.max(0, x + i))) + c] * k[i + r];
        tmp[3 * (y * w + x) + c] = acc;
      }
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let i = -r; i <= r; i++) acc += tmp[3 * (Math.min(h - 1, Math.max(0, y + i)) * w + x) + c] * k[i + r];
        out[3 * (y * w + x) + c] = acc;
      }
    }
  }
  return out;
};

const luma = (r, g, b) => 0.3 * r + 0.55 * g + 0.15 * b;

// Local corrections to a telephoto camera's registration (the calibration and the depth are good to about a pixel of the wide picture; the original software refines each telephoto
// camera against the wide one with dense optical flow). Both pictures are the low frequencies at the output grid (luma, `a` the wide picture's, `b` the camera's); they are reduced by
// `ds`, and for each block the shift of `b` that best matches `a` is searched (+-R reduced pixels, refined between steps), where the block has texture. Returns a function giving the
// shift (output pixels, to be added to where the camera is looked up) at an output pixel.
function flowOffsets(a, b, W, H, ds = 4, block = 6, R = 2) {
  const w = Math.floor(W / ds);
  const h = Math.floor(H / ds);
  const reduce = (src) => {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let dy = 0; dy < ds; dy++) for (let dx = 0; dx < ds; dx++) sum += src[(y * ds + dy) * W + x * ds + dx];
      out[y * w + x] = sum / (ds * ds);
    }
    return out;
  };
  const A = reduce(a);
  const B = reduce(b);
  const bw = Math.max(1, Math.floor(w / block));
  const bh = Math.max(1, Math.floor(h / block));
  const ox = new Float32Array(bw * bh);
  const oy = new Float32Array(bw * bh);
  const side = 2 * R + 1;
  const cost = new Float32Array(side * side);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const x0 = bx * block;
      const y0 = by * block;
      let mean = 0;
      let n = 0;
      for (let y = y0; y < Math.min(h, y0 + block); y++) for (let x = x0; x < Math.min(w, x0 + block); x++) { mean += A[y * w + x]; n++; }
      mean /= n;
      let variance = 0;
      for (let y = y0; y < Math.min(h, y0 + block); y++) for (let x = x0; x < Math.min(w, x0 + block); x++) variance += (A[y * w + x] - mean) ** 2;
      variance /= n;
      if (variance < 1e-6 + 0.0004 * mean * mean) continue; // no texture to match: no correction
      let best = Infinity;
      let bi = R * side + R;
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          let sad = 0;
          for (let y = y0; y < Math.min(h, y0 + block); y++) {
            const yy = Math.min(h - 1, Math.max(0, y + dy));
            for (let x = x0; x < Math.min(w, x0 + block); x++) sad += Math.abs(A[y * w + x] - B[yy * w + Math.min(w - 1, Math.max(0, x + dx))]);
          }
          cost[(dy + R) * side + dx + R] = sad;
          if (sad < best) {
            best = sad;
            bi = (dy + R) * side + dx + R;
          }
        }
      }
      let sx = (bi % side) - R;
      let sy = Math.floor(bi / side) - R;
      // between steps: a parabola through the neighbours
      const c = (x, y) => cost[(y + R) * side + x + R];
      if (sx > -R && sx < R) {
        const l = c(sx - 1, sy);
        const m = c(sx, sy);
        const r = c(sx + 1, sy);
        const den = l - 2 * m + r;
        if (den > 0) sx += Math.max(-0.5, Math.min(0.5, (l - r) / (2 * den)));
      }
      if (sy > -R && sy < R) {
        const u = c(Math.round(sx), sy - 1);
        const m = c(Math.round(sx), sy);
        const d = c(Math.round(sx), sy + 1);
        const den = u - 2 * m + d;
        if (den > 0) sy += Math.max(-0.5, Math.min(0.5, (u - d) / (2 * den)));
      }
      ox[by * bw + bx] = sx * ds;
      oy[by * bw + bx] = sy * ds;
    }
  }
  // a 3 x 3 median of the shifts (a wrong match among good ones is outvoted)
  const med = (src) => {
    const out = new Float32Array(src.length);
    const win = new Float32Array(9);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      let k = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) win[k++] = src[Math.min(bh - 1, Math.max(0, y + dy)) * bw + Math.min(bw - 1, Math.max(0, x + dx))];
      win.sort();
      out[y * bw + x] = win[4];
    }
    return out;
  };
  const mx = med(ox);
  const my = med(oy);
  const cellX = (block * ds);
  return (X, Y) => {
    // bilinear between block centers
    const fx = Math.min(bw - 1.001, Math.max(0, (X - cellX / 2) / cellX));
    const fy = Math.min(bh - 1.001, Math.max(0, (Y - cellX / 2) / cellX));
    const ix = fx | 0;
    const iy = fy | 0;
    const tx = fx - ix;
    const ty = fy - iy;
    const g = (arr) => (arr[iy * bw + ix] * (1 - tx) + arr[iy * bw + ix + 1] * tx) * (1 - ty) + (arr[(iy + 1) * bw + ix] * (1 - tx) + arr[(iy + 1) * bw + ix + 1] * tx) * ty;
    return [g(mx), g(my)];
  };
}


// A per capture correction of each longer lens camera's registration, as the original software refines the calibration of each capture before merging (its mirror angles and poses, from
// features matched against the wide cameras): the factory calibration and the mirror's position put a camera's picture a few pixels off, by an amount that changes smoothly over the
// frame. Over a grid of patches of the wide picture, the camera's picture is looked up through the depth and the calibration and moved until it matches best (normalized correlation,
// +-48 sensor pixels, coarse to fine, between steps by a parabola); the shifts of the patches that match well are fitted with an affine function of the place on the sensor (by weighted least squares,
// patches far off the fit dropped and the fit made again). Returns { [module id]: { ax: [a0, a1, a2], ay: [...] , n, rms } } where the sensor point (sx, sy) of the camera becomes
// (sx + ax0 + ax1 u + ax2 v, ...) with u = sx / 4160, v = sy / 3120; a module that could not be measured is left out.
// `area` ({ x0, y0, x1, y1 }, pixels of the wide picture): only the patches there are matched, and only the part of each camera's picture they land on is made (much quicker
// than the whole: what the zoomed-in view needs); the whole picture when null.
export function estimateCorrections(bytes, parsed, depth, wide, grid, modules, opts, onProgress = () => {}, area = null) {
  const refCam = cameraModel(parsed.header, parsed.modules[depth.ref][0]);
  const K = refCam.K;
  const W = wide.width;
  const H = wide.height;
  const wl = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) wl[i] = luma(wide.rgb[3 * i], wide.rgb[3 * i + 1], wide.rgb[3 * i + 2]);
  // the depth (mm) at a point of the wide grid
  const zAt = (x, y) => {
    const fx = Math.min(depth.width - 1.001, Math.max(0, (x * depth.width) / W - 0.5));
    const fy = Math.min(depth.height - 1.001, Math.max(0, (y * depth.height) / H - 0.5));
    const ix = fx | 0;
    const iy = fy | 0;
    const tx = fx - ix;
    const ty = fy - iy;
    const d = depth.invZ;
    const a = d[iy * depth.width + ix] * (1 - tx) + d[iy * depth.width + ix + 1] * tx;
    const b = d[(iy + 1) * depth.width + ix] * (1 - tx) + d[(iy + 1) * depth.width + ix + 1] * tx;
    return 1 / Math.max(1e-7, a * (1 - ty) + b * ty);
  };
  const T = Math.max(16, Math.round(96 / grid)); // patch size in wide pixels (96 sensor pixels)
  const step = Math.max(1, Math.round(T / 12)); // a 12 x 12 sample of it
  const R = 48; // search, sensor pixels
  const out = {};
  let done = 0;
  for (const id of modules) {
    // (how far along: one step per camera module)
    onProgress(done++ / modules.length);
    let cam;
    try {
      cam = cameraModel(parsed.header, parsed.modules[id][0]);
    } catch {
      continue;
    }
    const { R: Rm, T: Tm } = relativePose(refCam, cam);
    const project = (px, py) => {
      const Z = zAt(px, py);
      const Xr = (((px * grid) - K[2]) / K[0]) * Z;
      const Yr = (((py * grid) - K[5]) / K[4]) * Z;
      const Pz = Rm[6] * Xr + Rm[7] * Yr + Rm[8] * Z + Tm[2];
      if (Pz <= 1) return null;
      const ix = (cam.K[0] * (Rm[0] * Xr + Rm[1] * Yr + Rm[2] * Z + Tm[0])) / Pz + cam.K[2];
      const iy = (cam.K[4] * (Rm[3] * Xr + Rm[4] * Yr + Rm[5] * Z + Tm[1])) / Pz + cam.K[5];
      return cam.distort(ix, iy);
    };
    // (with an area: the part of this camera's picture it lands on, with room for the search)
    let crop = null;
    if (area) {
      let lo = [Infinity, Infinity];
      let hi = [-Infinity, -Infinity];
      for (let j = 0; j <= 8; j++) {
        for (let i = 0; i <= 8; i++) {
          const s2 = project(area.x0 + ((area.x1 - area.x0) * i) / 8, area.y0 + ((area.y1 - area.y0) * j) / 8);
          if (!s2) continue;
          lo = [Math.min(lo[0], s2[0]), Math.min(lo[1], s2[1])];
          hi = [Math.max(hi[0], s2[0]), Math.max(hi[1], s2[1])];
        }
      }
      if (!(hi[0] > lo[0] && hi[1] > lo[1])) continue;
      const pad = R + 2 * T * grid;
      crop = { x: Math.floor((lo[0] - pad) / 2), y: Math.floor((lo[1] - pad) / 2) };
      crop.w = Math.ceil((hi[0] + pad) / 2) - crop.x;
      crop.h = Math.ceil((hi[1] + pad) / 2) - crop.y;
      crop.x = Math.max(0, crop.x);
      crop.y = Math.max(0, crop.y);
      if (crop.w <= 0 || crop.h <= 0) continue;
    }
    const pic = halfSize(bytes, parsed.modules[id][0], opts, null, crop);
    const pox = pic.ox || 0;
    const poy = pic.oy || 0;
    const pw = pic.width;
    const ph = pic.height;
    const pl = new Float32Array(pw * ph);
    for (let i = 0; i < pw * ph; i++) pl[i] = luma(pic.rgb[3 * i], pic.rgb[3 * i + 1], pic.rgb[3 * i + 2]);
    const sample = (sx, sy) => {
      // sensor pixel -> the half size picture (or the part of it made)
      const x = sx / 2 - 0.5 - pox;
      const y = sy / 2 - 0.5 - poy;
      if (x < 0 || y < 0 || x >= pw - 1 || y >= ph - 1) return NaN;
      const x0 = x | 0;
      const y0 = y | 0;
      const fx = x - x0;
      const fy = y - y0;
      const i = y0 * pw + x0;
      return (pl[i] * (1 - fx) + pl[i + 1] * fx) * (1 - fy) + (pl[i + pw] * (1 - fx) + pl[i + pw + 1] * fx) * fy;
    };
    const pts = [];
    const n = 12;
    const a = new Float32Array(n * n);
    const sxs = new Float32Array(n * n);
    const sys = new Float32Array(n * n);
    // (at most about 300 patches a camera, spread over the frame: enough for the fit, and quick)
    const ax0 = area ? Math.max(T, Math.floor(area.x0)) : T;
    const ay0 = area ? Math.max(T, Math.floor(area.y0)) : T;
    const ax1 = area ? Math.min(W - T, Math.ceil(area.x1)) : W - T;
    const ay1 = area ? Math.min(H - T, Math.ceil(area.y1)) : H - T;
    const cols = Math.floor((ax1 - ax0 - T) / T);
    const rows = Math.floor((ay1 - ay0 - T) / T);
    const stride = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, cols * rows) / 300)));
    for (let ty = ay0; ty + T <= ay1; ty += T * stride) {
      for (let tx = ax0; tx + T <= ax1; tx += T * stride) {
        // the wide patch and where its samples land on the camera's sensor
        let k = 0;
        let ok = true;
        for (let j = 0; j < n && ok; j++) {
          for (let i = 0; i < n; i++) {
            const px = tx + i * step + 0.5;
            const py = ty + j * step + 0.5;
            a[k] = wl[Math.min(H - 1, py | 0) * W + Math.min(W - 1, px | 0)];
            const s2 = project(px, py);
            if (!s2) {
              ok = false;
              break;
            }
            sxs[k] = s2[0];
            sys[k] = s2[1];
            k++;
          }
        }
        if (!ok) continue;
        let ma = 0;
        for (let i = 0; i < k; i++) ma += a[i];
        ma /= k;
        let va = 0;
        for (let i = 0; i < k; i++) va += (a[i] - ma) ** 2;
        if (va / k < 1e-6 + 0.002 * ma * ma) continue; // no texture
        const nccAt = (dx, dy) => {
          let sb = 0;
          let sbb = 0;
          let sab = 0;
          let m = 0;
          for (let i = 0; i < k; i++) {
            const v = sample(sxs[i] + dx, sys[i] + dy);
            if (v !== v) continue;
            sb += v;
            sbb += v * v;
            sab += (a[i] - ma) * v;
            m++;
          }
          if (m <= k * 0.9) return -2;
          const vb = sbb - (sb * sb) / m;
          return vb > 1e-12 ? sab / Math.sqrt(va * vb) : -2;
        };
        // coarse (every 4 sensor pixels over +-R), then every pixel round the best, then between pixels by parabolas
        let best = -2;
        let bx = 0;
        let by = 0;
        for (let dy = -R; dy <= R; dy += 4) {
          for (let dx = -R; dx <= R; dx += 4) {
            const v = nccAt(dx, dy);
            if (v > best) {
              best = v;
              bx = dx;
              by = dy;
            }
          }
        }
        const fine = new Map();
        const cx0 = bx;
        const cy0 = by;
        for (let dy = cy0 - 3; dy <= cy0 + 3; dy++) {
          for (let dx = cx0 - 3; dx <= cx0 + 3; dx++) {
            const v = nccAt(dx, dy);
            fine.set(`${dx},${dy}`, v);
            if (v > best) {
              best = v;
              bx = dx;
              by = dy;
            }
          }
        }
        if (best < 0.75 || Math.abs(bx) >= R || Math.abs(by) >= R) continue; // a poor match, or at the edge of the search
        const sc = (x, y) => (fine.has(`${x},${y}`) ? fine.get(`${x},${y}`) : nccAt(x, y));
        const sub = (l, m0, r) => {
          const den = l - 2 * m0 + r;
          return den < 0 ? Math.max(-0.5, Math.min(0.5, (l - r) / (2 * den))) : 0;
        };
        const fx = bx + sub(sc(bx - 1, by), best, sc(bx + 1, by));
        const fy = by + sub(sc(bx, by - 1), best, sc(bx, by + 1));
        const c = (k >> 1) + (n >> 1);
        pts.push({ u: sxs[c] / 4160, v: sys[c] / 3120, dx: fx, dy: fy, w: best });
      }
    }
    if (pts.length < 8) continue;
    // weighted least squares of the affine function, three rounds, each dropping the patches more than 3 times the typical miss off
    let use = pts;
    let fit = null;
    for (let round = 0; round < 3; round++) {
      fit = fitAffine(use);
      if (!fit) break;
      const res = use.map((p) => Math.hypot(p.dx - (fit.ax[0] + fit.ax[1] * p.u + fit.ax[2] * p.v), p.dy - (fit.ay[0] + fit.ay[1] * p.u + fit.ay[2] * p.v)));
      const sorted = res.slice().sort((x, y) => x - y);
      const typical = Math.max(0.3, sorted[sorted.length >> 1] * 1.48);
      const keep = use.filter((p, i) => res[i] <= 3 * typical);
      if (keep.length < 8 || keep.length === use.length) {
        use = keep.length >= 8 ? keep : use;
        break;
      }
      use = keep;
    }
    fit = fitAffine(use);
    if (!fit) continue;
    const rms = Math.sqrt(use.reduce((acc, p) => acc + (p.dx - (fit.ax[0] + fit.ax[1] * p.u + fit.ax[2] * p.v)) ** 2 + (p.dy - (fit.ay[0] + fit.ay[1] * p.u + fit.ay[2] * p.v)) ** 2, 0) / use.length);
    out[id] = { ax: fit.ax, ay: fit.ay, n: use.length, rms };
  }
  return out;
}

// Weighted least squares of d = c0 + c1 u + c2 v for both components (the points' weights w). Null when the points do not fix it.
function fitAffine(pts) {
  const M = new Float64Array(9);
  const bx = new Float64Array(3);
  const by = new Float64Array(3);
  for (const p of pts) {
    const f = [1, p.u, p.v];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) M[3 * i + j] += p.w * f[i] * f[j];
      bx[i] += p.w * f[i] * p.dx;
      by[i] += p.w * f[i] * p.dy;
    }
  }
  const solve = (b) => {
    // Cramer's rule on the 3 x 3 system
    const det = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
    const d = det(M);
    if (Math.abs(d) < 1e-12) return null;
    const x = [];
    for (let c = 0; c < 3; c++) {
      const m = Float64Array.from(M);
      for (let r = 0; r < 3; r++) m[3 * r + c] = b[r];
      x.push(det(m) / d);
    }
    return x;
  };
  const ax = solve(bx);
  const ay = solve(by);
  return ax && ay ? { ax, ay } : null;
}

// The wide picture (`wide`: { width, height, rgb } on the reference grid, as fuse() returns it) as a bilinear sampler at ideal pixel position (x, y).
function bilinear(img, w, h, sx, sy, o) {
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

// Per channel minimum and maximum of a picture (3 per pixel) within `r` pixels (a square window), as two pictures.
function localBounds(a, W, H, r) {
  const pass = (src, w, h, horizontal, isMin) => {
    const out = new Float32Array(src.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 3; c++) {
          let best = isMin ? Infinity : -Infinity;
          for (let d = -r; d <= r; d++) {
            const xx = horizontal ? Math.min(w - 1, Math.max(0, x + d)) : x;
            const yy = horizontal ? y : Math.min(h - 1, Math.max(0, y + d));
            const v = src[3 * (yy * w + xx) + c];
            if (isMin ? v < best : v > best) best = v;
          }
          out[3 * (y * w + x) + c] = best;
        }
      }
    }
    return out;
  };
  return { min: pass(pass(a, W, H, true, true), W, H, false, true), max: pass(pass(a, W, H, true, false), W, H, false, false) };
}

// The cameras that add resolution: those whose focal length is `ratio` (range [lo, hi]) times the reference's.
export function telephotoModules(parsed, refId, [lo, hi]) {
  const f0 = cameraModel(parsed.header, parsed.modules[refId][0]).K[0];
  const ids = [];
  for (const [id, frames] of Object.entries(parsed.modules)) {
    const o = frames[0].module.sensor_bayer_red_override;
    if (o && o.x < 0) continue;
    try {
      const f = cameraModel(parsed.header, frames[0]).K[0];
      if (f / f0 >= lo && f / f0 <= hi) ids.push(id);
    } catch {
      // a module without usable calibration is left out
    }
  }
  return ids.sort();
}

// A box blur of one value per pixel (w x h), radius r, twice (close to a Gaussian).
function boxBlur1(src, w, h, r) {
  let a = src;
  for (let pass = 0; pass < 2; pass++) {
    const tmp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += a[y * w + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[y * w + x] = acc / (2 * r + 1);
        acc += a[y * w + Math.min(w - 1, x + r + 1)] - a[y * w + Math.max(0, x - r)];
      }
    }
    const out = new Float32Array(w * h);
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = acc / (2 * r + 1);
        acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
    a = out;
  }
  return a;
}

// Renders the region { x0, y0, w, h } (pixels of the wide reference's grid) at `scale` (output pixels per wide pixel). `wide` is the merged wide picture, `depth` the measured depth
// (core/l16depth.js), `modules` the telephoto cameras to use. Returns { width, height, rgb, covered: the share of output pixels that a telephoto camera supplied }.
// (`grid`: sensor pixels per pixel of the wide picture's grid, 1 for the full size merge and 2 for the half size one; the region is in that grid's pixels and `scale` is output pixels per grid pixel.)
export function renderRegion(bytes, parsed, depth, wide, { x0, y0, w, h, scale, grid = 1, corrections = null }, modules, opts, onProgress = () => {}, rawCache = null) {
  const W = Math.round(w * scale);
  const H = Math.round(h * scale);
  const refCam = cameraModel(parsed.header, parsed.modules[depth.ref][0]);
  const K = refCam.K;
  // the depth (mm) of every output pixel, from the depth map (bilinear in inverse depth)
  const z = new Float32Array(W * H);
  for (let Y = 0; Y < H; Y++) {
    const y = y0 + (Y + 0.5) / scale;
    const fy = Math.min(depth.height - 1.001, Math.max(0, (y * depth.height) / wide.height - 0.5));
    const iy = fy | 0;
    const ty = fy - iy;
    for (let X = 0; X < W; X++) {
      const x = x0 + (X + 0.5) / scale;
      const fx = Math.min(depth.width - 1.001, Math.max(0, (x * depth.width) / wide.width - 0.5));
      const ix = fx | 0;
      const tx = fx - ix;
      const a = depth.invZ[iy * depth.width + ix] * (1 - tx) + depth.invZ[iy * depth.width + ix + 1] * tx;
      const b = depth.invZ[(iy + 1) * depth.width + ix] * (1 - tx) + depth.invZ[(iy + 1) * depth.width + ix + 1] * tx;
      z[Y * W + X] = 1 / Math.max(1e-7, a * (1 - ty) + b * ty);
    }
  }
  // the wide picture on the output grid (bilinear)
  const up = new Float32Array(3 * W * H);
  const tmp = [0, 0, 0];
  for (let Y = 0; Y < H; Y++) {
    for (let X = 0; X < W; X++) {
      const ok = bilinear(wide.rgb, wide.width, wide.height, x0 + (X + 0.5) / scale, y0 + (Y + 0.5) / scale, tmp);
      const i = 3 * (Y * W + X);
      if (ok) {
        up[i] = tmp[0];
        up[i + 1] = tmp[1];
        up[i + 2] = tmp[2];
      }
    }
  }
  const sigma = scale * 0.9;
  const upLow = gauss(up, W, H, sigma);
  const out = Float32Array.from(up);
  const weight = new Float32Array(W * H).fill(0.04); // the wide picture's share where no telephoto camera helps
  const agreement = {};
  const details = []; // each camera's high frequency detail (3 per pixel, NaN where it has none or disagrees)
  const wsum = new Float32Array(W * H);
  let used = 0;
  for (const id of modules) {
    onProgress('Adding telephoto detail', used / Math.max(1, modules.length));
    const cam = cameraModel(parsed.header, parsed.modules[id][0]);
    const rel = relativePose(refCam, cam);
    const corr = corrections && corrections[id];
    const R = rel.R;
    const T = rel.T;
    // where each output pixel lands on this camera's sensor, and the window of the sensor that covers them
    const sxs = new Float32Array(W * H).fill(NaN);
    const sys = new Float32Array(W * H);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let Y = 0; Y < H; Y++) {
      const py = (y0 + (Y + 0.5) / scale) * grid;
      for (let X = 0; X < W; X++) {
        const i = Y * W + X;
        const px = (x0 + (X + 0.5) / scale) * grid;
        const Z = z[i];
        const Xr = ((px - K[2]) / K[0]) * Z;
        const Yr = ((py - K[5]) / K[4]) * Z;
        const Pz = R[6] * Xr + R[7] * Yr + R[8] * Z + T[2];
        if (Pz <= 1) continue;
        const ix = (cam.K[0] * (R[0] * Xr + R[1] * Yr + R[2] * Z + T[0])) / Pz + cam.K[2];
        const iy = (cam.K[4] * (R[3] * Xr + R[4] * Yr + R[5] * Z + T[1])) / Pz + cam.K[5];
        let [sx, sy] = cam.distort(ix, iy);
        if (corr) {
          // the capture's correction of this camera's registration (estimateCorrections)
          const u = sx / 4160;
          const v = sy / 3120;
          sx += corr.ax[0] + corr.ax[1] * u + corr.ax[2] * v;
          sy += corr.ay[0] + corr.ay[1] * u + corr.ay[2] * v;
        }
        sxs[i] = sx;
        sys[i] = sy;
        if (sx < minX) minX = sx;
        if (sx > maxX) maxX = sx;
        if (sy < minY) minY = sy;
        if (sy > maxY) maxY = sy;
      }
    }
    if (!(maxX >= minX)) continue;
    const img = demosaic(bytes, parsed.modules[id][0], opts, { x0: minX - 3, y0: minY - 3, w: maxX - minX + 7, h: maxY - minY + 7 }, rawCache || new Map());
    const samp = new Float32Array(3 * W * H);
    const have = new Uint8Array(W * H);
    const s3 = [0, 0, 0];
    for (let i = 0; i < W * H; i++) {
      if (sxs[i] !== sxs[i]) continue;
      if (bilinear(img.rgb, img.width, img.height, sxs[i] - img.x0, sys[i] - img.y0, s3)) {
        have[i] = 1;
        samp[3 * i] = s3[0];
        samp[3 * i + 1] = s3[1];
        samp[3 * i + 2] = s3[2];
      }
    }
    // gains that bring the camera's colors to the wide picture's (over where it has pixels)
    const sr = [0, 0, 0];
    const sd = [0, 0, 0];
    for (let i = 0; i < W * H; i += 5) {
      if (!have[i]) continue;
      for (let c = 0; c < 3; c++) {
        sr[c] += up[3 * i + c];
        sd[c] += samp[3 * i + c];
      }
    }
    const g = sd.map((v, c) => (v > 1e-6 ? sr[c] / v : 1));
    for (let i = 0; i < W * H; i++) {
      if (!have[i]) continue;
      samp[3 * i] *= g[0];
      samp[3 * i + 1] *= g[1];
      samp[3 * i + 2] *= g[2];
    }
    let low = gauss(samp, W, H, sigma);
    // refine the registration against the wide picture, then look the camera up again with the corrections
    if (opts.flow !== false && W >= 64 && H >= 64) {
      const lumaOf = (arr) => {
        const o = new Float32Array(W * H);
        for (let i = 0; i < W * H; i++) o[i] = luma(arr[3 * i], arr[3 * i + 1], arr[3 * i + 2]);
        return o;
      };
      const shiftAt = flowOffsets(lumaOf(upLow), lumaOf(low), W, H, 4, 6, 2);
      let moved = 0;
      for (let Y = 0; Y < H; Y++) {
        for (let X = 0; X < W; X++) {
          const i = Y * W + X;
          if (sxs[i] !== sxs[i]) continue;
          const [ox, oy] = shiftAt(X, Y);
          if (ox === 0 && oy === 0) continue;
          // the sensor's shift for an output shift: from how the lookup moves between neighbouring output pixels
          const nx = X + 1 < W && sxs[i + 1] === sxs[i + 1] ? i + 1 : i - 1;
          const ny = Y + 1 < H && sxs[i + W] === sxs[i + W] ? i + W : i - W;
          const sgx = nx > i ? 1 : -1;
          const sgy = ny > i ? 1 : -1;
          if (nx < 0 || ny < 0 || nx >= W * H || ny >= W * H || sxs[nx] !== sxs[nx] || sxs[ny] !== sxs[ny]) continue;
          const dxx = (sxs[nx] - sxs[i]) * sgx;
          const dyx = (sys[nx] - sys[i]) * sgx;
          const dxy = (sxs[ny] - sxs[i]) * sgy;
          const dyy = (sys[ny] - sys[i]) * sgy;
          // the camera at output pixel i is looked up where the wide picture's content is: the shift tells where the camera's content sits relative to it
          const fsx = sxs[i] + ox * dxx + oy * dxy;
          const fsy = sys[i] + ox * dyx + oy * dyy;
          if (bilinear(img.rgb, img.width, img.height, fsx - img.x0, fsy - img.y0, s3)) {
            samp[3 * i] = s3[0] * g[0];
            samp[3 * i + 1] = s3[1] * g[1];
            samp[3 * i + 2] = s3[2] * g[2];
            moved++;
          }
        }
      }
      if (moved) low = gauss(samp, W, H, sigma);
    }
    // (the detail is brightness only: a camera's color detail is mostly its demosaic's false color at fine edges, and mixing cameras per channel would color the edges)
    const det = new Float32Array(W * H).fill(NaN);
    const wmap = new Float32Array(W * H);
    let camW = 0;
    let camN = 0;
    // (near the sensor's white level a channel is cut, at a different level in each camera: there is no detail to add there, only the difference in where each one clipped)
    const wb = opts.gains || [1, 1, 1];
    const clipped = (arr, i, k) => Math.max(arr[3 * i] / (wb[0] * k[0]), arr[3 * i + 1] / (wb[1] * k[1]), arr[3 * i + 2] / (wb[2] * k[2])) > 0.9;
    for (let i = 0; i < W * H; i++) {
      if (!have[i]) continue;
      if (clipped(up, i, [1, 1, 1]) || clipped(samp, i, g)) continue;
      // agree: the telephoto's low frequencies match the wide picture's within noise and a small misregistration
      const ll = luma(low[3 * i], low[3 * i + 1], low[3 * i + 2]);
      const lu = luma(upLow[3 * i], upLow[3 * i + 1], upLow[3 * i + 2]);
      const sig = 0.015 + 0.08 * Math.sqrt(Math.max(lu, 0)) * 0.35;
      const d = (ll - lu) / sig;
      const wgt = Math.exp(-0.5 * d * d);
      camW += wgt;
      camN++;
      wmap[i] = wgt;
      det[i] = luma(samp[3 * i], samp[3 * i + 1], samp[3 * i + 2]) - ll;
    }
    // The agreement judged over a small neighborhood, not pixel by pixel: one pixel's noise would otherwise switch the detail on and off from pixel to pixel (a patchwork).
    const wsm = boxBlur1(wmap, W, H, Math.max(1, Math.round(scale)));
    for (let i = 0; i < W * H; i++) {
      if (det[i] !== det[i]) continue;
      if (wsm[i] < 0.05) det[i] = NaN;
      else wsum[i] += wsm[i];
    }
    // (a longer lens resolves more: where several agree, its detail is the one to take)
    details.push({ det, w: wsm, reach: cam.K[0] / K[0] });
    // (how well this camera fits the wide picture over the region: the mean agreement, for checking the registration)
    agreement[id] = camN ? camW / camN : null;
    used++;
  }
  // What the wide picture itself holds round each pixel (its smallest and largest value within about 1.5 of its pixels): detail that takes a pixel far outside that is a camera that sees an
  // edge a little off (parallax, a misregistration), and it would draw a dark or bright outline, so it is held to a little beyond it.
  const rr = Math.max(2, Math.round(scale * 1.5));
  const bounds = localBounds(up, W, H, rr);
  details.sort((a, b) => b.reach - a.reach);
  // The detail at each pixel: the cameras that agree there, weighted by how well (one that is a little out of register, or sees an edge another does not, counts little), and the
  // weak part of it, which is mostly noise, taken down.
  let covered = 0;
  for (let i = 0; i < W * H; i++) {
    if (!(wsum[i] > 0.05)) continue;
    const Y = luma(up[3 * i], up[3 * i + 1], up[3 * i + 2]);
    const noise = 0.004 + 0.02 * Math.sqrt(Math.max(Y, 0)) * 0.35;
    // the cameras' detail layered, the longest lens first: each fills in as much as it agrees round the pixel, and the shorter ones only what is left (averaging cameras evenly
    // blurs the detail, as one a little out of register, or one with less reach, takes the edge off the others)
    let m = 0;
    let rest = 1;
    let any = false;
    for (const { det, w: wm } of details) {
      const v = det[i];
      if (v !== v) continue;
      const t = Math.min(1, Math.max(0, (wm[i] - 0.15) / 0.45));
      const a = t * t * (3 - 2 * t);
      m += rest * a * v;
      rest *= 1 - a;
      any = true;
    }
    // (m is already in proportion to how well the cameras that supply it agree: no camera that disagrees takes it down)
    if (!any || rest > 0.999) continue;
    const a = Math.abs(m);
    m = a <= noise ? m * (a / noise) : Math.sign(m) * (a - noise * 0.5);
    // (held to a little beyond the wide picture's own brightness range there, in proportion: a dark pixel stays dark, not black)
    const lo = luma(bounds.min[3 * i], bounds.min[3 * i + 1], bounds.min[3 * i + 2]);
    const hi = luma(bounds.max[3 * i], bounds.max[3 * i + 1], bounds.max[3 * i + 2]);
    const Yn = Math.max(lo * 0.6, Math.min(hi * 1.3 + 0.006, Y + m));
    // the new brightness with the wide picture's color: scaled where there is light enough to scale, added equally in the dark
    if (Y > 0.02) {
      const k = Yn / Y;
      for (let c = 0; c < 3; c++) out[3 * i + c] = Math.max(0, up[3 * i + c] * k);
    } else {
      for (let c = 0; c < 3; c++) out[3 * i + c] = Math.max(0, up[3 * i + c] + (Yn - Y));
    }
    covered++;
  }
  return { width: W, height: H, rgb: out, covered: covered / (W * H), wide: up, agreement };
}
