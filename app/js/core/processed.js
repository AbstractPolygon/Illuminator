// Processed .lfp files: pictures exported by Lytro Desktop or shared online
// carry pre-rendered images instead of raw sensor data (see findImageStacks
// in lfp.js). This turns them into a picture the camera view can drive:
//   focus        refocus stack: the images on each side of the focus are
//                blended
//   perspective  images from several viewpoints: the nearest are blended
//   warp/single  all-in-focus image(s) with a depth map: pixels shift by
//                depth to change the viewpoint, and blur is drawn from the
//                depth map (aperture, depth of field, spread, tilt)
//
// Depth is in lambda, Lytro's focus units. The camera controls use focus
// values from -1.6 to 1.6 (as for raw photos); those map linearly onto the
// picture's lambda range.

import { applyDepthOfField, shapeOptions } from './dof.js';
import { fxOptions, applyBokehFx } from './bokehfx.js';
import { smoothDepth } from './depth.js';
import { nthSmallest } from './typed.js';
import { withExtension, uncoveredMask, depthRange } from './viewextend.js';

const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export const FOCUS_RANGE = 1.6;
// Aperture radius in Lytro's aperture coordinates.
export const APERTURE_RADIUS = 0.5;

// Depth map bytes -> { width, height, lambda: Float32Array }.
// `image` is the decoded RGBA ({ width, height, data }) for PNG/BMP maps.
export function decodeDepth(desc, image) {
  const { width: w, height: h } = desc;
  const min = desc.minLambda ?? -10;
  const max = desc.maxLambda ?? 10;
  const bytes = desc.bytes;
  const lambda = new Float32Array(w * h);
  if (desc.representation === 'packedFloat') {
    if (bytes.length < w * h * 4) throw new Error('Depth map is too short');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Little-endian unless that gives values far outside the stated range.
    let little = true;
    let bad = 0;
    for (let i = 0; i < w * h; i += 97) {
      const v = view.getFloat32(i * 4, true);
      if (!Number.isFinite(v) || v < min - 1 || v > max + 1) bad++;
    }
    if (bad > (w * h) / 97 / 4) little = false;
    for (let i = 0; i < w * h; i++) lambda[i] = view.getFloat32(i * 4, little);
  } else {
    let src;
    let stride = 1;
    if (image) {
      src = image.data;
      stride = 4;
    } else if (bytes.length >= w * h) {
      src = bytes;
    } else {
      throw new Error(`Unsupported depth map (${desc.representation})`);
    }
    for (let i = 0; i < w * h; i++) lambda[i] = min + (src[i * stride] / 255) * (max - min);
  }
  return { width: w, height: h, lambda };
}

function percentile(values, p) {
  return nthSmallest(values, Math.min(values.length - 1, Math.max(0, Math.floor(p * (values.length - 1)))));
}

// Bilinear sample of a depth map at image position (x, y) of a w x h image.
function depthAt(depth, w, h, x, y) {
  const dx = Math.min(depth.width - 1, Math.max(0, ((x + 0.5) * depth.width) / w - 0.5));
  const dy = Math.min(depth.height - 1, Math.max(0, ((y + 0.5) * depth.height) / h - 0.5));
  const x0 = Math.floor(dx);
  const y0 = Math.floor(dy);
  const x1 = Math.min(depth.width - 1, x0 + 1);
  const y1 = Math.min(depth.height - 1, y0 + 1);
  const fx = dx - x0;
  const fy = dy - y0;
  const L = depth.lambda;
  const W = depth.width;
  const a = L[y0 * W + x0] * (1 - fx) + L[y0 * W + x1] * fx;
  const b = L[y1 * W + x0] * (1 - fx) + L[y1 * W + x1] * fx;
  return a * (1 - fy) + b * fy;
}

function toLinear(rgba, n) {
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    out[3 * i] = SRGB_TO_LINEAR[rgba[4 * i]];
    out[3 * i + 1] = SRGB_TO_LINEAR[rgba[4 * i + 1]];
    out[3 * i + 2] = SRGB_TO_LINEAR[rgba[4 * i + 2]];
  }
  return out;
}

