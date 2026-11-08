// Focus peaking: which pixels of a picture have a sharp edge.

// The picture is read at about this many pixels at most.
export const PEAKING_MAX_PIXELS = 1000000;
// Pixels (ImageData data, w x h) whose brightness changes by more than
// `threshold` (0..1) across a pixel's neighbors. Returns RGBA bytes.
export function peakingPixels(data, w, h, threshold) {
  const lum = new Float32Array(w * h);
  for (let i = 0, j = 0; i < lum.length; i++, j += 4) lum[i] = (0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2]) / 255;
  const hit = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const g = Math.abs(lum[i + 1] - lum[i - 1]) + Math.abs(lum[i + w] - lum[i - w]);
      if (g > threshold) hit[i] = 1;
    }
  }
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < hit.length; i++) {
    if (!hit[i]) continue;
    out[4 * i] = 40;
    out[4 * i + 1] = 255;
    out[4 * i + 2] = 90;
    out[4 * i + 3] = 235;
  }
  return out;
}
