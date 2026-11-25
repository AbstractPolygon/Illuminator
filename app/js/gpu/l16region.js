// A region of a Light L16 photo with the telephoto cameras' detail (core/l16hires.js renderRegion), made on the graphics card with the processor's rules in single
// precision. The pictures stay on the card from step to step; what comes back is small (per row sums for the cameras' color gains and agreement, the pictures reduced
// for the flow search, which the processor does) and the finished region. Each camera's picture is made by core/l16fusion.js demosaic (itself on the card where it can).
import { program } from './renderer.js';
import { LOOKUP_PROJECT, LOOKUP_SAMPLE } from './l16lookup.js';
import { l16FilterTextures } from './l16filters.js';
import { cameraModel } from '../core/l16geometry.js';
import { relativePose } from '../core/l16depth.js';
import { demosaic } from '../core/l16fusion.js';
import { flowShifts, CLIP_LEVEL } from '../core/l16hires.js';

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
float luma(vec3 c) { return 0.3 * c.r + 0.55 * c.g + 0.15 * c.b; }
// (core/l16hires.js bilinear: the picture at a point in its pixels; false outside)
bool look(sampler2D img, vec2 s, out vec3 o) {
  vec2 q = s - 0.5;
  ivec2 size = textureSize(img, 0);
  if (q.x < 0.0 || q.y < 0.0 || q.x >= float(size.x - 1) || q.y >= float(size.y - 1)) return false;
  ivec2 i0 = ivec2(q);
  vec2 f = q - vec2(i0);
  o = (texelFetch(img, i0, 0).rgb * (1.0 - f.x) + texelFetch(img, i0 + ivec2(1, 0), 0).rgb * f.x) * (1.0 - f.y)
    + (texelFetch(img, i0 + ivec2(0, 1), 0).rgb * (1.0 - f.x) + texelFetch(img, i0 + ivec2(1, 1), 0).rgb * f.x) * f.y;
  return true;
}
`;

// The depth (mm) of every output pixel, bilinear in inverse depth from the depth map.
const ZGRID = `${HEAD}
uniform sampler2D uInvZ;
uniform vec3 uRegion;   // x0, y0, scale
uniform vec2 uWide;     // the wide picture's size
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 d = textureSize(uInvZ, 0);
  vec2 xy = uRegion.xy + (vec2(p) + 0.5) / uRegion.z;
  vec2 f = clamp(xy * vec2(d) / uWide - 0.5, vec2(0.0), vec2(d) - 1.001);
  ivec2 i = ivec2(f);
  vec2 t = f - vec2(i);
  float a = texelFetch(uInvZ, i, 0).r * (1.0 - t.x) + texelFetch(uInvZ, i + ivec2(1, 0), 0).r * t.x;
  float b = texelFetch(uInvZ, i + ivec2(0, 1), 0).r * (1.0 - t.x) + texelFetch(uInvZ, i + ivec2(1, 1), 0).r * t.x;
  outColor = vec4(1.0 / max(1e-7, a * (1.0 - t.y) + b * t.y), 0.0, 0.0, 1.0);
}`;

// The wide picture on the output grid (0 outside it).
const UP = `${HEAD}
uniform sampler2D uWideTex;
uniform vec3 uRegion;
out vec4 outColor;
void main() {
  vec3 c;
  outColor = look(uWideTex, uRegion.xy + (vec2(ivec2(gl_FragCoord.xy)) + 0.5) / uRegion.z, c) ? vec4(c, 1.0) : vec4(0.0, 0.0, 0.0, 1.0);
}`;

// Per row: where the camera's lookups land (the least and largest sensor x and y), for the window of its picture to make.
const ROWRANGE = `${HEAD}
uniform sampler2D uProj;
out vec4 outColor;
void main() {
  int y = int(gl_FragCoord.y);
  int W = textureSize(uProj, 0).x;
  vec4 r = vec4(1e30, 1e30, -1e30, -1e30);
  for (int x = 0; x < W; x++) {
    vec4 q = texelFetch(uProj, ivec2(x, y), 0);
    if (q.z == 0.0) continue;
    r = vec4(min(r.xy, q.xy), max(r.zw, q.xy));
  }
  outColor = r;
}`;

// Per row: the wide picture's and the camera's colors summed over every 5th pixel (by index) the camera has.
const ROWGAIN = `${HEAD}
uniform sampler2D uUp;
uniform sampler2D uSamp;
uniform sampler2D uClip;
layout(location = 0) out vec4 outUp;
layout(location = 1) out vec4 outSamp;
void main() {
  int y = int(gl_FragCoord.y);
  int W = textureSize(uUp, 0).x;
  vec3 su = vec3(0.0);
  vec3 ss = vec3(0.0);
  for (int x = 0; x < W; x++) {
    if ((y * W + x) % 5 != 0) continue;
    vec4 s = texelFetch(uSamp, ivec2(x, y), 0);
    if (s.a == 0.0 || texelFetch(uClip, ivec2(x, y), 0).r > 0.5) continue;
    su += texelFetch(uUp, ivec2(x, y), 0).rgb;
    ss += s.rgb;
  }
  outUp = vec4(su, 1.0);
  outSamp = vec4(ss, 1.0);
}`;

const GAIN = `${HEAD}
uniform sampler2D uSamp;
uniform vec3 uGain;
out vec4 outColor;
void main() {
  vec4 s = texelFetch(uSamp, ivec2(gl_FragCoord.xy), 0);
  outColor = s.a > 0.0 ? vec4(s.rgb * uGain, 1.0) : vec4(0.0);
}`;

// Where the wide picture or the camera's picture (before its gains) is near the sensor's white level (core/l16hires.js clippedNear, CLIP_LEVEL): 1 there.
const CLIP = `${HEAD}
uniform sampler2D uUp;
uniform sampler2D uSamp;
uniform vec3 uWb;
uniform float uLevel;
out vec4 outColor;
bool over(vec3 c) {
  vec3 r = c / uWb;
  return max(r.r, max(r.g, r.b)) > uLevel;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uSamp, p, 0);
  bool c = over(texelFetch(uUp, p, 0).rgb) || (s.a > 0.0 && over(s.rgb));
  outColor = vec4(c ? 1.0 : 0.0, 0.0, 0.0, 1.0);
}`;

// The camera's usable pixels (it has the pixel, not near clipping): 1 in every channel.
const USABLE = `${HEAD}
uniform sampler2D uSamp;
uniform sampler2D uClip;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float u = texelFetch(uSamp, p, 0).a > 0.0 && texelFetch(uClip, p, 0).r < 0.5 ? 1.0 : 0.0;
  outColor = vec4(u, u, u, 1.0);
}`;

const MASKED = `${HEAD}
uniform sampler2D uSamp;
uniform sampler2D uUsable;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  outColor = vec4(texelFetch(uSamp, p, 0).rgb * texelFetch(uUsable, p, 0).r, 1.0);
}`;

// The camera's low frequencies from its usable pixels only: their blur over the blur of where they are (none where few are near).
const LOWDIV = `${HEAD}
uniform sampler2D uNum;
uniform sampler2D uDen;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 d = texelFetch(uDen, p, 0).rgb;
  vec3 n = texelFetch(uNum, p, 0).rgb;
  outColor = vec4(d.r > 0.25 ? n / d : vec3(0.0), 1.0);
}`;

// The brightness of the wide picture's and the camera's low frequencies, each 4 x 4 block averaged (flowOffsets' reduce), for the flow search.
const REDUCE = `${HEAD}
uniform sampler2D uA;
uniform sampler2D uB;
uniform int uDs;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 s = vec2(0.0);
  for (int dy = 0; dy < uDs; dy++) for (int dx = 0; dx < uDs; dx++) {
    ivec2 q = p * uDs + ivec2(dx, dy);
    s += vec2(luma(texelFetch(uA, q, 0).rgb), luma(texelFetch(uB, q, 0).rgb));
  }
  outColor = vec4(s / float(uDs * uDs), 0.0, 1.0);
}`;

// The camera looked up again where the flow search says its content sits (renderRegion's second lookup).
const RELOOK = `${HEAD}
uniform sampler2D uProj;
uniform sampler2D uSamp;     // the camera's colors so far (times the gains)
uniform sampler2D uImg;
uniform sampler2D uShift;    // the blocks' shifts (output pixels), bw x bh
uniform vec2 uOrigin;
uniform vec3 uGain;
uniform float uCell;
out vec4 outColor;
vec4 proj(int i, int W) { return texelFetch(uProj, ivec2(i % W, i / W), 0); }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uProj, 0);
  int W = size.x;
  int H = size.y;
  vec4 s = texelFetch(uSamp, p, 0);
  outColor = s;
  vec4 q = texelFetch(uProj, p, 0);
  if (q.z == 0.0) return;
  ivec2 bs = textureSize(uShift, 0);
  vec2 f = clamp((vec2(p) - uCell / 2.0) / uCell, vec2(0.0), vec2(bs) - 1.001);
  ivec2 i0 = ivec2(f);
  vec2 t = f - vec2(i0);
  vec2 o = (texelFetch(uShift, i0, 0).rg * (1.0 - t.x) + texelFetch(uShift, i0 + ivec2(1, 0), 0).rg * t.x) * (1.0 - t.y)
    + (texelFetch(uShift, i0 + ivec2(0, 1), 0).rg * (1.0 - t.x) + texelFetch(uShift, i0 + ivec2(1, 1), 0).rg * t.x) * t.y;
  if (o.x == 0.0 && o.y == 0.0) return;
  // (the neighbours by index, as the processor's: the one before a row's first pixel is the last of the row above)
  int i = p.y * W + p.x;
  int nx = p.x + 1 < W && texelFetch(uProj, p + ivec2(1, 0), 0).z != 0.0 ? i + 1 : i - 1;
  int ny = p.y + 1 < H && texelFetch(uProj, p + ivec2(0, 1), 0).z != 0.0 ? i + W : i - W;
  if (nx < 0 || ny < 0 || nx >= W * H || ny >= W * H) return;
  vec4 qx = proj(nx, W);
  vec4 qy = proj(ny, W);
  if (qx.z == 0.0 || qy.z == 0.0) return;
  float sgx = nx > i ? 1.0 : -1.0;
  float sgy = ny > i ? 1.0 : -1.0;
  vec2 dX = (qx.xy - q.xy) * sgx;
  vec2 dY = (qy.xy - q.xy) * sgy;
  vec3 c;
  if (look(uImg, q.xy + o.x * dX + o.y * dY - uOrigin, c)) outColor = vec4(c * uGain, s.a);
}`;

// The camera's agreement with the wide picture and its detail: (detail, weight, 1) where it has a pixel and neither picture is near the white level, else 0.
const AGREE = `${HEAD}
uniform sampler2D uUp;
uniform sampler2D uUpLow;
uniform sampler2D uSamp;
uniform sampler2D uLow;
uniform sampler2D uClip;
uniform sampler2D uUsableLow;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  outColor = vec4(0.0);
  vec4 s = texelFetch(uSamp, p, 0);
  if (s.a == 0.0) return;
  // (near the white level, or where few usable pixels of the camera are near: no detail)
  if (texelFetch(uClip, p, 0).r > 0.5 || !(texelFetch(uUsableLow, p, 0).r > 0.25)) return;
  float ll = luma(texelFetch(uLow, p, 0).rgb);
  float lu = luma(texelFetch(uUpLow, p, 0).rgb);
  float sig = 0.015 + 0.08 * sqrt(max(lu, 0.0)) * 0.35;
  float d = (ll - lu) / sig;
  float w = exp(-0.5 * d * d);
  outColor = vec4(luma(s.rgb) - ll, w, 1.0, 0.0);
}`;

// Per row: the agreement summed, and the pixels it is over.
const ROWAGREE = `${HEAD}
uniform sampler2D uAgree;
out vec4 outColor;
void main() {
  int y = int(gl_FragCoord.y);
  int W = textureSize(uAgree, 0).x;
  vec2 s = vec2(0.0);
  for (int x = 0; x < W; x++) {
    vec4 a = texelFetch(uAgree, ivec2(x, y), 0);
    s += vec2(a.g * a.b, a.b);
  }
  outColor = vec4(s, 0.0, 1.0);
}`;

// The camera's layer: (detail, the agreement over the neighborhood, 1) where it has detail and agrees enough round the pixel.
const LAYER = `${HEAD}
uniform sampler2D uAgree;
uniform sampler2D uSmooth;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 a = texelFetch(uAgree, p, 0);
  float wsm = texelFetch(uSmooth, p, 0).g;
  outColor = a.b > 0.0 && wsm >= 0.05 ? vec4(a.r, wsm, 1.0, 0.0) : vec4(0.0, wsm, 0.0, 0.0);
}`;

// The detail layered over the wide picture, the longest lens first (uOrder), held to the wide picture's brightness range round the pixel; a = 1 where detail was added.
const MIX = `${HEAD}
uniform sampler2D uUp;
uniform sampler2D uMin;
uniform sampler2D uMax;
uniform sampler2DArray uLayers;
uniform int uN;
uniform int uOrder[16];
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 up = texelFetch(uUp, p, 0).rgb;
  outColor = vec4(up, 0.0);
  float wsum = 0.0;
  for (int k = 0; k < uN; k++) {
    vec4 L = texelFetch(uLayers, ivec3(p, k), 0);
    if (L.b > 0.0) wsum += L.g;
  }
  if (!(wsum > 0.05)) return;
  float Y = luma(up);
  float noise = 0.004 + 0.02 * sqrt(max(Y, 0.0)) * 0.35;
  float m = 0.0;
  float rest = 1.0;
  bool any = false;
  for (int j = 0; j < uN; j++) {
    vec4 L = texelFetch(uLayers, ivec3(p, uOrder[j]), 0);
    if (L.b == 0.0) continue;
    float t = clamp((L.g - 0.15) / 0.45, 0.0, 1.0);
    float a = t * t * (3.0 - 2.0 * t);
    m += rest * a * L.r;
    rest *= 1.0 - a;
    any = true;
  }
  if (!any || rest > 0.999) return;
  float a = abs(m);
  m = a <= noise ? m * (a / noise) : sign(m) * (a - noise * 0.5);
  float lo = luma(texelFetch(uMin, p, 0).rgb);
  float hi = luma(texelFetch(uMax, p, 0).rgb);
  float Yn = max(lo * 0.6, min(hi * 1.3 + 0.006, Y + m));
  vec3 o = Y > 0.02 ? max(vec3(0.0), up * (Yn / Y)) : max(vec3(0.0), up + (Yn - Y));
  outColor = vec4(o, 1.0);
}`;

// On `gpu` (a GpuRenderer): render(args) with renderRegion's arguments, returning what it returns.
export function l16RegionGpu(gpu) {
  const gl = gpu.gl;
  const filters = l16FilterTextures(gpu);
  let progs = null;
  const P = () =>
    (progs = progs || {
      zgrid: program(gl, ZGRID), up: program(gl, UP), project: program(gl, LOOKUP_PROJECT), sample: program(gl, LOOKUP_SAMPLE), rowRange: program(gl, ROWRANGE),
      rowGain: program(gl, ROWGAIN), gain: program(gl, GAIN), reduce: program(gl, REDUCE), relook: program(gl, RELOOK), agree: program(gl, AGREE),
      rowAgree: program(gl, ROWAGREE), layer: program(gl, LAYER), mix: program(gl, MIX),
      clip: program(gl, CLIP), usable: program(gl, USABLE), masked: program(gl, MASKED), lowDiv: program(gl, LOWDIV),
    });
  // (the wide picture is the same for every tile of a render: kept on the card until another comes)
  let wideKept = null;
  const wideTex = (wide) => {
    if (wideKept && wideKept.wide === wide) return wideKept.tex;
    if (wideKept) gl.deleteTexture(wideKept.tex);
    wideKept = null;
    const tex = gpu.texture(wide.width, wide.height, gl.RGB32F);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, wide.width, wide.height, gl.RGB, gl.FLOAT, wide.rgb);
    wideKept = { wide, tex };
    return tex;
  };
  // A draw of `prog` into `out` (w x h, or the attachments of `outs`), its textures bound in order.
  const draw = (prog, out, w, h, inputs, set = () => {}) => {
    if (Array.isArray(out)) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, gpu.fbo);
      out.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
      gl.drawBuffers(out.map((t, i) => gl.COLOR_ATTACHMENT0 + i));
      gl.viewport(0, 0, w, h);
    } else gpu.target(out, w, h);
    gl.useProgram(prog.p);
    inputs.forEach(([name, t, kind], i) => {
      gl.uniform1i(prog.u[name], i + 1);
      gpu.bindTex(i + 1, t, kind);
    });
    set(prog.u);
    gpu.draw();
  };
  const readRGBA = (tex, w, h, buf = new Float32Array(4 * w * h)) => {
    gpu.target(tex, w, h);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, buf);
    return buf;
  };
  const setDist = (u, distort) => {
    const d = distort && distort.params;
    gl.uniform1i(u.uHasDist, d ? 1 : 0);
    if (d) {
      gl.uniform4f(u.uDa, d.k1, d.k2, d.k3, d.p1);
      gl.uniform4f(u.uDb, d.p2, d.nx, d.ny, d.cx);
      gl.uniform1f(u.uDcy, d.cy);
    }
  };

  return function render(bytes, parsed, depth, wide, { x0, y0, w, h, scale, grid = 1, corrections = null }, modules, opts, onProgress = () => {}, rawCache = null) {
    const W = Math.round(w * scale);
    const H = Math.round(h * scale);
    if (modules.length > 16) throw new Error('More cameras than the graphics card mix takes');
    const pr = P();
    const refCam = cameraModel(parsed.header, parsed.modules[depth.ref][0]);
    const K = refCam.K;
    const made = [];
    const tex = (tw, th, internal = gl.RGBA32F) => {
      const t = gpu.texture(tw, th, internal);
      made.push(t);
      return t;
    };
    let layers = null;
    try {
      const region = (u) => gl.uniform3f(u.uRegion, x0, y0, scale);
      // the depth and the wide picture on the output grid
      const invZ = gpu.uploadR32F(null, null, depth.invZ, depth.width, depth.height);
      made.push(invZ);
      const zT = tex(W, H, gl.R32F);
      draw(pr.zgrid, zT, W, H, [['uInvZ', invZ]], (u) => {
        region(u);
        gl.uniform2f(u.uWide, wide.width, wide.height);
      });
      const upT = tex(W, H);
      draw(pr.up, upT, W, H, [['uWideTex', wideTex(wide)]], region);
      const sigma = scale * 0.9;
      const upLow = filters.gauss(made, upT, W, H, sigma);
      const agreement = {};
      const cams = [];
      const rowBuf = new Float32Array(4 * H);
      layers = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + 5);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, layers);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA32F, W, H, Math.max(1, modules.length));
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      let used = 0;
      for (const id of modules) {
        onProgress('Adding telephoto detail', used / Math.max(1, modules.length));
        const cam = cameraModel(parsed.header, parsed.modules[id][0]);
        const rel = relativePose(refCam, cam);
        const corr = corrections && corrections[id];
        const local = [];
        const ltex = (tw, th, internal = gl.RGBA32F) => {
          const t = gpu.texture(tw, th, internal);
          local.push(t);
          return t;
        };
        try {
          // where each output pixel lands on the camera's sensor
          const proj = ltex(W, H);
          draw(pr.project, proj, W, H, [['uZ', zT]], (u) => {
            gl.uniform4f(u.uRegion, x0, y0, scale, grid);
            gl.uniform4f(u.uK, K[0], K[2], K[4], K[5]);
            gl.uniform4f(u.uCK, cam.K[0], cam.K[2], cam.K[4], cam.K[5]);
            gl.uniformMatrix3fv(u.uR, false, Array.from(rel.R));
            gl.uniform3f(u.uT, rel.T[0], rel.T[1], rel.T[2]);
            setDist(u, cam.distort);
            gl.uniform3f(u.uCx, corr ? corr.ax[0] : 0, corr ? corr.ax[1] : 0, corr ? corr.ax[2] : 0);
            gl.uniform3f(u.uCy, corr ? corr.ay[0] : 0, corr ? corr.ay[1] : 0, corr ? corr.ay[2] : 0);
          });
          const rr = ltex(1, H);
          draw(pr.rowRange, rr, 1, H, [['uProj', proj]]);
          readRGBA(rr, 1, H, rowBuf);
          let minX = Infinity;
          let minY = Infinity;
          let maxX = -Infinity;
          let maxY = -Infinity;
          for (let y = 0; y < H; y++) {
            if (rowBuf[4 * y] > 1e29) continue;
            minX = Math.min(minX, rowBuf[4 * y]);
            minY = Math.min(minY, rowBuf[4 * y + 1]);
            maxX = Math.max(maxX, rowBuf[4 * y + 2]);
            maxY = Math.max(maxY, rowBuf[4 * y + 3]);
          }
          if (!(maxX >= minX)) continue;
          const img = demosaic(bytes, parsed.modules[id][0], opts, { x0: minX - 3, y0: minY - 3, w: maxX - minX + 7, h: maxY - minY + 7 }, rawCache || new Map());
          const imgT = ltex(img.width, img.height, gl.RGB32F);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, img.width, img.height, gl.RGB, gl.FLOAT, img.rgb);
          const samp = ltex(W, H);
          draw(pr.sample, samp, W, H, [['uProj', proj], ['uImg', imgT]], (u) => gl.uniform2f(u.uOrigin, img.x0 || 0, img.y0 || 0));
          // near the white level (and a pixel round), and the camera's usable pixels
          const wb = opts.gains || [1, 1, 1];
          const clipRaw = ltex(W, H);
          draw(pr.clip, clipRaw, W, H, [['uUp', upT], ['uSamp', samp]], (u) => {
            gl.uniform3f(u.uWb, wb[0], wb[1], wb[2]);
            gl.uniform1f(u.uLevel, CLIP_LEVEL);
          });
          const clipT = filters.bounds(local, clipRaw, W, H, 1).max;
          const usableT = ltex(W, H);
          draw(pr.usable, usableT, W, H, [['uSamp', samp], ['uClip', clipT]]);
          const usableLow = filters.gauss(local, usableT, W, H, sigma);
          const lowOf = (src) => {
            const m = ltex(W, H);
            draw(pr.masked, m, W, H, [['uSamp', src], ['uUsable', usableT]]);
            const num = filters.gauss(local, m, W, H, sigma);
            const out = ltex(W, H);
            draw(pr.lowDiv, out, W, H, [['uNum', num], ['uDen', usableLow]]);
            return out;
          };
          // gains that bring the camera's colors to the wide picture's
          const gu = ltex(1, H);
          const gs = ltex(1, H);
          try {
            draw(pr.rowGain, [gu, gs], 1, H, [['uUp', upT], ['uSamp', samp], ['uClip', clipT]]);
          } finally {
            gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, null, 0);
          }
          const sr = [0, 0, 0];
          const sd = [0, 0, 0];
          const bu = readRGBA(gu, 1, H);
          const bs = readRGBA(gs, 1, H);
          for (let y = 0; y < H; y++) {
            for (let c = 0; c < 3; c++) {
              sr[c] += bu[4 * y + c];
              sd[c] += bs[4 * y + c];
            }
          }
          const g = sd.map((v, c) => (v > 1e-6 ? sr[c] / v : 1));
          let sampG = ltex(W, H);
          draw(pr.gain, sampG, W, H, [['uSamp', samp]], (u) => gl.uniform3f(u.uGain, g[0], g[1], g[2]));
          let low = lowOf(sampG);
          // the registration refined against the wide picture (the block search on the processor, on the reduced pictures), and the camera looked up again
          if (opts.flow !== false && W >= 64 && H >= 64) {
            const ds = 4;
            const rw = Math.floor(W / ds);
            const rh = Math.floor(H / ds);
            const red = ltex(rw, rh);
            draw(pr.reduce, red, rw, rh, [['uA', upLow], ['uB', low]], (u) => gl.uniform1i(u.uDs, ds));
            const rb = readRGBA(red, rw, rh);
            const A = new Float32Array(rw * rh);
            const B = new Float32Array(rw * rh);
            for (let i = 0; i < rw * rh; i++) {
              A[i] = rb[4 * i];
              B[i] = rb[4 * i + 1];
            }
            const { mx, my, bw, bh } = flowShifts(A, B, rw, rh, ds, 6, 2);
            const sh = new Float32Array(4 * bw * bh);
            for (let i = 0; i < bw * bh; i++) {
              sh[4 * i] = mx[i];
              sh[4 * i + 1] = my[i];
            }
            const shT = ltex(bw, bh);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, bw, bh, gl.RGBA, gl.FLOAT, sh);
            const moved = ltex(W, H);
            draw(pr.relook, moved, W, H, [['uProj', proj], ['uSamp', sampG], ['uImg', imgT], ['uShift', shT]], (u) => {
              gl.uniform2f(u.uOrigin, img.x0 || 0, img.y0 || 0);
              gl.uniform3f(u.uGain, g[0], g[1], g[2]);
              gl.uniform1f(u.uCell, 6 * ds);
            });
            sampG = moved;
            low = lowOf(sampG);
          }
          // the agreement and the detail
          const agree = ltex(W, H);
          draw(pr.agree, agree, W, H, [['uUp', upT], ['uUpLow', upLow], ['uSamp', sampG], ['uLow', low], ['uClip', clipT], ['uUsableLow', usableLow]]);
          const ra = ltex(1, H);
          draw(pr.rowAgree, ra, 1, H, [['uAgree', agree]]);
          readRGBA(ra, 1, H, rowBuf);
          let camW = 0;
          let camN = 0;
          for (let y = 0; y < H; y++) {
            camW += rowBuf[4 * y];
            camN += rowBuf[4 * y + 1];
          }
          const smooth = filters.box(local, agree, W, H, Math.max(1, Math.round(scale)));
          // (into the camera's layer)
          gl.bindFramebuffer(gl.FRAMEBUFFER, gpu.fbo);
          gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, layers, 0, cams.length);
          gl.viewport(0, 0, W, H);
          gl.useProgram(pr.layer.p);
          gl.uniform1i(pr.layer.u.uAgree, 1);
          gpu.bindTex(1, agree);
          gl.uniform1i(pr.layer.u.uSmooth, 2);
          gpu.bindTex(2, smooth);
          gpu.draw();
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
          cams.push({ reach: cam.K[0] / K[0] });
          agreement[id] = camN ? camW / camN : null;
          used++;
        } finally {
          for (const t of local) gl.deleteTexture(t);
        }
      }
      // the wide picture's range round each pixel, and the mix (the longest lens first)
      const bounds = filters.bounds(made, upT, W, H, Math.max(2, Math.round(scale * 1.5)));
      const order = cams.map((c, i) => i).sort((a, b) => cams[b].reach - cams[a].reach);
      const outT = tex(W, H);
      draw(pr.mix, outT, W, H, [['uUp', upT], ['uMin', bounds.min], ['uMax', bounds.max], ['uLayers', layers, gl.TEXTURE_2D_ARRAY]], (u) => {
        gl.uniform1i(u.uN, cams.length);
        const o = new Int32Array(16);
        order.forEach((k, j) => (o[j] = k));
        gl.uniform1iv(u.uOrder, o);
      });
      const buf = readRGBA(outT, W, H);
      const rgb = new Float32Array(3 * W * H);
      let covered = 0;
      for (let i = 0; i < W * H; i++) {
        rgb[3 * i] = buf[4 * i];
        rgb[3 * i + 1] = buf[4 * i + 1];
        rgb[3 * i + 2] = buf[4 * i + 2];
        if (buf[4 * i + 3] > 0) covered++;
      }
      readRGBA(upT, W, H, buf);
      const up = new Float32Array(3 * W * H);
      for (let i = 0; i < W * H; i++) {
        up[3 * i] = buf[4 * i];
        up[3 * i + 1] = buf[4 * i + 1];
        up[3 * i + 2] = buf[4 * i + 2];
      }
      return { width: W, height: H, rgb, covered: covered / (W * H), wide: up, agreement };
    } finally {
      for (const t of made) gl.deleteTexture(t);
      if (layers) gl.deleteTexture(layers);
    }
  };
}

