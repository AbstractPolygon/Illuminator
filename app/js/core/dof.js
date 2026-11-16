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
// the tips', 0.1..0.9, and outer: how far the tips reach, as a share of the ball's radius, 0.3..1) and Heart (width: 0.6..1.4 of its usual width).
const drawn = new Map();
export function drawnShape(shape, { points = 5, inner = 0.45, width = 1, outer = 1 } = {}) {
  const ro = Math.max(0.3, Math.min(1, outer));
  const key = shape === 'star' ? `star:${Math.round(points)}:${inner.toFixed(3)}${ro < 1 ? `:${ro.toFixed(3)}` : ''}` : `heart:${width.toFixed(3)}`;
  if (drawn.has(key)) return drawn.get(key);
  const N = BOKEH_IMAGE_SIZE;
  const mask = new Float32Array(N * N);
  const n = Math.max(3, Math.min(12, Math.round(points)));
  const ri = Math.max(0.1, Math.min(0.9, inner));
  const pts = [];
  for (let i = 0; i < 2 * n; i++) {
    const r = (i % 2 ? ri : 1) * ro;
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

// What the shape settings of the bokeh are (every one that decides how a ball looks), picked out of a bokeh options object: for the places that hand them on.
export const SHAPE_KEYS = ['shape', 'blades', 'oval', 'rotation', 'onion', 'image', 'points', 'inner', 'outer', 'width', 'irregular', 'ringBlur', 'spots', 'grain', 'diffraction',
  'catEye', 'swirl', 'edge', 'edgeFB', 'bubble', 'hole', 'fringe', 'hot'];
export function shapeOptions(bokeh = {}) {
  const out = {};
  for (const k of SHAPE_KEYS) if (bokeh[k] !== undefined) out[k] = bokeh[k];
  return out;
}

// The ball's character: its brightness over the ball (t, 0 center to 1 edge), in the same way on the processor (here), in the preview and on the graphics card
// (DOF_GATHER). Each part keeps the ball's total light: it is divided by its own mean over the disc (the integrals below).
//   edge:   a bright rim (above 0) or a dark one (below 0); the front/back setting (edgeFB) adds to it for what is behind the focus and takes from it in front
//   bubble: a clear center and a bright rim (soap bubble bokeh); its rainbow colors are bubbleTint
//   hot:    a bright glow in the middle
//   hole:   a dark hole in the middle (a mirror lens's donut)
const integral = (f) => {
  let sum = 0;
  const n = 2000;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    sum += 2 * t * f(t) / n;
  }
  return sum;
};
export const PROFILE_CONST = {
  edgeA: integral((t) => Math.exp(-(((1 - t) / 0.12) ** 2))),
  bubbleA: integral((t) => Math.exp(-(((1 - t) / 0.1) ** 2))),
  hotA: integral((t) => Math.exp(-((t / 0.25) ** 2))),
};
const smoothstep = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
// `side`: 1 for light from behind the focus, -1 from in front, 0 where that is not known (the processor's blur).
export function profileGain(k, t, side = 0) {
  t = Math.max(0, Math.min(1, t));
  let g = 1;
  const e = k.edge + k.edgeFB * side;
  if (e !== 0) g *= Math.max(0, 1 + e * (1.2 * Math.exp(-(((1 - t) / 0.12) ** 2)) - 0.25)) / (1 + e * (1.2 * PROFILE_CONST.edgeA - 0.25));
  if (k.bubble > 0) g *= 1 + k.bubble * ((0.1 + 2.2 * Math.exp(-(((1 - t) / 0.1) ** 2))) / (0.1 + 2.2 * PROFILE_CONST.bubbleA) - 1);
  if (k.hot > 0) g *= (1 + 3 * k.hot * Math.exp(-((t / 0.25) ** 2))) / (1 + 3 * k.hot * PROFILE_CONST.hotA);
  if (k.hole > 0) g *= smoothstep(k.hole - 0.03, k.hole + 0.03, t) / (1 - k.hole * k.hole);
  return g;
}

// The soap bubble's rainbow rim: a color for each channel (mean 1) at the point dq of the ball (units of its radius, shrunk onto a round ball), t from its center.
export function bubbleTint(k, dq, t) {
  if (!(k.bubble > 0)) return [1, 1, 1];
  const rim = Math.exp(-(((1 - Math.min(1, t)) / 0.18) ** 2));
  const hue = Math.atan2(dq[1], dq[0]) / (2 * Math.PI) + t * 2;
  const c = [0, 1 / 3, 2 / 3].map((o) => 0.5 + 0.5 * Math.cos(2 * Math.PI * (hue + o)));
  const m = (c[0] + c[1] + c[2]) / 3;
  return c.map((v) => 1 + (v / m - 1) * k.bubble * rim);
}

// Cat's-eye: near the frame's edge the lens's barrel clips each ball into a lens shape (the overlap of two circles) that is narrow toward the center, and Swirl turns
// that narrow direction around the center, for swirly bokeh. For the ball centered at distance d (0 center to 1 corner of the half diagonal) and direction `ang` from the
// frame's center: the direction u of the narrow side, and the half of the distance c between the circles' centers (in radii; 0 at the center of the frame).
export function catEyeAt(k, d, ang) {
  const c = 0.6 * k.catEye * Math.min(1, 1.1 * d);
  const phi = k.swirl * d * 1.4;
  return { c, ux: Math.cos(ang + phi), uy: Math.sin(ang + phi), ratio: c > 0 ? (2 / Math.PI) * (Math.acos(c) - c * Math.sqrt(1 - c * c)) : 1 };
}

export function bokehKernel({ shape = 'smooth', blades = 6, oval = 0, rotation = 0, onion = 0, image = '', points = 5, inner = 0.45, outer = 1, width = 1, irregular = 0.5, ringBlur = 0.3, spots = 0, grain = 0, diffraction = 0,
  catEye = 0, swirl = 0, edge = 0, edgeFB = 0, bubble = 0, hole = 0, fringe = 0, hot = 0 } = {}) {
  const custom = shape === 'custom' ? decodeBokehImage(image) : shape === 'star' || shape === 'heart' ? drawnShape(shape, { points, inner, width, outer }) : null;
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
    // the onion skin as a picture (onionMap), with its irregularity, ring blur and dust spots
    onionMap: kind === 0 || optical ? null : onionMap({ onion: Math.max(0, Math.min(1, onion)), irregular: Math.max(0, Math.min(1, irregular)), blur: Math.max(0, Math.min(1, ringBlur)), spots: Math.max(0, Math.min(1, spots)), grain: Math.max(0, Math.min(1, grain)), diffraction: Math.max(0, Math.min(1, diffraction)) }),
    // the ball's character (profileGain) and the graphics card's ball effects: all off for the smooth shape and Optical
    ...(kind === 0 || optical ? { catEye: 0, swirl: 0, edge: 0, edgeFB: 0, bubble: 0, hole: 0, fringe: 0, hot: 0 } : {
      catEye: Math.max(0, Math.min(1, catEye)), swirl: Math.max(0, Math.min(1, swirl)), edge: Math.max(-1, Math.min(1, edge)), edgeFB: Math.max(-1, Math.min(1, edgeFB)),
      bubble: Math.max(0, Math.min(1, bubble)), hole: Math.max(0, Math.min(0.9, hole)), fringe: Math.max(0, Math.min(1, fringe)), hot: Math.max(0, Math.min(1, hot)),
    }),
    mask: custom ? custom.mask : null,
    // (how far the outline reaches in each direction, for onion rings that follow it)
    outline: custom ? outlineOf(custom) : null,
    area: custom ? custom.area : 1,
    image: imageKey,
  };
}

