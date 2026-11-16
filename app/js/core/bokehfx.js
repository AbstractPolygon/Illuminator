// Lens effects around bright points, drawn after the blur: anamorphic streaks, starburst spikes, flare ghosts, fog (veiling glare) and a dirty lens. They need no depth: they
// work on the bright parts of the picture (in focus or out), on a half size copy of them, and add light to the picture. The graphics card does the same in
// gpu/renderer.js (BOKEH_FX); the formulas and constants are these.
//
// Settings (bokeh options, each 0 for off):
//   fxStreak, fxStreakLen  a horizontal streak of light through bright points (0..1) and how far it reaches (0..1 of up to a third of the width)
//   fxStar, fxSpikes       thin spikes of light from bright points (0..1) and their number (3..16)
//   fxGhosts               faint, colored copies of the bright parts across the frame's center, as in-lens reflections (0..1)
//   fxFog                  a soft glow round the bright parts, which lifts the shadows near them (0..1)
//   fxDirt                 the glow caught by dirt on the glass: a fixed pattern of smudges (0..1)
import { boxBlur } from './dof.js';

export const FX_KEYS = ['fxStreak', 'fxStreakLen', 'fxStar', 'fxSpikes', 'fxGhosts', 'fxFog', 'fxDirt'];
// (the starburst's gain is for 6 spikes; its light stays the same with more or fewer)
export const FX_GAIN = { streak: 7, star: 3, ghosts: 0.6, fog: 6, dirt: 12 };
// Streaks and spikes come from small lights: they are fed the bright parts less their average over a box of this mip level (a large bright area gives none inside).
export const POINT_LOD = 4;
// Each effect's light is held below this (a soft limit: x / (1 + x / limit)), so a large bright area gives a glow, not a white bar: the gains are for small lights.
export const FX_LIMIT = 0.7;
export const softLimit = (x) => x / (1 + x / FX_LIMIT);
export const STREAK_TAPS = 24;   // on each side
export const STAR_TAPS = 20;     // along each spike
// Ghosts: where each one lies on the line through the light and the frame's center (a multiple of the light's distance from the center; negative: across it, and a
// larger one is a larger ghost) and its color. A ghost's pixel is read from the point 1 / that multiple of the way from the center.
export const GHOST_AT = [[-0.6, [1.0, 0.65, 0.4]], [-0.3, [0.5, 1.0, 0.7]], [0.45, [0.6, 0.7, 1.0]], [1.5, [1.0, 0.5, 1.0]]];
export const GHOSTS = GHOST_AT.map(([k, tint]) => [1 / k, tint]);
export const STREAK_TINT = [0.6, 0.8, 1.2];
export const DIRT_SIZE = 256;

// The settings out of a bokeh options object, or null when no effect is on.
export function fxOptions(b = {}) {
  const o = {
    streak: Math.max(0, Math.min(1, b.fxStreak || 0)),
    streakLen: Math.max(0, Math.min(1, b.fxStreakLen ?? 0.5)),
    star: Math.max(0, Math.min(1, b.fxStar || 0)),
    spikes: Math.max(3, Math.min(16, Math.round(b.fxSpikes || 6))),
    ghosts: Math.max(0, Math.min(1, b.fxGhosts || 0)),
    fog: Math.max(0, Math.min(1, b.fxFog || 0)),
    dirt: Math.max(0, Math.min(1, b.fxDirt || 0)),
  };
  return o.streak > 0 || o.star > 0 || o.ghosts > 0 || o.fog > 0 || o.dirt > 0 ? o : null;
}

// How big things are on the half size picture of width hw: the streak's reach L and the spacing of its taps, the spikes' reach and spacing, and the mip levels (box
// sizes) the ghosts, the fog and the dirt read the bright parts at.
export function fxGeometry(fx, hw) {
  const L = Math.max(2, (0.02 + 0.3 * fx.streakLen) * hw);
  const step = Math.max(1, (3 * L) / STREAK_TAPS);
  const L0 = Math.max(2, 0.06 * hw);
  const starStep = Math.max(1, (3 * L0) / STAR_TAPS);
  return { L, step, L0, starStep, ghostLod: 1.5, fogLod: Math.log2(Math.max(2, 0.06 * hw)), dirtLod: 4 };
}

