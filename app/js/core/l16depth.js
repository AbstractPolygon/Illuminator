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
// The depth pictures made on the graphics card (gpu/l16reduce.js l16ReduceGpu's), or null for the processor's: set by the worker that has the card.
let reduceOnCard = null;
export function setL16ReduceGpu(r) {
  reduceOnCard = r || null;
}

export function reducedPicture(bytes, frame, s) {
  const sd = frame.module.sensor_data_surface;
  if (reduceOnCard && sd.format === 'RAW_PACKED_10BPP') {
    // (on the graphics card, gpu/l16reduce.js, straight from the file's packed rows; here if it fails)
    const start = frame.blockStart + sd.data_offset;
    if (start + (sd.size.y - 1) * sd.row_stride + (sd.size.x / 4) * 5 <= bytes.length) {
      try {
        return reduceOnCard.reduced({ packed: { bytes, start, stride: sd.row_stride }, W: sd.size.x, H: sd.size.y, s, r: 6 });
      } catch (e) {
        console.warn('L16 depth pictures on the graphics card failed; making them here', e);
        reduceOnCard = null;
      }
    }
  }
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
const UNSURE = 0.05;
// Replaces the depth of the pixels whose confidence is under `threshold` by the confidence weighted mean of the pixels within `radius` that are over it (where there are none, it stays).
export function fillUnsure(invZ, confidence, w, h, radius, threshold) {
  const W1 = w + 1;
  const sumV = new Float64Array(W1 * (h + 1));
  const sumW = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let rv = 0;
    let rw = 0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const c = confidence[i] >= threshold ? confidence[i] : 0;
      rv += c * invZ[i];
      rw += c;
      sumV[(y + 1) * W1 + x + 1] = sumV[y * W1 + x + 1] + rv;
      sumW[(y + 1) * W1 + x + 1] = sumW[y * W1 + x + 1] + rw;
    }
  }
  const out = new Float32Array(invZ);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(h, y + radius + 1);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (confidence[i] >= threshold) continue;
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(w, x + radius + 1);
      const sw = sumW[y1 * W1 + x1] - sumW[y0 * W1 + x1] - sumW[y1 * W1 + x0] + sumW[y0 * W1 + x0];
      if (sw < 1e-6) continue;
      const sv = sumV[y1 * W1 + x1] - sumV[y0 * W1 + x1] - sumV[y1 * W1 + x0] + sumV[y0 * W1 + x0];
      out[i] = sv / sw;
    }
  }
  invZ.set(out);
}

// The first part of measureDepth: the pictures and numbers every depth step uses (`job`, which can be sent to a helper worker as it is), and what the last part needs.
function depthSetup(bytes, parsed, options = {}, onProgress = () => {}) {
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
  let refSample = null;
  if (reduceOnCard) {
    try {
      refSample = reduceOnCard.undistorted(ref.g, w, h, S, refCam.distort);
    } catch (e) {
      console.warn('L16 depth pictures on the graphics card failed; making them here', e);
      reduceOnCard = null;
    }
  }
  if (!refSample) refSample = new Float32Array(w * h);
  if (!reduceOnCard) for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [sx, sy] = refCam.distort((x + 0.5) * S, (y + 0.5) * S);
      refSample[y * w + x] = bilinear(ref.g, w, h, sx / S, sy / S);
    }
  }
  // Each module's numbers in one flat object, and the inner loop worked out in place (projection, lens distortion, bilinear lookup): the same arithmetic as
  // cam.distort and bilinear, with no array made per pixel, depth and module (that was most of this step's time).
  const mods = others.map((o) => {
    const R = o.rel.R;
    const T = o.rel.T;
    const d = o.cam.distort.params || null;
    return {
      r0: R[0], r1: R[1], r2: R[2], r3: R[3], r4: R[4], r5: R[5], r6: R[6], r7: R[7], r8: R[8], t0: T[0], t1: T[1], t2: T[2],
      f0: o.cam.K[0], c0: o.cam.K[2], f1: o.cam.K[4], c1: o.cam.K[5],
      dist: !!d, k1: d ? d.k1 : 0, k2: d ? d.k2 : 0, k3: d ? d.k3 : 0, p1: d ? d.p1 : 0, p2: d ? d.p2 : 0, nx: d ? d.nx : 1, ny: d ? d.ny : 1, dcx: d ? d.cx : 0, dcy: d ? d.cy : 0,
      g: o.pic.g, pw: o.pic.w, ph: o.pic.h,
      // (distort's own function, for a module whose distortion is not the polynomial)
      fn: d ? null : o.cam.distort,
    };
  });
  // (the module pictures' own functions do not go to a helper: a module without the polynomial distortion keeps the work here)
  const portable = mods.every((m) => m.dist);
  const job = { mods: mods.map(({ fn, ...m }) => m), refSample, w, h, S, K: Array.from(K), invMin, invMax, NZ };
  return { job, portable, mods, ref, refId, refCam, group, w, h, S, NZ, K, invMin, invMax, near, far, options };
}

