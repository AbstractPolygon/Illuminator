import { BOKEH_IMAGE_SIZE } from '../../app/js/core/dof.js';

// A five pointed star, white on black, as RGBA pixels of the shape's square (one tip up).
export function starRgba(N = BOKEH_IMAGE_SIZE) {
  const rgba = new Uint8ClampedArray(N * N * 4);
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 0.45 : 1;
    pts.push([Math.sin((i * Math.PI) / 5) * r, -Math.cos((i * Math.PI) / 5) * r]);
  }
  const inside = (x, y) => {
    let c = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i];
      const [xj, yj] = pts[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const v = inside(((x + 0.5) / N) * 2 - 1, ((y + 0.5) / N) * 2 - 1) ? 255 : 0;
      rgba.set([v, v, v, 255], 4 * (y * N + x));
    }
  }
  return rgba;
}
