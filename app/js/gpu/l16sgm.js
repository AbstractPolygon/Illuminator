// The semi-global smoothing of the Light L16 depth (core/l16depth.js depthFinish) on the graphics card, in the same integer steps as the processor, so the result is the same
// to the bit. Each direction's scan is one draw a column (or a row): every line along the scan and every depth step at once, the column before it read from the other of two
// textures (even and odd columns are kept apart, as a draw cannot read the texture it writes). Each direction's costs are added to a running total on the card, and each
// pixel's winner found there; only the winners are read back.
//
// Layout: the cost volume of w x h pixels and NZ steps is G = ceil(NZ / 4) texels a pixel, four steps each (RGBA16UI): texel column t = x G + g of row y holds steps 4g to
// 4g + 3. A row longer than the card's textures are wide is wrapped into bands of TW texels (a multiple of G, so no pixel is split), stacked: (t mod TW, (t / TW) R + y).
import { program } from './renderer.js';

const STEP = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uCost;
uniform usampler2D uPrev;   // the scan's costs at the line before (the other parity's texture)
uniform usampler2D uEdge;   // floor(P2) at the edge between a pixel and the next one along the scan's axis
uniform int uHorizontal;
uniform int uLine;          // the column (or row) drawn
uniform int uStep;          // +1 or -1 along the scan
uniform int uFirst;
uniform int uNZ;
uniform int uG;
uniform uint uP1;
uniform int uCostTW;        // the cost texture's band width (its rows: h)
uniform int uTW;            // the scan textures' band width
uniform int uR;             // and rows a band
out uvec4 outCost;
ivec2 place(int t, int r, int tw, int rows) { return ivec2(t % tw, (t / tw) * rows + r); }
ivec2 at(int x, int y, int g) {
  return uHorizontal == 1 ? place((x >> 1) * uG + g, y, uTW, uR) : place(x * uG + g, y >> 1, uTW, uR);
}
uint prevAt(int x, int y, int k) {
  uvec4 t = texelFetch(uPrev, at(x, y, k >> 2), 0);
  int c = k & 3;
  return c == 0 ? t.r : c == 1 ? t.g : c == 2 ? t.b : t.a;
}
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  int t = (f.y / uR) * uTW + f.x;
  int r = f.y % uR;
  int x;
  int y;
  int g;
  if (uHorizontal == 1) {
    x = uLine;
    y = r;
    g = t - (uLine >> 1) * uG;
  } else {
    y = uLine;
    x = t / uG;
    g = t - x * uG;
  }
  uvec4 cost = texelFetch(uCost, place(x * uG + g, y, uCostTW, textureSize(uEdge, 0).y), 0);
  if (uFirst == 1) {
    outCost = cost;
    return;
  }
  int px = uHorizontal == 1 ? x - uStep : x;
  int py = uHorizontal == 1 ? y : y - uStep;
  uint minPrev = 65535u;
  for (int k = 0; k < uNZ; k++) minPrev = min(minPrev, prevAt(px, py, k));
  uint F = texelFetch(uEdge, uHorizontal == 1 ? ivec2(min(x, px), y) : ivec2(x, min(y, py)), 0).r;
  uvec4 cur;
  for (int c = 0; c < 4; c++) {
    int k = 4 * g + c;
    uint v = 0u;
    if (k < uNZ) {
      uint best = prevAt(px, py, k);
      if (k > 0) best = min(best, prevAt(px, py, k - 1) + uP1);
      if (k < uNZ - 1) best = min(best, prevAt(px, py, k + 1) + uP1);
      uint here = c == 0 ? cost.r : c == 1 ? cost.g : c == 2 ? cost.b : cost.a;
      uint d = best - minPrev;
      v = (here + (d > F ? F : d)) & 65535u;
    }
    if (c == 0) cur.r = v;
    else if (c == 1) cur.g = v;
    else if (c == 2) cur.b = v;
    else cur.a = v;
  }
  outCost = cur;
}`;

// The directions' costs added up (wrapping at 65536, as the processor's Uint16Array): the total, laid out as the cost volume, plus the costs of the direction just scanned
// (from its two parities' textures).
const ADD = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uTotal;
uniform usampler2D uL0;
uniform usampler2D uL1;
uniform int uHasTotal;
uniform int uHorizontal;
uniform int uG;
uniform int uW;
uniform int uH;
uniform int uTW;     // the total's band width (rows a band: h)
uniform int uLTW;    // the scan textures' band width
uniform int uLR;     // and rows a band
out uvec4 outCost;
ivec2 place(int t, int r, int tw, int rows) { return ivec2(t % tw, (t / tw) * rows + r); }
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  int t = (f.y / uH) * uTW + f.x;
  int y = f.y % uH;
  int x = t / uG;
  int g = t - x * uG;
  if (x >= uW) {
    outCost = uvec4(0u);
    return;
  }
  uvec4 l;
  if (uHorizontal == 1) {
    ivec2 q = place((x >> 1) * uG + g, y, uLTW, uLR);
    l = (x & 1) == 0 ? texelFetch(uL0, q, 0) : texelFetch(uL1, q, 0);
  } else {
    ivec2 q = place(x * uG + g, y >> 1, uLTW, uLR);
    l = (y & 1) == 0 ? texelFetch(uL0, q, 0) : texelFetch(uL1, q, 0);
  }
  uvec4 old = uHasTotal == 1 ? texelFetch(uTotal, f, 0) : uvec4(0u);
  outCost = (old + l) & uvec4(65535u);
}`;