// One depth step of the cost volume (step `zi` of the job's NZ, in equal steps of inverse depth): for every reference pixel, the mean over the modules of the capped
// difference from the module's picture where that depth puts the pixel, gathered over a small window, scaled to 0..255. A helper worker runs the same function.
export function depthCostStep(job, zi, mods = job.mods) {
  const { refSample, w, h, S, K, invMin, invMax, NZ } = job;
  const CAP = 1.2;
  const diff = new Float32Array(w * h);
  const sum = new Float64Array(w * h);
  const cnt = new Uint8Array(w * h);
  const inv = invMin + ((invMax - invMin) * zi) / (NZ - 1);
  const z = 1 / inv;
  sum.fill(0);
  cnt.fill(0);
  // (one module at a time over every pixel, its numbers in local variables)
  for (let m = 0; m < mods.length; m++) {
    const { r0, r1, r2, r3, r4, r5, r6, r7, r8, t0, t1, t2, f0, c0, f1, c1, dist, k1, k2, k3, p1, p2, nx, ny, dcx, dcy, g, pw, ph, fn } = mods[m];
    const zx = r2 * z + t0;
    const zy = r5 * z + t1;
    const zz = r8 * z + t2;
    for (let y = 0; y < h; y++) {
      const Y = (((y + 0.5) * S - K[5]) / K[4]) * z;
      const ax = r1 * Y + zx;
      const ay = r4 * Y + zy;
      const az = r7 * Y + zz;
      for (let x = 0, i = y * w; x < w; x++, i++) {
        const rv = refSample[i];
        if (rv !== rv) continue;
        const X = (((x + 0.5) * S - K[2]) / K[0]) * z;
        const Pz = r6 * X + az;
        if (Pz <= 1) continue;
        const ix = (f0 * (r0 * X + ax)) / Pz + c0;
        const iy = (f1 * (r3 * X + ay)) / Pz + c1;
        let sx;
        let sy;
        if (dist) {
          const u = (ix - dcx) / nx;
          const v = (iy - dcy) / ny;
          const rr = u * u + v * v;
          const uv2 = 2 * u * v;
          const k = 1 + ((k3 * rr + k2) * rr + k1) * rr;
          sx = dcx + nx * (p1 * uv2 + p2 * (rr + 2 * u * u) + k * u);
          sy = dcy + ny * (p2 * uv2 + p1 * (rr + 2 * v * v) + k * v);
        } else {
          [sx, sy] = fn(ix, iy);
        }
        // (bilinear, as the function above)
        const bx = sx / S - 0.5;
        const by = sy / S - 0.5;
        if (!(bx >= 0 && by >= 0 && bx < pw - 1 && by < ph - 1)) continue;
        const xi = bx | 0;
        const yi = by | 0;
        const fx = bx - xi;
        const fy = by - yi;
        const q = yi * pw + xi;
        const val = (g[q] * (1 - fx) + g[q + 1] * fx) * (1 - fy) + (g[q + pw] * (1 - fx) + g[q + pw + 1] * fx) * fy;
        if (val === val) {
          const dd = val < rv ? rv - val : val - rv;
          sum[i] += dd < CAP ? dd : CAP;
          cnt[i]++;
        }
      }
    }
  }
  for (let i = 0; i < w * h; i++) diff[i] = cnt[i] ? sum[i] / cnt[i] : CAP;
  return costFromDiff(diff, w, h);
}

