// The pictures the Light L16 depth is measured on (core/l16depth.js reducedPicture), made on the graphics card from the file's packed 10 bit rows, with the processor's
// rules in single precision: each s x s block of sensor values averaged, then brightness-normalized by the local mean and spread over a (2r + 1) square (box blurs with
// the edges clamped). And the reference's picture looked up through its lens distortion (depthSetup's refSample).
import { program } from './renderer.js';

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
precision highp sampler2D;
`;

// The block means, unpacking the rows as core/lri.js decodeFrame does.
const REDUCE = `${HEAD}
uniform usampler2D uPacked;
uniform int uS;
out vec4 outColor;
uint px(int x, int y) {
  int o = 5 * (x >> 2) + (x & 3);
  uint b0 = texelFetch(uPacked, ivec2(o, y), 0).r;
  uint b1 = texelFetch(uPacked, ivec2(o + 1, y), 0).r;
  int j = x & 3;
  return j == 0 ? (b0 | ((b1 & 3u) << 8)) : j == 1 ? ((b0 >> 2) | ((b1 & 15u) << 6)) : j == 2 ? ((b0 >> 4) | ((b1 & 63u) << 4)) : ((b0 >> 6) | (b1 << 2));
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  uint sum = 0u;
  for (int dy = 0; dy < uS; dy++) for (int dx = 0; dx < uS; dx++) sum += px(uS * p.x + dx, uS * p.y + dy);
  float g = float(sum) / float(uS * uS);
  outColor = vec4(g, g * g, 0.0, 1.0);
}`;

// One box blur pass along uDir of (g, g squared) in r and g.
const BOX = `${HEAD}
uniform sampler2D uSrc;
uniform ivec2 uDir;
uniform int uR;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uSrc, 0);
  vec2 acc = vec2(0.0);
  for (int d = -uR; d <= uR; d++) acc += texelFetch(uSrc, clamp(p + d * uDir, ivec2(0), size - 1), 0).rg;
  outColor = vec4(acc / float(2 * uR + 1), 0.0, 1.0);
}`;

// (g - mean) / (spread + 0.02 mean + 2)
const NORMALIZE = `${HEAD}
uniform sampler2D uG;
uniform sampler2D uMean;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float g = texelFetch(uG, p, 0).r;
  vec2 m = texelFetch(uMean, p, 0).rg;
  float sd = sqrt(max(0.0, m.y - m.x * m.x));
  outColor = vec4((g - m.x) / (sd + 0.02 * m.x + 2.0), 0.0, 0.0, 1.0);
}`;

// The picture at the reference's ideal pixel centers ((x + 0.5) s), looked up where its lens drew them, bilinear; outside it, flagged (b = 0).
const UNDISTORT = `${HEAD}
uniform sampler2D uG;
uniform float uS;
uniform vec4 uDa;
uniform vec4 uDb;
uniform float uDcy;
uniform int uHasDist;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 q = (vec2(p) + 0.5) * uS;
  if (uHasDist == 1) {
    float u = (q.x - uDb.w) / uDb.y;
    float v = (q.y - uDcy) / uDb.z;
    float rr = u * u + v * v;
    float uv2 = 2.0 * u * v;
    float k = 1.0 + ((uDa.z * rr + uDa.y) * rr + uDa.x) * rr;
    q = vec2(uDb.w + uDb.y * (uDa.w * uv2 + uDb.x * (rr + 2.0 * u * u) + k * u), uDcy + uDb.z * (uDb.x * uv2 + uDa.w * (rr + 2.0 * v * v) + k * v));
  }
  vec2 c = q / uS - 0.5;
  ivec2 size = textureSize(uG, 0);
  if (c.x < 0.0 || c.y < 0.0 || c.x >= float(size.x - 1) || c.y >= float(size.y - 1)) {
    outColor = vec4(0.0);
    return;
  }
  ivec2 i0 = ivec2(c);
  vec2 f = c - vec2(i0);
  float a = texelFetch(uG, i0, 0).r;
  float b = texelFetch(uG, i0 + ivec2(1, 0), 0).r;
  float d = texelFetch(uG, i0 + ivec2(0, 1), 0).r;
  float e = texelFetch(uG, i0 + ivec2(1, 1), 0).r;
  outColor = vec4((a * (1.0 - f.x) + b * f.x) * (1.0 - f.y) + (d * (1.0 - f.x) + e * f.x) * f.y, 0.0, 1.0, 1.0);
}`;

// On `gpu` (a GpuRenderer): { reduced({ packed: { bytes, start, stride }, W, H, s, r }) -> { w, h, g }, undistorted(g, w, h, s, distort) -> Float32Array (NaN outside) }.
export function l16ReduceGpu(gpu) {
  const gl = gpu.gl;
  let progs = null;
  const P = () => (progs = progs || { reduce: program(gl, REDUCE), box: program(gl, BOX), normalize: program(gl, NORMALIZE), undistort: program(gl, UNDISTORT) });
  const scoped = (fn) => {
    const made = [];
    const tex = (w, h, internal) => {
      const t = gpu.texture(w, h, internal);
      made.push(t);
      return t;
    };
    try {
      return fn(tex);
    } finally {
      for (const t of made) gl.deleteTexture(t);
    }
  };
  const readR = (w, h) => {
    const buf = new Float32Array(4 * w * h);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, buf);
    return buf;
  };
  return {
    reduced({ packed, W, H, s, r }) {
      const w = Math.floor(W / s);
      const h = Math.floor(H / s);
      const { bytes, start, stride } = packed;
      const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      if (stride > max || H > max) throw new Error('The frame is larger than the graphics card textures');
      return scoped((tex) => {
        const p = P();
        // (the frame's rows; the last one, which the file may end within, padded)
        let rows = bytes.subarray(start, start + H * stride);
        if (rows.length < H * stride) {
          const padded = new Uint8Array(H * stride);
          padded.set(rows);
          rows = padded;
        }
        const pk = tex(stride, H, gl.R8UI);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        try {
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, stride, H, gl.RED_INTEGER, gl.UNSIGNED_BYTE, rows);
        } finally {
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        }
        const g = tex(w, h, gl.RGBA32F);
        gpu.target(g, w, h);
        gl.useProgram(p.reduce.p);
        gl.uniform1i(p.reduce.u.uPacked, 1);
        gpu.bindTex(1, pk);
        gl.uniform1i(p.reduce.u.uS, s);
        gpu.draw();
        const tmp = tex(w, h, gl.RGBA32F);
        const mean = tex(w, h, gl.RGBA32F);
        for (const [src, dst, dir] of [[g, tmp, [1, 0]], [tmp, mean, [0, 1]]]) {
          gpu.target(dst, w, h);
          gl.useProgram(p.box.p);
          gl.uniform1i(p.box.u.uSrc, 1);
          gpu.bindTex(1, src);
          gl.uniform2i(p.box.u.uDir, dir[0], dir[1]);
          gl.uniform1i(p.box.u.uR, r);
          gpu.draw();
        }
        gpu.target(tmp, w, h);
        gl.useProgram(p.normalize.p);
        gl.uniform1i(p.normalize.u.uG, 1);
        gpu.bindTex(1, g);
        gl.uniform1i(p.normalize.u.uMean, 2);
        gpu.bindTex(2, mean);
        gpu.draw();
        const buf = readR(w, h);
        const out = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) out[i] = buf[4 * i];
        return { w, h, g: out };
      });
    },
    undistorted(g, w, h, s, distort) {
      return scoped((tex) => {
        const p = P().undistort;
        const src = gpu.uploadR32F(null, null, g, w, h);
        const out = tex(w, h, gl.RGBA32F);
        try {
          gpu.target(out, w, h);
          gl.useProgram(p.p);
          gl.uniform1i(p.u.uG, 1);
          gpu.bindTex(1, src);
          gl.uniform1f(p.u.uS, s);
          const d = distort && distort.params;
          gl.uniform1i(p.u.uHasDist, d ? 1 : 0);
          if (d) {
            gl.uniform4f(p.u.uDa, d.k1, d.k2, d.k3, d.p1);
            gl.uniform4f(p.u.uDb, d.p2, d.nx, d.ny, d.cx);
            gl.uniform1f(p.u.uDcy, d.cy);
          }
          gpu.draw();
          const buf = readR(w, h);
          const res = new Float32Array(w * h);
          for (let i = 0; i < w * h; i++) res[i] = buf[4 * i + 2] > 0 ? buf[4 * i] : NaN;
          return res;
        } finally {
          gl.deleteTexture(src);
        }
      });
    },
  };
}