// How far a drawn or custom shape reaches from its center in each of OUTLINE_STEPS directions (the angle of (x, y) in the shape's own picture, from +x toward +y),
// in units of the radius: the outermost point still at least half lit. Onion rings are the outline scaled down, so they follow the shape.
export const OUTLINE_STEPS = 256;
function outlineOf(shape) {
  if (shape.outline) return shape.outline;
  const k = { mask: shape.mask, cos: 1, sin: 0 };
  const out = new Float32Array(OUTLINE_STEPS);
  for (let i = 0; i < OUTLINE_STEPS; i++) {
    const a = (i / OUTLINE_STEPS) * 2 * Math.PI;
    let last = 0;
    for (let s = 0; s <= 1.42; s += 1 / 128) if (maskValue(k, Math.cos(a) * s, Math.sin(a) * s) >= 0.5) last = s;
    out[i] = Math.max(0.05, last);
  }
  shape.outline = out;
  return out;
}

// A point (x, y) of the ball (units of its radius, already turned with the shape) moved to where it falls on a round ball when the shape is shrunk to fit a
// circle: rings drawn round on the onion skin then follow the shape (an oval's rings are ovals, a star's are stars).
export function toDisc(k, x, y) {
  if (k.kind === 1) return [x / k.aspect, y];
  const d = Math.hypot(x, y);
  if (!(d > 1e-9)) return [0, 0];
  let t;
  if (k.kind === 2) {
    t = kernelDistance({ ...k, cos: 1, sin: 0 }, x, y);
  } else {
    const a = Math.atan2(y, x);
    const f = ((a / (2 * Math.PI)) * OUTLINE_STEPS + OUTLINE_STEPS) % OUTLINE_STEPS;
    const i = Math.floor(f);
    const R = k.outline[i] * (1 - (f - i)) + k.outline[(i + 1) % OUTLINE_STEPS] * (f - i);
    t = d / R;
  }
  return [(x / d) * t, (y / d) * t];
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

// The onion skin as a picture (ONION_SIZE square over the ball, -1..1 each way, its center the ball's): the gain of the light at each point, so the rings can be
// uneven and the ball can carry dust. Settings (each 0..1): onion (how strong the rings are), irregular (rings unevenly spaced, wobbling round the ball and
// changing strength, with fine grain), blur (the rings softened), spots (dust on the glass: small dark specks, and a few faint bubble rings). Made the same way
// every time from its settings (a fixed seed), so the picture does not change between renders. null when there is nothing to draw.
export const ONION_SIZE = 128;
const onionMaps = new Map();
export function onionMap({ onion = 0, irregular = 0.5, blur = 0.3, spots = 0, grain = 0, diffraction = 0 } = {}) {
  if (!(onion > 0) && !(spots > 0) && !(grain > 0) && !(diffraction > 0)) return null;
  const key = [onion, irregular, blur, spots, grain, diffraction].map((v) => v.toFixed(3)).join(':');
  if (onionMaps.has(key)) return onionMaps.get(key);
  const N = ONION_SIZE;
  let seed = 12345;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // Smooth random functions: a few sines with random phases.
  const waves = (count, top) => Array.from({ length: count }, (_, i) => [1 + Math.floor(rnd() * top) + i, rnd() * 2 * Math.PI, 0.5 + rnd()]);
  const angular = waves(5, 6);
  const radial = waves(4, 5);
  const strength = waves(4, 4);
  const sum = (ws, x) => ws.reduce((acc, [f, p, a]) => acc + a * Math.sin(f * x + p), 0) / ws.length;
  const ring = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const X = ((x + 0.5) / N) * 2 - 1;
      const Y = ((y + 0.5) / N) * 2 - 1;
      const t = Math.min(1, Math.hypot(X, Y));
      const th = Math.atan2(Y, X);
      // the rings' radius wobbles round the ball and their spacing drifts; their strength changes from ring to ring and round the ball
      const tw = t + irregular * (0.03 * sum(angular, th) * t + 0.04 * sum(radial, 6 * t));
      const ph = 2 * Math.PI * ONION_RINGS * Math.max(0, tw) ** 1.5;
      const amp = (0.15 + 0.3 * t) * (1 + irregular * 0.8 * sum(strength, 3 * t + th));
      const grain = irregular * 0.06 * (rnd() - 0.5);
      ring[y * N + x] = amp * (0.75 * Math.cos(ph) + 0.25 * Math.cos(2.3 * ph + 1)) + grain;
    }
  }
  // Ring blur: the ring pattern softened (a Gaussian of up to 3% of the ball's width).
  const sm = blur > 0 ? gaussianMap(ring, N, N, Math.max(0.3, blur * 0.03 * N)) : ring;
  const map = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const t = Math.min(1, Math.hypot(((x + 0.5) / N) * 2 - 1, ((y + 0.5) / N) * 2 - 1));
      const rim = 0.7 * Math.exp(-(((1 - t) / 0.07) ** 2));
      // (diffraction: fine rings at the rim, as the light is cut by the opening's edge)
      const ripple = Math.cos(2 * Math.PI * 12 * t) * Math.exp(-(((1 - t) / 0.2) ** 2));
      map[y * N + x] = 1 + onion * (sm[y * N + x] + rim) + 0.5 * diffraction * ripple;
    }
  }
  // Grain: a fixed texture over the ball (coarse patches and fine grain), as from pores in the glass or noise in the light.
  if (grain > 0) {
    const G = 16;
    const coarse = Float32Array.from({ length: (G + 1) * (G + 1) }, () => rnd() * 2 - 1);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const fx = (x / N) * G;
        const fy = (y / N) * G;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const tx = fx - x0;
        const ty = fy - y0;
        const cv = (coarse[y0 * (G + 1) + x0] * (1 - tx) + coarse[y0 * (G + 1) + x0 + 1] * tx) * (1 - ty) + (coarse[(y0 + 1) * (G + 1) + x0] * (1 - tx) + coarse[(y0 + 1) * (G + 1) + x0 + 1] * tx) * ty;
        map[y * N + x] *= 1 + grain * 0.6 * (0.7 * cv + 0.3 * (rnd() * 2 - 1));
      }
    }
  }
  // Spots: dark specks of dust (soft discs, 0.5 to 2.5% of the ball's width) and a few faint bubble rings, inside the ball.
  if (spots > 0) {
    const count = Math.round(4 + 30 * spots);
    for (let i = 0; i < count; i++) {
      const a = rnd() * 2 * Math.PI;
      const d = Math.sqrt(rnd()) * 0.88;
      const cx = (Math.cos(a) * d * 0.5 + 0.5) * N;
      const cy = (Math.sin(a) * d * 0.5 + 0.5) * N;
      const bubble = rnd() < 0.2;
      const rad = (bubble ? 0.02 + rnd() * 0.03 : 0.005 + rnd() * 0.02) * N;
      const depth = (0.25 + 0.5 * rnd()) * Math.min(1, 0.4 + spots);
      const R = Math.ceil(rad + 3);
      for (let y = Math.max(0, Math.floor(cy - R)); y < Math.min(N, cy + R); y++) {
        for (let x = Math.max(0, Math.floor(cx - R)); x < Math.min(N, cx + R); x++) {
          const q = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
          // a speck darkens its disc; a bubble only its outline, a little brighter just inside
          const k = bubble ? Math.exp(-(((q - rad) / 0.9) ** 2)) - 0.4 * Math.exp(-(((q - rad + 1.5) / 0.9) ** 2)) : Math.max(0, Math.min(1, rad + 0.7 - q));
          map[y * N + x] *= 1 - depth * k;
        }
      }
    }
  }
  for (let i = 0; i < map.length; i++) if (map[i] < 0) map[i] = 0;
  const out = { map, key };
  if (onionMaps.size > 8) onionMaps.clear();
  onionMaps.set(key, out);
  return out;
}

