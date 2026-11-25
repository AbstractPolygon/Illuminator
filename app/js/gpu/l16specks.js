// The cleanup of core/l16fusion.js removeMergedSpecks on the graphics card: what is left after the merge of a long exposure's warm pixels (a dot of one or two colors,
// one or two pixels wide) and the mirrors' colored spots (up to about 5 pixels across at the half size picture's scale). Three passes, the same rules as the processor's:
//   1. a pixel's color more than twice its second brightest neighbor's (and HOT_OFFSET more) and twice the weakest color there takes the mean of its side neighbors but the
//      brightest;
//   2. the spots' centers on that: a local peak of a color, 2.5 times the brightest of the ring of pixels R away (and HOT_OFFSET more), rising far more than the weakest
//      other color, and twice the weakest color at the peak; each center keeps its ring's brightest and median, per color;
//   3. inside each spot (closer than R to its center) a color above its ring's brightest takes the ring's median (centers in the order the processor takes them: by row,
//      then column; the rings are read before any spot is filled, where the processor fills them one after the other).
import { program } from './renderer.js';

const MAX_RING = 256;

const SPECK = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uSrc;
uniform float uOffset;
out vec4 outColor;
vec3 at(ivec2 q) { return texelFetch(uSrc, q, 0).rgb; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uSrc, 0);
  vec3 c = at(p);
  if (p.x < 1 || p.y < 1 || p.x >= size.x - 1 || p.y >= size.y - 1) {
    outColor = vec4(c, 1.0);
    return;
  }
  vec3 a = at(p + ivec2(-1, 0));
  vec3 b = at(p + ivec2(1, 0));
  vec3 u = at(p + ivec2(0, -1));
  vec3 d = at(p + ivec2(0, 1));
  vec3 n[8] = vec3[8](a, b, u, d, at(p + ivec2(-1, -1)), at(p + ivec2(1, -1)), at(p + ivec2(-1, 1)), at(p + ivec2(1, 1)));
  vec3 outc = c;
  for (int ch = 0; ch < 3; ch++) {
    float m1 = -1.0;
    float m2 = -1.0;
    for (int k = 0; k < 8; k++) {
      float v = n[k][ch];
      if (v > m1) {
        m2 = m1;
        m1 = v;
      } else if (v > m2) m2 = v;
    }
    float weakest = min(ch == 0 ? 1e30 : c.r, min(ch == 1 ? 1e30 : c.g, ch == 2 ? 1e30 : c.b));
    if (c[ch] > m2 * 2.0 + uOffset && c[ch] > 2.0 * weakest) outc[ch] = (a[ch] + b[ch] + u[ch] + d[ch] - max(max(a[ch], b[ch]), max(u[ch], d[ch]))) / 3.0;
  }
  outColor = vec4(outc, 1.0);
}`;

// Pass 2: a spot's center (alpha 1) with its ring's brightest (uHi) and median (here) per color.
const DETECT = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uSrc;
uniform int uR;
uniform float uOffset;
layout(location = 0) out vec4 outMed;
layout(location = 1) out vec4 outHi;
vec3 at(ivec2 q) { return texelFetch(uSrc, q, 0).rgb; }
float vals[${MAX_RING}];
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uSrc, 0);
  outMed = vec4(0.0);
  outHi = vec4(0.0);
  if (p.x < uR || p.y < uR || p.x >= size.x - uR || p.y >= size.y - uR) return;
  vec3 v = at(p);
  vec3 l = at(p + ivec2(-1, 0));
  vec3 r = at(p + ivec2(1, 0));
  vec3 u = at(p + ivec2(0, -1));
  vec3 d = at(p + ivec2(0, 1));
  // the ring's brightest, per color
  vec3 hi = vec3(0.0);
  for (int dy = -uR; dy <= uR; dy++) {
    for (int dx = -uR; dx <= uR; dx++) {
      if (max(abs(dx), abs(dy)) != uR) continue;
      hi = max(hi, at(p + ivec2(dx, dy)));
    }
  }
  bool spot = false;
  for (int c = 0; c < 3; c++) {
    float x = v[c];
    if (x <= l[c] || x < r[c] || x <= u[c] || x < d[c]) continue;
    if (!(x > hi[c] * 2.5 + uOffset)) continue;
    float rise = x / max(1e-4, hi[c]);
    float least = 1e30;
    for (int o = 0; o < 3; o++) if (o != c) least = min(least, v[o] / max(1e-4, hi[o]));
    if (least > rise * 0.4) continue;
    float weakest = min(c == 0 ? 1e30 : v.r, min(c == 1 ? 1e30 : v.g, c == 2 ? 1e30 : v.b));
    if (!(x > 2.0 * weakest)) continue;
    spot = true;
  }
  if (!spot) return;
  // the ring's median, per color (the processor's: the value at half the count of the sorted ring)
  vec3 med = vec3(0.0);
  for (int c = 0; c < 3; c++) {
    int n = 0;
    for (int dy = -uR; dy <= uR; dy++) {
      for (int dx = -uR; dx <= uR; dx++) {
        if (max(abs(dx), abs(dy)) != uR || n >= ${MAX_RING}) continue;
        vals[n++] = at(p + ivec2(dx, dy))[c];
      }
    }
    // (selection: the (n / 2)-th smallest)
    int want = n / 2;
    int lo = 0;
    int hiI = n - 1;
    while (lo < hiI) {
      float pivot = vals[(lo + hiI) / 2];
      int i = lo;
      int j = hiI;
      while (i <= j) {
        while (vals[i] < pivot) i++;
        while (vals[j] > pivot) j--;
        if (i <= j) {
          float t = vals[i];
          vals[i] = vals[j];
          vals[j] = t;
          i++;
          j--;
        }
      }
      if (want <= j) hiI = j;
      else if (want >= i) lo = i;
      else break;
    }
    med[c] = vals[want];
  }
  outMed = vec4(med, 1.0);
  outHi = vec4(hi, 1.0);
}`;

