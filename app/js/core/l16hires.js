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
export function renderRegion(bytes, parsed, depth, wide, { x0, y0, w, h, scale }, modules, opts, onProgress = () => {}) {
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
    const img = demosaic(bytes, parsed.modules[id][0], opts);
    const samp = new Float32Array(3 * W * H);
    const have = new Uint8Array(W * H);
    const s3 = [0, 0, 0];
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
        if (bilinear(img.rgb, img.width, img.height, sx, sy, s3)) {
          have[i] = 1;
          samp[3 * i] = s3[0];
          samp[3 * i + 1] = s3[1];
          samp[3 * i + 2] = s3[2];
        }
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
    const low = gauss(samp, W, H, sigma);
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
