// The matching cost of core/l16classic.js (Classic Depth) on the graphics card: for every measured pixel of a layer and every depth plane of its range, the capped
// difference of the reference's 3 x 3 block from each camera's block where that plane puts it (to the nearest half pixel), summed over the cameras and scaled to 0..255.
// The same rules as the processor's matchCost, in the integers it uses: the first plane of a pixel's range is clamped into the camera's picture, and a later plane that
// falls outside it (or behind the camera) takes the cost of the nearest plane before it that did not. Each output texel is four planes of one pixel.
import { program } from './renderer.js';

const MAX_MODULES = 8;

const TW = 2048;
const TWE = 4096;   // the list's entries a row, as gpu/l16classicsgm.js reads them

const COST_SHARED = `#version 300 es
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

// the costs of planes k0 .. k0 + 3 of pixel p's range (from start; past count: 255)
uvec4 costsOf(int p, int start, int k0, int count) {
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
  return raw;
}
`;
const COST = COST_SHARED + `
void main() {
  ivec2 o = ivec2(gl_FragCoord.xy);
  int tw = textureSize(uBlocks, 0).x;
  if (o.y * tw + o.x >= uBlockCount) {
    outColor = uvec4(0u);
    return;
  }
  uvec4 b = texelFetch(uBlocks, o, 0);
  outColor = costsOf(int(b.x), int(b.y), int(b.z), int(b.w));
}`;
const COST_ENTRIES = COST_SHARED + `
uniform usampler2D uInfo;     // per pixel (w x h): its range's first plane, its count, measured (0) or only smoothed into (1)
uniform usampler2D uOffs;     // where each pixel's run starts in the list (cap planes, a multiple of 8), PW a row
uniform int uNpx;
uniform uint uCount;
uint offAt(int i) { return texelFetch(uOffs, ivec2(i % 2048, i / 2048), 0).r; }
void main() {
  // (four entries a texel: a pixel's run starts at a multiple of 8, so the four are always the same pixel's)
  uint e = 4u * uint(int(gl_FragCoord.y) * ${TWE} / 4 + int(gl_FragCoord.x));
  if (e >= uCount) {
    outColor = uvec4(0u);
    return;
  }
  int lo = 0;
  int hi = uNpx;
  while (hi - lo > 1) {
    int mid = (lo + hi) >> 1;
    if (offAt(mid) <= e) lo = mid;
    else hi = mid;
  }
  int k = int(e - offAt(lo));
  uvec4 inf = texelFetch(uInfo, ivec2(lo % uW, lo / uW), 0);
  int count = int(inf.y);
  if (inf.z == 1u || k >= count) {
    // (a pixel only smoothed into: 0 for its planes; past a pixel's planes: 255)
    uvec4 v = uvec4(255u);
    for (int j = 0; j < 4; j++) if (k + j < count) v[j] = 0u;
    outColor = v;
  } else outColor = costsOf(lo, int(inf.x), k, count);
}`;

