// Color grading with three tone wheels: shadows, midtones and highlights each get a color (a hue and a saturation, set on a wheel) and a brightness shift. The wheels tint what is
// dark, what is in the middle and what is bright; where one zone ends and the next begins is set by Blending (how softly they run into each other) and Balance (which way the
// split leans: toward the highlights above 0, toward the shadows below).
//
// Per pixel, on linear output RGB (applyGrade; gpu/renderer.js mirrors it): the pixel is looked at in a gamma 2.2 space like the tone curve. Its brightness x = luma^(1/2.2) gives the
// three zone weights (they add up to 1), and each channel moves by the weighted sum of the zones' offsets there.
//   offset of a zone = saturation * COLOR_STRENGTH * (the hue's color minus its own brightness, so the tint carries no light) + luminance * LUMA_STRENGTH on every channel

export const ZONES = ['shadows', 'mids', 'highlights'];
export const COLOR_STRENGTH = 0.28;
export const LUMA_STRENGTH = 0.2;

// An RGB triple (0..1) of full saturation and value at `hue` degrees.
function hueColor(hue) {
  const h = (((hue % 360) + 360) % 360) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  const k = Math.floor(h);
  return [[1, x, 0], [x, 1, 0], [0, 1, x], [0, x, 1], [x, 0, 1], [1, 0, x]][k % 6];
}

// The zone offsets and where the zones split, from the settings ({ zones: [{ hue 0..360, sat 0..1, lum -1..1 }, ...], blend 0..1, balance -1..1 }), or null when nothing is graded.
export function gradeParams(grade) {
  if (!grade || !Array.isArray(grade.zones)) return null;
  const offsets = ZONES.map((_, i) => {
    const z = grade.zones[i] || {};
    const sat = Math.min(1, Math.max(0, z.sat || 0));
    const lum = Math.min(1, Math.max(-1, z.lum || 0));
    const c = hueColor(z.hue || 0);
    const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    return c.map((v) => sat * COLOR_STRENGTH * (v - y) + lum * LUMA_STRENGTH);
  });
  if (!offsets.some((o) => o.some((v) => Math.abs(v) > 1e-6))) return null;
  const blend = Math.min(1, Math.max(0, grade.blend ?? 0.5));
  const balance = Math.min(1, Math.max(-1, grade.balance || 0));
  const shift = -0.25 * balance;
  const width = 0.12 + 0.28 * blend;
  return { offsets, low: 0.25 + shift, high: 0.75 + shift, width };
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// The weights of the shadows, midtones and highlights at gamma-space brightness x (they add up to 1).
export function zoneWeights(g, x) {
  const a = smoothstep(g.low - g.width, g.low + g.width, x);
  const b = smoothstep(g.high - g.width, g.high + g.width, x);
  return [1 - a, a - b, b];
}

// Grades one linear RGB pixel in place (`px`, length 3). `g` from gradeParams.
export function applyGrade(px, g) {
  const y = 0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2];
  const x = Math.pow(Math.max(y, 0), 1 / 2.2);
  const w = zoneWeights(g, x);
  for (let c = 0; c < 3; c++) {
    const d = w[0] * g.offsets[0][c] + w[1] * g.offsets[1][c] + w[2] * g.offsets[2][c];
    px[c] = Math.pow(Math.max(Math.pow(Math.max(px[c], 0), 1 / 2.2) + d, 0), 2.2);
  }
}

// The uniforms the GPU takes: nine numbers (three offsets) and where the zones split (low, high, width).
export function gradeUniforms(g) {
  return { offsets: Float32Array.from(g.offsets.flat()), split: [g.low, g.high, g.width] };
}
