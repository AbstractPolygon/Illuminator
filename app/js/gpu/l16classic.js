// The matching cost of core/l16classic.js (Classic Depth) on the graphics card: for every measured pixel of a layer and every depth plane of its range, the capped
// difference of the reference's 3 x 3 block from each camera's block where that plane puts it (to the nearest half pixel), summed over the cameras and scaled to 0..255.
// The same rules as the processor's matchCost, in the integers it uses: the first plane of a pixel's range is clamped into the camera's picture, and a later plane that
// falls outside it (or behind the camera) takes the cost of the nearest plane before it that did not. Each output texel is four planes of one pixel.
import { program } from './renderer.js';

const MAX_MODULES = 8;

const COST = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
precision highp usampler2DArray;
uniform usampler2D uRef;         // the reference's filtered picture, W x H (r, g, b: brightness and the two color axes)
uniform usampler2DArray uMods;   // the cameras' filtered pictures, one layer each
uniform highp sampler2D uPlanes; // the planes' depths (mm), n x 1
uniform highp sampler2D uParams; // 4 texels per camera: R0..R3, R4..R7, R8 T0 T1 T2, k0 k2 k4 k5
uniform usampler2D uBlocks;      // per output texel: the pixel, its range's first plane, the block's first plane in the range, the range's length
uniform int uM;
uniform ivec3 uWq[${MAX_MODULES}];
uniform int uBlockCount;
uniform int uW;                  // the layer's width
uniform int uScale;              // half size pixels per layer pixel
uniform vec4 uK;                 // the reference's K0, K2, K4, K5
uniform float uNorm;             // 1 / 27 / cameras
out uvec4 outColor;

const ivec3 CAPS = ivec3(2, 6, 6);
ivec3 refBlock[9];
ivec2 modSize;

uvec3 px(int m, ivec2 q) { return texelFetch(uMods, ivec3(q, m), 0).rgb; }

// the block cost at the camera's half pixel position (ix + hx / 2, iy + hy / 2)
int blockCost(int m, int ix, int iy, int hx, int hy) {
  ivec3 s = ivec3(0);
  for (int r = 0; r < 3; r++) {
    for (int c = 0; c < 3; c++) {
      ivec2 q = ivec2(ix - 1 + c, iy - 1 + r);
      ivec3 t = ivec3(px(m, q));
      if (hy == 1) {
        ivec3 t2 = ivec3(px(m, q + ivec2(0, 1)));
        if (hx == 1) {
          ivec3 a = (t + ivec3(px(m, q + ivec2(1, 0))) + 1) >> 1;
          ivec3 b = (t2 + ivec3(px(m, q + ivec2(1, 1))) + 1) >> 1;
          t = (a + b + 1) >> 1;
        } else t = (t + t2 + 1) >> 1;
      } else if (hx == 1) t = (t + ivec3(px(m, q + ivec2(1, 0))) + 1) >> 1;
      s += min(abs(t - refBlock[3 * r + c]), CAPS);
    }
  }
  ivec3 w = uWq[m];
  return ((s.x * w.x + 16) >> 5) + ((s.y * w.y + 16) >> 5) + ((s.z * w.z + 16) >> 5);
}

// the cost of plane d of the range (from start) for camera m, the processor's rules for the first plane and for planes outside the picture
int planeCost(int m, vec3 a, vec3 T, vec4 k, int start, int d) {
  for (int e = d; e >= 0; e--) {
    float z = texelFetch(uPlanes, ivec2(start + e, 0), 0).r;
    float pz = z * a.z + T.z;
    float u = (k.x * (z * a.x + T.x)) / pz + k.y;
    float v = (k.z * (z * a.y + T.y)) / pz + k.w;
    float fx = u / 2.0 - 0.5 + 0.25;
    float fy = v / 2.0 - 0.5 + 0.25;
    if (e == 0) {
      fx = min(max(fx, 1.0), float(modSize.x - 3));
      fy = min(max(fy, 1.0), float(modSize.y - 3));
    }
    int ix = int(floor(fx));
    int iy = int(floor(fy));
    int hx = int(floor(fx * 2.0)) & 1;
    int hy = int(floor(fy * 2.0)) & 1;
    if (e == 0 || (pz > 0.0 && ix >= 1 && ix < modSize.x - 2 && iy >= 1 && iy < modSize.y - 2)) return blockCost(m, ix, iy, hx, hy);
  }
  return 0;
}

