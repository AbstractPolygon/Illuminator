// The picture of a Light L16 photo: the pictures of its cameras merged into one on the reference camera's grid.
//
// Each camera of the reference's group (same focal length) sees the scene from a slightly different place. With the depth known, every pixel of the reference can be looked up in
// the other cameras (calibrated pose, intrinsics and lens distortion), where it is the same point of the scene. The pictures are averaged where they agree (what differs is
// something one camera saw that another did not, an occlusion, or noise too strong to share), which lowers noise by about the square root of the number of cameras, and the
// output is on the undistorted grid, so the lens distortion is corrected on the way.
//
// Each camera is first demosaiced at full size (Malvar, He and Cutler: a 5 x 5 linear filter that follows the missing colors' correlation with the sampled one).
import { decodeFrame } from './lri.js';
import { cameraModel } from './l16geometry.js';
import { relativePose } from './l16depth.js';

// Linear 0..1 full size RGB of a module's frame: black level removed, demosaiced, white balance gains applied. Float32Array(3 * w * h).
export function demosaic(bytes, frame, { black = 42, white = 1023, gains = [1, 1, 1] } = {}) {
  const { width: W, height: H, data } = decodeFrame(bytes, frame);
  const o = frame.module.sensor_bayer_red_override || { x: 0, y: 0 };
  const rgb = new Float32Array(3 * W * H);
  const scale = 1 / (white - black);
  if (o.x < 0) {
    // the monochrome module: one value for all three
    for (let i = 0; i < W * H; i++) {
      const v = Math.max(0, (data[i] - black) * scale);
      rgb[3 * i] = rgb[3 * i + 1] = rgb[3 * i + 2] = v;
    }
    return { width: W, height: H, rgb };
  }
  const px = new Float32Array(W * H);
  for (let i = 0; i < px.length; i++) px[i] = Math.max(0, (data[i] - black) * scale);
  const at = (x, y) => px[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];
  const rx = o.x;
  const ry = o.y;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = 3 * (y * W + x);
      const c = px[y * W + x];
      // the site's kind: red, blue, or green with red on its row (greenR) or on its column (greenB)
      const cx = (x & 1) === rx;
      const cy = (y & 1) === ry;
      let r;
      let g;
      let b;
      const c4 = 4 * c;
      if (cx && cy) {
        // red site
        r = c;
        g = (2 * (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1)) + c4 - (at(x - 2, y) + at(x + 2, y) + at(x, y - 2) + at(x, y + 2))) / 8;
        b = (2 * (at(x - 1, y - 1) + at(x + 1, y - 1) + at(x - 1, y + 1) + at(x + 1, y + 1)) + 6 * c - 1.5 * (at(x - 2, y) + at(x + 2, y) + at(x, y - 2) + at(x, y + 2))) / 8;
      } else if (!cx && !cy) {
        // blue site
        b = c;
        g = (2 * (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1)) + c4 - (at(x - 2, y) + at(x + 2, y) + at(x, y - 2) + at(x, y + 2))) / 8;
        r = (2 * (at(x - 1, y - 1) + at(x + 1, y - 1) + at(x - 1, y + 1) + at(x + 1, y + 1)) + 6 * c - 1.5 * (at(x - 2, y) + at(x + 2, y) + at(x, y - 2) + at(x, y + 2))) / 8;
      } else {
        g = c;
        const horizontalIsRed = cy; // a green site on the red row has red beside it
        // the MHC kernels for green sites: the color along the row from the row's neighbours, the other along the column
        const rowKernel = (5 * c - at(x - 1, y - 1) - at(x + 1, y - 1) - at(x - 1, y + 1) - at(x + 1, y + 1) - at(x - 2, y) - at(x + 2, y) + 0.5 * (at(x, y - 2) + at(x, y + 2)) + 4 * (at(x - 1, y) + at(x + 1, y))) / 8;
        const colKernel = (5 * c - at(x - 1, y - 1) - at(x + 1, y - 1) - at(x - 1, y + 1) - at(x + 1, y + 1) - at(x, y - 2) - at(x, y + 2) + 0.5 * (at(x - 2, y) + at(x + 2, y)) + 4 * (at(x, y - 1) + at(x, y + 1))) / 8;
        if (horizontalIsRed) {
          r = rowKernel;
          b = colKernel;
        } else {
          b = rowKernel;
          r = colKernel;
        }
      }
      rgb[i] = Math.max(0, r) * gains[0];
      rgb[i + 1] = Math.max(0, g) * gains[1];
      rgb[i + 2] = Math.max(0, b) * gains[2];
    }
  }
  return { width: W, height: H, rgb };
}

// The depth in mm at every pixel of a w x h grid, from the depth map (1 / mm, dw x dh): bilinear in inverse depth.
function depthGrid(invZ, dw, dh, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(dh - 1.001, Math.max(0, ((y + 0.5) * dh) / h - 0.5));
    const y0 = fy | 0;
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(dw - 1.001, Math.max(0, ((x + 0.5) * dw) / w - 0.5));
      const x0 = fx | 0;
      const tx = fx - x0;
      const a = invZ[y0 * dw + x0] * (1 - tx) + invZ[y0 * dw + x0 + 1] * tx;
      const b = invZ[(y0 + 1) * dw + x0] * (1 - tx) + invZ[(y0 + 1) * dw + x0 + 1] * tx;
      out[y * w + x] = 1 / Math.max(1e-7, a * (1 - ty) + b * ty);
    }
  }
  return out;
}

const luma = (r, g, b) => 0.3 * r + 0.55 * g + 0.15 * b;

