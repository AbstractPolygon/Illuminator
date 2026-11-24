// The search of core/l16hires.js estimateCorrections on the graphics card: for every patch of the wide picture and every shift tried, the normalized correlation of the patch's
// samples with the camera's picture (brightness, the half size picture or the part of it made) looked up where they land plus the shift. Same rules as the processor's nccAt:
// samples that land outside the picture are left out, -2 where fewer than 90% are in or the camera's samples are flat.
import { program } from './renderer.js';

const NCC = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uLum;     // the camera's brightness, pw x ph
uniform highp sampler2D uPatch;   // k x P: (sensor x, sensor y, the wide sample minus its patch's mean)
uniform highp sampler2D uBase;    // P x 1: (the patch's shift: x, y; the wide samples' variance)
uniform highp sampler2D uOffs;    // S x 1: the shifts tried, added to the patch's
uniform int uK;
uniform vec2 uOrigin;             // where the part made starts in the half size picture
out vec4 outColor;
void main() {
  int s = int(gl_FragCoord.x);
  int p = int(gl_FragCoord.y);
  ivec2 size = textureSize(uLum, 0);
  vec2 lim = vec2(size) - 1.0;
  vec4 base = texelFetch(uBase, ivec2(p, 0), 0);
  vec2 d = base.xy + texelFetch(uOffs, ivec2(s, 0), 0).xy;
  // (sums about the first sample in, so the variance keeps its precision)
  float ref = 0.0;
  bool first = true;
  float sb = 0.0;
  float sbb = 0.0;
  float sab = 0.0;
  float m = 0.0;
  for (int i = 0; i < uK; i++) {
    vec4 q = texelFetch(uPatch, ivec2(i, p), 0);
    vec2 xy = (q.xy + d) / 2.0 - 0.5 - uOrigin;
    if (xy.x < 0.0 || xy.y < 0.0 || xy.x >= lim.x || xy.y >= lim.y) continue;
    ivec2 i0 = ivec2(xy);
    vec2 f = xy - vec2(i0);
    float v = (texelFetch(uLum, i0, 0).r * (1.0 - f.x) + texelFetch(uLum, i0 + ivec2(1, 0), 0).r * f.x) * (1.0 - f.y)
      + (texelFetch(uLum, i0 + ivec2(0, 1), 0).r * (1.0 - f.x) + texelFetch(uLum, i0 + ivec2(1, 1), 0).r * f.x) * f.y;
    if (first) {
      ref = v;
      first = false;
    }
    float c = v - ref;
    sb += c;
    sbb += c * c;
    sab += q.z * v;
    m += 1.0;
  }
  float r = -2.0;
  if (m > float(uK) * 0.9) {
    float vb = sbb - sb * sb / m;
    if (vb > 1e-12) r = sab / sqrt(base.z * vb);
  }
  outColor = vec4(r, 0.0, 0.0, 1.0);
}`;

// On `gpu` (a GpuRenderer): a function (cam, patches, shifts) -> Float32Array of P x S correlations (patch-major), where cam is { lum, pw, ph, pox, poy } and each patch
// { k, sx, sy, a (the samples minus their mean), va, bx, by (the shift the tried ones are added to) }, shifts [dx0, dy0, dx1, dy1, ...].
// `open(cam)` uploads the camera's picture once for several searches: { search(patches, shifts), close() }.
export function l16NccGpu(gpu) {
  const gl = gpu.gl;
  let prog = null;
  const tex = (made, w, h, internal, format, data) => {
    const t = gpu.texture(w, h, internal);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, format, gl.FLOAT, data);
    made.push(t);
    return t;
  };
  return {
    open({ lum, pw, ph, pox, poy }) {
      const kept = [];
      const lumTex = tex(kept, pw, ph, gl.R32F, gl.RED, lum);
      return {
        search(patches, shifts) {
          const P = patches.length;
          const S = shifts.length / 2;
          if (!P || !S) return new Float32Array(0);
          const k = patches[0].k;
          const made = [];
          try {
            prog = prog || program(gl, NCC);
            const pd = new Float32Array(4 * k * P);
            const bd = new Float32Array(4 * P);
            patches.forEach((q, p) => {
              for (let i = 0; i < k; i++) {
                pd[4 * (p * k + i)] = q.sx[i];
                pd[4 * (p * k + i) + 1] = q.sy[i];
                pd[4 * (p * k + i) + 2] = q.a[i];
              }
              bd[4 * p] = q.bx;
              bd[4 * p + 1] = q.by;
              bd[4 * p + 2] = q.va;
            });
            const od = new Float32Array(4 * S);
            for (let s = 0; s < S; s++) {
              od[4 * s] = shifts[2 * s];
              od[4 * s + 1] = shifts[2 * s + 1];
            }
            const patchTex = tex(made, k, P, gl.RGBA32F, gl.RGBA, pd);
            const baseTex = tex(made, P, 1, gl.RGBA32F, gl.RGBA, bd);
            const offsTex = tex(made, S, 1, gl.RGBA32F, gl.RGBA, od);
            const outTex = gpu.texture(S, P, gl.RGBA32F);
            made.push(outTex);
            gpu.target(outTex, S, P);
            gl.useProgram(prog.p);
            const u = prog.u;
            gl.uniform1i(u.uLum, 1);
            gpu.bindTex(1, lumTex);
            gl.uniform1i(u.uPatch, 2);
            gpu.bindTex(2, patchTex);
            gl.uniform1i(u.uBase, 3);
            gpu.bindTex(3, baseTex);
            gl.uniform1i(u.uOffs, 4);
            gpu.bindTex(4, offsTex);
            gl.uniform1i(u.uK, k);
            gl.uniform2f(u.uOrigin, pox, poy);
            gpu.draw();
            const buf = new Float32Array(4 * S * P);
            gl.readPixels(0, 0, S, P, gl.RGBA, gl.FLOAT, buf);
            const out = new Float32Array(S * P);
            for (let i = 0; i < S * P; i++) out[i] = buf[4 * i];
            return out;
          } finally {
            for (const t of made) gl.deleteTexture(t);
          }
        },
        close() {
          for (const t of kept) gl.deleteTexture(t);
        },
      };
    },
  };
}
