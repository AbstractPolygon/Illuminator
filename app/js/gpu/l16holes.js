// A Light L16 photo seen from a moved viewpoint with the holes it opens filled (core/l16view.js, as worker.js l16Holes uses it), on the graphics card with the processor's
// rules in single precision:
// - synthesize: every pixel of the picture splatted forward as a rectangle reaching halfway to its neighbours of the same surface, the nearest winning (a depth test; equal
//   depths keep the first drawn, as the processor's z-buffer keeps the first);
// - fillFromBackground: sweeps that give each hole pixel the color and depth of its farthest filled side neighbour, until none is left or nothing changes (backgroundDepth is
//   the depth after these sweeps on the splatted view);
// - superpixelColor and fillFromDonors: the other color cameras' pictures (each 2 x 2 sensor cell a pixel, from the file's packed rows), their color gains to the reference's,
//   and each hole looked up in them, the camera nearest the new viewpoint first.
import { program } from './renderer.js';

const DEPTH_TOLERANCE = 0.03;
const MAX_EXTENT = 12;

// The splat: one instance a source pixel, six vertices (two triangles) covering the output pixels whose centers its footprint holds.
const SPLAT_VS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uRgb;   // the picture (rgb)
uniform sampler2D uZ;     // its depth (mm)
uniform vec4 uMove;       // focal, tx, ty, focal / pivot (0: none)
uniform float uZMax;      // for the depth test: depth / uZMax in 0..1
out vec4 vColor;
float zAt(ivec2 q) { return texelFetch(uZ, q, 0).r; }
vec2 land(ivec2 q, float z) {
  float k = uMove.x / z;
  return vec2(float(q.x) + 0.5 - k * uMove.y + uMove.y * uMove.w, float(q.y) + 0.5 - k * uMove.z + uMove.z * uMove.w);
}
bool similar(float a, float b) { return abs(a - b) <= ${DEPTH_TOLERANCE} * min(a, b); }
void main() {
  ivec2 size = textureSize(uZ, 0);
  ivec2 q = ivec2(gl_InstanceID % size.x, gl_InstanceID / size.x);
  float z = zAt(q);
  vec2 pc = land(q, z);
  float x0 = pc.x - 0.5;
  float x1 = pc.x + 0.5;
  float y0 = pc.y - 0.5;
  float y1 = pc.y + 0.5;
  if (q.x > 0) { float zn = zAt(q - ivec2(1, 0)); if (similar(z, zn)) x0 = max(pc.x - ${MAX_EXTENT}.0, (pc.x + land(q - ivec2(1, 0), zn).x) / 2.0); }
  if (q.x < size.x - 1) { float zn = zAt(q + ivec2(1, 0)); if (similar(z, zn)) x1 = min(pc.x + ${MAX_EXTENT}.0, (pc.x + land(q + ivec2(1, 0), zn).x) / 2.0); }
  if (q.y > 0) { float zn = zAt(q - ivec2(0, 1)); if (similar(z, zn)) y0 = max(pc.y - ${MAX_EXTENT}.0, (pc.y + land(q - ivec2(0, 1), zn).y) / 2.0); }
  if (q.y < size.y - 1) { float zn = zAt(q + ivec2(0, 1)); if (similar(z, zn)) y1 = min(pc.y + ${MAX_EXTENT}.0, (pc.y + land(q + ivec2(0, 1), zn).y) / 2.0); }
  if (x1 < x0) { float t = x0; x0 = x1; x1 = t; }
  if (y1 < y0) { float t = y0; y0 = y1; y1 = t; }
  // (the pixels whose centers fall inside; a footprint too small to hold one goes to the pixel it lands in)
  float ix0 = ceil(x0 - 0.5 - 1e-6);
  float ix1 = ceil(x1 - 0.5 - 1e-6) - 1.0;
  if (ix1 < ix0) ix0 = ix1 = floor(pc.x);
  float iy0 = ceil(y0 - 0.5 - 1e-6);
  float iy1 = ceil(y1 - 0.5 - 1e-6) - 1.0;
  if (iy1 < iy0) iy0 = iy1 = floor(pc.y);
  int v = gl_VertexID;
  float cx = (v == 1 || v == 2 || v == 4) ? ix1 + 1.0 : ix0;
  float cy = (v == 2 || v == 4 || v == 5) ? iy1 + 1.0 : iy0;
  vec2 ndc = vec2(cx, cy) / vec2(size) * 2.0 - 1.0;
  gl_Position = vec4(ndc, clamp(z / uZMax, 0.0, 1.0) * 2.0 - 1.0, 1.0);
  vColor = vec4(texelFetch(uRgb, q, 0).rgb, z);
}`;

const SPLAT_FS = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 outColor;
void main() { outColor = vColor; }`;

