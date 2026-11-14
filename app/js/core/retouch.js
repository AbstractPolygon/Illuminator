// Retouching: spot removal (clone and heal), the healing brush and red-eye. gpu/renderer.js mirrors applySpots.
//
// A spot copies a patch from another place onto a blemish, over a soft round edge. Each spot is { id, on, mode ('heal' | 'clone'), x, y (the blemish's center, fractions of the
// picture), r (its radius, a fraction of the picture's longer side), feather (0..1, how much of the radius fades out), opacity (0..1), sx, sy (the source patch's center),
// depth, sdepth (the focus value of the scene at the blemish and at the source, from the depth map when the spot was made), u0, v0, focus0 (the viewpoint and the focus the
// spot was made at) }.
//
// Anchored to the scene: the picture is made from a viewpoint (u, v) at a focus, and a point of the scene at `depth` moves between viewpoints and between focuses by
// k * (u * (depth - ref)), where ref is the depth that stays still: the focus when the picture is refocused, 0 for a single (pinhole) view. resolveSpots moves the blemish and the source by how far that is from where the spot was made, each by its own depth, so the spot stays on the same
// blemish as the viewpoint or the focus changes. `k` converts to picture fractions (see anchorScale in worker.js).
//
// A spot with a `path` ([[x, y], ...], fractions of the picture) is a brush stroke: round dabs of radius r along the path, each copying from the same offset (sx - x, sy - y); it
// is expanded into dabs by resolveSpots. Mode 'redeye' has no source: inside the circle, red pixels are made neutral and darker (strength = opacity).
//
// Heal differs from clone by matching the color: the patch is shifted by the (median) difference between a ring around the blemish and a ring around the source,
// so a patch from a lighter or darker place blends in.

export const MAX_SPOTS = 32;
// The most round dabs (a spot is one, a stroke many) one picture uses.
export const MAX_DABS = 96;
export const MAX_PATH = 64;
export const SPOT_MODES = ['heal', 'clone', 'redeye'];

const newId = () => Math.random().toString(36).slice(2, 10);

export function defaultSpot() {
  return { id: newId(), on: true, mode: 'heal', x: 0.5, y: 0.5, r: 0.03, feather: 0.5, opacity: 1, sx: 0.56, sy: 0.5, depth: 0, sdepth: 0, u0: 0, v0: 0, focus0: 0 };
}

export function parseSpots(text) {
  let list;
  try {
    list = JSON.parse(text || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter((s) => s && typeof s === 'object')
    .slice(0, MAX_SPOTS)
    .map((s, i) => {
      const d = defaultSpot();
      const out = { ...d, id: typeof s.id === 'string' && s.id ? s.id : `s${i}` };
      // A saved file can hold anything: a field of the wrong type falls back to the default instead of turning into NaN in the render.
      for (const [k, def] of Object.entries(d)) {
        if (k === 'id') continue;
        if (typeof def === 'number') out[k] = typeof s[k] === 'number' && Number.isFinite(s[k]) ? s[k] : def;
        else if (typeof def === 'boolean') out[k] = typeof s[k] === 'boolean' ? s[k] : def;
      }
      out.mode = SPOT_MODES.includes(s.mode) ? s.mode : 'heal';
      if (Array.isArray(s.path)) {
        const path = s.path.filter((p) => Array.isArray(p) && p.length >= 2 && p.slice(0, 2).every((v) => typeof v === 'number' && Number.isFinite(v))).slice(0, MAX_PATH).map((p) => [p[0], p[1]]);
        if (path.length) out.path = path;
      }
      out.r = Math.min(0.5, Math.max(0.002, out.r));
      out.feather = Math.min(1, Math.max(0, out.feather));
      out.opacity = Math.min(1, Math.max(0, out.opacity));
      return out;
    });
}

// The spots as one picture sees them: moved for the viewpoint (u, v) and the focus, for the scene they were anchored in, and strokes expanded into round dabs. Only spots that
// are on. (`focus` here is the depth that stays still.)
export function resolveSpots(spots, { u = 0, v = 0, focus = 0, k = 0 } = {}) {
  const dabs = [];
  for (const s of spots || []) {
    if (!s.on) continue;
    const move = (depth) => [k * (u * (depth - focus) - s.u0 * (depth - s.focus0)), k * (v * (depth - focus) - s.v0 * (depth - s.focus0))];
    const [dx, dy] = move(s.depth);
    const [sdx, sdy] = move(s.sdepth);
    // the source's offset from the blemish, after both have moved
    const ox = s.sx + sdx - (s.x + dx);
    const oy = s.sy + sdy - (s.y + dy);
    const points = s.path && s.path.length > 1 ? s.path : [[s.x, s.y]];
    // dabs along the path, spaced by a third of the radius (wider when the picture would get too many)
    const along = [];
    let spacing = Math.max(0.35 * s.r, 1e-3);
    const length = points.slice(1).reduce((n, p, i) => n + Math.hypot(p[0] - points[i][0], p[1] - points[i][1]), 0);
    spacing = Math.max(spacing, length / Math.max(1, Math.floor(MAX_DABS / 2)));
    let carry = 0;
    along.push(points[0]);
    for (let i = 1; i < points.length; i++) {
      const [ax, ay] = points[i - 1];
      const [bx, by] = points[i];
      const seg = Math.hypot(bx - ax, by - ay);
      if (!seg) continue;
      let t = spacing - carry;
      while (t <= seg) {
        along.push([ax + ((bx - ax) * t) / seg, ay + ((by - ay) * t) / seg]);
        t += spacing;
      }
      carry = (carry + seg) % spacing;
    }
    if (points.length > 1) along.push(points[points.length - 1]);
    for (const [px, py] of along) {
      if (dabs.length >= MAX_DABS) break;
      const x = px + dx;
      const y = py + dy;
      dabs.push({ ...s, path: undefined, x, y, sx: x + ox, sy: y + oy });
    }
  }
  return dabs;
}

// For the GPU: two vec4 per dab.
export function packSpots(resolved) {
  const list = resolved.slice(0, MAX_DABS);
  const a = new Float32Array(4 * MAX_DABS);
  const b = new Float32Array(4 * MAX_DABS);
  list.forEach((s, i) => {
    a.set([s.x, s.y, s.r, s.feather], 4 * i);
    b.set([s.sx, s.sy, s.opacity, s.mode === 'heal' ? 1 : s.mode === 'redeye' ? 2 : 0], 4 * i);
  });
  return { count: list.length, a, b };
}

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-6)));
  return t * t * (3 - 2 * t);
};

