// A region of a Light L16 photo at a higher resolution than the wide cameras have: the telephoto cameras (the 70 mm B group, 2.5 times the wide cameras' focal length, and the
// 150 mm C group, 5.4 times) see the same scene with that many more pixels per degree, and their pictures can be laid on the wide picture's grid through the depth, at a finer
// pixel spacing. Where a telephoto camera saw a place, it supplies the fine detail; the wide cameras' merged picture supplies the low frequencies (color, exposure and vignetting
// differ between cameras), and where the two do not agree (occlusions, a wrong depth, a camera out of focus) the wide picture alone is used.
//
// The output pixel (X, Y) of a region at `scale` is the point (x0 + (X + 0.5) / scale, y0 + (Y + 0.5) / scale) of the wide reference picture's undistorted grid (the grid of
// core/l16fusion.js). The depth there gives the 3D point, which each camera's calibration projects to its sensor.
import { cameraModel } from './l16geometry.js';
import { relativePose } from './l16depth.js';
import { demosaic } from './l16fusion.js';

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

// Renders the region { x0, y0, w, h } (pixels of the wide reference's grid) at `scale` (output pixels per wide pixel). `wide` is the merged wide picture, `depth` the measured depth
// (core/l16depth.js), `modules` the telephoto cameras to use. Returns { width, height, rgb, covered: the share of output pixels that a telephoto camera supplied }.
export function renderRegion(bytes, parsed, depth, wide, { x0, y0, w, h, scale }, modules, opts, onProgress = () => {}, rawCache = null) {
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
  const details = []; // each camera's high frequency detail (3 per pixel, NaN where it has none or disagrees)
  const wsum = new Float32Array(W * H);
  let used = 0;
  for (const id of modules) {
    onProgress('Adding telephoto detail', used / Math.max(1, modules.length));
    const cam = cameraModel(parsed.header, parsed.modules[id][0]);
    const rel = relativePose(refCam, cam);
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
      const py = y0 + (Y + 0.5) / scale;
      for (let X = 0; X < W; X++) {
        const i = Y * W + X;
        const px = x0 + (X + 0.5) / scale;
        const Z = z[i];
        const Xr = ((px - K[2]) / K[0]) * Z;
        const Yr = ((py - K[5]) / K[4]) * Z;
        const Pz = R[6] * Xr + R[7] * Yr + R[8] * Z + T[2];
        if (Pz <= 1) continue;
        const ix = (cam.K[0] * (R[0] * Xr + R[1] * Yr + R[2] * Z + T[0])) / Pz + cam.K[2];
        const iy = (cam.K[4] * (R[3] * Xr + R[4] * Yr + R[5] * Z + T[1])) / Pz + cam.K[5];
        const [sx, sy] = cam.distort(ix, iy);
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
    const det = new Float32Array(3 * W * H).fill(NaN);
    for (let i = 0; i < W * H; i++) {
      if (!have[i]) continue;
      // agree: the telephoto's low frequencies match the wide picture's within noise and a small misregistration
      const ll = luma(low[3 * i], low[3 * i + 1], low[3 * i + 2]);
      const lu = luma(upLow[3 * i], upLow[3 * i + 1], upLow[3 * i + 2]);
      const sig = 0.015 + 0.08 * Math.sqrt(Math.max(lu, 0)) * 0.35;
      const d = (ll - lu) / sig;
      const wgt = Math.exp(-0.5 * d * d);
      if (wgt < 0.05) continue;
      for (let c = 0; c < 3; c++) det[3 * i + c] = samp[3 * i + c] - low[3 * i + c];
      wsum[i] += wgt;
    }
    details.push(det);
    used++;
  }
  // The detail at each pixel: the median over the cameras that agree there (a camera that is a little out of register, or sees an edge another does not, is outvoted; with two, the
  // mean), and the weak part of it, which is mostly noise, taken down.
  let covered = 0;
  const vals = [];
  for (let i = 0; i < W * H; i++) {
    if (!(wsum[i] > 0.05)) continue;
    const lumaOf = up[3 * i + 1];
    const noise = 0.004 + 0.02 * Math.sqrt(Math.max(lumaOf, 0)) * 0.35;
    for (let c = 0; c < 3; c++) {
      vals.length = 0;
      for (const d of details) {
        const v = d[3 * i + c];
        if (v === v) vals.push(v);
      }
      if (!vals.length) continue;
      vals.sort((a, b) => a - b);
      let m = vals.length % 2 ? vals[vals.length >> 1] : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2;
      const a = Math.abs(m);
      m = a <= noise ? m * (a / noise) : Math.sign(m) * (a - noise * 0.5);
      out[3 * i + c] = Math.max(0, up[3 * i + c] + m);
    }
    covered++;
  }
  return { width: W, height: H, rgb: out, covered: covered / (W * H), wide: up };
}
