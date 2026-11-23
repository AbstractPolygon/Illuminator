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

// ----- filling from the other cameras

// The depth of the picture with its holes filled by the farther neighbour (the background that comes into view), for looking the holes up in other cameras.
export function backgroundDepth(z, hole, w, h) {
  const zz = Float32Array.from(z);
  const hh = Uint8Array.from(hole);
  fillFromBackground({ rgb: new Float32Array(3 * w * h), z: zz, hole: hh }, w, h);
  return zz;
}

// Per channel gains that give a donor the reference's colors: the ratio of mean colors over the pixels both see (the donor is looked up at the reference's depth).
function colorGains(ref, donorAt, w, h) {
  const sumR = [0, 0, 0];
  const sumD = [0, 0, 0];
  for (let y = 4; y < h; y += 7) {
    for (let x = 4; x < w; x += 7) {
      const d = donorAt(x, y);
      if (!d) continue;
      const i = 3 * (y * w + x);
      for (let c = 0; c < 3; c++) {
        sumR[c] += ref[i + c];
        sumD[c] += d[c];
      }
    }
  }
  return sumD.map((v, c) => (v > 1e-6 ? sumR[c] / v : 1));
}

// Fills the holes of `view` from donor cameras. `ref` = { rgb, width, height, z (depth in mm at the reference), K (the reference camera's 3x3 at the sensor's size),
// scale (sensor pixels per picture pixel, 2) }, `donors` = [{ cam (core/l16geometry cameraModel), rel ({R, T} of the donor relative to the reference), color ({width, height, rgb}) }],
// (tx, ty) the virtual camera's offset from the reference in mm, `zBack` the depth to look each hole up at. A hole takes the first donor, nearest to the virtual camera first,
// whose picture covers the place. Returns how many pixels were filled.
export function fillFromDonors(view, ref, donors, tx, ty, zBack) {
  const { width: w, height: h } = ref;
  const K = ref.K;
  const S = ref.scale;
  const prepared = donors
    .map((d) => {
      // the donor's centre relative to the reference, in image axes: C = -R^T T
      const c = [-(d.rel.R[0] * d.rel.T[0] + d.rel.R[3] * d.rel.T[1] + d.rel.R[6] * d.rel.T[2]), -(d.rel.R[1] * d.rel.T[0] + d.rel.R[4] * d.rel.T[1] + d.rel.R[7] * d.rel.T[2])];
      return { ...d, dist: Math.hypot(c[0] - tx, c[1] - ty) };
    })
    .sort((a, b) => a.dist - b.dist);
  const sample = (d, X, Y, Z) => {
    const R = d.rel.R;
    const T = d.rel.T;
    const Pz = R[6] * X + R[7] * Y + R[8] * Z + T[2];
    if (Pz <= 1) return null;
    const ix = (d.cam.K[0] * (R[0] * X + R[1] * Y + R[2] * Z + T[0])) / Pz + d.cam.K[2];
    const iy = (d.cam.K[4] * (R[3] * X + R[4] * Y + R[5] * Z + T[1])) / Pz + d.cam.K[5];
    const [sx, sy] = d.cam.distort(ix, iy);
    const px = sx / 2 - 0.5;
    const py = sy / 2 - 0.5;
    const { width: dw, height: dh, rgb } = d.color;
    if (px < 0 || py < 0 || px >= dw - 1 || py >= dh - 1) return null;
    const x0 = px | 0;
    const y0 = py | 0;
    const fx = px - x0;
    const fy = py - y0;
    const o = 3 * (y0 * dw + x0);
    const out = [0, 0, 0];
    for (let c = 0; c < 3; c++) out[c] = (rgb[o + c] * (1 - fx) + rgb[o + 3 + c] * fx) * (1 - fy) + (rgb[o + 3 * dw + c] * (1 - fx) + rgb[o + 3 * dw + 3 + c] * fx) * fy;
    return out;
  };
  // gains from the reference's own pixels
  for (const d of prepared) {
    d.gains = colorGains(ref.rgb, (x, y) => {
      const Z = ref.z[y * w + x];
      return sample(d, ((((x + 0.5) * S - K[2]) / K[0]) * Z), ((((y + 0.5) * S - K[5]) / K[4]) * Z), Z);
    }, w, h);
  }
  let filled = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!view.hole[i]) continue;
      const Z = zBack[i];
      // the point the hole shows: along the virtual camera's ray at the background depth
      const X = (((x + 0.5) * S - K[2]) / K[0]) * Z + tx;
      const Y = (((y + 0.5) * S - K[5]) / K[4]) * Z + ty;
      for (const d of prepared) {
        const c = sample(d, X, Y, Z);
        if (!c) continue;
        view.rgb[3 * i] = c[0] * d.gains[0];
        view.rgb[3 * i + 1] = c[1] * d.gains[1];
        view.rgb[3 * i + 2] = c[2] * d.gains[2];
        view.z[i] = Z;
        view.hole[i] = 0;
        filled++;
        break;
      }
    }
  }
  return filled;
}
