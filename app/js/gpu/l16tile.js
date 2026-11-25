// Steps of a rendered tile of a processed photo (a Light L16 photo's zoomed-in detail, its Render, its filled-in views) on the graphics card: the glow and flare light
// added as core/bokehfx.js addFxLight does it (the light, made once for the whole picture at half size, bilinear at the tile's place), and the finished picture's
// 8 bit pixels read back.
import { program } from './renderer.js';

const ADD_LIGHT = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uSrc;
uniform sampler2D uLight;   // hw x hh
uniform vec4 uFrame;        // the tile's corner in the whole picture, and the whole's size
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 ls = textureSize(uLight, 0);
  vec2 k = vec2(ls) / uFrame.zw;
  vec2 f = max(vec2(0.0), (vec2(p) + 0.5 + uFrame.xy) * k - 0.5);
  ivec2 i0 = min(ls - 1, ivec2(floor(f)));
  ivec2 i1 = min(ls - 1, i0 + 1);
  vec2 t = min(vec2(1.0), f - vec2(i0));
  vec3 v = (texelFetch(uLight, i0, 0).rgb * (1.0 - t.x) + texelFetch(uLight, ivec2(i1.x, i0.y), 0).rgb * t.x) * (1.0 - t.y)
    + (texelFetch(uLight, ivec2(i0.x, i1.y), 0).rgb * (1.0 - t.x) + texelFetch(uLight, i1, 0).rgb * t.x) * t.y;
  outColor = vec4(texelFetch(uSrc, p, 0).rgb + v, 1.0);
}`;

// On `gpu` (a GpuRenderer): { addLight(tex, w, h, light ({ light, hw, hh }), frame) -> a new texture, pixels(tex, w, h) -> Uint8ClampedArray RGBA (top row first) of an 8
// bit texture the color pass wrote (bottom row first), release() }.
export function l16TileGpu(gpu) {
  const gl = gpu.gl;
  let prog = null;
  let kept = null; // the light on the card: { of, tex }
  return {
    addLight(tex, w, h, light, frame) {
      prog = prog || program(gl, ADD_LIGHT);
      if (!kept || kept.of !== light) {
        if (kept) gl.deleteTexture(kept.tex);
        kept = null;
        const t = gpu.texture(light.hw, light.hh, gl.RGB32F);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, light.hw, light.hh, gl.RGB, gl.FLOAT, light.light);
        kept = { of: light, tex: t };
      }
      const out = gpu.texture(w, h, gl.RGBA32F);
      gpu.target(out, w, h);
      gl.useProgram(prog.p);
      gl.uniform1i(prog.u.uSrc, 1);
      gpu.bindTex(1, tex);
      gl.uniform1i(prog.u.uLight, 2);
      gpu.bindTex(2, kept.tex);
      gl.uniform4f(prog.u.uFrame, frame ? frame.x : 0, frame ? frame.y : 0, frame ? frame.width : 2 * light.hw, frame ? frame.height : 2 * light.hh);
      gpu.draw();
      return out;
    },
    pixels(tex, w, h) {
      gpu.target(tex, w, h);
      gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const out = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) out.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
      for (let i = 3; i < out.length; i += 4) out[i] = 255;
      return out;
    },
    release() {
      if (kept) gl.deleteTexture(kept.tex);
      kept = null;
    },
  };
}
