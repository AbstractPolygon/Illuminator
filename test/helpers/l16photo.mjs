// A tiny made-up Light L16 photo for the Classic Depth tests: three 192 x 128 cameras (the reference, one to its right, a monochrome one below it), each with its
// calibration (pinhole, pose, a small lens distortion) and its packed 10 bit sensor picture of one scene seen at a known depth: a flat gray strip far away, a near
// rectangle and a floor that comes closer down the picture, with fine texture, a little sensor noise and the second camera a little darker.
// Returns { bytes (number[]), parsed } as plain data, so it can be handed to a page; JSON.parse(JSON.stringify(parsed)) gives fresh frames for each run.
const SW = 192;
const SH = 128;
const F = 200;
const STRIDE = (SW / 4) * 5;
const BLACK = 42;
const WHITE = 1023;

// (a fixed sequence: a small linear congruential generator)
function random(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 8) / 16777216;
}

// the scene's depth (mm) at the reference's half size pixel (x, y)
function depthAt(x, y) {
  if (x < 14) return 1500;
  if (x >= 34 && x < 62 && y >= 18 && y < 46) return 380;
  return 1 / (1 / 3000 + (Math.max(0, y) / 64) * (1 / 600 - 1 / 3000));
}

// the scene's linear color (channel c) at the reference's half size position (x, y): smooth shading, fine texture between the grid points, flat in the strip
function sceneMaker(seed) {
  const rnd = random(seed);
  const G = 160;
  const grid = Float32Array.from({ length: 3 * G * G }, () => rnd());
  const at = (c, i, j) => grid[3 * ((((j % G) + G) % G) * G + (((i % G) + G) % G)) + c];
  return (c, x, y) => {
    if (x < 14) return 0.4;
    const X = 1.7 * (x + 20);
    const Y = 1.7 * (y + 20);
    const i = Math.floor(X);
    const j = Math.floor(Y);
    const fx = X - i;
    const fy = Y - j;
    const n = (at(c, i, j) * (1 - fx) + at(c, i + 1, j) * fx) * (1 - fy) + (at(c, i, j + 1) * (1 - fx) + at(c, i + 1, j + 1) * fx) * fy;
    return 0.3 + 0.12 * Math.sin(0.23 * x + 0.17 * y + 2 * c) + 0.3 * n;
  };
}

const mat = (m) => ({ x00: m[0], x01: m[1], x02: m[2], x10: m[3], x11: m[4], x12: m[5], x20: m[6], x21: m[7], x22: m[8] });

export function makeL16Photo() {
  const cams = [
    { id: 'A1', center: [0, 0, 0], dir: [0, 0], gain: 1, mono: false, coeffs: [0.004, 0, 0, 0, 0] },
    { id: 'A2', center: [20, 0, 0], dir: [1, 0], gain: 0.92, mono: false, coeffs: [-0.003, 0.001, 0.0005, -0.0004, 0] },
    { id: 'A3', center: [0, 12, 0], dir: [0, 1], gain: 1.05, mono: true, coeffs: [0.002, 0, 0, 0, 0] },
  ];
  const scene = sceneMaker(7);
  const noise = random(11);
  const bytes = new Uint8Array(cams.length * SH * STRIDE);
  const modules = {};
  const calibration = [];
  cams.forEach((cam, m) => {
    const dataOffset = m * SH * STRIDE;
    const px = new Uint16Array(SW * SH);
    for (let Y = 0; Y < SH; Y++) {
      for (let X = 0; X < SW; X++) {
        // (the site's place in half size pixels, moved by the camera's shift at the scene's depth there)
        const hx = (X + 0.5) / 2 - 0.5;
        const hy = (Y + 0.5) / 2 - 0.5;
        const z = depthAt(hx, hy);
        const shift = (F * Math.hypot(...cam.center)) / 2 / z;
        const sx = hx + cam.dir[0] * shift;
        const sy = hy + cam.dir[1] * shift;
        // (red at even x and y, blue at odd x and y)
        const c = cam.mono ? -1 : (X & 1) === (Y & 1) ? ((X & 1) === 0 ? 0 : 2) : 1;
        const v = c < 0 ? (scene(0, sx, sy) + scene(1, sx, sy) + scene(2, sx, sy)) / 3 : scene(c, sx, sy);
        px[Y * SW + X] = Math.max(0, Math.min(WHITE, Math.round(BLACK + (WHITE - BLACK) * cam.gain * v + 4 * (noise() - 0.5))));
      }
    }
    for (let Y = 0; Y < SH; Y++) {
      for (let g = 0; g < SW / 4; g++) {
        const [p0, p1, p2, p3] = px.subarray(Y * SW + 4 * g, Y * SW + 4 * g + 4);
        const o = dataOffset + Y * STRIDE + 5 * g;
        bytes[o] = p0 & 255;
        bytes[o + 1] = (p0 >> 8) | ((p1 & 63) << 2);
        bytes[o + 2] = (p1 >> 6) | ((p2 & 15) << 4);
        bytes[o + 3] = (p2 >> 4) | ((p3 & 3) << 6);
        bytes[o + 4] = p3 >> 2;
      }
    }
    const module = { id: cam.id, lens_position: 0, sensor_data_surface: { size: { x: SW, y: SH }, format: 'RAW_PACKED_10BPP', data_offset: dataOffset, row_stride: STRIDE } };
    if (cam.mono) module.sensor_bayer_red_override = { x: -1, y: -1 };
    modules[cam.id] = [{ module, blockStart: 0 }];
    calibration.push({
      camera_id: cam.id,
      geometry: {
        mirror_type: 'NONE',
        per_focus_calibration: [{
          intrinsics: { k_mat: mat([F, 0, SW / 2, 0, F, SH / 2, 0, 0, 1]) },
          extrinsics: { canonical: { rotation: mat([1, 0, 0, 0, 1, 0, 0, 0, 1]), translation: { x: -cam.center[0], y: -cam.center[1], z: -cam.center[2] } } },
        }],
        distortion: { polynomial: { coeffs: cam.coeffs, normalization: { x: 96, y: 96 }, distortion_center: { x: SW / 2, y: SH / 2 } } },
      },
    });
  });
  return { bytes: Array.from(bytes), parsed: { header: { image_reference_camera: 'A1', module_calibration: calibration }, modules } };
}