// The pictures, as core/l16classic.js viewPicture makes them: a camera's half size picture (linear RGB, RGBA32F) through its lens's distortion into its pinhole view,
// then its brightness and two color axes, gamma encoded (255 at white, the color axes signed); alpha 1 inside the camera's frame, 0 outside (where the rest is 0).
const VIEW = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uRGB;
uniform float uDist[9];   // k1, k2, k3, p1, p2, nx, ny, cx, cy
uniform int uMono;
uniform vec3 uLuma;
uniform vec3 uAxisU;
uniform vec3 uAxisV;
out vec4 outColor;
float gam(float v) { return v < 0.0 ? -255.0 * pow(-v, 1.0 / 2.2) : 255.0 * pow(v, 1.0 / 2.2); }
void main() {
  ivec2 size = textureSize(uRGB, 0);
  vec2 X = (floor(gl_FragCoord.xy) + 0.5) * 2.0;
  float u = (X.x - uDist[7]) / uDist[5];
  float v = (X.y - uDist[8]) / uDist[6];
  float rr = u * u + v * v;
  float uv2 = 2.0 * u * v;
  float k = 1.0 + ((uDist[2] * rr + uDist[1]) * rr + uDist[0]) * rr;
  float sx = uDist[7] + uDist[5] * (uDist[3] * uv2 + uDist[4] * (rr + 2.0 * u * u) + k * u);
  float sy = uDist[8] + uDist[6] * (uDist[4] * uv2 + uDist[3] * (rr + 2.0 * v * v) + k * v);
  float bx = sx / 2.0 - 0.5;
  float by = sy / 2.0 - 0.5;
  if (!(bx >= 0.0 && by >= 0.0 && bx < float(size.x - 1) && by < float(size.y - 1))) {
    outColor = vec4(0.0);
    return;
  }
  ivec2 i0 = ivec2(bx, by);
  vec2 f = vec2(bx, by) - vec2(i0);
  vec3 c = (texelFetch(uRGB, i0, 0).rgb * (1.0 - f.x) + texelFetch(uRGB, i0 + ivec2(1, 0), 0).rgb * f.x) * (1.0 - f.y)
    + (texelFetch(uRGB, i0 + ivec2(0, 1), 0).rgb * (1.0 - f.x) + texelFetch(uRGB, i0 + ivec2(1, 1), 0).rgb * f.x) * f.y;
  if (uMono == 1) outColor = vec4(gam((c.r + c.g + c.b) / 3.0), 0.0, 0.0, 1.0);
  else outColor = vec4(gam(dot(uLuma, c)), gam(dot(uAxisU, c)), gam(dot(uAxisV, c)), 1.0);
}`;

// The sums for a picture's mean and covariance: each 16 x 16 block of the picture (uKind 0: y, u, v, inside; 1: yy, uu, vv; 2: yu, yv, uv; outside the frame nothing),
// then the same sums of 16 x 16 blocks of sums (uKind 3), until the processor adds up what is left.
const SUMS = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uSrc;
uniform int uKind;
out vec4 outColor;
void main() {
  ivec2 size = textureSize(uSrc, 0);
  ivec2 o = ivec2(gl_FragCoord.xy) * 16;
  vec4 s = vec4(0.0);
  for (int y = 0; y < 16; y++) {
    for (int x = 0; x < 16; x++) {
      ivec2 q = o + ivec2(x, y);
      if (q.x >= size.x || q.y >= size.y) continue;
      vec4 c = texelFetch(uSrc, q, 0);
      if (uKind == 3) s += c;
      else if (c.a > 0.5) s += uKind == 0 ? c : uKind == 1 ? vec4(c.rgb * c.rgb, 0.0) : vec4(c.r * c.g, c.r * c.b, c.g * c.b, 0.0);
    }
  }
  outColor = s;
}`;

