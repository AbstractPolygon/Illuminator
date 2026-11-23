// A new viewpoint for a Light L16 photo: the reference picture and its depth, seen from a camera moved by (tx, ty) millimeters.
// A point at depth Z moves by -f * t * (1 / Z - 1 / Z0) pixels, where Z0 is the depth that stays still (the "pivot": things there keep their place and the scene swings
// around them). Each source pixel is splatted forward onto the new picture, nearest first (a z-buffer), as a small rectangle reaching to its neighbors' midpoints, but only
// across neighbors at a similar depth, so a surface that stretches is closed without bridging an occlusion. What no pixel reached is a real disocclusion: it is filled from
// the other cameras' pictures when they are given (fillFromDonors), then from the surrounding picture on the far side (fillFromBackground).
import { decodeFrame } from './lri.js';

const DEPTH_TOLERANCE = 0.03; // depths within this fraction count as one surface
const MAX_EXTENT = 12; // the largest footprint half size in pixels: a surface stretched more than this is nearly edge on, and stays a hole

// Superpixel color of a module: each 2 x 2 sensor cell becomes one pixel (red, the mean of the two greens, blue), linear 0..1 after the black level, white balanced.
// Returns { width, height, rgb: Float32Array(3 * w * h) }.
export function superpixelColor(bytes, frame, { black = 42, white = 1023, gains = [1, 1, 1] } = {}) {
  const { width: W, height: H, data } = decodeFrame(bytes, frame);
  const o = frame.module.sensor_bayer_red_override || { x: 0, y: 0 };
  const mono = o.x < 0;
  const w = W >> 1;
  const h = H >> 1;
  const rgb = new Float32Array(3 * w * h);
  const scale = 1 / (white - black);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const at = (dx, dy) => Math.max(0, (data[(2 * y + dy) * W + 2 * x + dx] - black) * scale);
      const i = 3 * (y * w + x);
      if (mono) {
        const v = (at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1)) / 4;
        rgb[i] = rgb[i + 1] = rgb[i + 2] = v;
      } else {
        const rx = o.x;
        const ry = o.y;
        rgb[i] = at(rx, ry) * gains[0];
        rgb[i + 1] = ((at(1 - rx, ry) + at(rx, 1 - ry)) / 2) * gains[1];
        rgb[i + 2] = at(1 - rx, 1 - ry) * gains[2];
      }
    }
  }
  return { width: w, height: h, rgb };
}

// Depth (1/mm, of the reduced size) resampled to w x h as depth in mm, bilinear in inverse depth.
export function depthAtSize(invZ, dw, dh, w, h) {
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

// Splats the picture into the view from (tx, ty) mm. `focal` is the reference camera's focal length in pixels of this picture. pivotZ (mm, 0 = none) is the depth that stays still.
// Returns { rgb, z (the depth of what landed, Infinity where nothing), hole: Uint8Array }.
export function synthesize({ rgb, width: w, height: h, z }, focal, tx, ty, pivotZ = 0) {
  const invZ0 = pivotZ > 0 ? 1 / pivotZ : 0;
  const out = new Float32Array(3 * w * h);
  const zbuf = new Float32Array(w * h).fill(Infinity);
  const dx = new Float32Array(w * h);
  const dy = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const k = focal / z[i];
    dx[i] = (i % w) + 0.5 - k * tx + focal * tx * invZ0;
    dy[i] = Math.floor(i / w) + 0.5 - k * ty + focal * ty * invZ0;
  }
  const similar = (a, b) => Math.abs(a - b) <= DEPTH_TOLERANCE * Math.min(a, b);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const zi = z[i];
      const px = dx[i];
      const py = dy[i];
      // footprint: halfway to the neighbours' landing places, on the sides where the neighbour is the same surface
      let x0 = px - 0.5;
      let x1 = px + 0.5;
      let y0 = py - 0.5;
      let y1 = py + 0.5;
      if (x > 0 && similar(zi, z[i - 1])) x0 = Math.max(px - MAX_EXTENT, (px + dx[i - 1]) / 2);
      if (x < w - 1 && similar(zi, z[i + 1])) x1 = Math.min(px + MAX_EXTENT, (px + dx[i + 1]) / 2);
      if (y > 0 && similar(zi, z[i - w])) y0 = Math.max(py - MAX_EXTENT, (py + dy[i - w]) / 2);
      if (y < h - 1 && similar(zi, z[i + w])) y1 = Math.min(py + MAX_EXTENT, (py + dy[i + w]) / 2);
      if (x1 < x0) [x0, x1] = [x1, x0];
      if (y1 < y0) [y0, y1] = [y1, y0];
      // the pixels whose centers (j + 0.5) fall inside the footprint; a footprint too small to hold a center goes to the pixel it lands in
      let ix0 = Math.ceil(x0 - 0.5 - 1e-6);
      let ix1 = Math.ceil(x1 - 0.5 - 1e-6) - 1;
      if (ix1 < ix0) ix0 = ix1 = Math.floor(px);
      let iy0 = Math.ceil(y0 - 0.5 - 1e-6);
      let iy1 = Math.ceil(y1 - 0.5 - 1e-6) - 1;
      if (iy1 < iy0) iy0 = iy1 = Math.floor(py);
      ix0 = Math.max(0, ix0);
      ix1 = Math.min(w - 1, ix1);
      iy0 = Math.max(0, iy0);
      iy1 = Math.min(h - 1, iy1);
      if (ix1 < 0 || iy1 < 0 || ix0 > w - 1 || iy0 > h - 1) continue;
      const r = rgb[3 * i];
      const g = rgb[3 * i + 1];
      const b = rgb[3 * i + 2];
      for (let yy = iy0; yy <= iy1; yy++) {
        for (let xx = ix0; xx <= ix1; xx++) {
          const j = yy * w + xx;
          if (zi < zbuf[j]) {
            zbuf[j] = zi;
            out[3 * j] = r;
            out[3 * j + 1] = g;
            out[3 * j + 2] = b;
          }
        }
      }
    }
  }
  const hole = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (zbuf[i] === Infinity) hole[i] = 1;
  return { rgb: out, z: zbuf, hole };
}

// Fills the holes from the surrounding picture, the farther side first: a disocclusion is background coming into view, so the nearer side's color is the one thing that must
// not be pulled in. Repeats a sweep that gives each hole pixel the color of its farthest filled neighbour, until nothing is left or it stops changing.
export function fillFromBackground(view, w, h) {
  const { rgb, z, hole } = view;
  const left = hole.reduce((a, b) => a + b, 0);
  let remaining = left;
  for (let pass = 0; pass < 200 && remaining > 0; pass++) {
    const fillZ = new Map();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!hole[i]) continue;
        let best = -1;
        let bz = -Infinity;
        const tryN = (j) => {
          if (!hole[j] && z[j] > bz) {
            bz = z[j];
            best = j;
          }
        };
        if (x > 0) tryN(i - 1);
        if (x < w - 1) tryN(i + 1);
        if (y > 0) tryN(i - w);
        if (y < h - 1) tryN(i + w);
        if (best >= 0) fillZ.set(i, best);
      }
    }
    if (!fillZ.size) break;
    for (const [i, j] of fillZ) {
      rgb[3 * i] = rgb[3 * j];
      rgb[3 * i + 1] = rgb[3 * j + 1];
      rgb[3 * i + 2] = rgb[3 * j + 2];
      z[i] = z[j];
      hole[i] = 0;
    }
    remaining -= fillZ.size;
  }
  return view;
}