// Each pixel's winner from the total (core/l16depth.js depthFinish): the first step with the least cost, that cost, the least cost more than one step from it (65535
// if none), and the costs of the steps either side (a | c << 16; 0 where there is none).
const WINNER = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uTotal;
uniform int uG;
uniform int uNZ;
uniform int uH;
uniform int uTW;
out uvec4 outWin;
uint at(int x, int y, int k) {
  int t = x * uG + (k >> 2);
  uvec4 v = texelFetch(uTotal, ivec2(t % uTW, (t / uTW) * uH + y), 0);
  int c = k & 3;
  return c == 0 ? v.r : c == 1 ? v.g : c == 2 ? v.b : v.a;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int best = 0;
  uint bc = 65535u;
  for (int k = 0; k < uNZ; k++) {
    uint c = at(p.x, p.y, k);
    if (c < bc) {
      bc = c;
      best = k;
    }
  }
  uint second = 65535u;
  for (int k = 0; k < uNZ; k++) {
    if (k >= best - 1 && k <= best + 1) continue;
    second = min(second, at(p.x, p.y, k));
  }
  uint a = best > 0 ? at(p.x, p.y, best - 1) : 0u;
  uint c = best < uNZ - 1 ? at(p.x, p.y, best + 1) : 0u;
  outWin = uvec4(uint(best), bc, second, a | (c << 16));
}`;

// On `gpu` (a GpuRenderer): a function ({ cost (Uint8Array or Uint16Array, w h NZ), w, h, NZ, P1, edgeX, edgeY (Uint32Array, w h: floor(P2) at each edge), onDirection }) -> Uint32Array
// of 4 a pixel: the winner of the four directions' costs added (WINNER above). Throws where the card cannot hold the volume.
export function l16SgmGpu(gpu) {
  const gl = gpu.gl;
  let prog = null;
  let addProg = null;
  let winProg = null;
  return function smooth({ cost, w, h, NZ, P1, edgeX, edgeY, onDirection = () => {} }) {
    const G = Math.ceil(NZ / 4);
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (!Number.isInteger(P1) || P1 < 0) throw new Error('P1 is not a whole number');
    // A texture of C texel columns and R rows, wrapped into bands (above); null where even that does not fit.
    const layout = (C, R) => {
      const TW = Math.min(C, Math.floor(max / G) * G);
      const bands = Math.ceil(C / TW);
      if (TW < G || R * bands > max || w > max || h > max) throw new Error('The depth volume is larger than the graphics card textures');
      return { C, R, TW, bands, height: R * bands };
    };
    prog = prog || program(gl, STEP);
    addProg = addProg || program(gl, ADD);
    winProg = winProg || program(gl, WINNER);
    const made = [];
    const tex = (tw, th, internal) => {
      const t = gpu.texture(tw, th, internal);
      made.push(t);
      return t;
    };
    try {
      // the cost volume, laid out as above (each pixel's steps padded to 4 G; one byte a step, or two)
      let packed = cost;
      if (NZ !== 4 * G) {
        packed = new cost.constructor(w * h * 4 * G);
        for (let i = 0; i < w * h; i++) packed.set(cost.subarray(i * NZ, (i + 1) * NZ), i * 4 * G);
      }
      const cl = layout(w * G, h);
      const bytes = cost instanceof Uint8Array;
      const costTex = tex(cl.TW, cl.height, bytes ? gl.RGBA8UI : gl.RGBA16UI);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, cl.C);
      for (let b = 0; b < cl.bands; b++) {
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, b * cl.TW);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, b * h, Math.min(cl.TW, cl.C - b * cl.TW), h, gl.RGBA_INTEGER, bytes ? gl.UNSIGNED_BYTE : gl.UNSIGNED_SHORT, packed);
      }
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
      const edgeTex = (data) => {
        const t = tex(w, h, gl.R32UI);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED_INTEGER, gl.UNSIGNED_INT, data);
        return t;
      };
      const ex = edgeTex(edgeX);
      const ey = edgeTex(edgeY);
      // (the total so far and the next one, swapped after each direction)
      const T = [tex(cl.TW, cl.height, gl.RGBA16UI), tex(cl.TW, cl.height, gl.RGBA16UI)];
      const u = prog.u;
      let dir = 0;
      for (const [horizontal, step] of [[1, 1], [1, -1], [0, 1], [0, -1]]) {
        const lines = horizontal ? w : h;
        // the two parities' textures: half the columns (or rows) each
        const ll = horizontal ? layout(Math.ceil(w / 2) * G, h) : layout(w * G, Math.ceil(h / 2));
        const L = [gpu.texture(ll.TW, ll.height, gl.RGBA16UI), gpu.texture(ll.TW, ll.height, gl.RGBA16UI)];
        try {
          gl.useProgram(prog.p);
          gl.uniform1i(u.uCost, 1);
          gpu.bindTex(1, costTex);
          gl.uniform1i(u.uEdge, 3);
          gpu.bindTex(3, horizontal ? ex : ey);
          gl.uniform1i(u.uPrev, 2);
          gl.uniform1i(u.uHorizontal, horizontal);
          gl.uniform1i(u.uStep, step);
          gl.uniform1i(u.uNZ, NZ);
          gl.uniform1i(u.uG, G);
          gl.uniform1ui(u.uP1, P1);
          gl.uniform1i(u.uCostTW, cl.TW);
          gl.uniform1i(u.uTW, ll.TW);
          gl.uniform1i(u.uR, ll.R);
          for (let n = 0; n < lines; n++) {
            const line = step > 0 ? n : lines - 1 - n;
            gpu.target(L[line & 1], ll.TW, ll.height);
            gpu.bindTex(2, L[(line & 1) ^ 1]);
            gl.uniform1i(u.uLine, line);
            gl.uniform1i(u.uFirst, n === 0 ? 1 : 0);
            if (horizontal) {
              // the column's G texels, in one band
              const t0 = (line >> 1) * G;
              gl.viewport(t0 % ll.TW, Math.floor(t0 / ll.TW) * ll.R, G, ll.R);
              gpu.draw();
            } else {
              // the row, across the bands
              for (let b = 0; b < ll.bands; b++) {
                gl.viewport(0, b * ll.R + (line >> 1), Math.min(ll.TW, ll.C - b * ll.TW), 1);
                gpu.draw();
              }
            }
          }
          // the direction's costs added to the total, on the card
          const into = T[(dir + 1) & 1];
          gpu.target(into, cl.TW, cl.height);
          gl.useProgram(addProg.p);
          const a = addProg.u;
          gl.uniform1i(a.uTotal, 1);
          gpu.bindTex(1, T[dir & 1]);
          gl.uniform1i(a.uL0, 2);
          gpu.bindTex(2, L[0]);
          gl.uniform1i(a.uL1, 3);
          gpu.bindTex(3, L[1]);
          gl.uniform1i(a.uHasTotal, dir > 0 ? 1 : 0);
          gl.uniform1i(a.uHorizontal, horizontal);
          gl.uniform1i(a.uG, G);
          gl.uniform1i(a.uW, w);
          gl.uniform1i(a.uH, h);
          gl.uniform1i(a.uTW, cl.TW);
          gl.uniform1i(a.uLTW, ll.TW);
          gl.uniform1i(a.uLR, ll.R);
          gpu.draw();
        } finally {
          gl.deleteTexture(L[0]);
          gl.deleteTexture(L[1]);
        }
        dir++;
        onDirection();
      }
      // each pixel's winner, read back
      const win = tex(w, h, gl.RGBA32UI);
      gpu.target(win, w, h);
      gl.useProgram(winProg.p);
      gl.uniform1i(winProg.u.uTotal, 1);
      gpu.bindTex(1, T[dir & 1]);
      gl.uniform1i(winProg.u.uG, G);
      gl.uniform1i(winProg.u.uNZ, NZ);
      gl.uniform1i(winProg.u.uH, h);
      gl.uniform1i(winProg.u.uTW, cl.TW);
      gpu.draw();
      const out = new Uint32Array(4 * w * h);
      gl.readPixels(0, 0, w, h, gl.RGBA_INTEGER, gl.UNSIGNED_INT, out);
      return out;
    } finally {
      for (const t of made) gl.deleteTexture(t);
    }
  };
}
