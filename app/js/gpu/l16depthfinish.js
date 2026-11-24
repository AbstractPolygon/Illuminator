// The last steps of the Light L16 depth (core/l16depth.js depthFinish, after each pixel's depth is picked) on the graphics card, with the processor's rules: the unsure
// pixels take the confidence-weighted mean depth of the sure ones within `radius` (fillUnsure: the window cut at the picture's edges), the border band takes the median
// of a 7 x 7 sample round the pixel BORDER inside (its confidence set to 0), then a 3 x 3 median (edges clamped).
import { program } from './renderer.js';

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

// One pass of the window sums of (confidence v, confidence) over the sure pixels (r: depth, g: confidence on the first pass; r, g: the sums after).
const SUMS = `${HEAD}
uniform sampler2D uSrc;
uniform ivec2 uDir;
uniform int uR;
uniform int uFirst;
uniform float uThreshold;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uSrc, 0);
  vec2 acc = vec2(0.0);
  for (int d = -uR; d <= uR; d++) {
    ivec2 q = p + d * uDir;
    if (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y) continue;
    vec4 t = texelFetch(uSrc, q, 0);
    if (uFirst == 1) {
      float c = t.g >= uThreshold ? t.g : 0.0;
      acc += vec2(c * t.r, c);
    } else acc += t.rg;
  }
  outColor = vec4(acc, 0.0, 1.0);
}`;

const FILL = `${HEAD}
uniform sampler2D uDepth;   // (depth, confidence)
uniform sampler2D uSums;
uniform float uThreshold;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 d = texelFetch(uDepth, p, 0);
  vec2 s = texelFetch(uSums, p, 0).rg;
  float v = d.r;
  if (d.g < uThreshold && s.y >= 1e-6) v = s.x / s.y;
  outColor = vec4(v, d.g, 0.0, 1.0);
}`;

const BORDER = `${HEAD}
uniform sampler2D uDepth;
uniform int uB;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uDepth, 0);
  vec4 d = texelFetch(uDepth, p, 0);
  if (p.x >= uB && p.x < size.x - uB && p.y >= uB && p.y < size.y - uB) {
    outColor = d;
    return;
  }
  ivec2 lo = ivec2(uB);
  ivec2 hi = size - 1 - uB;
  ivec2 c = clamp(p, lo, hi);
  float a[49];
  int n = 0;
  for (int dy = -6; dy <= 6; dy += 2) for (int dx = -6; dx <= 6; dx += 2) a[n++] = texelFetch(uDepth, clamp(c + ivec2(dx, dy), lo, hi), 0).r;
  // (the middle of the sorted values: sorted up to it)
  for (int i = 0; i <= 24; i++) {
    int m = i;
    for (int j = i + 1; j < 49; j++) if (a[j] < a[m]) m = j;
    float t = a[i];
    a[i] = a[m];
    a[m] = t;
  }
  outColor = vec4(a[24], 0.0, 0.0, 1.0);
}`;

const MEDIAN = `${HEAD}
uniform sampler2D uDepth;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uDepth, 0);
  float a[9];
  int n = 0;
  for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) a[n++] = texelFetch(uDepth, clamp(p + ivec2(dx, dy), ivec2(0), size - 1), 0).r;
  for (int i = 0; i <= 4; i++) {
    int m = i;
    for (int j = i + 1; j < 9; j++) if (a[j] < a[m]) m = j;
    float t = a[i];
    a[i] = a[m];
    a[m] = t;
  }
  outColor = vec4(a[4], texelFetch(uDepth, p, 0).g, 0.0, 1.0);
}`;

// On `gpu` (a GpuRenderer): finish(invZ, confidence, w, h, radius, threshold, border): both arrays changed in place.
export function l16DepthFinishGpu(gpu) {
  const gl = gpu.gl;
  let progs = null;
  const P = () => (progs = progs || { sums: program(gl, SUMS), fill: program(gl, FILL), border: program(gl, BORDER), median: program(gl, MEDIAN) });
  return function finish(invZ, confidence, w, h, radius, threshold, border) {
    const p = P();
    const made = [];
    const tex = () => {
      const t = gpu.texture(w, h, gl.RGBA32F);
      made.push(t);
      return t;
    };
    const pass = (prog, out, inputs, set) => {
      gpu.target(out, w, h);
      gl.useProgram(prog.p);
      inputs.forEach(([name, t], i) => {
        gl.uniform1i(prog.u[name], i + 1);
        gpu.bindTex(i + 1, t);
      });
      set(prog.u);
      gpu.draw();
    };
    try {
      const buf = new Float32Array(4 * w * h);
      for (let i = 0; i < w * h; i++) {
        buf[4 * i] = invZ[i];
        buf[4 * i + 1] = confidence[i];
      }
      const src = tex();
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, buf);
      const a = tex();
      const b = tex();
      pass(p.sums, a, [['uSrc', src]], (u) => {
        gl.uniform2i(u.uDir, 1, 0);
        gl.uniform1i(u.uR, radius);
        gl.uniform1i(u.uFirst, 1);
        gl.uniform1f(u.uThreshold, threshold);
      });
      pass(p.sums, b, [['uSrc', a]], (u) => {
        gl.uniform2i(u.uDir, 0, 1);
        gl.uniform1i(u.uR, radius);
        gl.uniform1i(u.uFirst, 0);
        gl.uniform1f(u.uThreshold, threshold);
      });
      pass(p.fill, a, [['uDepth', src], ['uSums', b]], (u) => gl.uniform1f(u.uThreshold, threshold));
      pass(p.border, b, [['uDepth', a]], (u) => gl.uniform1i(u.uB, border));
      pass(p.median, a, [['uDepth', b]], () => {});
      gpu.target(a, w, h);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, buf);
      for (let i = 0; i < w * h; i++) invZ[i] = buf[4 * i];
      // (the border band's confidence is 0)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) if (x < border || x >= w - border || y < border || y >= h - border) confidence[y * w + x] = 0;
      }
    } finally {
      for (const t of made) gl.deleteTexture(t);
    }
  };
}
