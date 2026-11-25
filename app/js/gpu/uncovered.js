// The map of places a moved viewpoint uncovers (core/viewextend.js uncoveredMask) on the graphics card, with the processor's rules in single precision: from each pixel the
// ray is walked through the depth in equal steps until it meets the surface, refined between steps; the pixel is uncovered where the surface found jumps (an occlusion
// edge), or the point lies outside the picture in the center view or in the edge view.
import { program } from './renderer.js';

const UNCOVERED = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uDepth;   // dw x dh
uniform vec2 uSize;         // w, h
uniform vec2 uT;            // tx, ty
uniform vec2 uE;            // ex, ey
uniform float uRef;
uniform float uT0;
uniform float uT1;
uniform int uN;
out vec4 outColor;
float depthAt(vec2 q) {
  ivec2 ds = textureSize(uDepth, 0);
  vec2 s = vec2(ds) / uSize;
  ivec2 d = clamp(ivec2(floor((q + 0.5) * s)), ivec2(0), ds - 1);
  return texelFetch(uDepth, d, 0).r - uRef;
}
bool outside(vec2 q) { return q.x < -0.5 || q.y < -0.5 || q.x > uSize.x - 0.5 || q.y > uSize.y - 0.5; }
void main() {
  vec2 p = vec2(ivec2(gl_FragCoord.xy));
  float step = (uT1 - uT0) / float(uN);
  float tPrev = uT0;
  float gPrev = depthAt(p - uT0 * uT) - uT0;
  vec2 c = p - uT1 * uT;
  bool jump = false;
  if (gPrev <= 0.0) {
    c = p - uT0 * uT;
  } else {
    for (int i = 1; i <= uN; i++) {
      float ti = uT0 + step * float(i);
      float gi = depthAt(p - ti * uT) - ti;
      if (gi <= 0.0) {
        float t = tPrev + (gPrev / (gPrev - gi)) * (ti - tPrev);
        c = p - t * uT;
        jump = abs(depthAt(c) - t) > 1.5 * abs(step);
        break;
      }
      tPrev = ti;
      gPrev = gi;
    }
  }
  float d = depthAt(c);
  outColor = vec4(jump || outside(c) || outside(c + d * uE) ? 1.0 : 0.0, 0.0, 0.0, 1.0);
}`;

// On `gpu` (a GpuRenderer): ({ w, h, depth, dw, dh, t, e, ref, t0, t1, n }) -> Uint8Array (1 where uncovered).
export function uncoveredGpu(gpu) {
  const gl = gpu.gl;
  let prog = null;
  return function mask({ w, h, depth, dw, dh, t, e, ref, t0, t1, n }) {
    prog = prog || program(gl, UNCOVERED);
    const made = [];
    try {
      const dT = gpu.uploadR32F(null, null, depth, dw, dh);
      made.push(dT);
      const out = gpu.texture(w, h, gl.RGBA8);
      made.push(out);
      gpu.target(out, w, h);
      gl.useProgram(prog.p);
      const u = prog.u;
      gl.uniform1i(u.uDepth, 1);
      gpu.bindTex(1, dT);
      gl.uniform2f(u.uSize, w, h);
      gl.uniform2f(u.uT, t[0], t[1]);
      gl.uniform2f(u.uE, e[0], e[1]);
      gl.uniform1f(u.uRef, ref);
      gl.uniform1f(u.uT0, t0);
      gl.uniform1f(u.uT1, t1);
      gl.uniform1i(u.uN, n);
      gpu.draw();
      gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
      const px = new Uint8Array(4 * w * h);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const res = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) res[i] = px[4 * i] > 127 ? 1 : 0;
      return res;
    } finally {
      for (const tx of made) gl.deleteTexture(tx);
    }
  };
}
