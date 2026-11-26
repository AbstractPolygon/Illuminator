// core/raw.js fixHotPixels on the graphics card (Process > Remove hot pixels, a photo without the camera's list of defective pixels): each pixel far from the median of
// its eight nearest same-color neighbors (two pixels away, diagonals included) takes that median, with the processor's quick test against the four nearest first. The
// rules are written in whole numbers, so every pixel comes out as the processor's. The result is read back two pixels a texel (low byte, high byte; the top bit marks a
// replaced pixel, for the count).
import { program } from './renderer.js';

const HOT = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uRaw;
out vec4 outColor;
int at(ivec2 q) { return int(texelFetch(uRaw, q, 0).r); }
int fixed1(ivec2 p, ivec2 size) {
  int v = at(p);
  if (p.x < 2 || p.y < 2 || p.x >= size.x - 2 || p.y >= size.y - 2) return v;
  int s4 = at(p + ivec2(-2, 0)) + at(p + ivec2(2, 0)) + at(p + ivec2(0, -2)) + at(p + ivec2(0, 2));
  // (v <= m4 * 1.6 + 20, or v < m4 * 0.4 with m4 > 100, m4 = s4 / 4)
  if (5 * v <= 2 * s4 + 100 && !(10 * v < s4 && s4 > 400)) return v;
  int nb[8] = int[8](at(p + ivec2(-2, -2)), at(p + ivec2(0, -2)), at(p + ivec2(2, -2)), at(p + ivec2(-2, 0)), at(p + ivec2(2, 0)), at(p + ivec2(-2, 2)), at(p + ivec2(0, 2)),
    at(p + ivec2(2, 2)));
  for (int i = 1; i < 8; i++) {
    int x = nb[i];
    int j = i - 1;
    while (j >= 0 && nb[j] > x) {
      nb[j + 1] = nb[j];
      j--;
    }
    nb[j + 1] = x;
  }
  int a = nb[3] + nb[4];
  // (v > m * 2 + 30, or v < m * 0.3 with m > 100, m = a / 2: replaced by m, rounded half up)
  if (v > a + 30 || (20 * v < 3 * a && a > 200)) return ((a + 1) >> 1) | 32768;
  return v;
}
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uRaw, 0);
  int a = fixed1(ivec2(2 * f.x, f.y), size);
  int b = fixed1(ivec2(2 * f.x + 1, f.y), size);
  outColor = vec4(float(a & 255), float(a >> 8), float(b & 255), float(b >> 8)) / 255.0;
}`;

// True when the card can take a sensor of this size.
export function hotPixelsGpuAvailable(gpu, width, height) {
  if (!gpu) return false;
  const max = gpu.gl.getParameter(gpu.gl.MAX_TEXTURE_SIZE);
  return width % 2 === 0 && Math.max(width, height) <= max;
}

// On `gpu` (a GpuRenderer): fixHotPixels(raw, width, height) without a list -> { raw, count }, the same values.
export function fixHotPixelsGpu(gpu, raw, width, height) {
  const gl = gpu.gl;
  const P = (gpu.hotProgram ||= program(gl, HOT));
  const made = [];
  try {
    const src = gpu.texture(width, height, gl.R16UI, gl.NEAREST);
    made.push(src);
    gl.bindTexture(gl.TEXTURE_2D, src);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED_INTEGER, gl.UNSIGNED_SHORT, raw instanceof Uint16Array ? raw : Uint16Array.from(raw));
    const W2 = width / 2;
    const out = gpu.texture(W2, height, gl.RGBA8, gl.NEAREST);
    made.push(out);
    gpu.target(out, W2, height);
    gl.useProgram(P.p);
    gl.uniform1i(P.u.uRaw, 1);
    gpu.bindTex(1, src);
    gpu.draw();
    const bytes = new Uint8Array(4 * W2 * height);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.readPixels(0, 0, W2, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    const v = new Uint16Array(width * height);
    let count = 0;
    for (let i = 0; i < v.length; i++) {
      const x = bytes[2 * i] | (bytes[2 * i + 1] << 8);
      if (x & 32768) count++;
      v[i] = x & 32767;
    }
    const fixedRaw = raw instanceof Uint16Array ? v : raw.constructor.from(v);
    return { raw: fixedRaw, count };
  } finally {
    for (const t of made) gl.deleteTexture(t);
  }
}
