// Content-aware source for a retouch spot: where in the picture to copy from. The patch that fits best is the one whose surroundings look like the surroundings of the area to fix
// (the area itself is unknown): a ring of samples around the area is compared with the same ring around each candidate place, and the closest match wins, with a small
// preference for places near the area. Works on a small copy of the picture (`img`: { w, h, data } with RGBA bytes, as ImageData). Positions and `r` are in its pixels.
const RING_ANGLES = 12;
const MAX_ANCHORS = 16;

// The offset [dx, dy] (pixels) from the area (a path of points, or one point, each with radius `r`) to the best source, or null when nothing fits.
export function bestSource(img, path, r) {
  const { data } = img;
  const w = img.w ?? img.width;
  const h = img.h ?? img.height;
  if (!(r > 0) || !path.length || w < 8 || h < 8) return null;
  const px = (x, y) => {
    const i = 4 * (Math.min(h - 1, Math.max(0, Math.round(y))) * w + Math.min(w - 1, Math.max(0, Math.round(x))));
    return [data[i] / 255, data[i + 1] / 255, data[i + 2] / 255];
  };
  const distToPath = (x, y) => {
    let best = Infinity;
    for (let n = 0; n < path.length; n++) {
      const [ax, ay] = path[n];
      const [bx, by] = path[Math.min(n + 1, path.length - 1)];
      const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
      const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / len2)) : 0;
      best = Math.min(best, Math.hypot(x - (ax + (bx - ax) * t), y - (ay + (by - ay) * t)));
    }
    return best;
  };
  // the ring: samples around the area, outside it
  const anchors = path.length <= MAX_ANCHORS ? path : Array.from({ length: MAX_ANCHORS }, (_, i) => path[Math.round((i * (path.length - 1)) / (MAX_ANCHORS - 1))]);
  const ring = [];
  for (const [ax, ay] of anchors) {
    for (let k = 0; k < RING_ANGLES; k++) {
      const a = (2 * Math.PI * k) / RING_ANGLES;
      const x = ax + 1.35 * r * Math.cos(a);
      const y = ay + 1.35 * r * Math.sin(a);
      if (x < 0 || y < 0 || x > w - 1 || y > h - 1 || distToPath(x, y) < 1.2 * r) continue;
      ring.push([x, y, px(x, y)]);
    }
  }
  if (ring.length < 6) return null;
  const size = Math.max(w, h);
  const score = (dx, dy) => {
    let sum = 0;
    for (const [x, y, c] of ring) {
      const sx = x + dx;
      const sy = y + dy;
      if (sx < 0 || sy < 0 || sx > w - 1 || sy > h - 1) return Infinity;
      // the candidate's ring must not lie on the area itself
      if (distToPath(sx, sy) < 1.2 * r) return Infinity;
      const q = px(sx, sy);
      sum += (c[0] - q[0]) ** 2 + (c[1] - q[1]) ** 2 + (c[2] - q[2]) ** 2;
    }
    return sum / ring.length + (0.004 * Math.hypot(dx, dy)) / size;
  };
  const step = Math.max(2, Math.round(r * 0.7));
  let best = { s: Infinity, dx: 0, dy: 0 };
  for (let dy = -h; dy <= h; dy += step) {
    for (let dx = -w; dx <= w; dx += step) {
      if (Math.hypot(dx, dy) < 2.4 * r) continue;
      const s = score(dx, dy);
      if (s < best.s) best = { s, dx, dy };
    }
  }
  if (!Number.isFinite(best.s)) return null;
  // refine around the best
  const fine = Math.max(1, Math.round(step / 3));
  const c = best;
  for (let dy = c.dy - step; dy <= c.dy + step; dy += fine) {
    for (let dx = c.dx - step; dx <= c.dx + step; dx += fine) {
      if (Math.hypot(dx, dy) < 2.4 * r) continue;
      const s = score(dx, dy);
      if (s < best.s) best = { s, dx, dy };
    }
  }
  return { dx: best.dx, dy: best.dy, score: best.s };
}