// Merges the cameras. `depth` is core/l16depth.js measureDepth's result for the reference; the cameras merged are the reference and depth.modules (the monochrome one left out:
// its picture has no color to share). Returns { width, height, rgb (linear, white balanced), used: how many cameras, merged: per camera id the share of pixels that agreed }.
export function fuse(bytes, parsed, depth, { black = 42, white = 1023, gains = [1, 1, 1] } = {}, onProgress = () => {}) {
  const refId = depth.ref;
  const refFrame = parsed.modules[refId][0];
  const refCam = cameraModel(parsed.header, refFrame);
  const opts = { black, white, gains };
  onProgress('Developing the pictures', 0.02);
  const ref = demosaic(bytes, refFrame, opts);
  const { width: W, height: H } = ref;
  // the output grid is the reference's undistorted picture: the value at ideal pixel (x, y) is the sensor picture at distort(x, y)
  const out = new Float32Array(3 * W * H);
  const weight = new Float32Array(W * H);
  const z = depthGrid(depth.invZ, depth.width, depth.height, W, H);
  const K = refCam.K;
  const bilinear = (img, w, h, sx, sy, o) => {
    const x = sx - 0.5;
    const y = sy - 0.5;
    if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return false;
    const x0 = x | 0;
    const y0 = y | 0;
    const fx = x - x0;
    const fy = y - y0;
    const i = 3 * (y0 * w + x0);
    for (let c = 0; c < 3; c++) o[c] = (img[i + c] * (1 - fx) + img[i + 3 + c] * fx) * (1 - fy) + (img[i + 3 * w + c] * (1 - fx) + img[i + 3 * w + 3 + c] * fx) * fy;
    return true;
  };
  // the reference on the undistorted grid
  const refUnd = new Float32Array(3 * W * H);
  const tmp = [0, 0, 0];
  const valid = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [sx, sy] = refCam.distort(x + 0.5, y + 0.5);
      if (bilinear(ref.rgb, W, H, sx, sy, tmp)) {
        const i = y * W + x;
        refUnd[3 * i] = tmp[0];
        refUnd[3 * i + 1] = tmp[1];
        refUnd[3 * i + 2] = tmp[2];
        valid[i] = 1;
      }
    }
  }
  for (let i = 0; i < W * H; i++) {
    out[3 * i] = refUnd[3 * i];
    out[3 * i + 1] = refUnd[3 * i + 1];
    out[3 * i + 2] = refUnd[3 * i + 2];
    weight[i] = valid[i];
  }
  const donors = depth.modules.filter((id) => ((parsed.modules[id][0].module.sensor_bayer_red_override || { x: 0 }).x >= 0));
  const merged = {};
  let n = 0;
  for (const id of donors) {
    onProgress('Merging the cameras', 0.1 + (0.85 * n) / Math.max(1, donors.length));
    n++;
    const cam = cameraModel(parsed.header, parsed.modules[id][0]);
    const rel = relativePose(refCam, cam);
    const R = rel.R;
    const T = rel.T;
    const img = demosaic(bytes, parsed.modules[id][0], opts);
    // gains that match this camera's colors to the reference's, from the pixels both see (sampled)
    const sumR = [0, 0, 0];
    const sumD = [0, 0, 0];
    const sample = [0, 0, 0];
    const at = (x, y) => {
      const Z = z[y * W + x];
      const X = ((x + 0.5 - K[2]) / K[0]) * Z;
      const Y = ((y + 0.5 - K[5]) / K[4]) * Z;
      const Pz = R[6] * X + R[7] * Y + R[8] * Z + T[2];
      if (Pz <= 1) return false;
      const ix = (cam.K[0] * (R[0] * X + R[1] * Y + R[2] * Z + T[0])) / Pz + cam.K[2];
      const iy = (cam.K[4] * (R[3] * X + R[4] * Y + R[5] * Z + T[1])) / Pz + cam.K[5];
      const [sx, sy] = cam.distort(ix, iy);
      return bilinear(img.rgb, img.width, img.height, sx, sy, sample);
    };
    for (let y = 8; y < H; y += 23) {
      for (let x = 8; x < W; x += 23) {
        if (!valid[y * W + x] || !at(x, y)) continue;
        const i = 3 * (y * W + x);
        for (let c = 0; c < 3; c++) {
          sumR[c] += refUnd[i + c];
          sumD[c] += sample[c];
        }
      }
    }
    const g = sumD.map((v, c) => (v > 1e-6 ? sumR[c] / v : 1));
    let agreed = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!valid[i] || !at(x, y)) continue;
        const r = sample[0] * g[0];
        const gr = sample[1] * g[1];
        const b = sample[2] * g[2];
        const rl = luma(refUnd[3 * i], refUnd[3 * i + 1], refUnd[3 * i + 2]);
        const dl = luma(r, gr, b);
        // agree: the difference is within what noise (growing with brightness) and a small misregistration allow
        const sigma = 0.012 + 0.07 * Math.sqrt(Math.max(rl, 0)) * 0.35;
        const d = (dl - rl) / sigma;
        const w = Math.exp(-0.5 * d * d);
        if (w < 0.02) continue;
        out[3 * i] += r * w;
        out[3 * i + 1] += gr * w;
        out[3 * i + 2] += b * w;
        weight[i] += w;
        if (w > 0.5) agreed++;
      }
    }
    merged[id] = agreed / (W * H);
  }
  onProgress('Merging the cameras', 0.97);
  for (let i = 0; i < W * H; i++) {
    const w = weight[i];
    if (w > 0) {
      out[3 * i] /= w;
      out[3 * i + 1] /= w;
      out[3 * i + 2] /= w;
    }
  }
  return { width: W, height: H, rgb: out, used: donors.length + 1, merged };
}
