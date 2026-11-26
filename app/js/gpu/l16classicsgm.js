// The smoothing of core/l16classic.js (Classic Depth) on the graphics card: the costs of every pixel's range of planes smoothed along eight directions, as runLayer does
// it on the processor, then each pixel's plane of least total cost.
//
// A pixel's planes are a run of entries in a long list (`off`: where each pixel's run starts, in rows of the picture), so the costs and what is smoothed are textures of
// that list, 4096 entries a row. The six directions that come from the row before (above, or below on the way up: straight, and diagonally either side) are worked out a
// row at a time, three at once; the two along the row (from the left, from the right) a column at a time, on a second list laid out by columns, so that the entries of a
// step are always together. After each sweep its values are added into the total; the total's least plane per pixel is found on the card and only that comes back.
// The same rules as the processor's: a neighbor's planes outside its range, and a neighbor past the picture's edge, count as 2000; the penalty for a jump falls with the
// change of the picture (the guide) between the two pixels.
import { program } from './renderer.js';

const TW = 4096;   // entries per texture row
const PW = 2048;   // pixels per row of the pixel tables
const BIG = 2000;

const COMMON = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
const uint BIG = ${BIG}u;
uniform usampler2D uInfo;    // per pixel (w x h): its run's start in the rows' list, in the columns' list, its first plane, its run's length (cap) and count (cap + count * 65536)
uniform usampler2D uOffs;    // the runs' starts in the order of the list stepped (rows' or columns'), PW a row
uniform int uW;
uniform int uH;
uint offAt(int i) { return texelFetch(uOffs, ivec2(i % ${PW}, i / ${PW}), 0).r; }
// the place in the list's order (of the pixels lo .. hi - 1) whose run holds entry e
int findIn(int lo, int hi, uint e) {
  while (hi - lo > 1) {
    int mid = (lo + hi) >> 1;
    if (offAt(mid) <= e) lo = mid;
    else hi = mid;
  }
  return lo;
}
uvec4 info(ivec2 p) { return texelFetch(uInfo, p, 0); }
`;

// One step: the entries of one line (a row, or a column on the columns' list), each path's value from the line before.
const STEP = `${COMMON}
uniform usampler2D uRaw;     // the costs, in the list's order (four entries a texel)
uniform usampler2D uPrev;    // the values so far (the line before is read), in the list's order
uniform usampler2D uMin;     // per pixel: the least value of each path over its run (the line before is read)
uniform highp sampler2D uGuide;  // per pixel: the reference's filtered picture
uniform int uLine;           // the row (or column) worked out
uniform int uDir;            // +1 down (or right), -1 up (or left)
uniform int uCols;           // 1: the columns' list (one path, along the row)
uniform uint uFirst;         // the line's first entry and one past its last
uniform uint uLast;
uniform vec3 uGw;            // the guide's weights
out uvec4 outColor;
uint rawAt(uint e) { int t = int(e >> 2); return texelFetch(uRaw, ivec2(t % ${TW / 4}, t / ${TW / 4}), 0)[int(e & 3u)]; }
uint prevAt(uint e, int c) { return texelFetch(uPrev, ivec2(int(e) % ${TW}, int(e) / ${TW}), 0)[c]; }
void main() {
  uint e = uint(int(gl_FragCoord.y) * ${TW} + int(gl_FragCoord.x));
  if (e < uFirst || e >= uLast) discard;
  int n = uCols == 1 ? uH : uW;
  int o = findIn(uLine * n, uLine * n + n, e);
  int along = o - uLine * n;
  ivec2 p = uCols == 1 ? ivec2(uLine, along) : ivec2(along, uLine);
  uvec4 me = info(p);
  uint k = e - offAt(o);
  uint q = me.z + k;
  uint raw = rawAt(e);
  vec3 g = texelFetch(uGuide, p, 0).rgb;
  uvec4 outv = uvec4(0u);
  int paths = uCols == 1 ? 1 : 3;
  for (int c = 0; c < 3; c++) {
    if (c >= paths) break;
    // the neighbor on the line before: along the row (the columns' list), or the row before, diagonally one way, straight, diagonally the other way
    ivec2 nb = uCols == 1 ? ivec2(uLine - uDir, along) : ivec2(along + (c == 0 ? -uDir : c == 1 ? 0 : uDir), uLine - uDir);
    uint Lm = BIG;
    uint L0 = BIG;
    uint Lp = BIG;
    uint minPrev = BIG;
    float S = 1e9;
    if (nb.x >= 0 && nb.x < uW && nb.y >= 0 && nb.y < uH) {
      uvec4 ni = info(nb);
      uint base = uCols == 1 ? ni.y : ni.x;
      uint ncap = ni.w & 65535u;
      minPrev = texelFetch(uMin, nb, 0)[c];
      // (the neighbor's planes q - 1, q, q + 1, where they are in its run)
      int kn = int(q) - int(ni.z);
      if (kn - 1 >= 0 && kn - 1 < int(ncap)) Lm = prevAt(base + uint(kn - 1), uCols == 1 ? 0 : c);
      if (kn >= 0 && kn < int(ncap)) L0 = prevAt(base + uint(kn), uCols == 1 ? 0 : c);
      if (kn + 1 >= 0 && kn + 1 < int(ncap)) Lp = prevAt(base + uint(kn + 1), uCols == 1 ? 0 : c);
      vec3 d = abs(g - texelFetch(uGuide, nb, 0).rgb) * uGw;
      S = d.x + d.y + d.z;
    }
    uint P2 = uint(floor(500.0 * exp2(-min(126.0, S))));
    uint m = min(min(Lm + 1u, L0), min(Lp + 1u, min(65535u, P2 + minPrev)));
    uint lc = min(raw + m, 65535u);
    lc = lc > minPrev ? lc - minPrev : 0u;
    outv[c] = lc;
  }
  outColor = outv;
}`;

// The least value of each path over a pixel's run, for the pixels of one line.
const MIN = `${COMMON}
uniform usampler2D uPrev;
uniform int uCols;
out uvec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  uvec4 me = info(p);
  uint base = uCols == 1 ? me.y : me.x;
  uint cap = me.w & 65535u;
  uvec4 m = uvec4(65535u);
  for (uint k = 0u; k < cap; k++) {
    uint e = base + k;
    m = min(m, texelFetch(uPrev, ivec2(int(e) % ${TW}, int(e) / ${TW}), 0));
  }
  outColor = m;
}`;

// The total: the sweep's values added in (the columns' sweeps read through to their own list).
const ADD = `${COMMON}
uniform usampler2D uTotal;
uniform usampler2D uSweep;    // the sweep's even steps
uniform usampler2D uSweep1;   // and its odd ones (a step reads the one before, so they alternate)
uniform int uDir;
uniform usampler2D uColOffs; // the runs' starts in the columns' list, in the rows' order
uniform int uCols;
uniform int uPaths;
uniform uint uCount;
out uvec4 outColor;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  uint e = uint(t.y * ${TW} + t.x);
  uint total = texelFetch(uTotal, t, 0).r;
  if (e >= uCount) {
    outColor = uvec4(total);
    return;
  }
  int i = findIn(0, uW * uH, e);
  uint s = e;
  if (uCols == 1) s = texelFetch(uColOffs, ivec2(i % ${PW}, i / ${PW}), 0).r + (e - offAt(i));
  // (the step that made it: its line, counted from where the sweep began)
  int line = uCols == 1 ? i % uW : i / uW;
  int lines = uCols == 1 ? uW : uH;
  int step = uDir > 0 ? line : lines - 1 - line;
  ivec2 at = ivec2(int(s) % ${TW}, int(s) / ${TW});
  uvec4 v = (step & 1) == 0 ? texelFetch(uSweep, at, 0) : texelFetch(uSweep1, at, 0);
  for (int c = 0; c < 3; c++) if (c < uPaths) total = min(65535u, total + v[c]);
  outColor = uvec4(total);
}`;

// Each pixel's plane of least total (the first if two tie), the total there and the least one not next to it.
const WTA = `${COMMON}
uniform usampler2D uTotal;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  uvec4 me = info(p);
  uint count = me.w >> 16;
  uint best = 65535u;
  uint arg = 0u;
  for (uint k = 0u; k < count; k++) {
    uint e = me.x + k;
    uint v = texelFetch(uTotal, ivec2(int(e) % ${TW}, int(e) / ${TW}), 0).r;
    if (v < best) {
      best = v;
      arg = k;
    }
  }
  uint second = 65535u;
  for (uint k = 0u; k < count; k++) {
    if (k + 1u >= arg && k <= arg + 1u) continue;
    uint e = me.x + k;
    second = min(second, texelFetch(uTotal, ivec2(int(e) % ${TW}, int(e) / ${TW}), 0).r);
  }
  outColor = vec4(float(arg), float(best), float(second), 1.0);
}`;

// The costs in the columns' order from the rows' (when they come from the card, gpu/l16classic.js costsTex): each entry of the columns' list finds its pixel and plane.
const GATHER = `${COMMON}
uniform usampler2D uRaw;
uniform usampler2D uRowOffs;   // the runs' starts in the rows' list, PW a row
uniform uint uCount;
out uvec4 outColor;
uint rawAt(uint e) { int t = int(e >> 2); return texelFetch(uRaw, ivec2(t % ${TW / 4}, t / ${TW / 4}), 0)[int(e & 3u)]; }
void main() {
  // (four entries a texel, all the same pixel's: its run starts at a multiple of 8 in both lists)
  uint e = 4u * uint(int(gl_FragCoord.y) * ${TW / 4} + int(gl_FragCoord.x));
  if (e >= uCount) {
    outColor = uvec4(0u);
    return;
  }
  int j = findIn(0, uW * uH, e);
  uint k = e - offAt(j);
  int i = (j % uH) * uW + j / uH;
  uint s = texelFetch(uRowOffs, ivec2(i % ${PW}, i / ${PW}), 0).r + k;
  outColor = uvec4(rawAt(s), rawAt(s + 1u), rawAt(s + 2u), rawAt(s + 3u));
}`;

// On `gpu` (a GpuRenderer): smooth({ w, h, start, count, cap, off, raw (Uint8Array of off[w * h]), guide (Float32Array, 3 per pixel), gw (3) }) -> { arg, best, second }
// (Float32Array per pixel: the plane of least total in the pixel's range, that total, and the least total not next to it).
export function l16ClassicSgmGpu(gpu) {
  const gl = gpu.gl;
  const progs = {};
  const prog = (name, src) => (progs[name] = progs[name] || program(gl, src));
  return function smooth({ w, h, start, count, cap, off, raw, rawTex = null, guide, gw }) {
    const npx = w * h;
    const E = off[npx];
    const rows = Math.max(1, Math.ceil(E / TW));
    const prow = Math.max(1, Math.ceil(npx / PW));
    // the columns' list: the pixels in column order
    const offC = new Uint32Array(npx + 1);
    const colOrder = new Uint32Array(npx);
    {
      let at = 0;
      let j = 0;
      for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++, j++) {
          const i = y * w + x;
          colOrder[j] = at;
          offC[i] = at;
          at += cap[i];
        }
      }
      offC[npx] = at;
    }
    const made = [];
    const tex = (tw, th, internal, format, type, data) => {
      const t = gpu.texture(tw, th, internal);
      made.push(t);
      if (data) {
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, tw, th, format, type, data);
      }
      return t;
    };
    const pad = (Type, src, n) => {
      const out = new Type(n);
      out.set(src.subarray ? src.subarray(0, Math.min(src.length, n)) : src);
      return out;
    };
    try {
      // the pixel tables
      const infoD = new Uint32Array(4 * npx);
      for (let i = 0; i < npx; i++) infoD.set([off[i], offC[i], start[i], cap[i] + count[i] * 65536], 4 * i);
      const infoTex = tex(w, h, gl.RGBA32UI, gl.RGBA_INTEGER, gl.UNSIGNED_INT, infoD);
      const offRowTex = tex(PW, prow, gl.R32UI, gl.RED_INTEGER, gl.UNSIGNED_INT, pad(Uint32Array, off, PW * prow));
      const offColTex = tex(PW, prow, gl.R32UI, gl.RED_INTEGER, gl.UNSIGNED_INT, pad(Uint32Array, colOrder, PW * prow));
      const colOfRowTex = tex(PW, prow, gl.R32UI, gl.RED_INTEGER, gl.UNSIGNED_INT, pad(Uint32Array, offC, PW * prow));
      const gd = new Float32Array(4 * npx);
      for (let i = 0; i < npx; i++) gd.set([guide[3 * i], guide[3 * i + 1], guide[3 * i + 2], 0], 4 * i);
      const guideTex = tex(w, h, gl.RGBA32F, gl.RGBA, gl.FLOAT, gd);
      // the costs in both orders
      let rawRow;
      let rawCol;
      if (rawTex) {
        // (left on the card by the costs: the columns' copy made here too)
        rawRow = rawTex;
        rawCol = tex(TW / 4, rows, gl.RGBA8UI);
        const G = prog('gather', GATHER);
        gpu.target(rawCol, TW / 4, rows);
        gl.useProgram(G.p);
        gl.uniform1i(G.u.uInfo, 1);
        gpu.bindTex(1, infoTex);
        gl.uniform1i(G.u.uOffs, 2);
        gpu.bindTex(2, offColTex);
        gl.uniform1i(G.u.uW, w);
        gl.uniform1i(G.u.uH, h);
        gl.uniform1i(G.u.uRaw, 3);
        gpu.bindTex(3, rawRow);
        gl.uniform1i(G.u.uRowOffs, 4);
        gpu.bindTex(4, offRowTex);
        gl.uniform1ui(G.u.uCount, offC[npx]);
        gpu.draw();
      } else {
        rawRow = tex(TW / 4, rows, gl.RGBA8UI, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, pad(Uint8Array, raw, TW * rows));
        const rawColD = new Uint8Array(TW * rows);
        for (let i = 0; i < npx; i++) rawColD.set(raw.subarray(off[i], off[i] + cap[i]), offC[i]);
        rawCol = tex(TW / 4, rows, gl.RGBA8UI, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, rawColD);
      }
      const sweeps = [tex(TW, rows, gl.RGBA16UI), tex(TW, rows, gl.RGBA16UI)];
      const mins = tex(w, h, gl.RGBA16UI);
      const totals = [tex(TW, rows, gl.R32UI), tex(TW, rows, gl.R32UI)];
      let cur = 0;
      gpu.target(totals[0], TW, rows);
      gl.clearBufferuiv(gl.COLOR, 0, new Uint32Array([0, 0, 0, 0]));

      const bindCommon = (P, offTex) => {
        gl.useProgram(P.p);
        gl.uniform1i(P.u.uInfo, 1);
        gpu.bindTex(1, infoTex);
        gl.uniform1i(P.u.uOffs, 2);
        gpu.bindTex(2, offTex);
        gl.uniform1i(P.u.uW, w);
        gl.uniform1i(P.u.uH, h);
      };
      const S = prog('step', STEP);
      const M = prog('min', MIN);
      const A = prog('add', ADD);
      for (const cols of [0, 1]) {
        for (const dir of [1, -1]) {
          const lines = cols ? w : h;
          const n = cols ? h : w;
          const starts = cols ? colOrder : off;
          const ends = (l) => (l * n + n < npx ? starts[l * n + n] : cols ? offC[npx] : off[npx]);
          for (let s = 0; s < lines; s++) {
            const line = dir > 0 ? s : lines - 1 - s;
            const first = starts[line * n];
            const last = ends(line);
            // the line's entries
            const sweep = sweeps[s & 1];
            gpu.target(sweep, TW, rows);
            gl.enable(gl.SCISSOR_TEST);
            gl.scissor(0, Math.floor(first / TW), TW, Math.floor((last - 1) / TW) - Math.floor(first / TW) + 1);
            bindCommon(S, cols ? offColTex : offRowTex);
            gl.uniform1i(S.u.uRaw, 3);
            gpu.bindTex(3, cols ? rawCol : rawRow);
            gl.uniform1i(S.u.uPrev, 4);
            gpu.bindTex(4, sweeps[1 - (s & 1)]);
            gl.uniform1i(S.u.uMin, 5);
            gpu.bindTex(5, mins);
            gl.uniform1i(S.u.uGuide, 6);
            gpu.bindTex(6, guideTex);
            gl.uniform1i(S.u.uLine, line);
            gl.uniform1i(S.u.uDir, dir);
            gl.uniform1i(S.u.uCols, cols);
            gl.uniform1ui(S.u.uFirst, first);
            gl.uniform1ui(S.u.uLast, last);
            gl.uniform3f(S.u.uGw, gw[0], gw[1], gw[2]);
            gpu.draw();
            // the line's least values
            gpu.target(mins, w, h);
            if (cols) gl.scissor(line, 0, 1, h);
            else gl.scissor(0, line, w, 1);
            bindCommon(M, cols ? offColTex : offRowTex);
            gl.uniform1i(M.u.uPrev, 3);
            gpu.bindTex(3, sweep);
            gl.uniform1i(M.u.uCols, cols);
            gpu.draw();
            gl.disable(gl.SCISSOR_TEST);
          }
          // the sweep into the total
          gpu.target(totals[1 - cur], TW, rows);
          bindCommon(A, offRowTex);
          gl.uniform1i(A.u.uTotal, 3);
          gpu.bindTex(3, totals[cur]);
          gl.uniform1i(A.u.uSweep, 4);
          gpu.bindTex(4, sweeps[0]);
          gl.uniform1i(A.u.uSweep1, 6);
          gpu.bindTex(6, sweeps[1]);
          gl.uniform1i(A.u.uDir, dir);
          gl.uniform1i(A.u.uColOffs, 5);
          gpu.bindTex(5, colOfRowTex);
          gl.uniform1i(A.u.uCols, cols);
          gl.uniform1i(A.u.uPaths, cols ? 1 : 3);
          gl.uniform1ui(A.u.uCount, E);
          gpu.draw();
          cur = 1 - cur;
        }
      }
      // each pixel's least plane
      const W = prog('wta', WTA);
      const res = tex(w, h, gl.RGBA32F);
      gpu.target(res, w, h);
      bindCommon(W, offRowTex);
      gl.uniform1i(W.u.uTotal, 3);
      gpu.bindTex(3, totals[cur]);
      gpu.draw();
      const buf = new Float32Array(4 * npx);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, buf);
      const arg = new Float32Array(npx);
      const best = new Float32Array(npx);
      const second = new Float32Array(npx);
      for (let i = 0; i < npx; i++) {
        arg[i] = buf[4 * i];
        best[i] = buf[4 * i + 1];
        second[i] = buf[4 * i + 2];
      }
      return { arg, best, second };
    } finally {
      gl.disable(gl.SCISSOR_TEST);
      for (const t of made) gl.deleteTexture(t);
    }
  };
}