export class ProcessedPicture {
  // images: [{ width, height, data (RGBA bytes), lambda?, u?, v? }], all one
  // size. depth: decodeDepth() result or null. pitchRatio: image pixels per
  // microlens pitch ratio from the file ({ x, y }).
  constructor({ kind, source, images, depth = null, pitchRatio = null }) {
    this.kind = kind;
    this.source = source;
    this.width = images[0].width;
    this.height = images[0].height;
    this.images = images.map((img) => ({ ...img, u: img.u ?? 0, v: img.v ?? 0 }));
    if (kind === 'focus') this.images.sort((a, b) => (a.lambda ?? 0) - (b.lambda ?? 0));
    this.depth = depth;
    // Image pixels shifted per lambda per unit of aperture coordinate.
    this.pxPerLambda = pitchRatio && pitchRatio.x > 0 ? 1 / pitchRatio.x : 1;
    let lo;
    let hi;
    if (kind === 'focus' && this.images.some((i) => i.lambda !== undefined)) {
      lo = this.images[0].lambda ?? 0;
      hi = this.images[this.images.length - 1].lambda ?? 0;
    } else if (depth) {
      lo = percentile(depth.lambda, 0.01);
      hi = percentile(depth.lambda, 0.99);
    } else {
      lo = -1;
      hi = 1;
    }
    if (!(hi > lo)) hi = lo + 1;
    this.lambdaRange = [lo, hi];
    const coords = this.images.map((i) => Math.hypot(i.u, i.v));
    this.radius = kind === 'perspective' ? Math.max(1e-3, ...coords)
      : depth && (kind === 'warp' || kind === 'single') ? APERTURE_RADIUS : 0;
  }

  // Edge-aware smoothing of the file's depth map (Depth > Smoothing), guided
  // by the picture scaled to the depth map's size.
  // The picture at the smallest size that still has `maxWidth` pixels across (a Light L16 photo keeps smaller copies, `levels`, for the quick views: zoomed out, or while the
  // viewpoint is dragged, a smaller picture is as sharp on the screen and much quicker to make). The full size one when none is wide enough or none is asked for.
  levelFor(maxWidth) {
    if (!this.levels || !(maxWidth > 0)) return this;
    let best = this;
    for (const l of this.levels) if (l.width >= maxWidth && l.width < best.width) best = l;
    return best;
  }

  setSmoothing(amount) {
    if (this.levels) for (const l of this.levels) if (l !== this) l.setSmoothing(amount);
    if (!this.depth) return;
    if (!this.depthOriginal) this.depthOriginal = this.depth;
    if (this.smoothing === amount) return;
    this.smoothing = amount;
    this.alpha = null;
    const d = this.depthOriginal;
    if (!(amount > 0)) {
      this.depth = d;
      return;
    }
    const img = this.linear(this.images[0]);
    const { width: w, height: h } = this;
    const guide = new Float32Array(d.width * d.height * 3);
    for (let y = 0; y < d.height; y++) {
      const sy = Math.min(h - 1, Math.floor(((y + 0.5) * h) / d.height));
      for (let x = 0; x < d.width; x++) {
        const sx = Math.min(w - 1, Math.floor(((x + 0.5) * w) / d.width));
        for (let c = 0; c < 3; c++) guide[3 * (y * d.width + x) + c] = img[3 * (sy * w + sx) + c];
      }
    }
    this.depth = { ...d, lambda: smoothDepth(d.lambda, d.width, d.height, guide, { amount }) };
  }

  get canDrag() {
    return this.radius > 0;
  }

  get hasDepth() {
    return !!this.depth;
  }

  // Camera focus value (-1.6..1.6) <-> lambda.
  toLambda(alpha) {
    const [lo, hi] = this.lambdaRange;
    return (lo + hi) / 2 + (alpha / FOCUS_RANGE) * ((hi - lo) / 2);
  }

  toAlpha(lambda) {
    const [lo, hi] = this.lambdaRange;
    return Math.max(-FOCUS_RANGE, Math.min(FOCUS_RANGE, ((lambda - (lo + hi) / 2) / ((hi - lo) / 2)) * FOCUS_RANGE));
  }

  lambdaAt(x, y) {
    return this.depth ? depthAt(this.depth, this.width, this.height, x, y) : null;
  }

