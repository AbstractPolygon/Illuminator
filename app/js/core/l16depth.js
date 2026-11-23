// Depth for a Light L16 photo, measured between its camera modules (plane sweep with the factory calibration, then semi-global smoothing).
//
// The reference module's picture is compared with the other modules of its group (same focal length: A1 to A5, or B1 to B5 on a telephoto capture) at a series of
// depths. For each depth every other module's picture is looked up where that depth would put the reference pixel (calibrated pose, intrinsics and lens distortion),
// and the difference of the two pictures is the cost of that depth at that pixel. The costs over all modules are averaged, gathered over a small window, then smoothed
// along four directions with a penalty for a change of depth (smaller across picture edges) to give one depth per pixel, refined between steps.
// Depth is measured as inverse distance (1 / mm) in equal steps, so the steps are equal in how far the picture moves.
import { cameraModel } from './l16geometry.js';
import { decodeFrame } from './lri.js';

const mul3 = (a, b) => {
  const o = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[3 * i + j] = a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j];
  return o;
};
const transpose3 = (a) => [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];

// The pose of camera `c` relative to camera `ref`: a point P in the reference camera's frame is R P + T in c's.
export function relativePose(ref, c) {
  const R = mul3(c.R, transpose3(ref.R));
  const T = [c.T[0] - (R[0] * ref.T[0] + R[1] * ref.T[1] + R[2] * ref.T[2]), c.T[1] - (R[3] * ref.T[0] + R[4] * ref.T[1] + R[5] * ref.T[2]), c.T[2] - (R[6] * ref.T[0] + R[7] * ref.T[1] + R[8] * ref.T[2])];
  return { R, T };
}

// Picture of a module reduced by `s` (sum of s x s sensor pixels), brightness-normalized by its local mean and spread so that exposure and vignetting differences
// between modules do not matter. Float32Array of (width / s) * (height / s).
export function reducedPicture(bytes, frame, s) {
  const { width: W, height: H, data } = decodeFrame(bytes, frame);
  const w = Math.floor(W / s);
  const h = Math.floor(H / s);
  const g = new Float32Array(w * h);
  const area = s * s;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let dy = 0; dy < s; dy++) {
        const row = (s * y + dy) * W + s * x;
        for (let dx = 0; dx < s; dx++) sum += data[row + dx];
      }
      g[y * w + x] = sum / area;
    }
  }
  return { w, h, g: normalizeLocally(g, w, h, 6) };
}

// (g - mean) / (spread + eps) over a (2r+1) square, so flat dark areas and bright ones weigh the same.
function normalizeLocally(g, w, h, r) {
  const mean = boxBlur(g, w, h, r);
  const sq = new Float32Array(g.length);
  for (let i = 0; i < g.length; i++) sq[i] = g[i] * g[i];
  const mean2 = boxBlur(sq, w, h, r);
  const out = new Float32Array(g.length);
  for (let i = 0; i < g.length; i++) {
    const sd = Math.sqrt(Math.max(0, mean2[i] - mean[i] * mean[i]));
    out[i] = (g[i] - mean[i]) / (sd + 0.02 * mean[i] + 2);
  }
  return out;
}

export function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / n;
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / n;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

const bilinear = (g, w, h, x, y) => {
  x -= 0.5;
  y -= 0.5;
  if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return NaN;
  const xi = x | 0;
  const yi = y | 0;
  const fx = x - xi;
  const fy = y - yi;
  const o = yi * w + xi;
  return (g[o] * (1 - fx) + g[o + 1] * fx) * (1 - fy) + (g[o + w] * (1 - fx) + g[o + w + 1] * fx) * fy;
};

// Which modules measure depth with the reference: the others of its group, a group being the modules of about the same focal length (the monochrome module A2
// joins in: its picture is brightness-normalized like the others).
export function depthGroup(parsed, refId) {
  const refFrame = parsed.modules[refId][0];
  const f0 = cameraModel(parsed.header, refFrame).K[0];
  const ids = [];
  for (const [id, frames] of Object.entries(parsed.modules)) {
    if (id === refId) continue;
    let c;
    try {
      c = cameraModel(parsed.header, frames[0]);
    } catch {
      continue;
    }
    if (Math.abs(c.K[0] / f0 - 1) < 0.1) ids.push(id);
  }
  return ids.sort();
}

