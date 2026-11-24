// The last steps of developing a Light L16 photo (core/l16photo.js) on the graphics card, as the processor does them (single precision): the color matrix
// (applyColorMatrix), and each value times the exposure gain, cut at 1, sRGB encoded and rounded to 8 bits (encodePicture).
import { program } from './renderer.js';

// applyColorMatrix: the camera's color to linear sRGB (uM: the matrix's rows), with highlights taken toward gray and colors below zero moved toward gray.
const MATRIX = `
uniform mat3 uM;
uniform int uHasMatrix;
vec3 colorMatrix(vec3 c) {
  if (uHasMatrix == 0) return c;
  vec3 x = min(c, vec3(1.0));
  vec3 m = vec3(dot(uM[0], x), dot(uM[1], x), dot(uM[2], x));
  float top = max(x.r, max(x.g, x.b));
  float t = clamp((top - 0.5) / 0.4, 0.0, 1.0);
  float k = t * t * (3.0 - 2.0 * t);
  vec3 lum = vec3(0.2126, 0.7152, 0.0722);
  float Y = dot(lum, m);
  vec3 v = m + (Y - m) * k;
  float low = min(v.r, min(v.g, v.b));
  if (low < 0.0) {
    float y2 = dot(lum, v);
    if (y2 > 0.0) v = y2 + (v - y2) * (y2 / (y2 - low));
    else v = vec3(0.0);
  }
  return max(v, vec3(0.0));
}`;

const ENCODE = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uSrc;
uniform float uGain;
${MATRIX}
out vec4 outColor;
float srgb(float v) { return v <= 0.0031308 ? 12.92 * v : 1.055 * pow(v, 1.0 / 2.4) - 0.055; }
void main() {
  vec3 v = min(vec3(1.0), colorMatrix(texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0).rgb) * uGain);
  // (rounded here, so the 8 bit texture stores the value exactly)
  vec3 s = round(255.0 * vec3(srgb(v.r), srgb(v.g), srgb(v.b))) / 255.0;
  outColor = vec4(clamp(s, 0.0, 1.0), 1.0);
}`;

const COLOR = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uSrc;
${MATRIX}
out vec4 outColor;
void main() {
  outColor = vec4(colorMatrix(texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0).rgb), 1.0);
}`;

// On `gpu` (a GpuRenderer): { encode(rgb (3 a pixel), w, h, gain, matrix) -> Uint8ClampedArray RGBA, color(rgb, w, h, matrix) -> Float32Array (3 a pixel) }.
export function l16DevelopGpu(gpu) {
  const gl = gpu.gl;
  let progs = null;
  const run = (which, rgb, w, h, matrix, internal, set, readBack) => {
    progs = progs || { encode: program(gl, ENCODE), color: program(gl, COLOR) };
    const p = progs[which];
    const made = [];
    try {
      const src = gpu.texture(w, h, gl.RGB32F);
      made.push(src);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGB, gl.FLOAT, rgb);
      const out = gpu.texture(w, h, internal);
      made.push(out);
      gpu.target(out, w, h);
      gl.useProgram(p.p);
      gl.uniform1i(p.u.uSrc, 1);
      gpu.bindTex(1, src);
      gl.uniform1i(p.u.uHasMatrix, matrix ? 1 : 0);
      // (row-major, given as the columns: uM[i] is row i)
      if (matrix) gl.uniformMatrix3fv(p.u.uM, false, Array.from(matrix));
      set(p.u);
      gpu.draw();
      return readBack();
    } finally {
      for (const t of made) gl.deleteTexture(t);
    }
  };
  return {
    encode(rgb, w, h, gain, matrix = null) {
      return run('encode', rgb, w, h, matrix, gl.RGBA8, (u) => gl.uniform1f(u.uGain, gain), () => {
        const data = new Uint8ClampedArray(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
        return data;
      });
    },
    color(rgb, w, h, matrix) {
      return run('color', rgb, w, h, matrix, gl.RGBA32F, () => {}, () => {
        const buf = new Float32Array(4 * w * h);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, buf);
        const out = new Float32Array(3 * w * h);
        for (let i = 0; i < w * h; i++) {
          out[3 * i] = buf[4 * i];
          out[3 * i + 1] = buf[4 * i + 1];
          out[3 * i + 2] = buf[4 * i + 2];
        }
        return out;
      });
    },
  };
}