// The colors matched to the reference's (core/l16classic.js matchColors: x -> A (x - mean) + the reference's mean), in 8 bits (the color axes about 128, the monochrome
// camera's brightness in all three; outside the frame 0), then the 3 x 3 box over the part of it inside the picture, rounded.
const FILTER = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uView;
uniform mat3 uA;
uniform vec3 uFrom;
uniform vec3 uTo;
uniform int uMono;
out uvec4 outColor;
float rnd(float v) { return floor(v + 0.5); }
vec3 bytes(ivec2 q) {
  vec4 c = texelFetch(uView, q, 0);
  if (c.a < 0.5) return vec3(0.0);
  vec3 y = uA * (c.rgb - uFrom) + uTo;
  float b = clamp(rnd(y.x), 0.0, 255.0);
  if (uMono == 1) return vec3(b);
  return vec3(b, clamp(rnd(y.y + 128.0), 0.0, 255.0), clamp(rnd(y.z + 128.0), 0.0, 255.0));
}
void main() {
  ivec2 size = textureSize(uView, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 s = vec3(0.0);
  float n = 0.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      ivec2 q = p + ivec2(dx, dy);
      if (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y) continue;
      s += bytes(q);
      n += 1.0;
    }
  }
  outColor = uvec4(uvec3(floor(s / n + 0.5)), 0u);
}`;


// On `gpu` (a GpuRenderer):
//   open({ ref, W, H, mods, planes, K }): the pictures made on the processor (ref and mods[i].img: Uint8Array, 3 per pixel) -> session
//   views(pics): pics = [{ rgb (Float32Array, 3 per pixel), w, h, dist (the distortion's params), mono }], the reference first -> { stats, filter(transforms) }, where
//     stats[i] = { sums: [y, u, v, n, yy, uu, vv, yu, yv, uv] } over the picture's frame, and filter([{ A (9), from (3), to (3) }] per picture) -> { ref (Uint8Array, 3 per
//     pixel, for the smoothing's guide), open({ mods, planes, K }) -> session }
//   session: { costs({ w, scale, start, count, skip, off }) -> raw, close() }: raw (Uint8Array of off[w * h]) as core/l16classic.js runLayer lays it out (the planes past a
//     pixel's count, 255; a pixel only smoothed into, 0).
export function l16ClassicGpu(gpu) {
  const gl = gpu.gl;
  const progs = {};
  const prog = (name, src) => (progs[name] = progs[name] || program(gl, src));
  const rgba = (src, n) => {
    const out = new Uint8Array(4 * n);
    for (let i = 0; i < n; i++) {
      out[4 * i] = src[3 * i];
      out[4 * i + 1] = src[3 * i + 1];
      out[4 * i + 2] = src[3 * i + 2];
    }
    return out;
  };
  const arrayTex = (iw, ih, layers) => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8UI, iw, ih, layers);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D_ARRAY, k, v);
    return t;
  };
  // the cost session on the pictures on the card
  const session = (refTex, modTex, owned, { mods, planes, K }) => {
    const P = prog('cost', COST);
    const kept = [...owned];
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
          gl.useProgram(P.p);
          const u = P.u;
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
          gl.uniform3iv(gl.getUniformLocation(P.p, 'uWq'), wq);
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
      // The costs left on the card in the list's order, for the smoothing (gpu/l16classicsgm.js): { tex (RGBA8UI: four entries a texel, TWE entries a row), release() }.
      costsTex({ w, scale, start, count, skip, off }) {
        const npx = skip.length;
        const E = off[npx];
        const rows = Math.max(1, Math.ceil(E / TWE));
        const prow = Math.max(1, Math.ceil(npx / 2048));
        const made = [];
        try {
          const P2 = prog('costEntries', COST_ENTRIES);
          const info = new Uint32Array(4 * npx);
          for (let i = 0; i < npx; i++) info.set([start[i], count[i], skip[i] ? 1 : 0, 0], 4 * i);
          const infoTex = gpu.texture(w, npx / w, gl.RGBA32UI);
          made.push(infoTex);
          gl.bindTexture(gl.TEXTURE_2D, infoTex);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, npx / w, gl.RGBA_INTEGER, gl.UNSIGNED_INT, info);
          const offs = new Uint32Array(2048 * prow);
          offs.set(off.subarray(0, npx));
          const offTex = gpu.texture(2048, prow, gl.R32UI);
          made.push(offTex);
          gl.bindTexture(gl.TEXTURE_2D, offTex);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 2048, prow, gl.RED_INTEGER, gl.UNSIGNED_INT, offs);
          const out = gpu.texture(TWE / 4, rows, gl.RGBA8UI);
          gpu.target(out, TWE / 4, rows);
          gl.useProgram(P2.p);
          const u = P2.u;
          gl.uniform1i(u.uRef, 1);
          gpu.bindTex(1, refTex);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D_ARRAY, modTex);
          gl.uniform1i(u.uMods, 2);
          gl.uniform1i(u.uPlanes, 3);
          gpu.bindTex(3, planeTex);
          gl.uniform1i(u.uParams, 4);
          gpu.bindTex(4, paramTex);
          gl.uniform1i(u.uInfo, 5);
          gpu.bindTex(5, infoTex);
          gl.uniform1i(u.uOffs, 6);
          gpu.bindTex(6, offTex);
          gl.uniform1i(u.uM, mods.length);
          gl.uniform3iv(gl.getUniformLocation(P2.p, 'uWq'), wq);
          gl.uniform1i(u.uW, w);
          gl.uniform1i(u.uScale, scale);
          gl.uniform1i(u.uNpx, npx);
          gl.uniform1ui(u.uCount, E);
          gl.uniform4f(u.uK, K[0], K[2], K[4], K[5]);
          gl.uniform1f(u.uNorm, 1 / 27 / mods.length);
          gpu.draw();
          return { tex: out, release: () => gl.deleteTexture(out) };
        } finally {
          for (const t of made) gl.deleteTexture(t);
        }
      },
      close() {
        for (const t of kept) gl.deleteTexture(t);
        gl.deleteTexture(modTex);
      },
    };
  };
  // the sums of a picture (RGBA32F, w x h) of the kind asked, to the processor
  const sumsOf = (src, w, h, kind) => {
    const P = prog('sums', SUMS);
    const made = [];
    try {
      let cur = src;
      let cw = w;
      let ch = h;
      let k = kind;
      while (cw > 64 || ch > 64 || k !== 3) {
        const nw = Math.ceil(cw / 16);
        const nh = Math.ceil(ch / 16);
        const t = gpu.texture(nw, nh, gl.RGBA32F);
        made.push(t);
        gpu.target(t, nw, nh);
        gl.useProgram(P.p);
        gl.uniform1i(P.u.uSrc, 1);
        gpu.bindTex(1, cur);
        gl.uniform1i(P.u.uKind, k);
        gpu.draw();
        cur = t;
        cw = nw;
        ch = nh;
        k = 3;
      }
      const buf = new Float32Array(4 * cw * ch);
      gl.readPixels(0, 0, cw, ch, gl.RGBA, gl.FLOAT, buf);
      const s = [0, 0, 0, 0];
      for (let i = 0; i < cw * ch; i++) for (let c = 0; c < 4; c++) s[c] += buf[4 * i + c];
      return s;
    } finally {
      for (const t of made) gl.deleteTexture(t);
    }
  };
  return {
    open({ ref, W, H, mods, planes, K }) {
      if (mods.length > MAX_MODULES) throw new Error('too many cameras for the graphics card');
      const iw = mods[0].iw;
      const ih = mods[0].ih;
      if (mods.some((m) => m.iw !== iw || m.ih !== ih)) throw new Error('the cameras’ pictures differ in size');
      const refTex = gpu.texture(W, H, gl.RGBA8UI);
      gl.bindTexture(gl.TEXTURE_2D, refTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, rgba(ref, W * H));
      const modTex = arrayTex(iw, ih, mods.length);
      for (let m = 0; m < mods.length; m++) gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, m, iw, ih, 1, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, rgba(mods[m].img, iw * ih));
      return session(refTex, modTex, [refTex], { mods, planes, K });
    },
    views(pics) {
      if (pics.length - 1 > MAX_MODULES) throw new Error('too many cameras for the graphics card');
      const { w: iw, h: ih } = pics[0];
      if (pics.some((p) => p.w !== iw || p.h !== ih)) throw new Error('the cameras’ pictures differ in size');
      const views = [];
      try {
        const P = prog('view', VIEW);
        for (const pic of pics) {
          if (!pic.dist) throw new Error('a camera without the polynomial distortion');
          // (a picture already on the card, core/l16fusion.js halfSize with `keep`, is used there; else sent)
          let src = pic.tex || null;
          if (!src) {
            src = gpu.texture(iw, ih, gl.RGBA32F);
            const data = new Float32Array(4 * iw * ih);
            for (let i = 0; i < iw * ih; i++) {
              data[4 * i] = pic.rgb[3 * i];
              data[4 * i + 1] = pic.rgb[3 * i + 1];
              data[4 * i + 2] = pic.rgb[3 * i + 2];
            }
            gl.bindTexture(gl.TEXTURE_2D, src);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, iw, ih, gl.RGBA, gl.FLOAT, data);
          }
          const view = gpu.texture(iw, ih, gl.RGBA32F);
          views.push(view);
          gpu.target(view, iw, ih);
          gl.useProgram(P.p);
          gl.uniform1i(P.u.uRGB, 1);
          gpu.bindTex(1, src);
          const d = pic.dist;
          gl.uniform1fv(gl.getUniformLocation(P.p, 'uDist'), [d.k1, d.k2, d.k3, d.p1, d.p2, d.nx, d.ny, d.cx, d.cy]);
          gl.uniform1i(P.u.uMono, pic.mono ? 1 : 0);
          gl.uniform3fv(P.u.uLuma, pic.luma);
          gl.uniform3fv(P.u.uAxisU, pic.axisU);
          gl.uniform3fv(P.u.uAxisV, pic.axisV);
          gpu.draw();
          gl.deleteTexture(src);
          pic.tex = null;
        }
        const stats = views.map((v) => ({ sums: [...sumsOf(v, iw, ih, 0), ...sumsOf(v, iw, ih, 1).slice(0, 3), ...sumsOf(v, iw, ih, 2).slice(0, 3)] }));
        return {
          stats,
          filter(transforms) {
            const F = prog('filter', FILTER);
            const refTex = gpu.texture(iw, ih, gl.RGBA8UI);
            const modTex = arrayTex(iw, ih, pics.length - 1);
            const tmp = gpu.texture(iw, ih, gl.RGBA8UI);
            try {
              pics.forEach((pic, k) => {
                const t = transforms[k];
                const out = k === 0 ? refTex : tmp;
                gpu.target(out, iw, ih);
                gl.useProgram(F.p);
                gl.uniform1i(F.u.uView, 1);
                gpu.bindTex(1, views[k]);
                // (column-major: the uniform's columns are A's columns)
                gl.uniformMatrix3fv(F.u.uA, false, [t.A[0], t.A[3], t.A[6], t.A[1], t.A[4], t.A[7], t.A[2], t.A[5], t.A[8]]);
                gl.uniform3fv(F.u.uFrom, t.from);
                gl.uniform3fv(F.u.uTo, t.to);
                gl.uniform1i(F.u.uMono, pic.mono ? 1 : 0);
                gpu.draw();
                if (k > 0) {
                  // (into the camera's layer of the array the costs read)
                  gl.bindTexture(gl.TEXTURE_2D_ARRAY, modTex);
                  gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, k - 1, 0, 0, iw, ih);
                }
              });
              // the reference's, for the smoothing's guide on the processor
              gpu.target(refTex, iw, ih);
              const buf = new Uint32Array(4 * iw * ih);
              gl.readPixels(0, 0, iw, ih, gl.RGBA_INTEGER, gl.UNSIGNED_INT, buf);
              const ref = new Uint8Array(3 * iw * ih);
              for (let i = 0; i < iw * ih; i++) {
                ref[3 * i] = buf[4 * i];
                ref[3 * i + 1] = buf[4 * i + 1];
                ref[3 * i + 2] = buf[4 * i + 2];
              }
              return { ref, open: (setup) => session(refTex, modTex, [refTex], setup) };
            } catch (e) {
              gl.deleteTexture(refTex);
              gl.deleteTexture(modTex);
              throw e;
            } finally {
              gl.deleteTexture(tmp);
              for (const v of views) gl.deleteTexture(v);
              views.length = 0;
            }
          },
          close() {
            for (const v of views) gl.deleteTexture(v);
          },
        };
      } catch (e) {
        for (const v of views) gl.deleteTexture(v);
        // (and the pictures handed over on the card that were not used)
        for (const pic of pics) {
          if (pic.tex) gl.deleteTexture(pic.tex);
          pic.tex = null;
        }
        throw e;
      }
    },
  };
}
