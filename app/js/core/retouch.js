// Retouching: spot removal (clone and heal). gpu/renderer.js mirrors applySpots.
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
// Heal differs from clone by matching the color: the patch is shifted by the difference between the mean colors of a ring around the blemish and a ring around the source,
// so a patch from a lighter or darker place blends in.

export const MAX_SPOTS = 32;
export const SPOT_MODES = ['heal', 'clone'];

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
      out.r = Math.min(0.5, Math.max(0.002, out.r));
      out.feather = Math.min(1, Math.max(0, out.feather));
      out.opacity = Math.min(1, Math.max(0, out.opacity));
      return out;
    });
}

// The spots as one picture sees them: moved for the viewpoint (u, v) and the focus, for the scene they were anchored in. Only spots that are on.
export function resolveSpots(spots, { u = 0, v = 0, focus = 0, k = 0 } = {}) {
  // (`focus` here is the ref: the depth that stays still)
  return (spots || []).filter((s) => s.on).map((s) => {
    const move = (depth) => [k * (u * (depth - focus) - s.u0 * (depth - s.focus0)), k * (v * (depth - focus) - s.v0 * (depth - s.focus0))];
    const [dx, dy] = move(s.depth);
    const [sdx, sdy] = move(s.sdepth);
    return { ...s, x: s.x + dx, y: s.y + dy, sx: s.sx + sdx, sy: s.sy + sdy };
  });
}

// For the GPU: two vec4 per spot.
export function packSpots(resolved) {
  const list = resolved.slice(0, MAX_SPOTS);
  const a = new Float32Array(4 * MAX_SPOTS);
  const b = new Float32Array(4 * MAX_SPOTS);
  list.forEach((s, i) => {
    a.set([s.x, s.y, s.r, s.feather], 4 * i);
    b.set([s.sx, s.sy, s.opacity, s.mode === 'heal' ? 1 : 0], 4 * i);
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
      for (let t = 0; t < RING_TAPS; t++) {
        const a = (2 * Math.PI * t) / RING_TAPS;
        const ox = Math.cos(a) * R * RING_RADIUS;
        const oy = Math.sin(a) * R * RING_RADIUS;
        for (let c = 0; c < 3; c++) shift[c] += (at(cx + ox, cy + oy, c) - at(cx + ox + dx, cy + oy + dy, c)) / RING_TAPS;
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