// The cost of one depth step from its mean capped differences (w x h, 0 .. DEPTH_CAP): gathered over a 5 x 5 window, scaled to 0..255. (Shared with the graphics
// card's step, gpu/l16cost.js, which makes the differences.)
export const DEPTH_CAP = 1.2;
export function costFromDiff(diff, w, h) {
  const agg = boxBlur(diff, w, h, 2);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = Math.min(255, Math.round((agg[i] / DEPTH_CAP) * 255 * 2));
  return out;
}

// Depth for the reference module of a Light L16 capture: { width, height, scale, ref, modules, focalPx, K, invZ (1 / mm per pixel), confidence, steps, near, far }.
export function measureDepth(bytes, parsed, options = {}, onProgress = () => {}) {
  const setup = depthSetup(bytes, parsed, options, onProgress);
  const { w, h, NZ, job, mods } = setup;
  const cost = new Uint8Array(w * h * NZ);
  for (let zi = 0; zi < NZ; zi++) {
    const slice = depthCostStep(job, zi, mods);
    for (let i = 0; i < w * h; i++) cost[i * NZ + zi] = slice[i];
    onProgress('Measuring depth', ((zi + 1) / NZ) * 0.6);
  }
  return depthFinish(setup, cost, onProgress);
}

// The same, with the depth steps shared out to helper workers (`pool`: run(job, zis, onSlice), see core/l16depthpool.js); the result is the same.
export async function measureDepthPooled(bytes, parsed, options = {}, onProgress = () => {}, pool = null) {
  const setup = depthSetup(bytes, parsed, options, onProgress);
  const { w, h, NZ, job, mods, portable } = setup;
  const cost = new Uint8Array(w * h * NZ);
  const have = new Uint8Array(NZ);
  let done = 0;
  const put = (zi, slice) => {
    if (have[zi]) return;
    have[zi] = 1;
    for (let i = 0; i < w * h; i++) cost[i * NZ + zi] = slice[i];
    onProgress('Measuring depth', (++done / NZ) * 0.6);
  };
  if (pool && portable) {
    try {
      await pool.run(job, NZ, put);
    } catch (err) {
      // (a helper failed: the steps not made yet are made here, as without helpers)
      console.warn('Depth helpers failed; measuring here', err);
    }
  }
  for (let zi = 0; zi < NZ; zi++) if (!have[zi]) put(zi, depthCostStep(job, zi, mods));
  return depthFinish(setup, cost, onProgress);
}

// The last steps on the graphics card (gpu/l16depthfinish.js l16DepthFinishGpu's function), or null for the processor's: set by the worker that has the card.
let finishOnCard = null;
export function setL16DepthFinishGpu(fn) {
  finishOnCard = fn || null;
}

// The smoothing on the graphics card (gpu/l16sgm.js l16SgmGpu's function), or null for the processor's: set by the worker that has the card.
let sgmOnCard = null;
export function setL16SgmGpu(fn) {
  sgmOnCard = fn || null;
}