  linear(img) {
    if (!img.linear) img.linear = toLinear(img.data, this.width * this.height);
    return img.linear;
  }

  // Base picture (linear RGB) for viewpoint (u, v) and focus lambda.
  base(u, v, lambda) {
    const { images, width: w, height: h } = this;
    if (this.kind === 'focus' && images.length > 1) {
      let k = 0;
      while (k < images.length - 2 && (images[k + 1].lambda ?? 0) < lambda) k++;
      const a = images[k];
      const b = images[k + 1];
      const span = (b.lambda ?? 0) - (a.lambda ?? 0);
      const t = Math.max(0, Math.min(1, span ? (lambda - (a.lambda ?? 0)) / span : 0));
      const A = this.linear(a);
      const B = this.linear(b);
      const out = new Float32Array(A.length);
      for (let i = 0; i < A.length; i++) out[i] = A[i] + (B[i] - A[i]) * t;
      return out;
    }
    if (this.kind === 'perspective' && images.length > 1) {
      // Inverse-distance blend of the three nearest viewpoints.
      const near = images
        .map((img) => ({ img, d: Math.hypot(img.u - u, img.v - v) }))
        .sort((p, q) => p.d - q.d)
        .slice(0, 3);
      if (near[0].d < 1e-6) return Float32Array.from(this.linear(near[0].img));
      const ws = near.map((p) => 1 / (p.d * p.d));
      const total = ws.reduce((s, x) => s + x, 0);
      const out = new Float32Array(w * h * 3);
      near.forEach((p, j) => {
        const L = this.linear(p.img);
        const f = ws[j] / total;
        for (let i = 0; i < L.length; i++) out[i] += L[i] * f;
      });
      return out;
    }
    // Nearest image, shifted by depth for the viewpoint change.
    let best = images[0];
    for (const img of images) if (Math.hypot(img.u - u, img.v - v) < Math.hypot(best.u - u, best.v - v)) best = img;
    const src = this.linear(best);
    const du = u - best.u;
    const dv = v - best.v;
    if (!this.depth || (Math.abs(du) < 1e-6 && Math.abs(dv) < 1e-6)) return Float32Array.from(src);
    // A Light L16 photo: the viewpoint is moved on from the one picture the way a Lytro photo is moved past its lens edge, nearest surface first, with the background stretched over
    // what a near thing uncovers (core/viewextend.js).
    if (this.source === 'l16') return this.extend(src, du, dv);
    return this.warp(src, du, dv);
  }

  // The depth as viewextend.js wants it for this picture: a point at lambda l shows at c - l * du * pxPerLambda, so the value there is -l with no reference, and `detail` turns its
  // shift in depth map pixels into this picture's.
  extension() {
    const d = this.depth;
    if (!this.ext || this.ext.of !== d.lambda) {
      const neg = new Float32Array(d.lambda.length);
      for (let i = 0; i < neg.length; i++) neg[i] = -d.lambda[i];
      this.ext = { of: d.lambda, neg, range: depthRange(neg), detail: (this.pxPerLambda * d.width) / this.width };
    }
    return this.ext;
  }

  extend(src, du, dv) {
    const e = this.extension();
    const d = this.depth;
    return withExtension(src, this.width, this.height, e.neg, d.width, d.height, [0, 0], [du, dv], 0, e.detail, e.range);
  }

  // Which pixels of the picture for viewpoint (u, v) show what no camera view held (for Fill with AI): 1 = not seen. Null for a picture that is not moved this way.
  holes(u, v) {
    if (this.source !== 'l16' || !this.depth || (Math.abs(u) < 1e-6 && Math.abs(v) < 1e-6)) return null;
    const e = this.extension();
    const d = this.depth;
    return uncoveredMask(this.width, this.height, e.neg, d.width, d.height, [0, 0], [u, v], 0, e.detail, e.range);
  }

