// The microlens grid's fit (core/lenslet.js calibrateGrid) on the graphics card: the contrast score of every candidate grid of a search at once, one candidate a pixel,
// each over all its sample lenses. The card's scores are single precision; core/lenslet.js takes the best few again on the processor, so the grid chosen is the
// processor's.
import { program } from './renderer.js';

const SAMPLE_W = 1024;

const SCORE = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
precision highp isampler2D;
uniform usampler2D uRaw;
uniform isampler2D uSamples;  // (row, column) of each sample lens, ${SAMPLE_W} a row
uniform sampler2D uCands;     // two texels a candidate: (pitch, rowStep, rotation, 0), (ox, oy, 0, 0)
uniform int uCount;           // samples
uniform int uCandW;           // candidates a row
out vec4 outColor;
float raw(int x, int y) { return float(texelFetch(uRaw, ivec2(x, y), 0).r); }
float lum(vec2 q, ivec2 size) {
  vec2 f = q - 0.5;
  ivec2 i = ivec2(floor(f));
  if (i.x < 0 || i.y < 0 || i.x + 3 >= size.x || i.y + 3 >= size.y) return 0.0;
  vec2 a = f - vec2(i);
  float r00 = raw(i.x, i.y), r10 = raw(i.x + 1, i.y), r20 = raw(i.x + 2, i.y);
  float r01 = raw(i.x, i.y + 1), r11 = raw(i.x + 1, i.y + 1), r21 = raw(i.x + 2, i.y + 1);
  float r02 = raw(i.x, i.y + 2), r12 = raw(i.x + 1, i.y + 2), r22 = raw(i.x + 2, i.y + 2);
  float b00 = r00 + r10 + r01 + r11;
  float b10 = r10 + r20 + r11 + r21;
  float b01 = r01 + r11 + r02 + r12;
  float b11 = r11 + r21 + r12 + r22;
  return (b00 * (1.0 - a.x) + b10 * a.x) * (1.0 - a.y) + (b01 * (1.0 - a.x) + b11 * a.x) * a.y;
}
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  int k = f.y * uCandW + f.x;
  vec4 g0 = texelFetch(uCands, ivec2(2 * f.x, f.y), 0);
  vec4 g1 = texelFetch(uCands, ivec2(2 * f.x + 1, f.y), 0);
  ivec2 size = textureSize(uRaw, 0);
  float pitch = g0.x;
  float rowStep = g0.y;
  float co = cos(g0.z);
  float si = sin(g0.z);
  float j = pitch / sqrt(3.0) * (rowStep / (pitch * 0.8660254037844386));
  vec2 J = vec2(-si * j, co * j);
  float s = 0.0;
  for (int n = 0; n < uCount; n++) {
    ivec2 rc = texelFetch(uSamples, ivec2(n % ${SAMPLE_W}, n / ${SAMPLE_W}), 0).xy;
    float lx = float(rc.y) * pitch + float(rc.x & 1) * pitch * 0.5;
    float ly = float(rc.x) * rowStep;
    vec2 p = vec2(g1.x + co * lx - si * ly, g1.y + si * lx + co * ly);
    s += 2.0 * lum(p, size) - lum(p + J, size) - lum(p - J, size);
  }
  outColor = vec4(s, 0.0, 0.0, 1.0);
}`;

// On `gpu` (a GpuRenderer): for the sensor picture raw (width x height): { scores(cands ([{ pitch, rowStep, rotation, ox, oy }]), samples (Int32Array of row, column))
// -> Float32Array, release() }.
export function lensletGpu(gpu, raw, width, height) {
  const gl = gpu.gl;
  const P = (gpu.lensletProgram ||= program(gl, SCORE));
  const rawT = gpu.texture(width, height, gl.R16UI, gl.NEAREST);
  gl.bindTexture(gl.TEXTURE_2D, rawT);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED_INTEGER, gl.UNSIGNED_SHORT, raw instanceof Uint16Array ? raw : Uint16Array.from(raw));
  // (the sample lists by identity: the same list is sent once)
  let sampleOf = null;
  let sampleT = null;
  return {
    scores(cands, samples) {
      const made = [];
      try {
        if (sampleOf !== samples) {
          if (sampleT) gl.deleteTexture(sampleT);
          const n = samples.length / 2;
          const rows = Math.max(1, Math.ceil(n / SAMPLE_W));
          const data = new Int32Array(2 * SAMPLE_W * rows);
          data.set(samples);
          sampleT = gpu.texture(SAMPLE_W, rows, gl.RG32I, gl.NEAREST);
          gl.bindTexture(gl.TEXTURE_2D, sampleT);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SAMPLE_W, rows, gl.RG_INTEGER, gl.INT, data);
          sampleOf = samples;
        }
        const N = cands.length;
        const cw = Math.min(N, 512);
        const ch = Math.ceil(N / cw);
        const cd = new Float32Array(8 * cw * ch);
        cands.forEach((g, k) => cd.set([g.pitch, g.rowStep, g.rotation, 0, g.ox, g.oy, 0, 0], 8 * k));
        const candT = gpu.texture(2 * cw, ch, gl.RGBA32F, gl.NEAREST);
        made.push(candT);
        gl.bindTexture(gl.TEXTURE_2D, candT);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 2 * cw, ch, gl.RGBA, gl.FLOAT, cd);
        const out = gpu.texture(cw, ch, gl.RGBA32F, gl.NEAREST);
        made.push(out);
        gpu.target(out, cw, ch);
        gl.useProgram(P.p);
        gl.uniform1i(P.u.uRaw, 1);
        gpu.bindTex(1, rawT);
        gl.uniform1i(P.u.uSamples, 2);
        gpu.bindTex(2, sampleT);
        gl.uniform1i(P.u.uCands, 3);
        gpu.bindTex(3, candT);
        gl.uniform1i(P.u.uCount, samples.length / 2);
        gl.uniform1i(P.u.uCandW, cw);
        gpu.draw();
        const buf = new Float32Array(4 * cw * ch);
        gl.readPixels(0, 0, cw, ch, gl.RGBA, gl.FLOAT, buf);
        const res = new Float32Array(N);
        for (let k = 0; k < N; k++) res[k] = buf[4 * k];
        return res;
      } finally {
        for (const t of made) gl.deleteTexture(t);
      }
    },
    release() {
      gl.deleteTexture(rawT);
      if (sampleT) gl.deleteTexture(sampleT);
      sampleT = null;
    },
  };
}