// One sweep of the background fill: (rgb, depth) where filled, depth -1 in a hole.
const SWEEP = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uSrc;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uSrc, 0);
  vec4 c = texelFetch(uSrc, p, 0);
  outColor = c;
  if (c.a >= 0.0) return;
  vec4 best = c;
  float bz = -1e30;
  // (left, right, above, below, the first farthest kept)
  if (p.x > 0) { vec4 n = texelFetch(uSrc, p - ivec2(1, 0), 0); if (n.a >= 0.0 && n.a > bz) { bz = n.a; best = n; } }
  if (p.x < size.x - 1) { vec4 n = texelFetch(uSrc, p + ivec2(1, 0), 0); if (n.a >= 0.0 && n.a > bz) { bz = n.a; best = n; } }
  if (p.y > 0) { vec4 n = texelFetch(uSrc, p - ivec2(0, 1), 0); if (n.a >= 0.0 && n.a > bz) { bz = n.a; best = n; } }
  if (p.y < size.y - 1) { vec4 n = texelFetch(uSrc, p + ivec2(0, 1), 0); if (n.a >= 0.0 && n.a > bz) { bz = n.a; best = n; } }
  outColor = best;
}`;

// Per row: the holes left.
const ROWHOLES = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uSrc;
out vec4 outColor;
void main() {
  int y = int(gl_FragCoord.y);
  int W = textureSize(uSrc, 0).x;
  float n = 0.0;
  for (int x = 0; x < W; x++) if (texelFetch(uSrc, ivec2(x, y), 0).a < 0.0) n += 1.0;
  outColor = vec4(n, 0.0, 0.0, 1.0);
}`;

