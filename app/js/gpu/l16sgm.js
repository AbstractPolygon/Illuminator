// The semi-global smoothing of the Light L16 depth (core/l16depth.js depthFinish) on the graphics card, in the same integer steps as the processor, so the result is the same
// to the bit. Each direction's scan is one draw a column (or a row): every line along the scan and every depth step at once, the column before it read from the other of two
// textures (even and odd columns are kept apart, as a draw cannot read the texture it writes). Each direction's costs are read back and added up on the processor, which
// keeps the graphics memory needed to about two copies of the cost volume.
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

// On `gpu` (a GpuRenderer): a function ({ cost (Uint8Array or Uint16Array, w h NZ), w, h, NZ, P1, edgeX, edgeY (Uint32Array, w h: floor(P2) at each edge), onDirection }) -> Uint16Array
// total (w h NZ), the four directions' costs added (wrapping at 65536, as the processor's Uint16Array). Throws where the card cannot hold the volume.
export function l16SgmGpu(gpu) {
  const gl = gpu.gl;
  let prog = null;
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
      const total = new Uint16Array(w * h * NZ);
      const u = prog.u;
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
          // the costs read back, a band of rows at a time, and added to the total
          for (let p = 0; p < 2; p++) {
            gpu.target(L[p], ll.TW, ll.height);
            const chunk = Math.max(1, Math.floor((1 << 22) / (4 * ll.TW)));
            const buf = new Uint32Array(4 * ll.TW * chunk);
            for (let b = 0; b < ll.bands; b++) {
              const bw = Math.min(ll.TW, ll.C - b * ll.TW);
              for (let r0 = 0; r0 < ll.R; r0 += chunk) {
                const rows = Math.min(chunk, ll.R - r0);
                gl.readPixels(0, b * ll.R + r0, bw, rows, gl.RGBA_INTEGER, gl.UNSIGNED_INT, buf);
                for (let r = 0; r < rows; r++) {
                  for (let X = 0; X < bw; X++) {
                    const t = b * ll.TW + X;
                    const cell = (t / G) | 0;
                    const g = t - cell * G;
                    const x = horizontal ? 2 * cell + p : cell;
                    const y = horizontal ? r0 + r : 2 * (r0 + r) + p;
                    if (x >= w || y >= h) continue;
                    const base = (y * w + x) * NZ + 4 * g;
                    const src = 4 * (r * bw + X);
                    for (let c = 0; c < 4 && 4 * g + c < NZ; c++) total[base + c] += buf[src + c];
                  }
                }
              }
            }
          }
        } finally {
          gl.deleteTexture(L[0]);
          gl.deleteTexture(L[1]);
        }
        onDirection();
      }
      return total;
    } finally {
      for (const t of made) gl.deleteTexture(t);
    }
  };
}
