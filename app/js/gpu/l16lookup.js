// The telephoto cameras' lookup of the Light L16 zoomed-in detail (core/l16hires.js renderRegion) on the graphics card, with the processor's rules in single precision:
// where every output pixel lands on a camera's sensor (the depth, the calibrated pose, the lens distortion, the capture's correction), and the camera's picture there.
import { program } from './renderer.js';

const PROJECT = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uZ;      // the depth (mm) of every output pixel
uniform vec4 uRegion;      // x0, y0 (wide grid pixels), scale (output pixels a grid pixel), grid (sensor pixels a grid pixel)
uniform vec4 uK;           // the reference: fx, cx, fy, cy
uniform vec4 uCK;          // the camera: fx, cx, fy, cy
uniform mat3 uR;           // rows of R (relative pose)
uniform vec3 uT;
uniform vec4 uDa;          // distortion: k1, k2, k3, p1
uniform vec4 uDb;          // p2, nx, ny, cx
uniform float uDcy;
uniform int uHasDist;
uniform vec3 uCx;          // the capture's correction of x (a0, a1, a2); 0 for none
uniform vec3 uCy;
out vec4 outColor;         // (sensor x, sensor y, 1) where it lands, 0 where it does not
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float px = (uRegion.x + (float(p.x) + 0.5) / uRegion.z) * uRegion.w;
  float py = (uRegion.y + (float(p.y) + 0.5) / uRegion.z) * uRegion.w;
  float Z = texelFetch(uZ, p, 0).r;
  vec3 P = vec3((px - uK.y) / uK.x * Z, (py - uK.w) / uK.z * Z, Z);
  float Pz = dot(uR[2], P) + uT.z;
  if (Pz <= 1.0) {
    outColor = vec4(0.0);
    return;
  }
  vec2 s = vec2(uCK.x * (dot(uR[0], P) + uT.x) / Pz + uCK.y, uCK.z * (dot(uR[1], P) + uT.y) / Pz + uCK.w);
  if (uHasDist == 1) {
    float u = (s.x - uDb.w) / uDb.y;
    float v = (s.y - uDcy) / uDb.z;
    float rr = u * u + v * v;
    float uv2 = 2.0 * u * v;
    float k = 1.0 + ((uDa.z * rr + uDa.y) * rr + uDa.x) * rr;
    s = vec2(uDb.w + uDb.y * (uDa.w * uv2 + uDb.x * (rr + 2.0 * u * u) + k * u), uDcy + uDb.z * (uDb.x * uv2 + uDa.w * (rr + 2.0 * v * v) + k * v));
  }
  vec2 uv = s / vec2(4160.0, 3120.0);
  s += vec2(uCx.x + uCx.y * uv.x + uCx.z * uv.y, uCy.x + uCy.y * uv.x + uCy.z * uv.y);
  outColor = vec4(s, 1.0, 0.0);
}`;

const SAMPLE = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uProj;
uniform sampler2D uImg;    // the camera's picture, the window of it made
uniform vec2 uOrigin;      // the window's place on the sensor
out vec4 outColor;         // (rgb, 1) where the camera has the pixel, else 0
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 q = texelFetch(uProj, p, 0);
  outColor = vec4(0.0);
  if (q.z == 0.0) return;
  vec2 c = q.xy - uOrigin - 0.5;
  ivec2 size = textureSize(uImg, 0);
  if (c.x < 0.0 || c.y < 0.0 || c.x >= float(size.x - 1) || c.y >= float(size.y - 1)) return;
  ivec2 i0 = ivec2(c);
  vec2 f = c - vec2(i0);
  vec3 v = (texelFetch(uImg, i0, 0).rgb * (1.0 - f.x) + texelFetch(uImg, i0 + ivec2(1, 0), 0).rgb * f.x) * (1.0 - f.y)
    + (texelFetch(uImg, i0 + ivec2(0, 1), 0).rgb * (1.0 - f.x) + texelFetch(uImg, i0 + ivec2(1, 1), 0).rgb * f.x) * f.y;
  outColor = vec4(v, 1.0);
}`;