// A donor camera's picture, each 2 x 2 sensor cell a pixel (core/l16view.js superpixelColor), unpacked from the file's packed rows.
const SUPERPIXEL = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uPacked;
uniform ivec2 uRed;
uniform int uMono;
uniform float uBlack;
uniform float uScale;
uniform vec3 uGains;
out vec4 outColor;
float px(int x, int y) {
  int o = 5 * (x >> 2) + (x & 3);
  uint b0 = texelFetch(uPacked, ivec2(o, y), 0).r;
  uint b1 = texelFetch(uPacked, ivec2(o + 1, y), 0).r;
  int j = x & 3;
  uint v = j == 0 ? (b0 | ((b1 & 3u) << 8)) : j == 1 ? ((b0 >> 2) | ((b1 & 15u) << 6)) : j == 2 ? ((b0 >> 4) | ((b1 & 63u) << 4)) : ((b0 >> 6) | (b1 << 2));
  return max(0.0, (float(v) - uBlack) * uScale);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int X = 2 * p.x;
  int Y = 2 * p.y;
  if (uMono == 1) {
    float v = (px(X, Y) + px(X + 1, Y) + px(X, Y + 1) + px(X + 1, Y + 1)) / 4.0;
    outColor = vec4(v, v, v, 1.0);
    return;
  }
  int rx = uRed.x;
  int ry = uRed.y;
  outColor = vec4(px(X + rx, Y + ry) * uGains.r, (px(X + 1 - rx, Y + ry) + px(X + rx, Y + 1 - ry)) / 2.0 * uGains.g, px(X + 1 - rx, Y + 1 - ry) * uGains.b, 1.0);
}`;

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform vec4 uK;      // the reference: fx, cx, fy, cy (sensor pixels)
uniform float uS;     // sensor pixels a picture pixel
// The donors (up to 4): rows of R, T, fx cx fy cy, distortion
uniform sampler2D uD0;
uniform sampler2D uD1;
uniform sampler2D uD2;
uniform sampler2D uD3;
uniform mat3 uR[4];
uniform vec3 uT[4];
uniform vec4 uCK[4];
uniform vec4 uDa[4];
uniform vec4 uDb[4];
uniform float uDcy[4];
uniform int uHasDist[4];
uniform vec3 uGain[4];
uniform int uN;
// The donor's picture where the point P (mm, the reference's frame) is, or false.
bool sampleAt(int d, vec3 P, out vec3 o) {
  float Pz = dot(uR[d][2], P) + uT[d].z;
  if (Pz <= 1.0) return false;
  vec2 s = vec2(uCK[d].x * (dot(uR[d][0], P) + uT[d].x) / Pz + uCK[d].y, uCK[d].z * (dot(uR[d][1], P) + uT[d].y) / Pz + uCK[d].w);
  if (uHasDist[d] == 1) {
    vec4 a = uDa[d];
    vec4 b = uDb[d];
    float u = (s.x - b.w) / b.y;
    float v = (s.y - uDcy[d]) / b.z;
    float rr = u * u + v * v;
    float uv2 = 2.0 * u * v;
    float k = 1.0 + ((a.z * rr + a.y) * rr + a.x) * rr;
    s = vec2(b.w + b.y * (a.w * uv2 + b.x * (rr + 2.0 * u * u) + k * u), uDcy[d] + b.z * (b.x * uv2 + a.w * (rr + 2.0 * v * v) + k * v));
  }
  vec2 c = s / 2.0 - 0.5;
  ivec2 size = d == 0 ? textureSize(uD0, 0) : d == 1 ? textureSize(uD1, 0) : d == 2 ? textureSize(uD2, 0) : textureSize(uD3, 0);
  if (c.x < 0.0 || c.y < 0.0 || c.x >= float(size.x - 1) || c.y >= float(size.y - 1)) return false;
  ivec2 i0 = ivec2(c);
  vec2 f = c - vec2(i0);
  vec3 t00, t10, t01, t11;
  if (d == 0) { t00 = texelFetch(uD0, i0, 0).rgb; t10 = texelFetch(uD0, i0 + ivec2(1, 0), 0).rgb; t01 = texelFetch(uD0, i0 + ivec2(0, 1), 0).rgb; t11 = texelFetch(uD0, i0 + ivec2(1, 1), 0).rgb; }
  else if (d == 1) { t00 = texelFetch(uD1, i0, 0).rgb; t10 = texelFetch(uD1, i0 + ivec2(1, 0), 0).rgb; t01 = texelFetch(uD1, i0 + ivec2(0, 1), 0).rgb; t11 = texelFetch(uD1, i0 + ivec2(1, 1), 0).rgb; }
  else if (d == 2) { t00 = texelFetch(uD2, i0, 0).rgb; t10 = texelFetch(uD2, i0 + ivec2(1, 0), 0).rgb; t01 = texelFetch(uD2, i0 + ivec2(0, 1), 0).rgb; t11 = texelFetch(uD2, i0 + ivec2(1, 1), 0).rgb; }
  else { t00 = texelFetch(uD3, i0, 0).rgb; t10 = texelFetch(uD3, i0 + ivec2(1, 0), 0).rgb; t01 = texelFetch(uD3, i0 + ivec2(0, 1), 0).rgb; t11 = texelFetch(uD3, i0 + ivec2(1, 1), 0).rgb; }
  o = (t00 * (1.0 - f.x) + t10 * f.x) * (1.0 - f.y) + (t01 * (1.0 - f.x) + t11 * f.x) * f.y;
  return true;
}
vec3 rayPoint(ivec2 p, float Z, vec2 t) {
  return vec3(((float(p.x) + 0.5) * uS - uK.y) / uK.x * Z + t.x, ((float(p.y) + 0.5) * uS - uK.w) / uK.z * Z + t.y, Z);
}
`;

