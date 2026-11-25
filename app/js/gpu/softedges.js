// core/segments.js softenObjectEdges on the graphics card (Camera > Depth > Object edges, Smooth edges): the depth blurred by a Gaussian of `sigma` pixels and mixed in
// near the objects' outlines (all of it on an outline, none from 2.5 sigma away, smoothly between). The distance to the nearest outline is the processor's chamfer distance
// (1 a step along a row or column, the square root of 2 diagonally), made here by relaxing every pixel against its eight neighbors as many times as the reach needs: the
// same distances wherever they are within the reach, and past it the depth is left as it was either way.
import { program } from './renderer.js';

const EDGE = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uLabels;
out vec4 outColor;
float lab(ivec2 q) { return texelFetch(uLabels, q, 0).r; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uLabels, 0);
  float o = lab(p);
  bool edge = (p.x + 1 < size.x && lab(p + ivec2(1, 0)) != o) || (p.y + 1 < size.y && lab(p + ivec2(0, 1)) != o)
    || (p.x > 0 && lab(p - ivec2(1, 0)) != o) || (p.y > 0 && lab(p - ivec2(0, 1)) != o);
  outColor = vec4(edge ? 0.0 : 1e9, 0.0, 0.0, 1.0);
}`;

const RELAX = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uDist;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uDist, 0);
  float d = texelFetch(uDist, p, 0).r;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) continue;
      ivec2 q = p + ivec2(dx, dy);
      if (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y) continue;
      d = min(d, texelFetch(uDist, q, 0).r + (dx != 0 && dy != 0 ? 1.41421356 : 1.0));
    }
  }
  outColor = vec4(d, 0.0, 0.0, 1.0);
}`;

const BLUR = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uSrc;
uniform ivec2 uDir;
uniform int uR;
uniform float uSigma;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uSrc, 0);
  float acc = 0.0;
  float sum = 0.0;
  for (int i = -uR; i <= uR; i++) {
    float k = exp(-0.5 * float(i * i) / (uSigma * uSigma));
    sum += k;
    acc += k * texelFetch(uSrc, clamp(p + uDir * i, ivec2(0), size - 1), 0).r;
  }
  outColor = vec4(acc / sum, 0.0, 0.0, 1.0);
}`;

const BLEND = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uDepth;
uniform highp sampler2D uBlurred;
uniform highp sampler2D uDist;
uniform float uReach;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float d = texelFetch(uDepth, p, 0).r;
  float t = max(0.0, 1.0 - texelFetch(uDist, p, 0).r / uReach);
  float wt = t * t * (3.0 - 2.0 * t);
  outColor = vec4(d + (texelFetch(uBlurred, p, 0).r - d) * wt, 0.0, 0.0, 1.0);
}`;

// On `gpu` (a GpuRenderer): soften(depth (Float32Array), objects (the labels, w x h), w, h, sigma) -> Float32Array, as softenObjectEdges.
export function softEdgesGpu(gpu) {
  const gl = gpu.gl;
  const progs = {};
  const prog = (name, src) => (progs[name] = progs[name] || program(gl, src));
  return function soften(depth, objects, w, h, sigma) {
    if (!(sigma > 0)) return depth;
    const made = [];
    const tex = (data) => {
      const t = gpu.texture(w, h, gl.R32F);
      made.push(t);
      if (data) {
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.FLOAT, data);
      }
      return t;
    };
    const pass = (name, src, target, set) => {
      const P = prog(name, src);
      gpu.target(target, w, h);
      gl.useProgram(P.p);
      set(P.u);
      gpu.draw();
    };
    try {
      const depthT = tex(depth instanceof Float32Array ? depth : Float32Array.from(depth));
      const labT = tex(Float32Array.from(objects));
      const reach = 2.5 * sigma;
      // the distance to the nearest outline, relaxed until it reaches past `reach`
      let dA = tex();
      let dB = tex();
      pass('edge', EDGE, dA, (u) => {
        gl.uniform1i(u.uLabels, 1);
        gpu.bindTex(1, labT);
      });
      for (let k = 0; k < Math.ceil(reach) + 1; k++) {
        pass('relax', RELAX, dB, (u) => {
          gl.uniform1i(u.uDist, 1);
          gpu.bindTex(1, dA);
        });
        [dA, dB] = [dB, dA];
      }
      // the Gaussian, along rows then columns
      const r = Math.ceil(2.5 * sigma);
      const tmp = tex();
      const blurred = tex();
      for (const [target, from, dir] of [[tmp, depthT, [1, 0]], [blurred, tmp, [0, 1]]]) {
        pass('blur', BLUR, target, (u) => {
          gl.uniform1i(u.uSrc, 1);
          gpu.bindTex(1, from);
          gl.uniform2i(u.uDir, dir[0], dir[1]);
          gl.uniform1i(u.uR, r);
          gl.uniform1f(u.uSigma, sigma);
        });
      }
      const out = tex();
      pass('blend', BLEND, out, (u) => {
        gl.uniform1i(u.uDepth, 1);
        gpu.bindTex(1, depthT);
        gl.uniform1i(u.uBlurred, 2);
        gpu.bindTex(2, blurred);
        gl.uniform1i(u.uDist, 3);
        gpu.bindTex(3, dA);
        gl.uniform1f(u.uReach, reach);
      });
      const res = new Float32Array(w * h);
      const buf = new Float32Array(4 * w * h);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, buf);
      for (let i = 0; i < w * h; i++) res[i] = buf[4 * i];
      return res;
    } finally {
      for (const t of made) gl.deleteTexture(t);
    }
  };
}