// The ring the heal compares colors on, in units of the spot's radius, and its taps.
export const RING_RADIUS = 1.25;
export const RING_TAPS = 8;

// Linear RGB (w x h) with the spots applied. `resolved` from resolveSpots.
export function applySpots(rgb, w, h, resolved) {
  if (!resolved || !resolved.length) return rgb;
  const out = Float32Array.from(rgb);
  const big = Math.max(w, h);
  const at = (x, y, c) => rgb[3 * (Math.min(h - 1, Math.max(0, Math.floor(y))) * w + Math.min(w - 1, Math.max(0, Math.floor(x)))) + c];
  for (const s of resolved) {
    const R = s.r * big;
    const cx = s.x * w;
    const cy = s.y * h;
    const dx = (s.sx - s.x) * w;
    const dy = (s.sy - s.y) * h;
    const shift = [0, 0, 0];
    if (s.mode === 'heal') {
      // The median of the ring's differences (a blemish that reaches the ring does not pull the color).
      const diffs = [[], [], []];
      for (let t = 0; t < RING_TAPS; t++) {
        const a = (2 * Math.PI * t) / RING_TAPS;
        const ox = Math.cos(a) * R * RING_RADIUS;
        const oy = Math.sin(a) * R * RING_RADIUS;
        for (let c = 0; c < 3; c++) diffs[c].push(at(cx + ox, cy + oy, c) - at(cx + ox + dx, cy + oy + dy, c));
      }
      for (let c = 0; c < 3; c++) {
        diffs[c].sort((p, q) => p - q);
        shift[c] = (diffs[c][RING_TAPS / 2 - 1] + diffs[c][RING_TAPS / 2]) / 2;
      }
    }
    const x0 = Math.max(0, Math.floor(cx - R));
    const x1 = Math.min(w - 1, Math.ceil(cx + R));
    const y0 = Math.max(0, Math.floor(cy - R));
    const y1 = Math.min(h - 1, Math.ceil(cy + R));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / R;
        if (d >= 1) continue;
        const wgt = s.opacity * (1 - smooth(1 - s.feather, 1, d));
        if (wgt <= 0) continue;
        if (s.mode === 'redeye') {
          const i = 3 * (y * w + x);
          const [r, g, b] = [out[i], out[i + 1], out[i + 2]];
          const red = Math.min(1, Math.max(0, ((r - Math.max(g, b)) / (r + 1e-3)) * 2));
          const neutral = (g + b) / 2;
          const k = wgt * red;
          out[i] = r + (neutral * 0.6 - r) * k;
          out[i + 1] = g + (g * 0.6 - g) * k;
          out[i + 2] = b + (b * 0.6 - b) * k;
          continue;
        }
        for (let c = 0; c < 3; c++) {
          const src = Math.max(0, at(x + dx, y + dy, c) + shift[c]);
          const i = 3 * (y * w + x) + c;
          out[i] = out[i] + (src - out[i]) * wgt;
        }
      }
    }
  }
  return out;
}