let dirt = null;
// The dirty lens as a picture (DIRT_SIZE square, 0..1, mean about 0.25): soft smudges and a few small specks; the same every time.
export function dirtMap() {
  if (dirt) return dirt;
  const N = DIRT_SIZE;
  let seed = 987654;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const map = new Float32Array(N * N);
  // smudges: sums of soft random blobs, kept where they pass a threshold
  for (let i = 0; i < 90; i++) {
    const cx = rnd() * N;
    const cy = rnd() * N;
    const rad = (0.03 + 0.12 * rnd() * rnd()) * N;
    const a = 0.3 + 0.7 * rnd();
    for (let y = Math.max(0, Math.floor(cy - 2 * rad)); y < Math.min(N, cy + 2 * rad); y++) {
      for (let x = Math.max(0, Math.floor(cx - 2 * rad)); x < Math.min(N, cx + 2 * rad); x++) {
        map[y * N + x] += a * Math.exp(-(((x - cx) ** 2 + (y - cy) ** 2) / (rad * rad)));
      }
    }
  }
  for (let i = 0; i < 60; i++) {
    const cx = rnd() * N;
    const cy = rnd() * N;
    const rad = 1 + 2.5 * rnd();
    for (let y = Math.max(0, Math.floor(cy - 3 * rad)); y < Math.min(N, cy + 3 * rad); y++) {
      for (let x = Math.max(0, Math.floor(cx - 3 * rad)); x < Math.min(N, cx + 3 * rad); x++) map[y * N + x] += Math.exp(-(((x - cx) ** 2 + (y - cy) ** 2) / (rad * rad)));
    }
  }
  for (let i = 0; i < map.length; i++) map[i] = Math.min(1, map[i] * 0.55);
  dirt = map;
  return map;
}

const LUMA = [0.2126, 0.7152, 0.0722];

// The bright parts: each pixel's color times a weight that goes from 0 at 70% of the clip level to 1 at it (squared), as a half size picture (2 x 2 pixels averaged).
export function brightParts(rgb, w, h, clip) {
  const hw = Math.ceil(w / 2);
  const hh = Math.ceil(h / 2);
  const out = new Float32Array(hw * hh * 3);
  const knee = 0.7 * clip;
  const span = 0.3 * clip;
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < hw; x++) {
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const i = 3 * (Math.min(h - 1, 2 * y + dy) * w + Math.min(w - 1, 2 * x + dx));
          const t = Math.max(0, Math.min(1, (LUMA[0] * rgb[i] + LUMA[1] * rgb[i + 1] + LUMA[2] * rgb[i + 2] - knee) / span));
          const wt = (t * t) / 4;
          const o = 3 * (y * hw + x);
          out[o] += rgb[i] * wt;
          out[o + 1] += rgb[i + 1] * wt;
          out[o + 2] += rgb[i + 2] * wt;
        }
      }
    }
  }
  return out;
}

