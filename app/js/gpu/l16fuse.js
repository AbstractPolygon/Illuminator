// The merge of a Light L16 photo's cameras (core/l16fusion.js fuse) on the graphics card, with the processor's rules in single precision: the reference camera's picture
// laid on its undistorted grid, and each other camera's picture looked up where the depth puts every pixel (the calibrated pose, the lens distortion, the capture's
// correction, a bilinear lookup), its colors brought to the reference's locally, with its weight by how well it agrees with the reference (core/l16fusion.js mergeShare). The output is made in bands of rows (the full size merge is 4160 x 3120); each
// band's result is read back and added up on the processor, which keeps the graphics memory needed to the cameras' pictures and a band.
import { program } from './renderer.js';
import { l16FilterTextures } from './l16filters.js';

const COMMON = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform vec4 uDa;     // distortion: k1, k2, k3, p1
uniform vec4 uDb;     // p2, nx, ny, cx
uniform float uDcy;   // cy
uniform int uHasDist;
uniform float uS;     // sensor pixels a grid pixel
uniform int uRow0;    // the band's first row
vec2 distort(vec2 q) {
  if (uHasDist == 0) return q;
  float u = (q.x - uDb.w) / uDb.y;
  float v = (q.y - uDcy) / uDb.z;
  float rr = u * u + v * v;
  float uv2 = 2.0 * u * v;
  float k = 1.0 + ((uDa.z * rr + uDa.y) * rr + uDa.x) * rr;
  return vec2(uDb.w + uDb.y * (uDa.w * uv2 + uDb.x * (rr + 2.0 * u * u) + k * u), uDcy + uDb.z * (uDb.x * uv2 + uDa.w * (rr + 2.0 * v * v) + k * v));
}
// the picture (rgb) at a point in its pixels, bilinear; false outside (as the processor's bilinear)
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
float luma(vec3 c) { return 0.3 * c.r + 0.55 * c.g + 0.15 * c.b; }
`;

// The reference on its undistorted grid: (rgb, 1) where its picture covers the pixel, else 0.
const REF = `${COMMON}
uniform sampler2D uImg;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) + ivec2(0, uRow0);
  vec3 c;
  bool ok = look(uImg, distort((vec2(p) + 0.5) * uS) / uS, c);
  outColor = ok ? vec4(c, 1.0) : vec4(0.0);
}`;

// The camera's picture at each pixel of the reference's grid where the reference has one: (rgb, 1), else 0.
const CAM = `${COMMON}
uniform sampler2D uImg;
uniform sampler2D uRefU;   // the band of the reference on the grid: (rgb, 1 where valid)
uniform sampler2D uZ;      // the band's depth, mm
uniform vec4 uK;           // the reference: fx, cx, fy, cy
uniform vec4 uCK;          // this camera: fx, cx, fy, cy
uniform mat3 uR;           // rows of R (relative pose)
uniform vec3 uT;
uniform vec3 uCx;          // the capture's correction (a0, a1, a2) of x; 0 for none
uniform vec3 uCy;
out vec4 outColor;
void main() {
  ivec2 b = ivec2(gl_FragCoord.xy);
  ivec2 p = b + ivec2(0, uRow0);
  outColor = vec4(0.0);
  if (texelFetch(uRefU, b, 0).a == 0.0) return;
  float Z = texelFetch(uZ, b, 0).r;
  vec3 P = vec3(((float(p.x) + 0.5) * uS - uK.y) / uK.x * Z, ((float(p.y) + 0.5) * uS - uK.w) / uK.z * Z, Z);
  float Pz = dot(uR[2], P) + uT.z;
  if (Pz <= 1.0) return;
  vec2 s = distort(vec2(uCK.x * (dot(uR[0], P) + uT.x) / Pz + uCK.y, uCK.z * (dot(uR[1], P) + uT.y) / Pz + uCK.w));
  vec2 uv = s / vec2(4160.0, 3120.0);
  s += vec2(uCx.x + uCx.y * uv.x + uCx.z * uv.y, uCy.x + uCy.y * uv.x + uCy.z * uv.y);
  vec3 smp;
  if (!look(uImg, s / uS, smp)) return;
  outColor = vec4(smp, 1.0);
}`;

// The two pictures where both have a pixel (for their local color ratio): r g b times that, and the mask.
const MASKED = `${COMMON}
uniform sampler2D uA;   // (rgb, any)
uniform sampler2D uOk;  // a: 1 where both have a pixel
out vec4 outColor;
void main() {
  ivec2 b = ivec2(gl_FragCoord.xy);
  float ok = texelFetch(uOk, b, 0).a;
  outColor = vec4(texelFetch(uA, b, 0).rgb * ok, ok);
}`;

// The camera's share (core/l16fusion.js mergeShare): its colors brought to the reference's locally, and its weight for the pixel alone.
const SHARE = `${COMMON}
uniform sampler2D uRefU;
uniform sampler2D uSmp;
uniform sampler2D uRefL;   // the blurred masked reference (rgb, the mask's blur)
uniform sampler2D uSmpL;   // and the camera's
uniform int uMono;
uniform float uMg;
uniform vec3 uGain;
out vec4 outColor;
float sig(float v) { return 0.012 + 0.07 * sqrt(max(v, 0.0)) * 0.35; }
void main() {
  ivec2 b = ivec2(gl_FragCoord.xy);
  vec4 sm = texelFetch(uSmp, b, 0);
  outColor = vec4(0.0);
  if (sm.a == 0.0) return;
  vec3 ref = texelFetch(uRefU, b, 0).rgb;
  vec4 rl4 = texelFetch(uRefL, b, 0);
  vec4 sl4 = texelFetch(uSmpL, b, 0);
  bool enough = rl4.a > 0.3;
  vec3 k;
  for (int c = 0; c < 3; c++) {
    int cc = uMono == 1 ? 1 : c;
    float ratio = enough && sl4[cc] > 1e-4 ? rl4[uMono == 1 ? 1 : c] / sl4[cc] : (uMono == 1 ? uMg : uGain[c]);
    k[c] = clamp(ratio, 0.25, 4.0);
  }
  float rl = luma(ref);
  vec3 col;
  if (uMono == 1) {
    float q = clamp(sm.g * k.g / max(1e-4, ref.g), 0.0, 4.0);
    col = ref * q;
  } else col = sm.rgb * k;
  float d = abs(luma(col) - rl) / sig(rl);
  if (uMono == 0) d = max(d, max(abs(col.r - ref.r) / (1.5 * sig(ref.r)), max(abs(col.g - ref.g) / (1.5 * sig(ref.g)), abs(col.b - ref.b) / (1.5 * sig(ref.b)))));
  outColor = vec4(col, exp(-0.5 * d * d));
}`;

// The weight: the lower of the pixel's own and its neighborhood's (a box of 5 x 5); none under 0.02. (rgb times it, it)
const WEIGHT = `${COMMON}
uniform sampler2D uShare;
uniform sampler2D uNear;   // a: the share's weight blurred
uniform sampler2D uSmp;
layout(location = 0) out vec4 outShare;
layout(location = 1) out vec4 outAgree;
void main() {
  ivec2 b = ivec2(gl_FragCoord.xy);
  outShare = vec4(0.0);
  outAgree = vec4(0.0);
  if (texelFetch(uSmp, b, 0).a == 0.0) return;
  vec4 sh = texelFetch(uShare, b, 0);
  float w = min(sh.a, texelFetch(uNear, b, 0).a);
  if (w < 0.02) return;
  outShare = vec4(sh.rgb * w, w);
  outAgree = vec4(w > 0.5 ? 1.0 : 0.0, 0.0, 0.0, 1.0);
}`;

const setDist = (gl, u, dist) => {
  const p = dist && dist.params;
  gl.uniform1i(u.uHasDist, p ? 1 : 0);
  if (!p) return;
  gl.uniform4f(u.uDa, p.k1, p.k2, p.k3, p.p1);
  gl.uniform4f(u.uDb, p.p2, p.nx, p.ny, p.cx);
  gl.uniform1f(u.uDcy, p.cy);
};

// The merge kept on the card (begin / camera / end, for a merge made in one band: the half size one): the running sums, the reference's samples and the cameras' shares
// added in, rgb times the weight and the weight; and the count of a camera's pixels that agreed (16 x 16 blocks summed, then the blocks of blocks).
const ACC = `${COMMON}
uniform sampler2D uAcc;
uniform sampler2D uAdd;    // init: the reference (rgb, valid); add: the camera's share (rgb times its weight, the weight)
uniform int uInit;
out vec4 outColor;
void main() {
  ivec2 b = ivec2(gl_FragCoord.xy);
  vec4 a = texelFetch(uAdd, b, 0);
  if (uInit == 1) {
    // (as the processor starts: the reference's samples, weighed 1 where it has a pixel)
    outColor = vec4(a.rgb, a.a > 0.0 ? 1.0 : 0.0);
    return;
  }
  vec4 acc = texelFetch(uAcc, b, 0);
  outColor = a.a > 0.0 ? acc + a : acc;
}`;
const COUNT = `${COMMON}
uniform sampler2D uSrc;
uniform sampler2D uFlags;  // first pass: the agree flags (r > 0.5) where the share's weight is above 0
uniform int uFirst;
out vec4 outColor;
void main() {
  ivec2 o = ivec2(gl_FragCoord.xy) * 16;
  ivec2 size = textureSize(uSrc, 0);
  float n = 0.0;
  for (int y = 0; y < 16; y++) {
    for (int x = 0; x < 16; x++) {
      ivec2 q = o + ivec2(x, y);
      if (q.x >= size.x || q.y >= size.y) continue;
      if (uFirst == 1) n += texelFetch(uSrc, q, 0).a > 0.0 && texelFetch(uFlags, q, 0).r > 0.5 ? 1.0 : 0.0;
      else n += texelFetch(uSrc, q, 0).r;
    }
  }
  outColor = vec4(n, 0.0, 0.0, 1.0);
}`;

// On `gpu` (a GpuRenderer): { reference(job), camera(job) }, the two steps of fuse (core/l16fusion.js), as described there.
export function l16FuseGpu(gpu) {
  const gl = gpu.gl;
  const filters = l16FilterTextures(gpu);
  let progs = null;
  const P = () => (progs = progs || { ref: program(gl, REF), cam: program(gl, CAM), masked: program(gl, MASKED), share: program(gl, SHARE), weight: program(gl, WEIGHT), acc: program(gl, ACC), count: program(gl, COUNT) });
  // (the merge kept on the card between begin and end: { W, H, refT, zT, acc: [a, b], cur })
  let kept = null;
  const dropKept = () => {
    if (kept) for (const t of [kept.refT, kept.zT, ...kept.acc]) gl.deleteTexture(t);
    kept = null;
  };
  // (a picture of 3 values a pixel, as it is: an RGB32F texture)
  const rgbTex = (made, { width, height, rgb }) => {
    const t = gpu.texture(width, height, gl.RGB32F);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGB, gl.FLOAT, rgb);
    made.push(t);
    return t;
  };
  const bandRows = (W) => Math.max(1, Math.floor((1 << 22) / W));
  const read = (tex, W, rows, buf) => {
    gpu.target(tex, W, rows);
    gl.readPixels(0, 0, W, rows, gl.RGBA, gl.FLOAT, buf);
  };
  const scoped = (fn) => {
    const made = [];
    try {
      return fn(made);
    } finally {
      for (const t of made) gl.deleteTexture(t);
    }
  };
  return {
    // The reference on its undistorted grid (W x H, `S` sensor pixels a grid pixel): fills refUnd (3 a pixel) and valid.
    reference({ img, W, H, S, dist, refUnd, valid }) {
      scoped((made) => {
        const p = P().ref;
        const src = rgbTex(made, img);
        const rows = Math.min(H, bandRows(W));
        const out = gpu.texture(W, rows, gl.RGBA32F);
        made.push(out);
        const buf = new Float32Array(4 * W * rows);
        for (let y0 = 0; y0 < H; y0 += rows) {
          const n = Math.min(rows, H - y0);
          gpu.target(out, W, n);
          gl.useProgram(p.p);
          gl.uniform1i(p.u.uImg, 1);
          gpu.bindTex(1, src);
          gl.uniform1f(p.u.uS, S);
          gl.uniform1i(p.u.uRow0, y0);
          setDist(gl, p.u, dist);
          gpu.draw();
          read(out, W, n, buf);
          for (let i = 0; i < W * n; i++) {
            const j = y0 * W + i;
            refUnd[3 * j] = buf[4 * i];
            refUnd[3 * j + 1] = buf[4 * i + 1];
            refUnd[3 * j + 2] = buf[4 * i + 2];
            valid[j] = buf[4 * i + 3] > 0 ? 1 : 0;
          }
        }
      });
    },
    // The merge kept on the card (one band only, the half size merge): the reference (refUnd, valid) and the depth sent once, the running sums started from the
    // reference's samples. Returns false (and nothing is kept) where the merge is made in bands. Then camera() adds each share there, and end() reads the sums back.
    begin({ W, H, S, refUnd, valid, z }) {
      dropKept();
      const r = Math.max(2, Math.round(12 / S));
      if (H > Math.max(1, bandRows(W) - 2 * (r + 4))) return false;
      const refBuf = new Float32Array(4 * W * H);
      for (let j = 0; j < W * H; j++) {
        refBuf[4 * j] = refUnd[3 * j];
        refBuf[4 * j + 1] = refUnd[3 * j + 1];
        refBuf[4 * j + 2] = refUnd[3 * j + 2];
        refBuf[4 * j + 3] = valid[j];
      }
      const refT = gpu.texture(W, H, gl.RGBA32F);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RGBA, gl.FLOAT, refBuf);
      const zT = gpu.texture(W, H, gl.R32F);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RED, gl.FLOAT, z);
      kept = { W, H, refT, zT, acc: [gpu.texture(W, H, gl.RGBA32F), gpu.texture(W, H, gl.RGBA32F)], cur: 0 };
      const pr = P();
      gpu.target(kept.acc[0], W, H);
      gl.useProgram(pr.acc.p);
      gl.uniform1i(pr.acc.u.uAcc, 1);
      gpu.bindTex(1, refT);
      gl.uniform1i(pr.acc.u.uAdd, 2);
      gpu.bindTex(2, refT);
      gl.uniform1i(pr.acc.u.uInit, 1);
      gpu.draw();
      return true;
    },
    // The sums kept on the card read back into out (3 a pixel) and weight, and the card's copies let go.
    end({ out, weight }) {
      try {
        if (!kept) throw new Error('no merge kept on the graphics card');
        const { W, H } = kept;
        const buf = new Float32Array(4 * W * H);
        gpu.target(kept.acc[kept.cur], W, H);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, buf);
        for (let j = 0; j < W * H; j++) {
          out[3 * j] = buf[4 * j];
          out[3 * j + 1] = buf[4 * j + 1];
          out[3 * j + 2] = buf[4 * j + 2];
          weight[j] = buf[4 * j + 3];
        }
      } finally {
        dropKept();
      }
    },
    drop: dropKept,
    // One camera's share added to out (3 a pixel) and weight; returns how many pixels agreed. Made in bands of rows, each with a margin above and below as deep as
    // the blurs reach, so the band's own rows come out as from the whole picture.
    camera({ img, W, H, S, K, cam, rel, corr, gain, mono, mg, z, refUnd, valid, out: acc, weight }) {
      return scoped((made) => {
        const pr = P();
        const src = rgbTex(made, img);
        const r = Math.max(2, Math.round(12 / S));
        const margin = r + 4;
        const rows = Math.min(H, Math.max(1, bandRows(W) - 2 * margin));
        const ext = Math.min(H, rows + 2 * margin);
        const refBuf = new Float32Array(4 * W * ext);
        const zBuf = new Float32Array(W * ext);
        const buf = new Float32Array(4 * W * ext);
        const flags = new Uint8Array(4 * W * ext);
        let agreed = 0;
        const fb = gl.createFramebuffer();
        const draw = (prog, out, n, inputs, set = () => {}) => {
          gpu.target(out, W, n);
          gl.useProgram(prog.p);
          inputs.forEach(([name, t], k) => {
            gl.uniform1i(prog.u[name], k + 1);
            gpu.bindTex(k + 1, t);
          });
          set(prog.u);
          gpu.draw();
        };
        try {
          for (let y0 = 0; y0 < H; y0 += rows) {
            const n = Math.min(rows, H - y0);
            // (the band with its margins: rows e0 to e0 + en)
            const e0 = Math.max(0, y0 - margin);
            const en = Math.min(H, y0 + n + margin) - e0;
            const local = [];
            const ltex = (internal = gl.RGBA32F) => {
              const t = gpu.texture(W, en, internal);
              local.push(t);
              return t;
            };
            try {
              // (the reference and the depth: kept on the card for every camera when the merge is kept there, else sent for the band)
              const onCard = kept && kept.W === W && kept.H === H && e0 === 0 && en === H;
              let refT;
              let zT;
              if (onCard) {
                refT = kept.refT;
                zT = kept.zT;
              } else {
                for (let i = 0; i < W * en; i++) {
                  const j = e0 * W + i;
                  refBuf[4 * i] = refUnd[3 * j];
                  refBuf[4 * i + 1] = refUnd[3 * j + 1];
                  refBuf[4 * i + 2] = refUnd[3 * j + 2];
                  refBuf[4 * i + 3] = valid[j];
                }
                refT = ltex();
                gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, en, gl.RGBA, gl.FLOAT, refBuf);
                zT = ltex(gl.R32F);
                zBuf.set(z.subarray(e0 * W, (e0 + en) * W));
                gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, en, gl.RED, gl.FLOAT, zBuf.subarray(0, W * en));
              }
              // the camera's picture at each pixel
              const smp = ltex();
              draw(pr.cam, smp, en, [['uImg', src], ['uRefU', refT], ['uZ', zT]], (u) => {
                gl.uniform1f(u.uS, S);
                gl.uniform1i(u.uRow0, e0);
                setDist(gl, u, cam.distort);
                gl.uniform4f(u.uK, K[0], K[2], K[4], K[5]);
                gl.uniform4f(u.uCK, cam.K[0], cam.K[2], cam.K[4], cam.K[5]);
                // (row-major R given as the columns: the shader's uR[i] is row i)
                gl.uniformMatrix3fv(u.uR, false, Array.from(rel.R));
                gl.uniform3f(u.uT, rel.T[0], rel.T[1], rel.T[2]);
                gl.uniform3f(u.uCx, corr ? corr.ax[0] : 0, corr ? corr.ax[1] : 0, corr ? corr.ax[2] : 0);
                gl.uniform3f(u.uCy, corr ? corr.ay[0] : 0, corr ? corr.ay[1] : 0, corr ? corr.ay[2] : 0);
              });
              // the local color ratio: both pictures blurred where both have pixels
              const refM = ltex();
              draw(pr.masked, refM, en, [['uA', refT], ['uOk', smp]]);
              const smpM = ltex();
              draw(pr.masked, smpM, en, [['uA', smp], ['uOk', smp]]);
              const refL = filters.boxOnce(local, refM, W, en, r);
              const smpL = filters.boxOnce(local, smpM, W, en, r);
              const share = ltex();
              draw(pr.share, share, en, [['uRefU', refT], ['uSmp', smp], ['uRefL', refL], ['uSmpL', smpL]], (u) => {
                gl.uniform1i(u.uMono, mono ? 1 : 0);
                gl.uniform1f(u.uMg, mg);
                gl.uniform3f(u.uGain, gain[0], gain[1], gain[2]);
              });
              const near = filters.boxOnce(local, share, W, en, 2);
              const outT = ltex();
              const agreeT = ltex(gl.RGBA8);
              gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
              gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outT, 0);
              gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, agreeT, 0);
              gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
              gl.viewport(0, 0, W, en);
              gl.useProgram(pr.weight.p);
              [['uShare', share], ['uNear', near], ['uSmp', smp]].forEach(([name, t], k) => {
                gl.uniform1i(pr.weight.u[name], k + 1);
                gpu.bindTex(k + 1, t);
              });
              gpu.draw();
              gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
              gl.bindFramebuffer(gl.FRAMEBUFFER, null);
              if (onCard) {
                // (added to the running sums on the card, and the agreeing pixels counted there)
                const next = kept.acc[1 - kept.cur];
                draw(pr.acc, next, H, [['uAcc', kept.acc[kept.cur]], ['uAdd', outT]], (u) => gl.uniform1i(u.uInit, 0));
                kept.cur = 1 - kept.cur;
                let cur = outT;
                let cw = W;
                let ch = H;
                let first = 1;
                while (first || cw > 64 || ch > 64) {
                  const nw = Math.ceil(cw / 16);
                  const nh = Math.ceil(ch / 16);
                  const t = gpu.texture(nw, nh, gl.RGBA32F);
                  local.push(t);
                  gpu.target(t, nw, nh);
                  gl.useProgram(pr.count.p);
                  gl.uniform1i(pr.count.u.uSrc, 1);
                  gpu.bindTex(1, cur);
                  gl.uniform1i(pr.count.u.uFlags, 2);
                  gpu.bindTex(2, agreeT);
                  gl.uniform1i(pr.count.u.uFirst, first);
                  gpu.draw();
                  cur = t;
                  cw = nw;
                  ch = nh;
                  first = 0;
                }
                const cb = new Float32Array(4 * cw * ch);
                gl.readPixels(0, 0, cw, ch, gl.RGBA, gl.FLOAT, cb);
                for (let i = 0; i < cw * ch; i++) agreed += cb[4 * i];
                continue;
              }
              gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
              gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
              // (the band's own rows, read back and added up)
              const skip = y0 - e0;
              gl.readBuffer(gl.COLOR_ATTACHMENT0);
              gl.readPixels(0, skip, W, n, gl.RGBA, gl.FLOAT, buf);
              gl.readBuffer(gl.COLOR_ATTACHMENT1);
              gl.readPixels(0, skip, W, n, gl.RGBA, gl.UNSIGNED_BYTE, flags);
              gl.readBuffer(gl.COLOR_ATTACHMENT0);
              gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
              gl.bindFramebuffer(gl.FRAMEBUFFER, null);
              for (let i = 0; i < W * n; i++) {
                const w = buf[4 * i + 3];
                if (!(w > 0)) continue;
                const j = y0 * W + i;
                acc[3 * j] += buf[4 * i];
                acc[3 * j + 1] += buf[4 * i + 1];
                acc[3 * j + 2] += buf[4 * i + 2];
                weight[j] += w;
                if (flags[4 * i] > 127) agreed++;
              }
            } finally {
              for (const t of local) gl.deleteTexture(t);
            }
          }
        } finally {
          gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
          gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.deleteFramebuffer(fb);
        }
        return agreed;
      });
    },
  };
}
