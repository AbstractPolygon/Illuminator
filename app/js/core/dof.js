// Synthetic depth of field: blur each pixel in proportion to how far its
// depth is from the focus depth. This can narrow the depth of field beyond
// what the camera's small aperture records. A stack of increasingly blurred
// copies is built once and each pixel interpolates between the two levels
// around its blur radius.
//
// The blur's shape is the bokeh: 'smooth' (Gaussian), 'circle' or 'blades'
// (a polygon, like an aperture of that many blades). The circle can be
// stretched into an oval, both can be turned, and both can carry onion
// rings (concentric rings, as from aspherical lens elements). Shaped kernels
// are summed row by row from running sums, so a radius-r blur costs about
// 2r operations per pixel (times the number of ring bands with onion rings).

// A custom bokeh shape (shape 'custom'): an image the user loaded, BOKEH_IMAGE_SIZE pixels square, white where light passes and black where it does not
// (gray lets some through). Kept as text (base64 of one byte a pixel) so it is saved with the photo.
export const BOKEH_IMAGE_SIZE = 64;

// RGBA pixels of a BOKEH_IMAGE_SIZE square picture -> the shape as text (its brightness, 0 black to 255 white), or '' when it is all black.
export function encodeBokehImage(rgba) {
  const n = BOKEH_IMAGE_SIZE * BOKEH_IMAGE_SIZE;
  const bytes = new Uint8Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    // (a transparent pixel is black: no light)
    const a = rgba[4 * i + 3] / 255;
    const v = Math.round(a * (0.2126 * rgba[4 * i] + 0.7152 * rgba[4 * i + 1] + 0.0722 * rgba[4 * i + 2]));
    bytes[i] = v;
    if (v > 16) any = true;
  }
  if (!any) return '';
  let bin = '';
  for (let i = 0; i < n; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

const decoded = new Map();
// The shape as text -> { mask: Float32Array (0..1, row by row, top first), area } or null. area: the shape's area over the circle's (pi r^2) at the same radius, so a
// custom ball spreads the same light as a round one.
export function decodeBokehImage(text) {
  if (!text || typeof text !== 'string') return null;
  if (decoded.has(text)) return decoded.get(text);
  let out = null;
  try {
    const bin = atob(text);
    const n = BOKEH_IMAGE_SIZE * BOKEH_IMAGE_SIZE;
    if (bin.length === n) {
      const mask = new Float32Array(n);
      let sum = 0;
      for (let i = 0; i < n; i++) sum += mask[i] = bin.charCodeAt(i) / 255;
      // (the square spans 2r by 2r: 4 r^2 times the mean)
      if (sum > 0) out = { mask, area: ((4 * sum) / n) / Math.PI };
    }
  } catch {
    out = null;
  }
  if (decoded.size > 8) decoded.clear();
  decoded.set(text, out);
  return out;
}

// The kernel's shape from the bokeh options. kind: 0 smooth, 1 circle, 2
// blades, 3 custom (an image, see above; a circle when there is none). aspect: the oval's width to height (1 = round). cos, sin: the
// rotation. 'hexagon' is the six-blade shape of older edits.
// 'optical': the lens's own ball, a disc whose edge softens over a quarter of its radius (soft), what the camera's views averaged look like (Natural, 'smooth',
// is a Gaussian glow).
export const OPTICAL_SOFT = 0.25;
// The built-in drawn shapes, made as a custom shape's image is (the star with a tip up, the heart with its point down): Star (points, inner: the notches' radius over
// the tips', 0.1..0.9) and Heart (width: 0.6..1.4 of its usual width).
const drawn = new Map();
export function drawnShape(shape, { points = 5, inner = 0.45, width = 1 } = {}) {
  const key = shape === 'star' ? `star:${Math.round(points)}:${inner.toFixed(3)}` : `heart:${width.toFixed(3)}`;
  if (drawn.has(key)) return drawn.get(key);
  const N = BOKEH_IMAGE_SIZE;
  const mask = new Float32Array(N * N);
  const n = Math.max(3, Math.min(12, Math.round(points)));
  const ri = Math.max(0.1, Math.min(0.9, inner));
  const pts = [];
  for (let i = 0; i < 2 * n; i++) {
    const r = i % 2 ? ri : 1;
    const a = (i * Math.PI) / n;
    pts.push([Math.sin(a) * r, -Math.cos(a) * r]);
  }
  const inStar = (x, y) => {
    let c = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i];
      const [xj, yj] = pts[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  // The heart curve (x^2 + y^2 - 1)^3 <= x^2 y^3, y up, fitted into the square: it spans x +-1.14 and y -1 to 1.24.
  const wf = Math.max(0.6, Math.min(1.4, width));
  // (a heart wider than usual is made smaller as a whole, so it still fits its square)
  const fit = 1.2 * Math.max(1, wf);
  const inHeart = (x, y) => {
    const X = (x * fit) / wf;
    const Y = -y * fit + 0.12;
    const a = X * X + Y * Y - 1;
    return a * a * a - X * X * Y * Y * Y <= 0;
  };
  const inside = shape === 'star' ? inStar : inHeart;
  // (4 x 4 samples a pixel, for smooth edges)
  let sum = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let c = 0;
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) if (inside(((x + (i + 0.5) / 4) / N) * 2 - 1, ((y + (j + 0.5) / 4) / N) * 2 - 1)) c++;
      sum += mask[y * N + x] = c / 16;
    }
  }
  const out = { mask, area: ((4 * sum) / (N * N)) / Math.PI, key };
  if (drawn.size > 16) drawn.clear();
  drawn.set(key, out);
  return out;
}

