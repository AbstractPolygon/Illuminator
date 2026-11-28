// Texture, Clarity and Dehaze (Process > Tone): local contrast at three scales, on linear RGB after the Details pass (gpu/renderer.js localTone
// mirrors it). Brightness is worked on as the square root of luminance (S), so shadows and highlights are treated alike, and the color is kept: each
// pixel's RGB is scaled by its new brightness.
//   Texture: the fine detail (S minus a blur of about a pixel and a half) made stronger, or smoothed away below 0.
//   Clarity: the mid-size detail (S minus a blur of about ten pixels) made stronger, or softened below 0, mostly in the midtones; large steps are
//            held back a little, so strong edges do not grow halos.
//   Dehaze:  haze lifts the darkest of the three colors everywhere it lies (the "dark channel"): where even the darkest color of a neighborhood
//            is bright compared with the haze's own color (the airlight, measured once per photo, airlight below), there is haze, and it is taken
//            out there in proportion; below 0, haze of that color is added evenly.
// Sizes are for a picture one pixel per lens wide (the view); localToneForSize scales them for finer pictures.

import { clamp } from './helpers.js';

const LUMA = [0.2126, 0.7152, 0.0722];
export const LOCAL_TONE = { textureSigma: 1.5, claritySigma: 10, hazeRadius: 6, hazeSigma: 6, minTransmission: 0.12 };

// Slider values (settings.tone.texture, .clarity, .dehaze, each -1..1) -> parameters, or null when all are 0.
export function makeLocalTone(settings = {}) {
  const t = settings.tone || {};
  const p = { texture: clamp(t.texture || 0, -1, 1), clarity: clamp(t.clarity || 0, -1, 1), dehaze: clamp(t.dehaze || 0, -1, 1), scale: 1, air: null };
  return p.texture || p.clarity || p.dehaze ? p : null;
}

// For a picture with more pixels per lens than the view: the sizes grow with it (as the sharpening's radius does, core/detail.js detailForSize).
export function localToneForSize(p, width, lensColumns) {
  if (!p || !(lensColumns > 0)) return p;
  const f = Math.max(1, width / lensColumns);
  return f === p.scale ? p : { ...p, scale: f };
}

// The haze's color (linear RGB, the picture's units): the mean color of the pixels whose darkest color is brightest (the top 0.2%), from the
// picture's middle view. null for an empty picture.
export function airlight(rgb, n = rgb.length / 3) {
  if (!n) return null;
  const dark = new Float32Array(n);
  for (let i = 0; i < n; i++) dark[i] = Math.min(rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2]);
  const sorted = Float32Array.from(dark).sort();
  const cut = sorted[Math.max(0, Math.floor(n * 0.998) - 1)];
  const a = [0, 0, 0];
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (dark[i] < cut) continue;
    a[0] += rgb[3 * i];
    a[1] += rgb[3 * i + 1];
    a[2] += rgb[3 * i + 2];
    k++;
  }
  return k ? a.map((v) => Math.max(1e-4, v / k)) : null;
}

// One channel blurred by a Gaussian of `sigma` pixels (separable, edge pixels repeated).
export function gaussian(src, w, h, sigma) {
  const r = Math.min(48, Math.ceil(3 * sigma));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp((-i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += k[i + r] * src[y * w + Math.min(w - 1, Math.max(0, x + i))];
      tmp[y * w + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += k[i + r] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
      out[y * w + x] = s;
    }
  }
  return out;
}

// The smallest value within `r` pixels (a square, separable).
export function minFilter(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = Infinity;
      for (let i = -r; i <= r; i++) m = Math.min(m, src[y * w + Math.min(w - 1, Math.max(0, x + i))]);
      tmp[y * w + x] = m;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = Infinity;
      for (let i = -r; i <= r; i++) m = Math.min(m, tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x]);
      out[y * w + x] = m;
    }
  }
  return out;
}

// The haze's share of each pixel (0..1): the darkest color relative to the airlight's (in linear light: in a square-root space a dark color that is
// not black read as hazy), its smallest value nearby, softened.
export function hazeMap(rgb, w, h, air, scale = 1) {
  const n = w * h;
  const dark = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = Infinity;
    for (let c = 0; c < 3; c++) m = Math.min(m, Math.max(0, rgb[3 * i + c]) / air[c]);
    dark[i] = Math.min(1, m);
  }
  const r = Math.max(1, Math.round(LOCAL_TONE.hazeRadius * scale));
  return gaussian(minFilter(dark, w, h, r), w, h, LOCAL_TONE.hazeSigma * scale);
}

// Texture, clarity and dehaze on linear RGB (3 per pixel). Returns a new array (or `rgb` itself when `p` is null).
export function applyLocalTone(rgb, w, h, p) {
  if (!p) return rgb;
  const n = w * h;
  const out = Float32Array.from(rgb);
  const f = p.scale || 1;
  if (p.texture || p.clarity) {
    const S = new Float32Array(n);
    for (let i = 0; i < n; i++) S[i] = Math.sqrt(Math.max(0, LUMA[0] * rgb[3 * i] + LUMA[1] * rgb[3 * i + 1] + LUMA[2] * rgb[3 * i + 2]));
    const bt = p.texture ? gaussian(S, w, h, LOCAL_TONE.textureSigma * f) : null;
    const bc = p.clarity ? gaussian(S, w, h, LOCAL_TONE.claritySigma * f) : null;
    for (let i = 0; i < n; i++) {
      const s = S[i];
      let s2 = s;
      if (bt) s2 += textureGain(p.texture) * (s - bt[i]);
      if (bc) s2 += clarityTerm(p.clarity, s, bc[i]);
      s2 = Math.max(0, s2);
      const g = s > 1e-6 ? (s2 * s2) / (s * s) : 1;
      out[3 * i] *= g;
      out[3 * i + 1] *= g;
      out[3 * i + 2] *= g;
    }
  }
  if (p.dehaze && p.air) {
    // The haze model: what is seen is the scene times t plus the airlight times (1 - t), t the share of the scene's light that comes through.
    if (p.dehaze > 0) {
      const haze = hazeMap(out, w, h, p.air, f);
      for (let i = 0; i < n; i++) {
        const t = Math.max(LOCAL_TONE.minTransmission, 1 - 0.95 * p.dehaze * haze[i]);
        for (let c = 0; c < 3; c++) out[3 * i + c] = Math.max(0, (out[3 * i + c] - p.air[c] * (1 - t)) / t);
      }
    } else {
      // (in linear light a little goes a long way: at -100 an eighth of the way to the airlight, which on screen is a clear veil)
      const k = -0.12 * p.dehaze;
      for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) out[3 * i + c] += (p.air[c] - out[3 * i + c]) * k;
    }
  }
  return out;
}

// Below 0 the fine detail is smoothed (at -1, 60% of it); above, it is made up to twice as strong.
export function textureGain(v) {
  return v >= 0 ? 1.0 * v : 0.6 * v;
}

// The clarity term at one pixel: its difference from the wide blur (limited, so strong edges do not grow halos), weighted to the midtones.
export function clarityTerm(v, s, blurred) {
  const d = s - blurred;
  const limited = d / (1 + 4 * Math.abs(d));
  const mid = Math.max(0, 1 - (2 * Math.min(1, s) - 1) ** 2);
  return (v >= 0 ? 0.9 : 0.6) * v * limited * (0.35 + 0.65 * mid);
}
