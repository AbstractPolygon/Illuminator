// The picture filters of the Light L16 telephoto detail (core/l16hires.js) on the graphics card, as the processor does them (same rules, single precision): a Gaussian blur of a
// three channel picture, a box blur (twice) of a one channel one, and the per channel minimum and maximum within a square window. Each filter is two passes, along the rows
// and then along the columns; neighbours past the edge are the edge's pixels.
import { program } from './renderer.js';

// One pass along `uDir`: uMode 0 sums the neighbours times the weights (uWeights, 2r + 1 of them), 1 takes the smallest, 2 the largest.
const PASS = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uSrc;
uniform highp sampler2D uWeights;
uniform ivec2 uDir;
uniform int uR;
uniform int uMode;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uSrc, 0);
  vec4 acc = uMode == 1 ? vec4(3.4e38) : uMode == 2 ? vec4(-3.4e38) : vec4(0.0);
  for (int d = -uR; d <= uR; d++) {
    vec4 v = texelFetch(uSrc, clamp(p + d * uDir, ivec2(0), size - 1), 0);
    if (uMode == 0) acc += v * texelFetch(uWeights, ivec2(d + uR, 0), 0).r;
    else if (uMode == 1) acc = min(acc, v);
    else acc = max(acc, v);
  }
  outColor = acc;
}`;

// The filters on `gpu` (a GpuRenderer): { gauss(src, w, h, sigma), boxBlur1(src, w, h, r), localBounds(src, w, h, r) }, each returning what the processor's function does.
export function l16FiltersGpu(gpu) {
  const gl = gpu.gl;
  let prog = null;
  const P = () => (prog = prog || program(gl, PASS));
  // (channels: 3 for an rgb picture, 1 for one value per pixel; kept in RGBA)
  const upload = (src, w, h, channels) => {
    const buf = new Float32Array(4 * w * h);
    if (channels === 3) {
      for (let i = 0; i < w * h; i++) {
        buf[4 * i] = src[3 * i];
        buf[4 * i + 1] = src[3 * i + 1];
        buf[4 * i + 2] = src[3 * i + 2];
      }
    } else {
      for (let i = 0; i < w * h; i++) buf[4 * i] = src[i];
    }
    const t = gpu.texture(w, h, gl.RGBA32F);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, buf);
    return t;
  };
  const read = (tex, w, h, channels) => {
    gpu.target(tex, w, h);
    const buf = new Float32Array(4 * w * h);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, buf);
    const out = new Float32Array(channels * w * h);
    if (channels === 3) {
      for (let i = 0; i < w * h; i++) {
        out[3 * i] = buf[4 * i];
        out[3 * i + 1] = buf[4 * i + 1];
        out[3 * i + 2] = buf[4 * i + 2];
      }
    } else {
      for (let i = 0; i < w * h; i++) out[i] = buf[4 * i];
    }
    return out;
  };
  const weightsTex = (k) => {
    const t = gpu.texture(k.length, 1, gl.R32F);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, k.length, 1, gl.RED, gl.FLOAT, k);
    return t;
  };
  // Runs the passes ([{ dir: [1, 0] or [0, 1], r, mode, weights }]) over `src`, ping-ponging between two textures; returns the last one.
  const run = (made, src, w, h, passes) => {
    const p = P();
    let a = src;
    let spare = null;
    for (const pass of passes) {
      const out = spare || gpu.texture(w, h, gl.RGBA32F);
      if (!spare) made.push(out);
      gpu.target(out, w, h);
      gl.useProgram(p.p);
      gl.uniform1i(p.u.uSrc, 1);
      gpu.bindTex(1, a);
      gl.uniform1i(p.u.uWeights, 2);
      gpu.bindTex(2, pass.weights);
      gl.uniform2i(p.u.uDir, pass.dir[0], pass.dir[1]);
      gl.uniform1i(p.u.uR, pass.r);
      gl.uniform1i(p.u.uMode, pass.mode);
      gpu.draw();
      spare = a === src ? null : a;
      a = out;
    }
    return a;
  };
  const scoped = (fn) => {
    const made = [];
    try {
      return fn(made);
    } finally {
      for (const t of made) gl.deleteTexture(t);
    }
  };
  // (a weight texture no pass reads, for the min and max passes)
  const none = (made) => {
    const t = weightsTex(new Float32Array(1));
    made.push(t);
    return t;
  };
  return {
    gauss(src, w, h, sigma) {
      return scoped((made) => {
        const r = Math.max(1, Math.ceil(sigma * 2.5));
        const k = new Float32Array(2 * r + 1);
        let sum = 0;
        for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
        for (let i = 0; i < k.length; i++) k[i] /= sum;
        const wt = weightsTex(k);
        made.push(wt);
        const s = upload(src, w, h, 3);
        made.push(s);
        const out = run(made, s, w, h, [
          { dir: [1, 0], r, mode: 0, weights: wt },
          { dir: [0, 1], r, mode: 0, weights: wt },
        ]);
        return read(out, w, h, 3);
      });
    },
    boxBlur1(src, w, h, r) {
      return scoped((made) => {
        const wt = weightsTex(new Float32Array(2 * r + 1).fill(1 / (2 * r + 1)));
        made.push(wt);
        const s = upload(src, w, h, 1);
        made.push(s);
        const pass = (dir) => ({ dir, r, mode: 0, weights: wt });
        const out = run(made, s, w, h, [pass([1, 0]), pass([0, 1]), pass([1, 0]), pass([0, 1])]);
        return read(out, w, h, 1);
      });
    },
    localBounds(src, w, h, r) {
      return scoped((made) => {
        const wt = none(made);
        const s = upload(src, w, h, 3);
        made.push(s);
        const bound = (mode) => read(run(made, s, w, h, [{ dir: [1, 0], r, mode, weights: wt }, { dir: [0, 1], r, mode, weights: wt }]), w, h, 3);
        return { min: bound(1), max: bound(2) };
      });
    },
  };
}