export function bokehKernel({ shape = 'smooth', blades = 6, oval = 0, rotation = 0, onion = 0, image = '', points = 5, inner = 0.45, width = 1 } = {}) {
  const custom = shape === 'custom' ? decodeBokehImage(image) : shape === 'star' || shape === 'heart' ? drawnShape(shape, { points, inner, width }) : null;
  const optical = shape === 'optical';
  const kind = custom ? 3 : shape === 'blades' || shape === 'hexagon' ? 2 : shape === 'circle' || shape === 'custom' || optical ? 1 : 0;
  // (what names the shape's picture, so the graphics card uploads it again only when it changes)
  const imageKey = custom ? (custom.key || image) : '';
  const a = (rotation * Math.PI) / 180;
  return {
    kind,
    blades: Math.max(3, Math.min(32, Math.round(shape === 'hexagon' ? 6 : blades))),
    aspect: kind === 1 && !optical ? 1 - 0.6 * Math.max(0, Math.min(1, oval)) : 1,
    soft: optical ? OPTICAL_SOFT : 0,
    cos: Math.cos(a),
    sin: Math.sin(a),
    onion: kind === 0 || optical ? 0 : Math.max(0, Math.min(1, onion)),
    mask: custom ? custom.mask : null,
    area: custom ? custom.area : 1,
    image: imageKey,
  };
}

// A custom shape's light at (x, y) in units of its radius (the image spans -1..1, turned with the rotation): 0..1, bilinear between its pixels.
export function maskValue(k, x, y) {
  const qx = k.cos * x + k.sin * y;
  const qy = -k.sin * x + k.cos * y;
  const N = BOKEH_IMAGE_SIZE;
  const fx = (qx * 0.5 + 0.5) * N - 0.5;
  const fy = (qy * 0.5 + 0.5) * N - 0.5;
  if (fx <= -1 || fy <= -1 || fx >= N || fy >= N) return 0;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (xx, yy) => (xx < 0 || yy < 0 || xx >= N || yy >= N ? 0 : k.mask[yy * N + xx]);
  return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
}

// Distance from the kernel's center in units of its radius: 1 on its edge.
// Blades: a regular polygon with one corner up and circumradius 1.
export function kernelDistance(k, x, y) {
  const qx = k.cos * x + k.sin * y;
  const qy = -k.sin * x + k.cos * y;
  if (k.kind === 2) {
    const seg = (2 * Math.PI) / k.blades;
    const a = Math.atan2(qx, qy);
    const m = ((a % seg) + seg) % seg - seg / 2;
    return (Math.hypot(qx, qy) * Math.cos(m)) / Math.cos(seg / 2);
  }
  return Math.hypot(qx / k.aspect, qy);
}

