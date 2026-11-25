// A Light L16 camera's picture prepared on the graphics card, as core/l16fusion.js halfSize does it on the processor (same rules, single precision): hot and dead
// pixels taken out of the sensor plane (removeSpecks), every color at the center of each 2 x 2 block (the Malvar-He-Cutler demosaic of its four sites, averaged;
// the monochrome camera's four sites averaged), and the lens's lateral chromatic aberration taken out (unshiftChannel) with the amounts the processor measures.
import { program } from './renderer.js';

// Pass 0: the sensor plane from the file's packed 10 bit rows (core/lri.js decodeFrame: four pixels in five bytes), at black 0 and white 1.
const UNPACK = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uPacked;   // the rows needed, from the byte of the first group needed
uniform int uX0;              // the plane's first sensor column
uniform float uBlack;
uniform float uScale;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int x = p.x + uX0;
  int o = 5 * ((x >> 2) - (uX0 >> 2));
  int j = x & 3;
  uint b0 = texelFetch(uPacked, ivec2(o + j, p.y), 0).r;
  uint b1 = texelFetch(uPacked, ivec2(o + j + 1, p.y), 0).r;
  uint v = j == 0 ? (b0 | ((b1 & 3u) << 8)) : j == 1 ? ((b0 >> 2) | ((b1 & 15u) << 6)) : j == 2 ? ((b0 >> 4) | ((b1 & 63u) << 4)) : ((b0 >> 6) | (b1 << 2));
  outColor = vec4(max(0.0, (float(v) - uBlack) * uScale), 0.0, 0.0, 1.0);
}`;

// Pass 1: hot and dead pixels. A pixel far brighter than every neighbour of its own color (`uStep` away), or far darker than all of them, takes the mean of the four
// side neighbours; neighbours past the edge are the edge's pixels. All read from the unchanged plane, as the processor replaces only after its search.
const HOT = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uPlane;
uniform int uStep;
uniform int uLong;   // a long exposure: its warm pixels are found too (core/l16fusion.js removeSpecks)
out vec4 outColor;
float at(ivec2 q, ivec2 size) { return texelFetch(uPlane, clamp(q, ivec2(0), size - 1), 0).r; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uPlane, 0);
  int s = uStep;
  float v = texelFetch(uPlane, p, 0).r;
  float a = at(p + ivec2(-s, 0), size);
  float b = at(p + ivec2(s, 0), size);
  float c = at(p + ivec2(0, -s), size);
  float d = at(p + ivec2(0, s), size);
  float e = at(p + ivec2(-s, -s), size);
  float f = at(p + ivec2(s, -s), size);
  float g = at(p + ivec2(-s, s), size);
  float h = at(p + ivec2(s, s), size);
  // (the second brightest neighbor: two hot pixels side by side are found too, and a thin bright line, which has two neighbors on it, is not)
  float n[8] = float[8](a, b, c, d, e, f, g, h);
  float m1 = -1.0;
  float m2 = -1.0;
  for (int k = 0; k < 8; k++) {
    if (n[k] > m1) { m2 = m1; m1 = n[k]; }
    else if (n[k] > m2) m2 = n[k];
  }
  float lo = min(min(min(a, b), min(c, d)), min(min(e, f), min(g, h)));
  float m4 = max(max(a, b), max(c, d));
  bool hot = uLong == 1 ? v > m2 * 1.5 + 0.008 : v > m1 * 1.5 + 0.03;
  if (hot || (lo > 0.12 && v < lo * 0.3)) v = uLong == 1 ? (a + b + c + d - m4) / 3.0 : (a + b + c + d) / 4.0;
  outColor = vec4(v, 0.0, 0.0, 1.0);
}`;

