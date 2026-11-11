// A viewpoint past the lens edge, on the CPU (the GPU's is EXTEND in gpu/renderer.js; the two match): a picture rendered from the edge viewpoint `edge` ([u, v]) moved on
// to `total` by the depth. A point at depth d at c in the center view's coordinates shows at c + (d - ref) * k * u for viewpoint u (k = `detail`, in depth-map pixels; the
// picture may be larger than the depth map). For each output pixel p, the points that can land there lie on the line c = p - t * k * total, t = d - ref. The search walks t
// from the nearest depth in the picture (`range[0]`, near is the smaller depth) to the farthest and takes the first place where the depth there matches t: the nearest
// surface, which hides what is behind it. The color is then taken from the edge picture at c + (d(c) - ref) * k * edge. Where a near object uncovers what no view saw, the
// only crossing is at the object's border, a jump in depth that does not match t: there the background just beside the border is taken (its last sample before the jump),
// so the background is stretched over the gap and the object keeps its shape. `rgb`: three floats per pixel, w x h; `depth`: dw x dh.

// The steps of the search: at least one per pixel of movement across the depth range, within these limits.
export const MIN_STEPS = 24;
export const MAX_STEPS = 128;

export function searchSteps(range, ref, total, detail) {
  const span = Math.abs(range[1] - range[0]) * detail * Math.hypot(total[0], total[1]);
  return Math.max(MIN_STEPS, Math.min(MAX_STEPS, Math.ceil(span)));
}

// The smallest and largest value of a depth map.
export function depthRange(depth) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const d of depth) {
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return lo <= hi ? [lo, hi] : [0, 0];
}

export function withExtension(rgb, w, h, depth, dw, dh, edge, total, ref, detail, range = depthRange(depth)) {
  const sx = dw / w;
  const sy = dh / h;
  const tx = detail * total[0] * (w / dw);
  const ty = detail * total[1] * (h / dh);
  const ex = detail * edge[0] * (w / dw);
  const ey = detail * edge[1] * (h / dh);
  const depthAt = (x, y) => {
    const dx = Math.min(dw - 1, Math.max(0, Math.floor((x + 0.5) * sx)));
    const dy = Math.min(dh - 1, Math.max(0, Math.floor((y + 0.5) * sy)));
    return depth[dy * dw + dx] - ref;
  };
  const t0 = range[0] - ref;
  const t1 = range[1] - ref;
  const n = searchSteps(range, ref, total, detail);
  const out = new Float32Array(rgb.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // g(t) = d(p - t T) - ref - t: at least 0 at the nearest depth, at most 0 at the farthest; the first crossing is the nearest surface.
      const step = (t1 - t0) / n;
      let tPrev = t0;
      let gPrev = depthAt(x - t0 * tx, y - t0 * ty) - t0;
      let cx = x - t1 * tx;
      let cy = y - t1 * ty;
      let d = depthAt(cx, cy);
      if (gPrev <= 0) {
        cx = x - t0 * tx;
        cy = y - t0 * ty;
        d = depthAt(cx, cy);
      } else {
        for (let i = 1; i <= n; i++) {
          const ti = t0 + step * i;
          const gi = depthAt(x - ti * tx, y - ti * ty) - ti;
          if (gi <= 0) {
            const t = tPrev + (gPrev / (gPrev - gi)) * (ti - tPrev);
            cx = x - t * tx;
            cy = y - t * ty;
            d = depthAt(cx, cy);
            if (Math.abs(d - t) > 1.5 * Math.abs(step)) {
              // (a jump: uncovered background; the sample before it, on the far side)
              cx = x - tPrev * tx;
              cy = y - tPrev * ty;
              d = gPrev + tPrev;
            }
            break;
          }
          tPrev = ti;
          gPrev = gi;
        }
      }
      const fx = cx + d * ex;
      const fy = cy + d * ey;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const ax = fx - x0;
      const ay = fy - y0;
      const xa = Math.max(0, Math.min(w - 1, x0));
      const xb = Math.max(0, Math.min(w - 1, x0 + 1));
      const ya = Math.max(0, Math.min(h - 1, y0));
      const yb = Math.max(0, Math.min(h - 1, y0 + 1));
      for (let c = 0; c < 3; c++) {
        const top = rgb[(ya * w + xa) * 3 + c] * (1 - ax) + rgb[(ya * w + xb) * 3 + c] * ax;
        const bottom = rgb[(yb * w + xa) * 3 + c] * (1 - ax) + rgb[(yb * w + xb) * 3 + c] * ax;
        out[(y * w + x) * 3 + c] = top * (1 - ay) + bottom * ay;
      }
    }
  }
  return out;
}

// How far a single view can go in each direction before the lens images give out (Perspective > Reach): from the vignetting map (core/superres.js estimateVignetting:
// each channel's gain over offsets within the lens, 0 where too dark), the farthest offset along each of `dirs` directions where every channel is still at least `level` of
// the lens center's brightness, less `margin` sensor pixels for the sampling's footprint, and never less than `base` (the aperture radius the app has always used). The
// views are in the lens grid's frame, the map in the sensor's: `rotation` is the grid's. Returns { dirs, radius: Float32Array } in sensor pixels.
export const REACH_LEVEL = 0.4;
export function reachProfile(vg, base, rotation = 0, { level = REACH_LEVEL, margin = 0.5, dirs = 72 } = {}) {
  const { bins, rMax, gain } = vg;
  const tiles = (vg.tilesX || 1) * (vg.tilesY || 1);
  const mid = Math.floor((vg.tilesY || 1) / 2) * (vg.tilesX || 1) + Math.floor((vg.tilesX || 1) / 2);
  const offset = (tiles > 1 ? mid : 0) * bins * bins * 3;
  const bright = (x, y) => {
    const bu = Math.floor(((x / rMax + 1) / 2) * bins);
    const bv = Math.floor(((y / rMax + 1) / 2) * bins);
    if (bu < 0 || bv < 0 || bu >= bins || bv >= bins) return 0;
    let m = Infinity;
    for (let c = 0; c < 3; c++) {
      const g = gain[offset + (bv * bins + bu) * 3 + c];
      m = Math.min(m, g > 0 ? 1 / g : 0);
    }
    return m;
  };
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const radius = new Float32Array(dirs);
  for (let k = 0; k < dirs; k++) {
    const a = (2 * Math.PI * k) / dirs;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    let good = 0;
    for (let r = 0; r <= rMax; r += 0.1) {
      const u = ux * r;
      const v = uy * r;
      if (bright(cos * u - sin * v, sin * u + cos * v) < level) break;
      good = r;
    }
    radius[k] = Math.max(base, good - margin);
  }
  return { dirs, radius };
}

// The reach toward (u, v) (interpolated between the profile's directions).
export function reachToward(profile, u, v) {
  const { dirs, radius } = profile;
  let a = Math.atan2(v, u);
  if (a < 0) a += 2 * Math.PI;
  const f = (a / (2 * Math.PI)) * dirs;
  const i = Math.floor(f) % dirs;
  const t = f - Math.floor(f);
  return radius[i] * (1 - t) + radius[(i + 1) % dirs] * t;
}
