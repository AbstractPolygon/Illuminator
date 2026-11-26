// A processed photo's picture for a focus or a viewpoint (core/processed.js ProcessedPicture.base) on the graphics card: the saved pictures kept there, and the two of a
// focus stack either side of the focus, or the three viewpoints nearest, mixed by the same weights as the processor's.
import { program } from './renderer.js';

const MIX = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uA;
uniform highp sampler2D uB;
uniform highp sampler2D uC;
uniform vec3 uW;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 c = texelFetch(uA, p, 0).rgb * uW.x + texelFetch(uB, p, 0).rgb * uW.y + texelFetch(uC, p, 0).rgb * uW.z;
  outColor = vec4(c, 1.0);
}`;

// On `gpu` (a GpuRenderer): { base(pp, u, v, lambda) -> texture or null (the picture needs the processor: one picture moved by the depth), release() }.
export function blendViewsGpu(gpu) {
  const gl = gpu.gl;
  let prog = null;
  let kept = new Map();
  let keptFor = null;
  const texOf = (pp, img) => {
    if (keptFor !== pp) {
      for (const t of kept.values()) gl.deleteTexture(t);
      kept = new Map();
      keptFor = pp;
    }
    let t = kept.get(img);
    if (!t) {
      t = gpu.holdCopy(gpu.uploadRGB(pp.linear(img), pp.width, pp.height, { full: true }), pp.width, pp.height);
      kept.set(img, t);
    }
    return t;
  };
  const mix = (pp, parts) => {
    prog = prog || program(gl, MIX);
    const { width: w, height: h } = pp;
    // (the pictures on the card first: sending one there uses the card's own passes)
    const texs = [0, 1, 2].map((k) => texOf(pp, (parts[k] || parts[0]).img));
    const out = gpu.scratch(w, h, 'blendViews', gl.RGBA32F);
    gpu.target(out, w, h);
    gl.useProgram(prog.p);
    const units = [1, 2, 3];
    ['uA', 'uB', 'uC'].forEach((name, k) => {
      gl.uniform1i(prog.u[name], units[k]);
      gpu.bindTex(units[k], texs[k]);
    });
    gl.uniform3f(prog.u.uW, parts[0].w, parts[1] ? parts[1].w : 0, parts[2] ? parts[2].w : 0);
    gpu.draw();
    return out;
  };
  return {
    base(pp, u, v, lambda) {
      const { images } = pp;
      if (pp.kind === 'focus' && images.length > 1) {
        let k = 0;
        while (k < images.length - 2 && (images[k + 1].lambda ?? 0) < lambda) k++;
        const a = images[k];
        const b = images[k + 1];
        const span = (b.lambda ?? 0) - (a.lambda ?? 0);
        const t = Math.max(0, Math.min(1, span ? (lambda - (a.lambda ?? 0)) / span : 0));
        return mix(pp, [{ img: a, w: 1 - t }, { img: b, w: t }]);
      }
      if (pp.kind === 'perspective' && images.length > 1) {
        const near = images
          .map((img) => ({ img, d: Math.hypot(img.u - u, img.v - v) }))
          .sort((p, q) => p.d - q.d)
          .slice(0, 3);
        if (near[0].d < 1e-6) return texOf(pp, near[0].img);
        const ws = near.map((p) => 1 / (p.d * p.d));
        const total = ws.reduce((s, x) => s + x, 0);
        return mix(pp, near.map((p, j) => ({ img: p.img, w: ws[j] / total })));
      }
      return null;
    },
    release() {
      for (const t of kept.values()) gl.deleteTexture(t);
      kept = new Map();
      keptFor = null;
    },
  };
}