// Pass 2: the half size picture. The plane is read mirrored by two past its edges (keeping each site's color), as the processor's padded copy.
const HALF = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uPlane;
uniform ivec2 uRed;   // the red site's phase (x, y)
uniform int uMono;
uniform vec3 uGains;
out vec4 outColor;
float P(int x, int y, ivec2 size) {
  if (x < 0) x += 2;
  else if (x >= size.x) x -= 2;
  if (y < 0) y += 2;
  else if (y >= size.y) y -= 2;
  return texelFetch(uPlane, ivec2(x, y), 0).r;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uPlane, 0);
  if (uMono == 1) {
    ivec2 q = 2 * p;
    float m = (texelFetch(uPlane, q, 0).r + texelFetch(uPlane, q + ivec2(1, 0), 0).r + texelFetch(uPlane, q + ivec2(0, 1), 0).r + texelFetch(uPlane, q + ivec2(1, 1), 0).r) / 4.0;
    outColor = vec4(m, m, m, 1.0);
    return;
  }
  vec3 sum = vec3(0.0);
  for (int k = 0; k < 4; k++) {
    int X = 2 * p.x + (k & 1);
    int Y = 2 * p.y + (k >> 1);
    float c = P(X, Y, size);
    float n4 = P(X - 1, Y, size) + P(X + 1, Y, size) + P(X, Y - 1, size) + P(X, Y + 1, size);
    float d4 = P(X - 1, Y - 1, size) + P(X + 1, Y - 1, size) + P(X - 1, Y + 1, size) + P(X + 1, Y + 1, size);
    float h2 = P(X - 2, Y, size) + P(X + 2, Y, size);
    float v2 = P(X, Y - 2, size) + P(X, Y + 2, size);
    bool isR = (X & 1) == uRed.x;
    bool isRrow = (Y & 1) == uRed.y;
    if (isR == isRrow) {
      float g = clamp((2.0 * n4 + 4.0 * c - (h2 + v2)) / 8.0, 0.0, 1.0);
      float opp = clamp((2.0 * d4 + 6.0 * c - 1.5 * (h2 + v2)) / 8.0, 0.0, 1.0);
      if (isR) {
        sum.r += c;
        sum.b += opp;
      } else {
        sum.b += c;
        sum.r += opp;
      }
      sum.g += g;
    } else {
      float row = clamp((5.0 * c - d4 - h2 + 0.5 * v2 + 4.0 * (P(X - 1, Y, size) + P(X + 1, Y, size))) / 8.0, 0.0, 1.0);
      float col = clamp((5.0 * c - d4 - v2 + 0.5 * h2 + 4.0 * (P(X, Y - 1, size) + P(X, Y + 1, size))) / 8.0, 0.0, 1.0);
      sum.g += c;
      if (isRrow) {
        sum.r += row;
        sum.b += col;
      } else {
        sum.b += row;
        sum.r += col;
      }
    }
  }
  outColor = vec4(max(vec3(0.0), sum / 4.0) * uGains, 1.0);
}`;

// Pass 2, full size: every sensor pixel demosaiced (core/l16fusion.js demosaicRaw: Malvar-He-Cutler, neighbours past the edge are the edge's pixels, values not held to
// the white level), times the gains.
const FULL = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uPlane;
uniform ivec2 uRed;
uniform int uMono;
uniform vec3 uGains;
out vec4 outColor;
float P(int x, int y, ivec2 size) { return texelFetch(uPlane, clamp(ivec2(x, y), ivec2(0), size - 1), 0).r; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uPlane, 0);
  int X = p.x;
  int Y = p.y;
  float c = P(X, Y, size);
  if (uMono == 1) {
    outColor = vec4(c, c, c, 1.0);
    return;
  }
  float n4 = P(X - 1, Y, size) + P(X + 1, Y, size) + P(X, Y - 1, size) + P(X, Y + 1, size);
  float d4 = P(X - 1, Y - 1, size) + P(X + 1, Y - 1, size) + P(X - 1, Y + 1, size) + P(X + 1, Y + 1, size);
  float h2 = P(X - 2, Y, size) + P(X + 2, Y, size);
  float v2 = P(X, Y - 2, size) + P(X, Y + 2, size);
  bool isR = (X & 1) == uRed.x;
  bool isRrow = (Y & 1) == uRed.y;
  vec3 rgb;
  if (isR == isRrow) {
    float g = (2.0 * n4 + 4.0 * c - (h2 + v2)) / 8.0;
    float opp = (2.0 * d4 + 6.0 * c - 1.5 * (h2 + v2)) / 8.0;
    rgb = isR ? vec3(c, g, opp) : vec3(opp, g, c);
  } else {
    float row = (5.0 * c - d4 - h2 + 0.5 * v2 + 4.0 * (P(X - 1, Y, size) + P(X + 1, Y, size))) / 8.0;
    float col = (5.0 * c - d4 - v2 + 0.5 * h2 + 4.0 * (P(X, Y - 1, size) + P(X, Y + 1, size))) / 8.0;
    rgb = isRrow ? vec3(row, c, col) : vec3(col, c, row);
  }
  outColor = vec4(max(vec3(0.0), rgb) * uGains, 1.0);
}`;