// One channel blurred by a Gaussian (separable, edge pixels repeated).
function gaussianMap(src, w, h, sigma) {
  const reach = Math.ceil(2.5 * sigma);
  const k = new Float32Array(2 * reach + 1);
  let sum = 0;
  for (let i = -reach; i <= reach; i++) sum += k[i + reach] = Math.exp(-0.5 * (i * i) / (sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0;
    for (let i = -reach; i <= reach; i++) a += k[i + reach] * src[y * w + Math.min(w - 1, Math.max(0, x + i))];
    tmp[y * w + x] = a;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0;
    for (let i = -reach; i <= reach; i++) a += k[i + reach] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
    out[y * w + x] = a;
  }
  return out;
}

// The onion skin's gain at (x, y) in units of the ball's radius (bilinear between its pixels; 1 outside it).
export function onionAt(m, x, y) {
  const N = ONION_SIZE;
  const fx = (x * 0.5 + 0.5) * N - 0.5;
  const fy = (y * 0.5 + 0.5) * N - 0.5;
  const x0 = Math.max(0, Math.min(N - 2, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(N - 2, Math.floor(fy)));
  const tx = Math.max(0, Math.min(1, fx - x0));
  const ty = Math.max(0, Math.min(1, fy - y0));
  const v = (xx, yy) => m.map[yy * N + xx];
  return (v(x0, y0) * (1 - tx) + v(x0 + 1, y0) * tx) * (1 - ty) + (v(x0, y0 + 1) * (1 - tx) + v(x0 + 1, y0 + 1) * tx) * ty;
}

// Its average round the ball at distance t (for the processor's blur, which can only draw rings).
export function onionRadial(m, t) {
  let s = 0;
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * 2 * Math.PI;
    s += onionAt(m, Math.cos(a) * t, Math.sin(a) * t);
  }
  return s / 32;
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
// `need` (optional, one byte a pixel): only those pixels are made (the rest are left 0), for a level of the stack only some pixels use.
function shapedBlur(src, w, h, r, k, need = null) {
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
  // (the onion skin's rings, averaged round the ball: the processor's blur draws nested shapes, so it cannot show their wobble or the spots)
  const profiled = k.onionMap || k.edge !== 0 || k.bubble > 0 || k.hot > 0 || k.hole > 0;
  const bands = profiled ? Math.max(1, Math.min(4 * ONION_RINGS, Math.floor(r / 1.5))) : 1;
  const shapes = [];
  for (let b = bands; b >= 1; b--) {
    const gain = (t) => (bands > 1 ? (k.onionMap ? onionRadial(k.onionMap, t) : 1) * profileGain(k, t, 0) : 1);
    const inside = gain((b - 0.5) / bands);
    const outside = b === bands ? 0 : gain((b + 0.5) / bands);
    shapes.push([kernelRows(k, (r * b) / bands), inside - outside]);
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (need && !need[y * w + x]) continue;
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
export function boxBlur(src, w, h, r) {
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

function blur(src, w, h, r, k, need = null) {
  if (r < 1) return src;
  if (k.kind) {
    // (a soft edge blurs the result again, which needs every pixel around the ones wanted)
    const out = shapedBlur(src, w, h, r, k, k.soft > 0 ? null : need);
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
  // The stack of blurred copies goes only as far as the largest radius in the picture, and each copy is made only where a pixel uses it (each pixel mixes the two
  // copies around its radius).
  let top = 0;
  for (let i = 0; i < radius.length; i++) if (radius[i] > top) top = radius[i];
  const radii = [0];
  for (let r = 1; ; r *= kernel.kind ? Math.SQRT2 : 2) {
    radii.push(r);
    if (r >= top) break;
  }
  const bracket = new Int16Array(w * h);
  for (let i = 0; i < radius.length; i++) {
    let k = 0;
    while (k < radii.length - 2 && radii[k + 1] < radius[i]) k++;
    bracket[i] = k;
  }
  const levels = radii.map((r, L) => {
    if (L === 0) return src;
    const need = new Uint8Array(w * h);
    let any = false;
    for (let i = 0; i < need.length; i++) if (bracket[i] === L || bracket[i] + 1 === L) any = need[i] = 1;
    return any ? blur(src, w, h, r, kernel, need) : null;
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const r = radius[y * w + x];
      const k = bracket[y * w + x];
      const t = Math.max(0, Math.min(1, (r - radii[k]) / (radii[k + 1] - radii[k] || 1)));
      const p = (y * w + x) * 3;
      // In-focus pixels keep their original (unboosted) values.
      const lo = k === 0 ? rgb : levels[k];
      for (let c = 0; c < 3; c++) out[p + c] = lo[p + c] * (1 - t) + levels[k + 1][p + c] * t;
    }
  }
  return out;
}

// One bokeh ball as the blur draws it (the GPU's weight, DOF_GATHER): a size x size picture of a ball of radius r pixels at its center, as three channels (R, G, B
// of every pixel one after the other), the brightest channel value 1. `at`: where the ball is in the frame ({ d, ang }: distance from the center, 0 to 1, and its
// direction), for the cat's-eye and swirl, which depend on it. `side`: 1 behind the focus, -1 in front (the edge's front/back setting and the color fringe).
export function ballRGB(k, size, r, at = null, side = 1) {
  const out = new Float32Array(size * size * 3);
  const c = (size - 1) / 2;
  const cat = k.catEye > 0 && at ? catEyeAt(k, at.d, at.ang) : null;
  const kk = k.fringe > 0 && r > 4 ? 0.07 * k.fringe * (side > 0 ? -1 : 1) : 0;
  const scales = [1 + kk, 1, 1 + kk];
  // the shape's coverage at an offset from its center
  const cover = (dx, dy) => {
    if (k.kind === 0) return Math.exp(-2 * ((Math.hypot(dx, dy) / r) ** 2));
    if (k.kind === 3) return maskValue(k, dx / r, dy / r);
    return Math.max(0, Math.min(1, (r + (k.soft * r) / 2 + 0.5 - kernelDistance(k, dx, dy)) / (k.soft * r + 1)));
  };
  let top = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c;
      const dy = y - c;
      const v = [0, 0, 0];
      for (let ch = 0; ch < 3; ch++) {
        const sc = scales[ch];
        let cv;
        if (cat) {
          const shx = cat.ux * cat.c * r;
          const shy = cat.uy * cat.c * r;
          cv = (cover(dx / sc - shx, dy / sc - shy) * cover(dx / sc + shx, dy / sc + shy)) / cat.ratio;
        } else {
          cv = cover(dx / sc, dy / sc);
        }
        v[ch] = cv / (sc * sc);
      }
      let g = 1;
      let tint = [1, 1, 1];
      if (k.kind !== 0 && r > 4) {
        // (turned with the shape, and shrunk with it onto a round ball: the rings and the ball's character follow the shape)
        const dq = toDisc(k, (k.cos * dx + k.sin * dy) / r, (-k.sin * dx + k.cos * dy) / r);
        const t = Math.min(1, Math.hypot(dq[0], dq[1]));
        if (k.onionMap) g *= onionAt(k.onionMap, dq[0], dq[1]);
        g *= profileGain(k, t, side);
        tint = bubbleTint(k, dq, t);
      }
      for (let ch = 0; ch < 3; ch++) {
        out[3 * (y * size + x) + ch] = v[ch] * g * tint[ch];
        if (out[3 * (y * size + x) + ch] > top) top = out[3 * (y * size + x) + ch];
      }
    }
  }
  if (top > 0) for (let i = 0; i < out.length; i++) out[i] /= top;
  return out;
}

// The same as one brightness for each pixel (the mean of the three channels, the brightest 1), for the tests and for anything that has no use for the color.
export function bokehBall(k, size, r, at = null, side = 1) {
  const rgb = ballRGB(k, size, r, at, side);
  const out = new Float32Array(size * size);
  let top = 0;
  for (let i = 0; i < out.length; i++) {
    out[i] = (rgb[3 * i] + rgb[3 * i + 1] + rgb[3 * i + 2]) / 3;
    if (out[i] > top) top = out[i];
  }
  if (top > 0) for (let i = 0; i < out.length; i++) out[i] /= top;
  return out;
}
