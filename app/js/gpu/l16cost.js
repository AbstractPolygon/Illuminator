// The depth steps of a Light L16 photo's depth (core/l16depth.js depthCostStep) on the graphics card: for every reference pixel, the mean over the other modules of
// the capped difference between the pixel and the module's picture where the step's depth puts it (projection by the calibrated pose, the module's lens
// distortion, a bilinear lookup), the same arithmetic as the processor's, in single precision. The 5 x 5 window and the scaling are the processor's (costFromDiff).
// Used through the same interface as the helper workers (run(job, steps, onSlice)), so measureDepthPooled takes either.
import { program } from './renderer.js';
import { costFromDiff, DEPTH_CAP } from '../core/l16depth.js';

function shaderFor(n) {
  const mods = Array.from({ length: n }, (_, m) => `
  {
    // module ${m}
    float Pz = dot(uR${m}[2], P) + uT${m}.z;
    if (Pz > 1.0) {
      float ix = (uF${m}.x * (dot(uR${m}[0], P) + uT${m}.x)) / Pz + uF${m}.y;
      float iy = (uF${m}.z * (dot(uR${m}[1], P) + uT${m}.y)) / Pz + uF${m}.w;
      float u = (ix - uD${m}b.w) / uD${m}b.y;
      float v = (iy - uD${m}c.x) / uD${m}b.z;
      float rr = u * u + v * v;
      float uv2 = 2.0 * u * v;
      float k = 1.0 + ((uD${m}a.z * rr + uD${m}a.y) * rr + uD${m}a.x) * rr;
      float sx = uD${m}b.w + uD${m}b.y * (uD${m}a.w * uv2 + uD${m}b.x * (rr + 2.0 * u * u) + k * u);
      float sy = uD${m}c.x + uD${m}b.z * (uD${m}b.x * uv2 + uD${m}a.w * (rr + 2.0 * v * v) + k * v);
      float bx = sx / uS - 0.5;
      float by = sy / uS - 0.5;
      ivec2 size = textureSize(uPic${m}, 0);
      if (bx >= 0.0 && by >= 0.0 && bx < float(size.x - 1) && by < float(size.y - 1)) {
        int xi = int(bx);
        int yi = int(by);
        float fx = bx - float(xi);
        float fy = by - float(yi);
        float g00 = texelFetch(uPic${m}, ivec2(xi, yi), 0).r;
        float g10 = texelFetch(uPic${m}, ivec2(xi + 1, yi), 0).r;
        float g01 = texelFetch(uPic${m}, ivec2(xi, yi + 1), 0).r;
        float g11 = texelFetch(uPic${m}, ivec2(xi + 1, yi + 1), 0).r;
        float val = (g00 * (1.0 - fx) + g10 * fx) * (1.0 - fy) + (g01 * (1.0 - fx) + g11 * fx) * fy;
        if (!isnan(val)) {
          sum += min(abs(val - rv), CAP);
          cnt += 1.0;
        }
      }
    }
  }`).join('');
  const decl = Array.from({ length: n }, (_, m) => `uniform sampler2D uPic${m};
uniform mat3 uR${m};
uniform vec3 uT${m};
uniform vec4 uF${m};
uniform vec4 uD${m}a;
uniform vec4 uD${m}b;
uniform vec4 uD${m}c;`).join('\n');
  return `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uRef;
uniform float uS;
uniform float uZ;
uniform vec4 uK; // reference: fx, cx, fy, cy
const float CAP = ${DEPTH_CAP.toFixed(4)};
${decl}
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float rv = texelFetch(uRef, p, 0).r;
  float sum = 0.0;
  float cnt = 0.0;
  if (!isnan(rv)) {
    float X = ((float(p.x) + 0.5) * uS - uK.y) / uK.x * uZ;
    float Y = ((float(p.y) + 0.5) * uS - uK.w) / uK.z * uZ;
    vec3 P = vec3(X, Y, uZ);
${mods}
  }
  outColor = vec4(cnt > 0.0 ? sum / cnt : CAP, 0.0, 0.0, 1.0);
}`;
}

// A runner for the job's depth steps on `gpu` (a GpuRenderer), or null where it cannot (a module whose distortion is not the polynomial, too many modules).
export function l16CostGpu(gpu, job) {
  const { mods, refSample, w, h, S, K, invMin, invMax, NZ } = job;
  if (!gpu || !mods.length || mods.length > 12 || !mods.every((m) => m.dist)) return null;
  const gl = gpu.gl;
  const P = program(gl, shaderFor(mods.length));
  const textures = [];
  const upload = (data, tw, th) => {
    const t = gpu.uploadR32F(null, null, data, tw, th);
    textures.push(t);
    return t;
  };
  const ref = upload(refSample, w, h);
  const pics = mods.map((m) => upload(m.g, m.pw, m.ph));
  const out = gpu.texture(w, h, gl.RGBA32F);
  textures.push(out);
  const buf = new Float32Array(w * h * 4);
  const diff = new Float32Array(w * h);
  const step = (zi) => {
    const inv = invMin + ((invMax - invMin) * zi) / (NZ - 1);
    gpu.target(out, w, h);
    gl.useProgram(P.p);
    gl.uniform1i(P.u.uRef, 0);
    gpu.bindTex(0, ref);
    gl.uniform1f(P.u.uS, S);
    gl.uniform1f(P.u.uZ, 1 / inv);
    gl.uniform4f(P.u.uK, K[0], K[2], K[4], K[5]);
    mods.forEach((m, k) => {
      gl.uniform1i(P.u[`uPic${k}`], k + 1);
      gpu.bindTex(k + 1, pics[k]);
      // (row-major R as three rows: the shader's dot(uR[i], P) is row i)
      gl.uniformMatrix3fv(P.u[`uR${k}`], false, [m.r0, m.r1, m.r2, m.r3, m.r4, m.r5, m.r6, m.r7, m.r8]);
      gl.uniform3f(P.u[`uT${k}`], m.t0, m.t1, m.t2);
      gl.uniform4f(P.u[`uF${k}`], m.f0, m.c0, m.f1, m.c1);
      gl.uniform4f(P.u[`uD${k}a`], m.k1, m.k2, m.k3, m.p1);
      gl.uniform4f(P.u[`uD${k}b`], m.p2, m.nx, m.ny, m.dcx);
      gl.uniform4f(P.u[`uD${k}c`], m.dcy, 0, 0, 0);
    });
    gpu.draw();
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, buf);
    for (let i = 0; i < w * h; i++) diff[i] = buf[4 * i];
    return costFromDiff(diff, w, h);
  };
  return {
    async run(j, steps, onSlice) {
      for (let zi = 0; zi < steps; zi++) {
        onSlice(zi, step(zi));
        // (let the worker's messages through now and then)
        if (zi % 8 === 7) await new Promise((r) => setTimeout(r, 0));
      }
    },
    close() {
      for (const t of textures) gl.deleteTexture(t);
      gl.deleteProgram(P.p);
    },
  };
}