// Pass 3: red and blue looked up where the lens drew them (core/l16fusion.js unshiftChannel): at the point minus the shift s * (point - middle) / R + t (times k),
// clamped inside the picture as the processor does, bilinear; green as it is.
const UNSHIFT = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uSrc;
uniform vec4 uR;   // red: s, tx, ty, k
uniform vec4 uB;   // blue
out vec4 outColor;
float chan(vec4 m, int c, vec2 px, vec2 size) {
  vec2 cen = 0.5 * size;
  float R = length(cen);
  vec2 sh = m.w * (m.x * (px - cen) / R + m.yz);
  vec2 s = clamp(px - sh - 0.5, vec2(0.0), size - 1.001);
  ivec2 i0 = ivec2(floor(s));
  vec2 f = s - vec2(i0);
  float a = texelFetch(uSrc, i0, 0)[c];
  float b = texelFetch(uSrc, i0 + ivec2(1, 0), 0)[c];
  float d = texelFetch(uSrc, i0 + ivec2(0, 1), 0)[c];
  float e = texelFetch(uSrc, i0 + ivec2(1, 1), 0)[c];
  return (a * (1.0 - f.x) + b * f.x) * (1.0 - f.y) + (d * (1.0 - f.x) + e * f.x) * f.y;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 size = vec2(textureSize(uSrc, 0));
  vec2 px = vec2(p) + 0.5;
  vec4 c = texelFetch(uSrc, p, 0);
  float r = (uR.x != 0.0 || uR.y != 0.0 || uR.z != 0.0) ? chan(uR, 0, px, size) : c.r;
  float b = (uB.x != 0.0 || uB.y != 0.0 || uB.z != 0.0) ? chan(uB, 2, px, size) : c.b;
  outColor = vec4(r, c.g, b, 1.0);
}`;

// The color fringe measurement's sums (core/l16fusion.js tileSums), one fragment for each row of each tile: x is the row within the tile, y the tile. Each sums its row
// (green and the channel over the whole row; the gradient sums over the inside of the tile only); the rows are added up on the processor.
const SUMS = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uSrc;
uniform highp sampler2D uTiles;   // T x 1: the tiles' x0, y0
uniform int uN;
uniform int uC;
layout(location = 0) out vec4 out0;
layout(location = 1) out vec4 out1;
layout(location = 2) out vec4 out2;
float ch(vec4 t) { return uC == 0 ? t.r : t.b; }
void main() {
  int j = int(gl_FragCoord.x);
  int t = int(gl_FragCoord.y);
  ivec2 o = ivec2(texelFetch(uTiles, ivec2(t, 0), 0).xy);
  int y = o.y + j;
  float mg = 0.0;
  float mv = 0.0;
  for (int x = o.x; x < o.x + uN; x++) {
    vec4 q = texelFetch(uSrc, ivec2(x, y), 0);
    mg += q.g;
    mv += ch(q);
  }
  float sxx = 0.0;
  float sxy = 0.0;
  float syy = 0.0;
  float sxv = 0.0;
  float sxg = 0.0;
  float syv = 0.0;
  float syg = 0.0;
  if (j >= 1 && j <= uN - 2) {
    for (int x = o.x + 1; x < o.x + uN - 1; x++) {
      float gx = (texelFetch(uSrc, ivec2(x + 1, y), 0).g - texelFetch(uSrc, ivec2(x - 1, y), 0).g) / 2.0;
      float gy = (texelFetch(uSrc, ivec2(x, y + 1), 0).g - texelFetch(uSrc, ivec2(x, y - 1), 0).g) / 2.0;
      vec4 q = texelFetch(uSrc, ivec2(x, y), 0);
      float v = ch(q);
      sxx += gx * gx;
      sxy += gx * gy;
      syy += gy * gy;
      sxv += gx * v;
      sxg += gx * q.g;
      syv += gy * v;
      syg += gy * q.g;
    }
  }
  out0 = vec4(mg, mv, sxx, sxy);
  out1 = vec4(syy, sxv, sxg, syv);
  out2 = vec4(syg, 0.0, 0.0, 0.0);
}`;