// Onion rings: brightness at distance t (0 center, 1 edge), averaging 1.
// As from a molded aspherical element: many fine rings, closer together and stronger toward the edge (the mold's tool marks), and a bright rim where the
// light piles up at the edge of the opening. At 1 the rings swing about +-45% at the edge and the rim is about 70% brighter.
export const ONION_RINGS = 6;
export function onionGain(onion, t) {
  const tt = Math.max(0, Math.min(1, t));
  const ph = 2 * Math.PI * ONION_RINGS * tt ** 1.5;
  // (a second, finer ripple makes the rings uneven, as tool marks are)
  const rings = (0.15 + 0.3 * tt) * (0.75 * Math.cos(ph) + 0.25 * Math.cos(2.3 * ph + 1));
  const rim = 0.7 * Math.exp(-(((1 - tt) / 0.07) ** 2));
  return Math.max(0, 1 + onion * (rings + rim));
}

// Kernel rows at radius r: [dy, x0, x1] spans (inclusive) inside the shape.
// The built-in shapes are convex, so each row is one span; a custom shape can have several in a row (light where its image is at least half white).
function kernelRows(k, r) {
  const rows = [];
  const R = Math.ceil(r);
  if (k.kind === 3) {
    // (below a radius of 2 pixels the shape cannot show: a small disc)
    if (r < 2) return kernelRows({ ...k, kind: 1, aspect: 1 }, r);
    for (let dy = -R; dy <= R; dy++) {
      let start = null;
      for (let dx = -R; dx <= R + 1; dx++) {
        // (the blur gathers: a pixel takes light from those whose ball reaches it, so the shape is read mirrored through its center)
        const inside = dx <= R && maskValue(k, -dx / r, -dy / r) >= 0.5;
        if (inside && start === null) start = dx;
        if (!inside && start !== null) {
          rows.push([dy, start, dx - 1]);
          start = null;
        }
      }
    }
    if (!rows.length) rows.push([0, 0, 0]);
    return rows;
  }
  for (let dy = -R; dy <= R; dy++) {
    let x0 = Infinity;
    let x1 = -Infinity;
    for (let dx = -R; dx <= R; dx++) {
      if (kernelDistance(k, dx, dy) <= r + 1e-6) {
        x0 = Math.min(x0, dx);
        x1 = Math.max(x1, dx);
      }
    }
    if (x1 >= x0) rows.push([dy, x0, x1]);
  }
  if (!rows.length) rows.push([0, 0, 0]);
  return rows;
}

// Shaped blur: the weighted average over the kernel, built from per-row
// prefix sums. Onion rings split the kernel into nested shapes, each adding
// the change in ring brightness at its edge.
function shapedBlur(src, w, h, r, k) {
  const out = new Float32Array(src.length);
  const prefix = new Float64Array((w + 1) * h * 3);
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      const base = (y * (w + 1)) * 3 + c;
      prefix[base] = 0;
      for (let x = 0; x < w; x++) {
        acc += src[(y * w + x) * 3 + c];
        prefix[base + (x + 1) * 3] = acc;
      }
    }
  }
  // Nested shapes [rows, weight]: weight is the ring brightness inside its
  // edge minus the brightness just outside it.
  const bands = k.onion > 0 ? Math.max(1, Math.min(4 * ONION_RINGS, Math.floor(r / 1.5))) : 1;
  const shapes = [];
  for (let b = bands; b >= 1; b--) {
    const gain = (t) => (bands > 1 ? onionGain(k.onion, t) : 1);
    const inside = gain((b - 0.5) / bands);
    const outside = b === bands ? 0 : gain((b + 0.5) / bands);
    shapes.push([kernelRows(k, (r * b) / bands), inside - outside]);
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let n = 0;
      for (const [rows, wt] of shapes) {
        for (const [dy, a0, a1] of rows) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          const x0 = Math.max(0, x + a0);
          const x1 = Math.min(w, x + a1 + 1);
          if (x1 <= x0) continue;
          const a = (yy * (w + 1) + x0) * 3;
          const b = (yy * (w + 1) + x1) * 3;
          s0 += wt * (prefix[b] - prefix[a]);
          s1 += wt * (prefix[b + 1] - prefix[a + 1]);
          s2 += wt * (prefix[b + 2] - prefix[a + 2]);
          n += wt * (x1 - x0);
        }
      }
      const o = (y * w + x) * 3;
      if (n > 1e-9) {
        out[o] = s0 / n;
        out[o + 1] = s1 / n;
        out[o + 2] = s2 / n;
      } else {
        out[o] = src[o];
        out[o + 1] = src[o + 1];
        out[o + 2] = src[o + 2];
      }
    }
  }
  return out;
}