  // Backward warp: the pixel at p comes from p + lambda(source) * d * k.
  // Lambda is looked up at p, then once more at the found source point.
  warp(src, du, dv) {
    const { width: w, height: h } = this;
    const k = this.pxPerLambda;
    const out = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let l = this.lambdaAt(x, y);
        let sx = x + l * du * k;
        let sy = y + l * dv * k;
        l = this.lambdaAt(Math.min(w - 1, Math.max(0, sx)), Math.min(h - 1, Math.max(0, sy)));
        sx = Math.min(w - 1, Math.max(0, x + l * du * k));
        sy = Math.min(h - 1, Math.max(0, y + l * dv * k));
        const x0 = Math.floor(sx);
        const y0 = Math.floor(sy);
        const x1 = Math.min(w - 1, x0 + 1);
        const y1 = Math.min(h - 1, y0 + 1);
        const fx = sx - x0;
        const fy = sy - y0;
        const o = 3 * (y * w + x);
        for (let c = 0; c < 3; c++) {
          const a = src[3 * (y0 * w + x0) + c] * (1 - fx) + src[3 * (y0 * w + x1) + c] * fx;
          const b = src[3 * (y1 * w + x0) + c] * (1 - fx) + src[3 * (y1 * w + x1) + c] * fx;
          out[o + c] = a * (1 - fy) + b * fy;
        }
      }
    }
    return out;
  }

  // The picture for the camera controls: { u, v, alpha (focus), blur (0 = no
  // blur, 1 = the camera's own f/2 blur), bokeh options with spread and tilt
  // in camera focus units }. Returns linear RGB (width x height).
  render({ u = 0, v = 0, alpha = 0, blur = 0, bokeh = {} }) {
    const lambda = this.toLambda(alpha);
    const rgb = this.base(u, v, lambda);
    // (the lens effects round bright points need no depth)
    const fx = fxOptions(bokeh);
    if (!(blur > 0 || bokeh.blur > 0) || !this.depth || this.kind === 'focus') return applyBokehFx(rgb, this.width, this.height, fx, 1);
    const scale = (this.lambdaRange[1] - this.lambdaRange[0]) / 2 / FOCUS_RANGE;
    const lambdaGrid = this.depthGrid();
    return applyBokehFx(applyDepthOfField(rgb, this.width, this.height, lambdaGrid.lambda, lambdaGrid.width, lambdaGrid.height, lambda,
      blur * (bokeh.size ?? 1), APERTURE_RADIUS * this.pxPerLambda, {
        ...shapeOptions(bokeh),
        highlights: bokeh.highlights,
        clip: 1,
        spread: (bokeh.spread || 0) * scale,
        smooth: (bokeh.smooth || 0) * scale,
        blur: (bokeh.blur || 0) * scale * APERTURE_RADIUS * this.pxPerLambda,
        tilt: (bokeh.tilt || [0, 0]).map((t) => t * scale),
        point: bokeh.point,
        frame: bokeh.frame || null,
      }), this.width, this.height, fx, 1);
  }

  depthGrid() {
    return this.depth;
  }

  // Index of the sharpest focus-stack image around (x, y).
  sharpestAt(x, y, radius = 10) {
    const { width: w, height: h } = this;
    let best = 0;
    let bestScore = -Infinity;
    this.images.forEach((img, k) => {
      const d = img.data;
      let s = 0;
      let m = 0;
      for (let yy = Math.max(1, Math.round(y - radius)); yy < Math.min(h - 1, Math.round(y + radius)); yy++) {
        for (let xx = Math.max(1, Math.round(x - radius)); xx < Math.min(w - 1, Math.round(x + radius)); xx++) {
          const o = 4 * (yy * w + xx);
          const gx = d[o + 5] - d[o - 3];
          const gy = d[o + 4 * w + 1] - d[o - 4 * w + 1];
          s += gx * gx + gy * gy;
          m += d[o + 1];
        }
      }
      const score = s / Math.max(1, m * m);
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    });
    return best;
  }

  // Focus value that makes (x, y) sharp.
  focusAt(x, y) {
    if (this.depth) return this.toAlpha(this.lambdaAt(x, y));
    if (this.kind === 'focus') return this.toAlpha(this.images[this.sharpestAt(x, y)].lambda ?? 0);
    return 0;
  }

  // Depth in camera focus units at image resolution (for the depth view
  // and the spread overlay).
  alphaMap() {
    if (!this.depth) return null;
    const { width: w, height: h } = this;
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = this.toAlpha(this.lambdaAt(x, y));
    return out;
  }
}