// The last part: semi-global smoothing of the cost volume, the depth with its confidence, the filling of unsure pixels and the border.
function depthFinish(setup, cost, onProgress) {
  const { ref, refId, group, w, h, S, NZ, K, invMin, invMax, near, far, options } = setup;
  // semi-global smoothing along four directions
  // (made only when the smoothing is done here)
  let total = null;
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
  // (the card gives each pixel's winner: best step, its cost, the runner up, the costs either side)
  let winners = null;
  if (sgmOnCard) {
    // (on the graphics card, gpu/l16sgm.js: the same integer steps; here if it fails)
    try {
      const floorP2 = (g) => {
        const out = new Uint32Array(w * h);
        for (let i = 0; i < w * h; i++) out[i] = Math.floor(p2of(g[i]));
        return out;
      };
      const progress = [0.7, 0.8, 0.9, 0.9];
      let dir = 0;
      winners = sgmOnCard({ cost, w, h, NZ, P1, edgeX: floorP2(gx), edgeY: floorP2(gy), onDirection: () => onProgress('Smoothing depth', progress[dir++]) });
    } catch (err) {
      console.warn('L16 depth smoothing on the graphics card failed; smoothing here', err);
      sgmOnCard = null;
    }
  }
  if (!winners) {
    total = new Uint16Array(w * h * NZ);
    path(0, 0, 1, 0);
    onProgress('Smoothing depth', 0.7);
    path(w - 1, 0, -1, 0);
    onProgress('Smoothing depth', 0.8);
    path(0, 0, 0, 1);
    onProgress('Smoothing depth', 0.9);
    path(0, h - 1, 0, -1);
  }
  // winner, refined between steps by a parabola through the neighbours; confidence from how much better it is than the runner up
  const invZ = new Float32Array(w * h);
  const confidence = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const base = i * NZ;
    let best = 0;
    let bc = 65535;
    let second = 65535;
    let a = 0;
    let c = 0;
    if (winners) {
      best = winners[4 * i];
      bc = winners[4 * i + 1];
      second = winners[4 * i + 2];
      a = winners[4 * i + 3] & 0xffff;
      c = winners[4 * i + 3] >>> 16;
    } else {
      for (let k = 0; k < NZ; k++) {
        const v = total[base + k];
        if (v < bc) {
          bc = v;
          best = k;
        }
      }
      for (let k = 0; k < NZ; k++) if ((k < best - 1 || k > best + 1) && total[base + k] < second) second = total[base + k];
      if (best > 0) a = total[base + best - 1];
      if (best < NZ - 1) c = total[base + best + 1];
    }
    let pos = best;
    if (best > 0 && best < NZ - 1) {
      const den = a - 2 * bc + c;
      if (den > 0) pos += Math.max(-0.5, Math.min(0.5, (a - c) / (2 * den)));
    }
    invZ[i] = invMin + ((invMax - invMin) * pos) / (NZ - 1);
    confidence[i] = second > 0 ? Math.max(0, Math.min(1, 1 - bc / second)) : 0;
  }
  // Where the match is no better than its runner up (dark or flat areas), the depth is a guess: it is taken from the surer pixels round it (the mean of their depth, by confidence, over a
  // window), and a pixel that is sure keeps its own.
  const BORDER = Math.max(4, Math.round(48 / S));
  if (finishOnCard) {
    // (the filling, the border and the median on the graphics card, gpu/l16depthfinish.js; here if it fails)
    try {
      finishOnCard(invZ, confidence, w, h, Math.max(3, Math.round(40 / S)), UNSURE, BORDER);
      onProgress('Depth measured', 1);
      return { width: w, height: h, scale: S, ref: refId, modules: group, focalPx: K[0], K, invZ, confidence, steps: NZ, near, far };
    } catch (e) {
      console.warn('L16 depth finish on the graphics card failed; finishing here', e);
      finishOnCard = null;
    }
  }
  fillUnsure(invZ, confidence, w, h, Math.max(3, Math.round(40 / S)), UNSURE);
  // The border band is not measured well (the other cameras see less of it there): it takes the depth of the pixel BORDER inside; then a 3 x 3 median removes single bad steps.
  // (the median of a window round that pixel, not the one value: one noisy pixel would otherwise be spread out as a stripe to the edge of the picture)
  const filled = new Float32Array(invZ);
  const around = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= BORDER && x < w - BORDER && y >= BORDER && y < h - BORDER) continue;
      const ix = Math.min(w - 1 - BORDER, Math.max(BORDER, x));
      const iy = Math.min(h - 1 - BORDER, Math.max(BORDER, y));
      around.length = 0;
      for (let dy = -6; dy <= 6; dy += 2) {
        for (let dx = -6; dx <= 6; dx += 2) {
          const sx = Math.min(w - 1 - BORDER, Math.max(BORDER, ix + dx));
          const sy = Math.min(h - 1 - BORDER, Math.max(BORDER, iy + dy));
          around.push(invZ[sy * w + sx]);
        }
      }
      around.sort((a, b) => a - b);
      filled[y * w + x] = around[around.length >> 1];
      confidence[y * w + x] = 0;
    }
  }
  invZ.set(filled);
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