const APPLY = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uSrc;
uniform highp sampler2D uMed;
uniform highp sampler2D uHi;
uniform int uR;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uSrc, 0);
  vec3 c = texelFetch(uSrc, p, 0).rgb;
  // (the centers closer than R, by row, then column, as the processor takes them)
  for (int dy = 1 - uR; dy < uR; dy++) {
    for (int dx = 1 - uR; dx < uR; dx++) {
      ivec2 q = p + ivec2(dx, dy);
      if (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y) continue;
      vec4 m = texelFetch(uMed, q, 0);
      if (m.a < 0.5) continue;
      vec3 hi = texelFetch(uHi, q, 0).rgb;
      for (int o = 0; o < 3; o++) if (c[o] > hi[o]) c[o] = m[o];
    }
  }
  outColor = vec4(c, 1.0);
}`;

// On `gpu` (a GpuRenderer): clean(rgb (Float32Array, 3 per pixel, changed in place), W, H, R (the spots' ring), offset (HOT_OFFSET)).
export function l16SpecksGpu(gpu) {
  const gl = gpu.gl;
  const progs = {};
  const prog = (name, src) => (progs[name] = progs[name] || program(gl, src));
  return function clean(rgb, W, H, R, offset) {
    if (8 * R > MAX_RING) throw new Error('the spots’ ring is too large for the graphics card');
    const made = [];
    const tex = () => {
      const t = gpu.texture(W, H, gl.RGBA32F);
      made.push(t);
      return t;
    };
    try {
      const data = new Float32Array(4 * W * H);
      for (let i = 0; i < W * H; i++) {
        data[4 * i] = rgb[3 * i];
        data[4 * i + 1] = rgb[3 * i + 1];
        data[4 * i + 2] = rgb[3 * i + 2];
      }
      const src = tex();
      gl.bindTexture(gl.TEXTURE_2D, src);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RGBA, gl.FLOAT, data);
      // 1. the dots of one or two pixels
      const specked = tex();
      gpu.target(specked, W, H);
      let P = prog('speck', SPECK);
      gl.useProgram(P.p);
      gl.uniform1i(P.u.uSrc, 1);
      gpu.bindTex(1, src);
      gl.uniform1f(P.u.uOffset, offset);
      gpu.draw();
      // 2. the spots' centers, their rings' median and brightest (two targets)
      const med = tex();
      const hi = tex();
      const fb = gl.createFramebuffer();
      try {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, med, 0);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, hi, 0);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
        gl.viewport(0, 0, W, H);
        P = prog('detect', DETECT);
        gl.useProgram(P.p);
        gl.uniform1i(P.u.uSrc, 1);
        gpu.bindTex(1, specked);
        gl.uniform1i(P.u.uR, R);
        gl.uniform1f(P.u.uOffset, offset);
        gpu.draw();
        gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      } finally {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(fb);
      }
      // 3. the spots filled
      gpu.target(src, W, H);
      P = prog('apply', APPLY);
      gl.useProgram(P.p);
      gl.uniform1i(P.u.uSrc, 1);
      gpu.bindTex(1, specked);
      gl.uniform1i(P.u.uMed, 2);
      gpu.bindTex(2, med);
      gl.uniform1i(P.u.uHi, 3);
      gpu.bindTex(3, hi);
      gl.uniform1i(P.u.uR, R);
      gpu.draw();
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, data);
      for (let i = 0; i < W * H; i++) {
        rgb[3 * i] = data[4 * i];
        rgb[3 * i + 1] = data[4 * i + 1];
        rgb[3 * i + 2] = data[4 * i + 2];
      }
    } finally {
      for (const t of made) gl.deleteTexture(t);
    }
  };
}