// On `gpu` (a GpuRenderer): { project(job) -> { sx, sy (NaN where it does not land), sample(img) -> { samp, have }, release() } }.
export function l16LookupGpu(gpu) {
  const gl = gpu.gl;
  let progs = null;
  const P = () => (progs = progs || { project: program(gl, PROJECT), sample: program(gl, SAMPLE) });
  return {
    // job: { W, H, x0, y0, scale, grid, K, z (Float32Array W H), cam (core/l16geometry.js cameraModel), rel ({ R, T }), corr }
    project({ W, H, x0, y0, scale, grid, K, z, cam, rel, corr }) {
      const pr = P();
      const made = [];
      const release = () => {
        for (const t of made.splice(0)) gl.deleteTexture(t);
      };
      try {
        const zT = gpu.uploadR32F(null, null, z, W, H);
        made.push(zT);
        const proj = gpu.texture(W, H, gl.RGBA32F);
        made.push(proj);
        gpu.target(proj, W, H);
        const p = pr.project;
        const u = p.u;
        gl.useProgram(p.p);
        gl.uniform1i(u.uZ, 1);
        gpu.bindTex(1, zT);
        gl.uniform4f(u.uRegion, x0, y0, scale, grid);
        gl.uniform4f(u.uK, K[0], K[2], K[4], K[5]);
        gl.uniform4f(u.uCK, cam.K[0], cam.K[2], cam.K[4], cam.K[5]);
        // (row-major R given as the columns: the shader's uR[i] is row i)
        gl.uniformMatrix3fv(u.uR, false, Array.from(rel.R));
        gl.uniform3f(u.uT, rel.T[0], rel.T[1], rel.T[2]);
        const d = cam.distort && cam.distort.params;
        gl.uniform1i(u.uHasDist, d ? 1 : 0);
        if (d) {
          gl.uniform4f(u.uDa, d.k1, d.k2, d.k3, d.p1);
          gl.uniform4f(u.uDb, d.p2, d.nx, d.ny, d.cx);
          gl.uniform1f(u.uDcy, d.cy);
        }
        gl.uniform3f(u.uCx, corr ? corr.ax[0] : 0, corr ? corr.ax[1] : 0, corr ? corr.ax[2] : 0);
        gl.uniform3f(u.uCy, corr ? corr.ay[0] : 0, corr ? corr.ay[1] : 0, corr ? corr.ay[2] : 0);
        gpu.draw();
        const buf = new Float32Array(4 * W * H);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, buf);
        const sx = new Float32Array(W * H);
        const sy = new Float32Array(W * H);
        for (let i = 0; i < W * H; i++) {
          if (buf[4 * i + 2] > 0) {
            sx[i] = buf[4 * i];
            sy[i] = buf[4 * i + 1];
          } else sx[i] = NaN;
        }
        return {
          sx,
          sy,
          // The camera's picture (img: { width, height, rgb, x0, y0 }, a window of its sensor) at every output pixel: samp (3 a pixel) and have (1 where it has it).
          sample(img) {
            const src = gpu.texture(img.width, img.height, gl.RGB32F);
            made.push(src);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, img.width, img.height, gl.RGB, gl.FLOAT, img.rgb);
            const out = gpu.texture(W, H, gl.RGBA32F);
            made.push(out);
            gpu.target(out, W, H);
            const s = pr.sample;
            gl.useProgram(s.p);
            gl.uniform1i(s.u.uProj, 1);
            gpu.bindTex(1, proj);
            gl.uniform1i(s.u.uImg, 2);
            gpu.bindTex(2, src);
            gl.uniform2f(s.u.uOrigin, img.x0 || 0, img.y0 || 0);
            gpu.draw();
            gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, buf);
            const samp = new Float32Array(3 * W * H);
            const have = new Uint8Array(W * H);
            for (let i = 0; i < W * H; i++) {
              if (!(buf[4 * i + 3] > 0)) continue;
              have[i] = 1;
              samp[3 * i] = buf[4 * i];
              samp[3 * i + 1] = buf[4 * i + 1];
              samp[3 * i + 2] = buf[4 * i + 2];
            }
            return { samp, have };
          },
          release,
        };
      } catch (e) {
        release();
        throw e;
      }
    },
  };
}