// options: { ref (module id, default the header's reference), scale (sensor pixels per depth pixel, default 4), steps (depth steps, 48), near, far (mm) }
// Returns { width, height, scale, ref, modules, focalPx (of the reference at full size, K), invZ: Float32Array (1 / mm), steps, near, far, confidence: Float32Array 0..1 }.
export function measureDepth(bytes, parsed, options = {}, onProgress = () => {}) {
  const refId = options.ref || parsed.header.image_reference_camera;
  const S = options.scale || 4;
  const NZ = options.steps || 48;
  const refCam = cameraModel(parsed.header, parsed.modules[refId][0]);
  const group = options.modules || depthGroup(parsed, refId);
  if (!group.length) throw new Error('No other camera module of the same kind to measure depth with');
  const focal = refCam.K[0];
  const near = options.near || (focal > 6000 ? 1500 : 500);
  const far = options.far || (focal > 6000 ? 60000 : 25000);
  const invMin = 1 / far;
  const invMax = 1 / near;
  onProgress('Reading the camera pictures', 0);
  const ref = reducedPicture(bytes, parsed.modules[refId][0], S);
  const { w, h } = ref;
  const others = group.map((id) => {
    const cam = cameraModel(parsed.header, parsed.modules[id][0]);
    const pic = reducedPicture(bytes, parsed.modules[id][0], S);
    return { cam, pic, rel: relativePose(refCam, cam) };
  });
  const K = refCam.K;
  // the reference pixel's ideal position, the sensor position of the reference picture (its own distortion)
  const refSample = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [sx, sy] = refCam.distort((x + 0.5) * S, (y + 0.5) * S);
      refSample[y * w + x] = bilinear(ref.g, w, h, sx / S, sy / S);
    }
  }
  // cost volume, 0..255 (the mean over modules of the capped difference, scaled)
  const cost = new Uint8Array(w * h * NZ);
  const diff = new Float32Array(w * h);
  const CAP = 1.2;
  for (let zi = 0; zi < NZ; zi++) {
    const inv = invMin + ((invMax - invMin) * zi) / (NZ - 1);
    const z = 1 / inv;
    for (let y = 0; y < h; y++) {
      const py = (y + 0.5) * S;
      const Y = ((py - K[5]) / K[4]) * z;
      for (let x = 0; x < w; x++) {
        const px = (x + 0.5) * S;
        const X = ((px - K[2]) / K[0]) * z;
        const rv = refSample[y * w + x];
        let sum = 0;
        let n = 0;
        if (rv === rv) {
          for (const o of others) {
            const R = o.rel.R;
            const T = o.rel.T;
            const Pz = R[6] * X + R[7] * Y + R[8] * z + T[2];
            if (Pz <= 1) continue;
            const ix = (o.cam.K[0] * (R[0] * X + R[1] * Y + R[2] * z + T[0])) / Pz + o.cam.K[2];
            const iy = (o.cam.K[4] * (R[3] * X + R[4] * Y + R[5] * z + T[1])) / Pz + o.cam.K[5];
            const [sx, sy] = o.cam.distort(ix, iy);
            const v = bilinear(o.pic.g, o.pic.w, o.pic.h, sx / S, sy / S);
            if (v === v) {
              const d = Math.abs(v - rv);
              sum += d < CAP ? d : CAP;
              n++;
            }
          }
        }
        diff[y * w + x] = n ? sum / n : CAP;
      }
    }
    const agg = boxBlur(diff, w, h, 2);
    for (let i = 0; i < w * h; i++) cost[i * NZ + zi] = Math.min(255, Math.round((agg[i] / CAP) * 255 * 2));
    onProgress('Measuring depth', ((zi + 1) / NZ) * 0.6);
  }
  // semi-global smoothing along four directions
  const total = new Uint16Array(w * h * NZ);
  const P1 = options.p1 ?? 2;
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      gx[i] = Math.abs(ref.g[i] - ref.g[y * w + Math.min(w - 1, x + 1)]);
      gy[i] = Math.abs(ref.g[i] - ref.g[Math.min(h - 1, y + 1) * w + x]);
    }
  }
  const p2of = (grad) => Math.max(P1 + 2, (options.p2 ?? 14) - Math.min(options.p2 ?? 14, grad * 40));
  const path = (startX, startY, dx, dy) => {
    // one scan: the aggregated cost of the previous pixel along the path is the running row
    const prev = new Uint16Array(NZ);
    const cur = new Uint16Array(NZ);
    const lines = dx !== 0 ? h : w;
    for (let line = 0; line < lines; line++) {
      let x = dx !== 0 ? startX : line;
      let y = dx !== 0 ? line : startY;
      let first = true;
      while (x >= 0 && x < w && y >= 0 && y < h) {
        const i = y * w + x;
        const base = i * NZ;
        if (first) {
          for (let k = 0; k < NZ; k++) cur[k] = cost[base + k];
          first = false;
        } else {
          let minPrev = 65535;
          for (let k = 0; k < NZ; k++) if (prev[k] < minPrev) minPrev = prev[k];
          const pi = (y - dy) * w + (x - dx);
          const grad = dx !== 0 ? (dx > 0 ? gx[pi] : gx[i]) : dy > 0 ? gy[pi] : gy[i];
          const P2 = p2of(grad);
          for (let k = 0; k < NZ; k++) {
            let best = prev[k];
            if (k > 0 && prev[k - 1] + P1 < best) best = prev[k - 1] + P1;
            if (k < NZ - 1 && prev[k + 1] + P1 < best) best = prev[k + 1] + P1;
            if (minPrev + P2 < best) best = minPrev + P2;
            cur[k] = cost[base + k] + best - minPrev;
          }
        }
        for (let k = 0; k < NZ; k++) {
          total[base + k] += cur[k];
          prev[k] = cur[k];
        }
        x += dx;
        y += dy;
      }
    }
  };
  path(0, 0, 1, 0);
  onProgress('Smoothing depth', 0.7);
  path(w - 1, 0, -1, 0);
  onProgress('Smoothing depth', 0.8);
  path(0, 0, 0, 1);
  onProgress('Smoothing depth', 0.9);
  path(0, h - 1, 0, -1);
  // winner, refined between steps by a parabola through the neighbours; confidence from how much better it is than the runner up
  const invZ = new Float32Array(w * h);
  const confidence = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const base = i * NZ;
    let best = 0;
    let bc = 65535;
    for (let k = 0; k < NZ; k++) {
      const c = total[base + k];
      if (c < bc) {
        bc = c;
        best = k;
      }
    }
    let second = 65535;
    for (let k = 0; k < NZ; k++) if ((k < best - 1 || k > best + 1) && total[base + k] < second) second = total[base + k];
    let pos = best;
    if (best > 0 && best < NZ - 1) {
      const a = total[base + best - 1];
      const c = total[base + best + 1];
      const den = a - 2 * bc + c;
      if (den > 0) pos += Math.max(-0.5, Math.min(0.5, (a - c) / (2 * den)));
    }
    invZ[i] = invMin + ((invMax - invMin) * pos) / (NZ - 1);
    confidence[i] = second > 0 ? Math.max(0, Math.min(1, 1 - bc / second)) : 0;
  }
  // The border band is not measured well (the other cameras see less of it there): it takes the depth of the pixel BORDER inside; then a 3 x 3 median removes single bad steps.
  const BORDER = Math.max(4, Math.round(48 / S));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= BORDER && x < w - BORDER && y >= BORDER && y < h - BORDER) continue;
      const ix = Math.min(w - 1 - BORDER, Math.max(BORDER, x));
      const iy = Math.min(h - 1 - BORDER, Math.max(BORDER, y));
      invZ[y * w + x] = invZ[iy * w + ix];
      confidence[y * w + x] = 0;
    }
  }
  const median = new Float32Array(w * h);
  const win = new Float32Array(9);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) win[n++] = invZ[Math.min(h - 1, Math.max(0, y + dy)) * w + Math.min(w - 1, Math.max(0, x + dx))];
      win.sort();
      median[y * w + x] = win[4];
    }
  }
  invZ.set(median);
  onProgress('Depth measured', 1);
  return { width: w, height: h, scale: S, ref: refId, modules: group, focalPx: K[0], K, invZ, confidence, steps: NZ, near, far };
}