// Per row of the gains' sample grid (every 7th pixel from 4, each way): the reference's colors and donor uDonor's, summed where the donor sees the point.
const ROWGAIN = `${HEAD}
uniform sampler2D uRef;   // the reference picture (rgb) on its grid
uniform sampler2D uRefZ;  // its depth (mm)
uniform int uDonor;
layout(location = 0) out vec4 outRef;
layout(location = 1) out vec4 outDonor;
void main() {
  int y = 4 + 7 * int(gl_FragCoord.y);
  int W = textureSize(uRef, 0).x;
  vec3 sr = vec3(0.0);
  vec3 sd = vec3(0.0);
  for (int x = 4; x < W; x += 7) {
    ivec2 p = ivec2(x, y);
    vec3 c;
    if (!sampleAt(uDonor, rayPoint(p, texelFetch(uRefZ, p, 0).r, vec2(0.0)), c)) continue;
    sr += texelFetch(uRef, p, 0).rgb;
    sd += c;
  }
  outRef = vec4(sr, 1.0);
  outDonor = vec4(sd, 1.0);
}`;

// Each hole looked up in the donors, nearest the new viewpoint first (uN of them, in that order), at its background depth.
const DONORS = `${HEAD}
uniform sampler2D uView;   // (rgb, depth; -1 in a hole)
uniform sampler2D uBack;   // the background depth (a: depth)
uniform vec2 uMoveT;       // tx, ty
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(uView, p, 0);
  outColor = c;
  if (c.a >= 0.0) return;
  float Z = texelFetch(uBack, p, 0).a;
  if (!(Z >= 0.0)) return;
  vec3 P = rayPoint(p, Z, uMoveT);
  for (int d = 0; d < 4; d++) {
    if (d >= uN) break;
    vec3 s;
    if (!sampleAt(d, P, s)) continue;
    outColor = vec4(s * uGain[d], Z);
    return;
  }
}`;

