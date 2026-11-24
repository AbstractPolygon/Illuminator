// The last step of developing a Light L16 photo (core/l16photo.js developL16) on the graphics card: each value times the exposure gain, cut at 1, sRGB encoded and
// rounded to 8 bits, as the processor does it (single precision).
import { program } from './renderer.js';

const ENCODE = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uSrc;
uniform float uGain;
out vec4 outColor;
float srgb(float v) { return v <= 0.0031308 ? 12.92 * v : 1.055 * pow(v, 1.0 / 2.4) - 0.055; }
void main() {
  vec3 v = min(vec3(1.0), texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0).rgb * uGain);
  // (rounded here, so the 8 bit texture stores the value exactly)
  vec3 s = round(255.0 * vec3(srgb(v.r), srgb(v.g), srgb(v.b))) / 255.0;
  outColor = vec4(clamp(s, 0.0, 1.0), 1.0);
}`;

// On `gpu` (a GpuRenderer): (rgb (3 a pixel), w, h, gain) -> Uint8ClampedArray RGBA.
export function l16DevelopGpu(gpu) {
  const gl = gpu.gl;
  let prog = null;
  return function encode(rgb, w, h, gain) {
    prog = prog || program(gl, ENCODE);
    const made = [];
    try {
      const src = gpu.texture(w, h, gl.RGB32F);
      made.push(src);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGB, gl.FLOAT, rgb);
      const out = gpu.texture(w, h, gl.RGBA8);
      made.push(out);
      gpu.target(out, w, h);
      gl.useProgram(prog.p);
      gl.uniform1i(prog.u.uSrc, 1);
      gpu.bindTex(1, src);
      gl.uniform1f(prog.u.uGain, gain);
      gpu.draw();
      const data = new Uint8ClampedArray(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
      return data;
    } finally {
      for (const t of made) gl.deleteTexture(t);
    }
  };
}
