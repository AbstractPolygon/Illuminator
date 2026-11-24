// The merge of a Light L16 photo's cameras (core/l16fusion.js fuse) on the graphics card, with the processor's rules in single precision: the reference camera's picture
// laid on its undistorted grid, and each other camera's picture looked up where the depth puts every pixel (the calibrated pose, the lens distortion, the capture's
// correction, a bilinear lookup), with its weight by how well it agrees with the reference. The output is made in bands of rows (the full size merge is 4160 x 3120); each
// band's result is read back and added up on the processor, which keeps the graphics memory needed to the cameras' pictures and a band.
import { program } from './renderer.js';

const COMMON = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform vec4 uDa;     // distortion: k1, k2, k3, p1
uniform vec4 uDb;     // p2, nx, ny, cx
uniform float uDcy;   // cy
uniform int uHasDist;
uniform float uS;     // sensor pixels a grid pixel
uniform int uRow0;    // the band's first row
vec2 distort(vec2 q) {
  if (uHasDist == 0) return q;
  float u = (q.x - uDb.w) / uDb.y;
  float v = (q.y - uDcy) / uDb.z;
  float rr = u * u + v * v;
  float uv2 = 2.0 * u * v;
  float k = 1.0 + ((uDa.z * rr + uDa.y) * rr + uDa.x) * rr;
  return vec2(uDb.w + uDb.y * (uDa.w * uv2 + uDb.x * (rr + 2.0 * u * u) + k * u), uDcy + uDb.z * (uDb.x * uv2 + uDa.w * (rr + 2.0 * v * v) + k * v));
}
// the picture (rgb) at a point in its pixels, bilinear; false outside (as the processor's bilinear)
bool look(sampler2D img, vec2 s, out vec3 o) {
  vec2 q = s - 0.5;
  ivec2 size = textureSize(img, 0);
  if (q.x < 0.0 || q.y < 0.0 || q.x >= float(size.x - 1) || q.y >= float(size.y - 1)) return false;
  ivec2 i0 = ivec2(q);
  vec2 f = q - vec2(i0);
  o = (texelFetch(img, i0, 0).rgb * (1.0 - f.x) + texelFetch(img, i0 + ivec2(1, 0), 0).rgb * f.x) * (1.0 - f.y)
    + (texelFetch(img, i0 + ivec2(0, 1), 0).rgb * (1.0 - f.x) + texelFetch(img, i0 + ivec2(1, 1), 0).rgb * f.x) * f.y;
  return true;
}
float luma(vec3 c) { return 0.3 * c.r + 0.55 * c.g + 0.15 * c.b; }
`;

// The reference on its undistorted grid: (rgb, 1) where its picture covers the pixel, else 0.
const REF = `${COMMON}
uniform sampler2D uImg;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) + ivec2(0, uRow0);
  vec3 c;
  bool ok = look(uImg, distort((vec2(p) + 0.5) * uS) / uS, c);
  outColor = ok ? vec4(c, 1.0) : vec4(0.0);
}`;

// One camera's share: (rgb times its weight, the weight); the weight's alpha past 0.5 counts as agreeing (the second output).
const CAM = `${COMMON}
uniform sampler2D uImg;
uniform sampler2D uRefU;   // the band of the reference on the grid: (rgb, 1 where valid)
uniform sampler2D uZ;      // the band's depth, mm
uniform vec4 uK;           // the reference: fx, cx, fy, cy
uniform vec4 uCK;          // this camera: fx, cx, fy, cy
uniform mat3 uR;           // rows of R (relative pose)
uniform vec3 uT;
uniform vec3 uCx;          // the capture's correction (a0, a1, a2) of x; 0 for none
uniform vec3 uCy;
uniform vec3 uGain;
uniform int uMono;
uniform float uMg;
layout(location = 0) out vec4 outShare;
layout(location = 1) out vec4 outAgree;
void main() {
  ivec2 b = ivec2(gl_FragCoord.xy);
  ivec2 p = b + ivec2(0, uRow0);
  outShare = vec4(0.0);
  outAgree = vec4(0.0);
  vec4 ru = texelFetch(uRefU, b, 0);
  if (ru.a == 0.0) return;
  float Z = texelFetch(uZ, b, 0).r;
  vec3 P = vec3(((float(p.x) + 0.5) * uS - uK.y) / uK.x * Z, ((float(p.y) + 0.5) * uS - uK.w) / uK.z * Z, Z);
  float Pz = dot(uR[2], P) + uT.z;
  if (Pz <= 1.0) return;
  vec2 s = distort(vec2(uCK.x * (dot(uR[0], P) + uT.x) / Pz + uCK.y, uCK.z * (dot(uR[1], P) + uT.y) / Pz + uCK.w));
  vec2 uv = s / vec2(4160.0, 3120.0);
  s += vec2(uCx.x + uCx.y * uv.x + uCx.z * uv.y, uCy.x + uCy.y * uv.x + uCy.z * uv.y);
  vec3 smp;
  if (!look(uImg, s / uS, smp)) return;
  float rl = luma(ru.rgb);
  vec3 col = uMono == 1 ? ru.rgb * ((smp.g * uMg) / max(1e-4, rl)) : smp * uGain;
  float dl = luma(col);
  float sigma = 0.012 + 0.07 * sqrt(max(rl, 0.0)) * 0.35;
  float d = (dl - rl) / sigma;
  float w = exp(-0.5 * d * d);
  if (w < 0.02) return;
  outShare = vec4(col * w, w);
  outAgree = vec4(w > 0.5 ? 1.0 : 0.0, 0.0, 0.0, 1.0);
}`;

const setDist = (gl, u, dist) => {
  const p = dist && dist.params;
  gl.uniform1i(u.uHasDist, p ? 1 : 0);
  if (!p) return;
  gl.uniform4f(u.uDa, p.k1, p.k2, p.k3, p.p1);
  gl.uniform4f(u.uDb, p.p2, p.nx, p.ny, p.cx);
  gl.uniform1f(u.uDcy, p.cy);
};

// On `gpu` (a GpuRenderer): { reference(job), camera(job) }, the two steps of fuse (core/l16fusion.js), as described there.
export function l16FuseGpu(gpu) {
  const gl = gpu.gl;
  let progs = null;
  const P = () => (progs = progs || { ref: program(gl, REF), cam: program(gl, CAM) });
  // (a picture of 3 values a pixel, as it is: an RGB32F texture)
  const rgbTex = (made, { width, height, rgb }) => {
    const t = gpu.texture(width, height, gl.RGB32F);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGB, gl.FLOAT, rgb);
    made.push(t);
    return t;
  };
  const bandRows = (W) => Math.max(1, Math.floor((1 << 22) / W));
  const read = (tex, W, rows, buf) => {
    gpu.target(tex, W, rows);
    gl.readPixels(0, 0, W, rows, gl.RGBA, gl.FLOAT, buf);
  };
  const scoped = (fn) => {
    const made = [];
    try {
      return fn(made);
    } finally {
      for (const t of made) gl.deleteTexture(t);
    }
  };
  return {
    // The reference on its undistorted grid (W x H, `S` sensor pixels a grid pixel): fills refUnd (3 a pixel) and valid.
    reference({ img, W, H, S, dist, refUnd, valid }) {
      scoped((made) => {
        const p = P().ref;
        const src = rgbTex(made, img);
        const rows = Math.min(H, bandRows(W));
        const out = gpu.texture(W, rows, gl.RGBA32F);
        made.push(out);
        const buf = new Float32Array(4 * W * rows);
        for (let y0 = 0; y0 < H; y0 += rows) {
          const n = Math.min(rows, H - y0);
          gpu.target(out, W, n);
          gl.useProgram(p.p);
          gl.uniform1i(p.u.uImg, 1);
          gpu.bindTex(1, src);
          gl.uniform1f(p.u.uS, S);
          gl.uniform1i(p.u.uRow0, y0);
          setDist(gl, p.u, dist);
          gpu.draw();
          read(out, W, n, buf);
          for (let i = 0; i < W * n; i++) {
            const j = y0 * W + i;
            refUnd[3 * j] = buf[4 * i];
            refUnd[3 * j + 1] = buf[4 * i + 1];
            refUnd[3 * j + 2] = buf[4 * i + 2];
            valid[j] = buf[4 * i + 3] > 0 ? 1 : 0;
          }
        }
      });
    },
    // One camera's share added to out (3 a pixel) and weight; returns how many pixels agreed.
    camera({ img, W, H, S, K, cam, rel, corr, gain, mono, mg, z, refUnd, valid, out: acc, weight }) {
      return scoped((made) => {
        const p = P().cam;
        const src = rgbTex(made, img);
        const rows = Math.min(H, bandRows(W));
        const share = gpu.texture(W, rows, gl.RGBA32F);
        const agree = gpu.texture(W, rows, gl.RGBA8);
        const refT = gpu.texture(W, rows, gl.RGBA32F);
        const zT = gpu.texture(W, rows, gl.R32F);
        made.push(share, agree, refT, zT);
        const buf = new Float32Array(4 * W * rows);
        const flags = new Uint8Array(4 * W * rows);
        const refBuf = new Float32Array(4 * W * rows);
        let agreed = 0;
        const fb = gl.createFramebuffer();
        try {
          for (let y0 = 0; y0 < H; y0 += rows) {
            const n = Math.min(rows, H - y0);
            for (let i = 0; i < W * n; i++) {
              const j = y0 * W + i;
              refBuf[4 * i] = refUnd[3 * j];
              refBuf[4 * i + 1] = refUnd[3 * j + 1];
              refBuf[4 * i + 2] = refUnd[3 * j + 2];
              refBuf[4 * i + 3] = valid[j];
            }
            gpu.bindTex(1, refT);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, n, gl.RGBA, gl.FLOAT, refBuf);
            gpu.bindTex(1, zT);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, n, gl.RED, gl.FLOAT, z.subarray(y0 * W, (y0 + n) * W));
            gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, share, 0);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, agree, 0);
            gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
            gl.viewport(0, 0, W, n);
            gl.useProgram(p.p);
            const u = p.u;
            gl.uniform1i(u.uImg, 1);
            gpu.bindTex(1, src);
            gl.uniform1i(u.uRefU, 2);
            gpu.bindTex(2, refT);
            gl.uniform1i(u.uZ, 3);
            gpu.bindTex(3, zT);
            gl.uniform1f(u.uS, S);
            gl.uniform1i(u.uRow0, y0);
            setDist(gl, u, cam.distort);
            gl.uniform4f(u.uK, K[0], K[2], K[4], K[5]);
            gl.uniform4f(u.uCK, cam.K[0], cam.K[2], cam.K[4], cam.K[5]);
            // (row-major R given as the columns: the shader's uR[i] is row i)
            gl.uniformMatrix3fv(u.uR, false, Array.from(rel.R));
            gl.uniform3f(u.uT, rel.T[0], rel.T[1], rel.T[2]);
            gl.uniform3f(u.uCx, corr ? corr.ax[0] : 0, corr ? corr.ax[1] : 0, corr ? corr.ax[2] : 0);
            gl.uniform3f(u.uCy, corr ? corr.ay[0] : 0, corr ? corr.ay[1] : 0, corr ? corr.ay[2] : 0);
            gl.uniform3f(u.uGain, gain[0], gain[1], gain[2]);
            gl.uniform1i(u.uMono, mono ? 1 : 0);
            gl.uniform1f(u.uMg, mg);
            gpu.draw();
            gl.readBuffer(gl.COLOR_ATTACHMENT0);
            gl.readPixels(0, 0, W, n, gl.RGBA, gl.FLOAT, buf);
            gl.readBuffer(gl.COLOR_ATTACHMENT1);
            gl.readPixels(0, 0, W, n, gl.RGBA, gl.UNSIGNED_BYTE, flags);
            gl.readBuffer(gl.COLOR_ATTACHMENT0);
            for (let i = 0; i < W * n; i++) {
              const w = buf[4 * i + 3];
              if (!(w > 0)) continue;
              const j = y0 * W + i;
              acc[3 * j] += buf[4 * i];
              acc[3 * j + 1] += buf[4 * i + 1];
              acc[3 * j + 2] += buf[4 * i + 2];
              weight[j] += w;
              if (flags[4 * i] > 127) agreed++;
            }
          }
        } finally {
          gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
          gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.deleteFramebuffer(fb);
        }
        return agreed;
      });
    },
  };
}