// On `gpu` (a GpuRenderer): fill(job) -> { rgb, z (Infinity where none), gap (1 where the splat left a hole) }, as worker.js l16Holes makes them with core/l16view.js.
// job: { rgb, z, w, h, focal, tx, ty, pivotZ, K, S, donors: [{ cam, rel, packed: { bytes, start, stride }, red, mono, opts }] (sorted nearest first, at most 4) }.
export function l16HolesGpu(gpu) {
  const gl = gpu.gl;
  let progs = null;
  const P = () =>
    (progs = progs || {
      splat: program(gl, SPLAT_FS, SPLAT_VS), sweep: program(gl, SWEEP), rowHoles: program(gl, ROWHOLES), superpixel: program(gl, SUPERPIXEL), rowGain: program(gl, ROWGAIN),
      donors: program(gl, DONORS),
    });
  return function fill({ rgb, z, w, h, focal, tx, ty, pivotZ, K, S, donors }) {
    if (donors.length > 4) throw new Error('More donor cameras than the graphics card fill takes');
    const pr = P();
    const made = [];
    const tex = (tw, th, internal = gl.RGBA32F) => {
      const t = gpu.texture(tw, th, internal);
      made.push(t);
      return t;
    };
    const fb = gl.createFramebuffer();
    const depthRb = gl.createRenderbuffer();
    const vao = gl.createVertexArray();
    const draw = (prog, out, tw, th, inputs, set = () => {}) => {
      gpu.target(out, tw, th);
      gl.useProgram(prog.p);
      inputs.forEach(([name, t], i) => {
        gl.uniform1i(prog.u[name], i + 1);
        gpu.bindTex(i + 1, t);
      });
      set(prog.u);
      gpu.draw();
    };
    try {
      // the picture and its depth on the card
      const rgbT = tex(w, h, gl.RGB32F);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGB, gl.FLOAT, rgb);
      const zT = gpu.uploadR32F(null, null, z, w, h);
      made.push(zT);
      let zMax = 0;
      for (let i = 0; i < z.length; i++) if (z[i] > zMax && Number.isFinite(z[i])) zMax = z[i];
      // the splat, with a depth test
      const view = tex(w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, view, 0);
      gl.bindRenderbuffer(gl.RENDERBUFFER, depthRb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT32F, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRb);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, -1);
      gl.clearDepth(1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.clearColor(0, 0, 0, 0);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      try {
        gl.useProgram(pr.splat.p);
        gl.uniform1i(pr.splat.u.uRgb, 1);
        gpu.bindTex(1, rgbT);
        gl.uniform1i(pr.splat.u.uZ, 2);
        gpu.bindTex(2, zT);
        gl.uniform4f(pr.splat.u.uMove, focal, tx, ty, pivotZ > 0 ? focal / pivotZ : 0);
        gl.uniform1f(pr.splat.u.uZMax, zMax * 1.001 + 1);
        gl.bindVertexArray(vao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, w * h);
      } finally {
        gl.disable(gl.DEPTH_TEST);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
      // (the splat's holes, for the caller)
      const buf = new Float32Array(4 * w * h);
      gpu.target(view, w, h);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, buf);
      const gap = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) if (buf[4 * i + 3] < 0) gap[i] = 1;
      // the background fill's sweeps, until no hole is left or none was filled
      const rowT = tex(1, h);
      const rows = new Float32Array(4 * h);
      const holesLeft = (t) => {
        draw(pr.rowHoles, rowT, 1, h, [['uSrc', t]]);
        gl.readPixels(0, 0, 1, h, gl.RGBA, gl.FLOAT, rows);
        let n = 0;
        for (let y = 0; y < h; y++) n += rows[4 * y];
        return n;
      };
      const sweeps = (start) => {
        const a = tex(w, h);
        const b = tex(w, h);
        let cur = start;
        let left = holesLeft(cur);
        for (let pass = 0; pass < 200 && left > 0; ) {
          // (several sweeps between checks: a sweep that fills nothing changes nothing)
          for (let k = 0; k < 8 && pass < 200; k++, pass++) {
            const out = cur === a ? b : a;
            draw(pr.sweep, out, w, h, [['uSrc', cur]]);
            cur = out;
          }
          const now = holesLeft(cur);
          if (now === left) break;
          left = now;
        }
        return cur;
      };
      const back = sweeps(view);
      // the donors' pictures and color gains
      // (the donors' uniforms on `prog`: an array's elements each have their own location)
      const set = (prog) => {
        const u = prog.u;
        const at = (name) => gl.getUniformLocation(prog.p, name);
        gl.uniform4f(u.uK, K[0], K[2], K[4], K[5]);
        gl.uniform1f(u.uS, S);
        gl.uniform1i(u.uN, donors.length);
        donors.forEach((d, k) => {
          gl.uniformMatrix3fv(at(`uR[${k}]`), false, Array.from(d.rel.R));
          gl.uniform3f(at(`uT[${k}]`), d.rel.T[0], d.rel.T[1], d.rel.T[2]);
          gl.uniform4f(at(`uCK[${k}]`), d.cam.K[0], d.cam.K[2], d.cam.K[4], d.cam.K[5]);
          const p = d.cam.distort && d.cam.distort.params;
          gl.uniform1i(at(`uHasDist[${k}]`), p ? 1 : 0);
          if (p) {
            gl.uniform4f(at(`uDa[${k}]`), p.k1, p.k2, p.k3, p.p1);
            gl.uniform4f(at(`uDb[${k}]`), p.p2, p.nx, p.ny, p.cx);
            gl.uniform1f(at(`uDcy[${k}]`), p.cy);
          }
          const g = d.gains || [1, 1, 1];
          gl.uniform3f(at(`uGain[${k}]`), g[0], g[1], g[2]);
        });
      };
      const dTex = donors.map((d) => {
        const sd = d.size;
        const ow = sd.x >> 1;
        const oh = sd.y >> 1;
        const { bytes, start, stride } = d.packed;
        let rows8 = bytes.subarray(start, start + sd.y * stride);
        if (rows8.length < sd.y * stride) {
          const padded = new Uint8Array(sd.y * stride);
          padded.set(rows8);
          rows8 = padded;
        }
        const pk = tex(stride, sd.y, gl.R8UI);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        try {
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, stride, sd.y, gl.RED_INTEGER, gl.UNSIGNED_BYTE, rows8);
        } finally {
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        }
        const out = tex(ow, oh);
        draw(pr.superpixel, out, ow, oh, [['uPacked', pk]], (u) => {
          gl.uniform2i(u.uRed, Math.max(0, d.red.x), Math.max(0, d.red.y));
          gl.uniform1i(u.uMono, d.mono ? 1 : 0);
          gl.uniform1f(u.uBlack, d.opts.black ?? 42);
          gl.uniform1f(u.uScale, 1 / ((d.opts.white ?? 1023) - (d.opts.black ?? 42)));
          const g = d.opts.gains || [1, 1, 1];
          gl.uniform3f(u.uGains, g[0], g[1], g[2]);
        });
        return out;
      });
      const donorInputs = [0, 1, 2, 3].map((k) => [`uD${k}`, dTex[k] || dTex[0] || rgbT]);
      const refT = rgbT;
      const gh = Math.max(0, Math.ceil((h - 4) / 7));
      const gr = tex(1, gh);
      const gd = tex(1, gh);
      donors.forEach((d, k) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, gpu.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, gr, 0);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, gd, 0);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
        gl.viewport(0, 0, 1, gh);
        try {
          gl.useProgram(pr.rowGain.p);
          [['uRef', refT], ['uRefZ', zT], ...donorInputs].forEach(([name, t], i) => {
            gl.uniform1i(pr.rowGain.u[name], i + 1);
            gpu.bindTex(i + 1, t);
          });
          set(pr.rowGain);
          gl.uniform1i(pr.rowGain.u.uDonor, k);
          gpu.draw();
          const a = new Float32Array(4 * gh);
          const b = new Float32Array(4 * gh);
          gl.readBuffer(gl.COLOR_ATTACHMENT0);
          gl.readPixels(0, 0, 1, gh, gl.RGBA, gl.FLOAT, a);
          gl.readBuffer(gl.COLOR_ATTACHMENT1);
          gl.readPixels(0, 0, 1, gh, gl.RGBA, gl.FLOAT, b);
          gl.readBuffer(gl.COLOR_ATTACHMENT0);
          const sr = [0, 0, 0];
          const sdn = [0, 0, 0];
          for (let y = 0; y < gh; y++) for (let c = 0; c < 3; c++) {
            sr[c] += a[4 * y + c];
            sdn[c] += b[4 * y + c];
          }
          d.gains = sdn.map((v, c) => (v > 1e-6 ? sr[c] / v : 1));
        } finally {
          gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, null, 0);
        }
      });
      // the holes from the donors, then the background fill again
      const filled = tex(w, h);
      draw(pr.donors, filled, w, h, [['uView', view], ['uBack', back], ...donorInputs], (u) => {
        set(pr.donors);
        gl.uniform2f(u.uMoveT, tx, ty);
      });
      const done = sweeps(filled);
      gpu.target(done, w, h);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, buf);
      const outRgb = new Float32Array(3 * w * h);
      const outZ = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) {
        outRgb[3 * i] = buf[4 * i];
        outRgb[3 * i + 1] = buf[4 * i + 1];
        outRgb[3 * i + 2] = buf[4 * i + 2];
        outZ[i] = buf[4 * i + 3] >= 0 ? buf[4 * i + 3] : Infinity;
      }
      return { rgb: outRgb, z: outZ, gap };
    } finally {
      for (const t of made) gl.deleteTexture(t);
      gl.deleteFramebuffer(fb);
      gl.deleteRenderbuffer(depthRb);
      gl.deleteVertexArray(vao);
    }
  };
}