// Separable box blur of radius r, RGB.
function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += src[(y * w + Math.min(w - 1, Math.max(0, k))) * 3 + c];
      for (let x = 0; x < w; x++) {
        tmp[(y * w + x) * 3 + c] = acc / n;
        const add = Math.min(w - 1, x + r + 1);
        const sub = Math.max(0, x - r);
        acc += src[(y * w + add) * 3 + c] - src[(y * w + sub) * 3 + c];
      }
    }
  }
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += tmp[(Math.min(h - 1, Math.max(0, k)) * w + x) * 3 + c];
      for (let y = 0; y < h; y++) {
        out[(y * w + x) * 3 + c] = acc / n;
        const add = Math.min(h - 1, y + r + 1);
        const sub = Math.max(0, y - r);
        acc += tmp[(add * w + x) * 3 + c] - tmp[(sub * w + x) * 3 + c];
      }
    }
  }
  return out;
}

function blur(src, w, h, r, k) {
  if (r < 1) return src;
  if (k.kind) {
    const out = shapedBlur(src, w, h, r, k);
    // (a soft edge: the disc spread over the edge's width)
    const e = Math.round((k.soft * r) / 2);
    return e >= 1 ? boxBlur(out, w, h, e) : out;
  }
  // Two box passes approximate a Gaussian.
  return boxBlur(boxBlur(src, w, h, Math.round(r)), w, h, Math.round(r));
}

// Clipped highlights hold far more light than the picture can store; give
// them back some of it before blurring so they spread into bright bokeh
// balls instead of dull smudges. `amount` 0..1 (up to 128x).
function boostHighlights(rgb, clip, amount) {
  if (!(amount > 0)) return rgb;
  const out = new Float32Array(rgb.length);
  const knee = 0.8 * clip;
  for (let i = 0; i < rgb.length; i += 3) {
    const y = 0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2];
    const t = Math.max(0, Math.min(1, (y - knee) / (clip - knee)));
    const k = 1 + (2 ** (7 * amount) - 1) * t * t;
    out[i] = rgb[i] * k;
    out[i + 1] = rgb[i + 1] * k;
    out[i + 2] = rgb[i + 2] * k;
  }
  return out;
}

// A one-channel map smoothed by a Gaussian of `sigma` pixels (separable, edge pixels repeated). Used for the blur radius map (focus spread feathering).
export function smoothMap(map, w, h, feather) {
  const sigma = Math.max(0.3, feather / 2);
  const reach = Math.ceil(2.5 * sigma);
  const kernel = new Float32Array(2 * reach + 1);
  let sum = 0;
  for (let i = -reach; i <= reach; i++) sum += kernel[i + reach] = Math.exp(-0.5 * (i * i) / (sigma * sigma));
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  const tmp = new Float32Array(map.length);
  const out = new Float32Array(map.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -reach; i <= reach; i++) acc += kernel[i + reach] * map[y * w + Math.min(w - 1, Math.max(0, x + i))];
      tmp[y * w + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -reach; i <= reach; i++) acc += kernel[i + reach] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
      out[y * w + x] = acc;
    }
  }
  return out;
}