// The camera picture preparation on `gpu` (a GpuRenderer): prep({ plane, W, H, w, h, red, mono, hot, gains, full }) -> { rgb, unshift(ca, k) -> rgb, release() }.
// `plane`: the sensor values (0 at black, 1 at white), W x H = 2w x 2h; the picture made is w x h, or W x H with `full` (every sensor pixel demosaiced).
export function l16PrepGpu(gpu) {
  const gl = gpu.gl;
  let progs = null;
  const programs = () => {
    if (!progs) progs = { hot: program(gl, HOT), half: program(gl, HALF), full: program(gl, FULL), unshift: program(gl, UNSHIFT), sums: program(gl, SUMS), unpack: program(gl, UNPACK) };
    return progs;
  };
  const read = (tex, w, h) => {
    gpu.target(tex, w, h);
    const buf = new Float32Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, buf);
    const rgb = new Float32Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      rgb[3 * i] = buf[4 * i];
      rgb[3 * i + 1] = buf[4 * i + 1];
      rgb[3 * i + 2] = buf[4 * i + 2];
    }
    return rgb;
  };
  // `packed` in place of `plane`: { bytes, start, stride, x0, y0, black, scale }, the file's packed rows (core/lri.js), the plane being W x H from sensor pixel x0, y0.
  return function prep({ plane, packed, W, H, w: hw, h: hh, red, mono, hot, gains, full = false }) {
    // (`hot` 'long': a long exposure's rules)
    const w = full ? W : hw;
    const h = full ? H : hh;
    const P = programs();
    const made = [];
    const tex = (tw, th, internal) => {
      const t = gpu.texture(tw, th, internal);
      made.push(t);
      return t;
    };
    try {
      let raw;
      if (packed) {
        const { bytes, start, stride, x0, y0, black, scale } = packed;
        const bx0 = 5 * (x0 >> 2);
        const bw = 5 * (((x0 + W - 1) >> 2) - (x0 >> 2) + 1);
        const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        if (bw > max || H > max) throw new Error('The frame is larger than the graphics card textures');
        // (the file's rows from y0; the last one, which the file may end within, padded)
        const from = start + y0 * stride;
        let rows = bytes.subarray(from, from + H * stride);
        if (rows.length < H * stride) {
          const padded = new Uint8Array(H * stride);
          padded.set(rows);
          rows = padded;
        }
        const pk = tex(bw, H, gl.R8UI);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, stride);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, bx0);
        try {
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, bw, H, gl.RED_INTEGER, gl.UNSIGNED_BYTE, rows);
        } finally {
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
          gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
          gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
        }
        raw = tex(W, H, gl.R32F);
        gpu.target(raw, W, H);
        gl.useProgram(P.unpack.p);
        gl.uniform1i(P.unpack.u.uPacked, 1);
        gpu.bindTex(1, pk);
        gl.uniform1i(P.unpack.u.uX0, x0);
        gl.uniform1f(P.unpack.u.uBlack, black);
        gl.uniform1f(P.unpack.u.uScale, scale);
        gpu.draw();
      } else {
        raw = gpu.uploadR32F(null, null, plane, W, H);
        made.push(raw);
      }
      let src = raw;
      if (hot) {
        const clean = tex(W, H, gl.R32F);
        gpu.target(clean, W, H);
        gl.useProgram(P.hot.p);
        gl.uniform1i(P.hot.u.uPlane, 1);
        gpu.bindTex(1, raw);
        gl.uniform1i(P.hot.u.uStep, mono ? 1 : 2);
        gl.uniform1i(P.hot.u.uLong, hot === 'long' ? 1 : 0);
        gpu.draw();
        src = clean;
      }
      const half = tex(w, h, gl.RGBA32F);
      gpu.target(half, w, h);
      const D = full ? P.full : P.half;
      gl.useProgram(D.p);
      gl.uniform1i(D.u.uPlane, 1);
      gpu.bindTex(1, src);
      gl.uniform2i(D.u.uRed, red.x, red.y);
      gl.uniform1i(D.u.uMono, mono ? 1 : 0);
      gl.uniform3f(D.u.uGains, gains[0], gains[1], gains[2]);
      gpu.draw();
      const rgb = read(half, w, h);
      let out = null;
      // (the picture as it now stands: the unshifted one, or the last unshift)
      let latest = half;
      return {
        rgb,
        // The picture with red and blue shifted by `ca` ({ r, b }: { s, tx, ty } each) times k, from the unshifted one (read back unless `readBack` is false).
        unshift(ca, k = 1, readBack = true) {
          if (!out) out = tex(w, h, gl.RGBA32F);
          gpu.target(out, w, h);
          gl.useProgram(P.unshift.p);
          gl.uniform1i(P.unshift.u.uSrc, 1);
          gpu.bindTex(1, half);
          gl.uniform4f(P.unshift.u.uR, ca.r.s, ca.r.tx, ca.r.ty, k);
          gl.uniform4f(P.unshift.u.uB, ca.b.s, ca.b.tx, ca.b.ty, k);
          gpu.draw();
          latest = out;
          return readBack ? read(out, w, h) : null;
        },
        // The picture as it now stands, read back.
        current() {
          return read(latest, w, h);
        },
        // The color fringe sums of the picture as it now stands (core/l16fusion.js measureChroma's sumsOf): CHROMA_SUMS (9) a tile, the rows added in double precision.
        chromaSums(c, tiles, n) {
          const T = tiles.length;
          const local = [];
          try {
            const td = new Float32Array(4 * T);
            tiles.forEach(([x0, y0], t) => {
              td[4 * t] = x0;
              td[4 * t + 1] = y0;
            });
            const tilesTex = gpu.texture(T, 1, gl.RGBA32F);
            local.push(tilesTex);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, T, 1, gl.RGBA, gl.FLOAT, td);
            const outs = [0, 1, 2].map(() => {
              const t = gpu.texture(n, T, gl.RGBA32F);
              local.push(t);
              return t;
            });
            const fb = gl.createFramebuffer();
            const parts = [];
            try {
              gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
              outs.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
              gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
              gl.viewport(0, 0, n, T);
              gl.useProgram(P.sums.p);
              gl.uniform1i(P.sums.u.uSrc, 1);
              gpu.bindTex(1, latest);
              gl.uniform1i(P.sums.u.uTiles, 2);
              gpu.bindTex(2, tilesTex);
              gl.uniform1i(P.sums.u.uN, n);
              gl.uniform1i(P.sums.u.uC, c);
              gpu.draw();
              for (let i = 0; i < 3; i++) {
                const buf = new Float32Array(4 * n * T);
                gl.readBuffer(gl.COLOR_ATTACHMENT0 + i);
                gl.readPixels(0, 0, n, T, gl.RGBA, gl.FLOAT, buf);
                parts.push(buf);
              }
              gl.readBuffer(gl.COLOR_ATTACHMENT0);
            } finally {
              gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
              gl.bindFramebuffer(gl.FRAMEBUFFER, null);
              gl.deleteFramebuffer(fb);
            }
            // (the 9 sums are the first 9 of the 12 values the three outputs hold)
            const sums = new Float64Array(9 * T);
            for (let t = 0; t < T; t++) {
              for (let j = 0; j < n; j++) {
                for (let q = 0; q < 9; q++) sums[9 * t + q] += parts[q >> 2][4 * (t * n + j) + (q & 3)];
              }
            }
            return sums;
          } finally {
            for (const t of local) gl.deleteTexture(t);
          }
        },
        release() {
          for (const t of made) gl.deleteTexture(t);
        },
      };
    } catch (e) {
      for (const t of made) gl.deleteTexture(t);
      throw e;
    }
  };
}
