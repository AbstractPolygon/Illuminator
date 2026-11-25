// The Illuminator method's winners for a Light L16 photo (core/l16depth.js depthFinishIlluminator) on the graphics card: from the cost volume (NZ steps a pixel, one byte each),
// each pixel's step of least cost (the first if two tie), refined between steps by a parabola through its neighbors, as a position 0..1 of the range, and its confidence
// (how much better it is than the best step not next to it). The same integers and rules as the processor's.
import { program } from './renderer.js';

const TW = 4096;

const WINNER = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uCost;   // the cost volume, four bytes a texel, TW texels a row
uniform int uNZ;
uniform int uW;
out vec4 outColor;
float costAt(int e) {
  int t = e >> 2;
  return float(texelFetch(uCost, ivec2(t % ${TW}, t / ${TW}), 0)[e & 3]);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int base = (p.y * uW + p.x) * uNZ;
  int best = 0;
  float bc = 1e30;
  for (int k = 0; k < uNZ; k++) {
    float v = costAt(base + k);
    if (v < bc) {
      bc = v;
      best = k;
    }
  }
  float second = 1e30;
  for (int k = 0; k < uNZ; k++) if ((k < best - 1 || k > best + 1)) second = min(second, costAt(base + k));
  float pos = float(best);
  if (best > 0 && best < uNZ - 1) {
    float a = costAt(base + best - 1);
    float c = costAt(base + best + 1);
    float den = a - 2.0 * bc + c;
    if (den > 0.0) pos += clamp((a - c) / (2.0 * den), -0.5, 0.5);
  }
  float conf = second > 0.0 && second < 1e30 ? clamp(1.0 - bc / second, 0.0, 1.0) : 0.0;
  outColor = vec4(pos / float(uNZ - 1), conf, 0.0, 1.0);
}`;

// On `gpu` (a GpuRenderer): winners(cost (Uint8Array, NZ per pixel), w, h, NZ) -> { pos01, confidence } (Float32Array per pixel).
export function l16WinnerGpu(gpu) {
  const gl = gpu.gl;
  let prog = null;
  return function winners(cost, w, h, NZ) {
    prog = prog || program(gl, WINNER);
    const n = w * h * NZ;
    const rows = Math.ceil(Math.ceil(n / 4) / TW);
    const made = [];
    try {
      const packed = new Uint8Array(4 * TW * rows);
      packed.set(cost.subarray(0, n));
      const costTex = gpu.texture(TW, rows, gl.RGBA8UI);
      made.push(costTex);
      gl.bindTexture(gl.TEXTURE_2D, costTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TW, rows, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, packed);
      const out = gpu.texture(w, h, gl.RGBA32F);
      made.push(out);
      gpu.target(out, w, h);
      gl.useProgram(prog.p);
      gl.uniform1i(prog.u.uCost, 1);
      gpu.bindTex(1, costTex);
      gl.uniform1i(prog.u.uNZ, NZ);
      gl.uniform1i(prog.u.uW, w);
      gpu.draw();
      const buf = new Float32Array(4 * w * h);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, buf);
      const pos01 = new Float32Array(w * h);
      const confidence = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) {
        pos01[i] = buf[4 * i];
        confidence[i] = buf[4 * i + 1];
      }
      return { pos01, confidence };
    } finally {
      for (const t of made) gl.deleteTexture(t);
    }
  };
}