// The small peaks of the bright parts: each pixel less 90% of the average round it (at POINT_LOD), kept above 0.
export function pointsOf(hl, hw, hh) {
  const avg = atLod(hl, hw, hh, POINT_LOD);
  const out = new Float32Array(hl.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(0, hl[i] - 0.9 * avg[i]);
  return out;
}

// A copy of the bright parts averaged over a box (a mip level `lod` of the graphics card's: 2^lod pixels wide).
function atLod(hl, hw, hh, lod) {
  const r = Math.max(0, Math.round((2 ** lod - 1) / 2));
  return r < 1 ? hl : boxBlur(hl, hw, hh, r);
}

// The effects on linear RGB (w x h); a new array, or `rgb` itself when no effect is on.
export function applyBokehFx(rgb, w, h, fx, clip = 1) {
  if (!fx) return rgb;
  const hw = Math.ceil(w / 2);
  const hh = Math.ceil(h / 2);
  const hl = brightParts(rgb, w, h, clip);
  const G = fxGeometry(fx, hw);
  const out = new Float32Array(hw * hh * 3);
  const pts = fx.streak > 0 || fx.star > 0 ? pointsOf(hl, hw, hh) : null;
  const streakImg = fx.streak > 0 ? atLod(pts, hw, hh, Math.log2(G.step)) : null;
  const starImg = fx.star > 0 ? atLod(pts, hw, hh, Math.log2(G.starStep)) : null;
  const ghostImg = fx.ghosts > 0 ? atLod(hl, hw, hh, G.ghostLod) : null;
  let fogImg = null;
  if (fx.fog > 0) fogImg = boxBlur(atLod(hl, hw, hh, G.fogLod), hw, hh, Math.max(1, Math.round(0.02 * hw)));
  const dirtImg = fx.dirt > 0 ? atLod(hl, hw, hh, G.dirtLod) : null;
  const dm = fx.dirt > 0 ? dirtMap() : null;
  const sample = (img, x, y, c) => (x < 0 || y < 0 || x >= hw || y >= hh ? 0 : img[3 * (y * hw + x) + c]);
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < hw; x++) {
      const o = 3 * (y * hw + x);
      for (let c = 0; c < 3; c++) {
        let v = 0;
        if (streakImg) {
          let s = 0;
          for (let j = -STREAK_TAPS; j <= STREAK_TAPS; j++) {
            const d = j * G.step;
            s += Math.exp(-Math.abs(d) / G.L) * sample(streakImg, Math.round(x + d), y, c);
          }
          v += softLimit(fx.streak * FX_GAIN.streak * ((G.step * G.step) / (2 * G.L)) * s * STREAK_TINT[c]);
        }
        if (starImg) {
          let s = 0;
          for (let m = 0; m < fx.spikes; m++) {
            const a = (2 * Math.PI * m) / fx.spikes;
            const dx = Math.cos(a);
            const dy = Math.sin(a);
            for (let j = 1; j <= STAR_TAPS; j++) {
              const d = j * G.starStep;
              s += Math.exp(-d / G.L0) * sample(starImg, Math.round(x + dx * d), Math.round(y + dy * d), c);
            }
          }
          v += softLimit(fx.star * FX_GAIN.star * (6 / fx.spikes) * ((G.starStep * G.starStep) / G.L0) * s);
        }
        if (ghostImg) {
          let s = 0;
          for (const [scale, tint] of GHOSTS) {
            const gx = Math.round(hw / 2 + (x - hw / 2) * scale);
            const gy = Math.round(hh / 2 + (y - hh / 2) * scale);
            s += tint[c] * sample(ghostImg, gx, gy, c);
          }
          v += softLimit(fx.ghosts * FX_GAIN.ghosts * s);
        }
        if (fogImg) v += softLimit(fx.fog * FX_GAIN.fog * fogImg[o + c]);
        if (dirtImg) {
          const u = Math.min(DIRT_SIZE - 1, Math.floor(((x + 0.5) / hw) * DIRT_SIZE));
          const t = Math.min(DIRT_SIZE - 1, Math.floor(((y + 0.5) / hh) * DIRT_SIZE));
          v += softLimit(fx.dirt * FX_GAIN.dirt * dirtImg[o + c] * dm[t * DIRT_SIZE + u]);
        }
        out[o + c] = v;
      }
    }
  }
  // added to the picture, the half size light spread bilinearly
  const res = new Float32Array(rgb.length);
  for (let y = 0; y < h; y++) {
    const fy = Math.max(0, (y + 0.5) / 2 - 0.5);
    const y0 = Math.min(hh - 1, Math.floor(fy));
    const y1 = Math.min(hh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx0 = Math.max(0, (x + 0.5) / 2 - 0.5);
      const x0 = Math.min(hw - 1, Math.floor(fx0));
      const x1 = Math.min(hw - 1, x0 + 1);
      const tx = fx0 - x0;
      const i = 3 * (y * w + x);
      for (let c = 0; c < 3; c++) {
        const v = (out[3 * (y0 * hw + x0) + c] * (1 - tx) + out[3 * (y0 * hw + x1) + c] * tx) * (1 - ty) + (out[3 * (y1 * hw + x0) + c] * (1 - tx) + out[3 * (y1 * hw + x1) + c] * tx) * ty;
        res[i + c] = rgb[i + c] + v;
      }
    }
  }
  return res;
}