void main() {
  ivec2 o = ivec2(gl_FragCoord.xy);
  int tw = textureSize(uBlocks, 0).x;
  if (o.y * tw + o.x >= uBlockCount) {
    outColor = uvec4(0u);
    return;
  }
  uvec4 b = texelFetch(uBlocks, o, 0);
  int p = int(b.x);
  int start = int(b.y);
  int k0 = int(b.z);
  int count = int(b.w);
  ivec2 size = textureSize(uRef, 0);
  int x = min(uScale * (p % uW) + (uScale >> 1), size.x - 1);
  int y = min(uScale * (p / uW) + (uScale >> 1), size.y - 1);
  for (int r = 0; r < 3; r++) for (int c = 0; c < 3; c++) refBlock[3 * r + c] = ivec3(texelFetch(uRef, clamp(ivec2(x - 1 + c, y - 1 + r), ivec2(0), size - 1), 0).rgb);
  modSize = textureSize(uMods, 0).xy;
  float X0 = ((float(x) + 0.5) * 2.0 - uK.y) / uK.x;
  float Y0 = ((float(y) + 0.5) * 2.0 - uK.w) / uK.z;
  ivec4 sum = ivec4(0);
  for (int m = 0; m < ${MAX_MODULES}; m++) {
    if (m >= uM) break;
    vec4 p0 = texelFetch(uParams, ivec2(0, m), 0);
    vec4 p1 = texelFetch(uParams, ivec2(1, m), 0);
    vec4 p2 = texelFetch(uParams, ivec2(2, m), 0);
    vec4 k = texelFetch(uParams, ivec2(3, m), 0);
    // (the reference pixel's ray in the camera's frame: P(z) = z a + T)
    vec3 a = vec3(p0.x * X0 + p0.y * Y0 + p0.z, p0.w * X0 + p1.x * Y0 + p1.y, p1.z * X0 + p1.w * Y0 + p2.x);
    vec3 T = p2.yzw;
    for (int j = 0; j < 4; j++) if (k0 + j < count) sum[j] += planeCost(m, a, T, k, start, k0 + j);
  }
  uvec4 raw = uvec4(255u);
  for (int j = 0; j < 4; j++) if (k0 + j < count) raw[j] = uint(min(255.0, floor(float(sum[j]) * uNorm)));
  outColor = raw;
}`;

const TW = 2048;

// On `gpu` (a GpuRenderer): open({ ref (Uint8Array, 3 per pixel), W, H, mods: [{ img, iw, ih, R, T, k0, k2, k4, k5, wq }], planes, K }) -> { costs(layer), close() }, where
// costs({ w, scale, start, count, skip, off }) fills and returns raw (Uint8Array of off[w * h]) as core/l16classic.js runLayer lays it out (the planes past a pixel's
// count, 255; a pixel only smoothed into, 0).
export function l16ClassicGpu(gpu) {
  const gl = gpu.gl;
  let prog = null;
  const rgba = (src, n) => {
    const out = new Uint8Array(4 * n);
    for (let i = 0; i < n; i++) {
      out[4 * i] = src[3 * i];
      out[4 * i + 1] = src[3 * i + 1];
      out[4 * i + 2] = src[3 * i + 2];
    }
    return out;
  };
  return {
    open({ ref, W, H, mods, planes, K }) {
      if (mods.length > MAX_MODULES) throw new Error('too many cameras for the graphics card');
      const iw = mods[0].iw;
      const ih = mods[0].ih;
      if (mods.some((m) => m.iw !== iw || m.ih !== ih)) throw new Error('the cameras’ pictures differ in size');
      prog = prog || program(gl, COST);
      const kept = [];
      const refTex = gpu.texture(W, H, gl.RGBA8UI);
      kept.push(refTex);
      gl.bindTexture(gl.TEXTURE_2D, refTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, rgba(ref, W * H));
      const modTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, modTex);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8UI, iw, ih, mods.length);
      for (let m = 0; m < mods.length; m++) gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, m, iw, ih, 1, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, rgba(mods[m].img, iw * ih));
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D_ARRAY, k, v);
      const planeTex = gpu.texture(planes.length, 1, gl.R32F);
      kept.push(planeTex);
      gl.bindTexture(gl.TEXTURE_2D, planeTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, planes.length, 1, gl.RED, gl.FLOAT, Float32Array.from(planes));
      const pd = new Float32Array(16 * mods.length);
      mods.forEach((m, i) => pd.set([...m.R, ...m.T, m.k0, m.k2, m.k4, m.k5], 16 * i));
      const paramTex = gpu.texture(4, mods.length, gl.RGBA32F);
      kept.push(paramTex);
      gl.bindTexture(gl.TEXTURE_2D, paramTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 4, mods.length, gl.RGBA, gl.FLOAT, pd);
      const wq = new Int32Array(3 * MAX_MODULES);
      mods.forEach((m, i) => wq.set(m.wq, 3 * i));
      return {
        costs({ w, scale, start, count, skip, off }) {
          const npx = skip.length;
          const raw = new Uint8Array(off[npx]);
          // the blocks of four planes of every measured pixel
          let B = 0;
          for (let i = 0; i < npx; i++) {
            for (let k = count[i]; k < off[i + 1] - off[i]; k++) raw[off[i] + k] = 255;
            if (!skip[i]) B += Math.ceil(count[i] / 4);
          }
          if (!B) return raw;
          const rows = Math.ceil(B / TW);
          const blocks = new Uint32Array(4 * TW * rows);
          let b = 0;
          for (let i = 0; i < npx; i++) {
            if (skip[i]) continue;
            for (let k = 0; k < count[i]; k += 4, b++) blocks.set([i, start[i], k, count[i]], 4 * b);
          }
          const made = [];
          try {
            const blockTex = gpu.texture(TW, rows, gl.RGBA32UI);
            made.push(blockTex);
            gl.bindTexture(gl.TEXTURE_2D, blockTex);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TW, rows, gl.RGBA_INTEGER, gl.UNSIGNED_INT, blocks);
            const outTex = gpu.texture(TW, rows, gl.RGBA8UI);
            made.push(outTex);
            gpu.target(outTex, TW, rows);
            gl.useProgram(prog.p);
            const u = prog.u;
            gl.uniform1i(u.uRef, 1);
            gpu.bindTex(1, refTex);
            gl.activeTexture(gl.TEXTURE2);
            gl.bindTexture(gl.TEXTURE_2D_ARRAY, modTex);
            gl.uniform1i(u.uMods, 2);
            gl.uniform1i(u.uPlanes, 3);
            gpu.bindTex(3, planeTex);
            gl.uniform1i(u.uParams, 4);
            gpu.bindTex(4, paramTex);
            gl.uniform1i(u.uBlocks, 5);
            gpu.bindTex(5, blockTex);
            gl.uniform1i(u.uM, mods.length);
            gl.uniform3iv(gl.getUniformLocation(prog.p, 'uWq'), wq);
            gl.uniform1i(u.uBlockCount, B);
            gl.uniform1i(u.uW, w);
            gl.uniform1i(u.uScale, scale);
            gl.uniform4f(u.uK, K[0], K[2], K[4], K[5]);
            gl.uniform1f(u.uNorm, 1 / 27 / mods.length);
            gpu.draw();
            const out = new Uint32Array(4 * TW * rows);
            gl.readPixels(0, 0, TW, rows, gl.RGBA_INTEGER, gl.UNSIGNED_INT, out);
            b = 0;
            for (let i = 0; i < npx; i++) {
              if (skip[i]) continue;
              const o = off[i];
              for (let k = 0; k < count[i]; k += 4, b++) for (let j = 0; j < 4 && k + j < count[i]; j++) raw[o + k + j] = out[4 * b + j];
            }
            return raw;
          } finally {
            for (const t of made) gl.deleteTexture(t);
          }
        },
        close() {
          for (const t of kept) gl.deleteTexture(t);
          gl.deleteTexture(modTex);
        },
      };
    },
  };
}
