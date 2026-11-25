// The f-stops of Camera > Depth > Aperture, and the slider's position among them: a whole position is a stop, a position between two is the f-number between them on
// a log scale (an animation's in-between f-number, so the slider glides from stop to stop instead of jumping).
export const F_STOPS = [22, 16, 11, 8, 5.6, 4, 2.8, 2, 1.4, 1, 0.7, 0.5];

// The f-number at slider position `pos` (0 .. F_STOPS.length - 1).
export function fNumberAt(pos) {
  const p = Math.max(0, Math.min(F_STOPS.length - 1, +pos || 0));
  const i = Math.floor(p);
  const t = p - i;
  if (t < 1e-9 || i >= F_STOPS.length - 1) return F_STOPS[i];
  return F_STOPS[i] * (F_STOPS[i + 1] / F_STOPS[i]) ** t;
}

// The slider position of f-number n (between the stops round it; clamped to the ends).
export function stopPosition(n) {
  if (!(n > 0)) return 0;
  if (n >= F_STOPS[0]) return 0;
  const last = F_STOPS.length - 1;
  if (n <= F_STOPS[last]) return last;
  for (let i = 0; i < last; i++) {
    const a = F_STOPS[i];
    const b = F_STOPS[i + 1];
    if (n <= a && n >= b) {
      const t = Math.log(n / a) / Math.log(b / a);
      // (a stop exactly, where it is one)
      return Math.abs(t) < 1e-9 ? i : Math.abs(1 - t) < 1e-9 ? i + 1 : i + t;
    }
  }
  return 0;
}