// rgb: linear RGB (w x h). depth: per-pixel focus values (dw x dh, may be a
// lower resolution than rgb). focus: the focus value kept sharp.
// strength: blur radius in pixels of `rgb` is strength * |depth - focus| *
// pxPerUnit. Options: shape ('smooth' | 'circle' | 'blades') with blades,
// oval (0..1), rotation (degrees) and onion (0..1) (see bokehKernel),
// highlights (0..1), clip (the developed level where highlights clip), and
// the focus field: spread (depth kept sharp on each side of the focus),
// smooth (width of the soft edge where blur starts after the spread), feather
// (pixels: the blur radius map is smoothed over this distance, so the sharp
// range turns into blur gradually across the picture; the picture itself is
// not blurred by it),
// tilt ([x, y] focus change across the picture) turning around point
// Focus distance past the sharp range -> amount of blur. With `smooth` the
// blur starts gradually (a quadratic ease over that width) instead of at
// once; the sharp range itself stays sharp.
export function softEdge(excess, smooth) {
  if (!(excess > 0)) return 0;
  if (!(smooth > 0)) return excess;
  return excess < smooth ? (excess * excess) / (2 * smooth) : excess - smooth / 2;
}

// ([x, y], normalized).
export function applyDepthOfField(rgb, w, h, depth, dw, dh, focus, strength, pxPerUnit = 14, options = {}) {
  if (!(strength > 0)) return rgb;
  const { feather = 0, highlights = 0, clip = 1, spread = 0, smooth = 0, tilt = [0, 0], point = [0.5, 0.5] } = options;
  const kernel = bokehKernel(options);
  const src = boostHighlights(rgb, clip, highlights);
  const maxR = Math.max(1, strength * 1.6 * pxPerUnit);
  const radii = [0];
  for (let r = 1; r < maxR * 1.5; r *= kernel.kind ? Math.SQRT2 : 2) radii.push(r);
  if (radii.length < 2) radii.push(1);
  const levels = radii.map((r) => blur(src, w, h, r, kernel));
  const out = new Float32Array(rgb.length);
  const sx = dw / w;
  const sy = dh / h;
  // The blur radius of every pixel, then smoothed over `feather` pixels.
  let radius = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const dy = Math.min(dh - 1, Math.floor((y + 0.5) * sy));
    const rowFocus = focus + tilt[1] * ((y + 0.5) / h - point[1]);
    for (let x = 0; x < w; x++) {
      const d = depth[dy * dw + Math.min(dw - 1, Math.floor((x + 0.5) * sx))];
      const f = rowFocus + tilt[0] * ((x + 0.5) / w - point[0]);
      radius[y * w + x] = strength * softEdge(Math.abs(d - f) - spread, smooth) * pxPerUnit;
    }
  }
  if (feather > 0) radius = smoothMap(radius, w, h, feather);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const r = radius[y * w + x];
      let k = 0;
      while (k < radii.length - 2 && radii[k + 1] < r) k++;
      const t = Math.max(0, Math.min(1, (r - radii[k]) / (radii[k + 1] - radii[k] || 1)));
      const p = (y * w + x) * 3;
      // In-focus pixels keep their original (unboosted) values.
      const lo = k === 0 ? rgb : levels[k];
      for (let c = 0; c < 3; c++) out[p + c] = lo[p + c] * (1 - t) + levels[k + 1][p + c] * t;
    }
  }
  return out;
}

// One bokeh ball as the blur draws it (the GPU's weight, DOF_GATHER weightFor): a size x size picture of a ball of radius r pixels at its center, 0..1 (its
// brightest pixel 1). For the preview above the Shape list.
export function bokehBall(k, size, r) {
  const out = new Float32Array(size * size);
  const c = (size - 1) / 2;
  let top = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c;
      const dy = y - c;
      let v;
      if (k.kind === 0) {
        const t = Math.hypot(dx, dy) / r;
        v = Math.exp(-2 * t * t);
      } else {
        let t;
        if (k.kind === 3) {
          v = maskValue(k, dx / r, dy / r);
          t = Math.hypot(dx, dy) / r;
        } else {
          t = kernelDistance(k, dx, dy) / r;
          v = Math.max(0, Math.min(1, (r + (k.soft * r) / 2 + 0.5 - t * r) / (k.soft * r + 1)));
          // (the rings come from the lens's glass, not the blades: round whatever the blades' shape)
          if (k.kind === 2) t = Math.hypot(dx, dy) / r;
        }
        if (k.onion > 0 && r > 4) v *= onionGain(k.onion, t);
      }
      out[y * size + x] = v;
      if (v > top) top = v;
    }
  }
  if (top > 0) for (let i = 0; i < out.length; i++) out[i] /= top;
  return out;
}
