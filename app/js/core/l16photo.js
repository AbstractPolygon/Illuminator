// A Light L16 photo as a picture with a depth map, the form the app's "processed photo" path works with (core/processed.js): a developed picture, and depth in the unit that
// path turns into viewpoint shifts and blur (lambda: how far a pixel moves when the viewpoint moves by one unit, in pixels).
//
// The picture is the cameras of the reference's group merged on the reference's grid (core/l16fusion.js: at half size, 2080 x 1560 on the L16, for the quick views; the final render makes the full size picture and adds the telephoto cameras' detail; lens distortion corrected, noise
// lowered), white balanced and brought to a good exposure. The depth is measured between the modules of the group (core/l16depth.js).
//
// The viewpoint coordinates of the app run over -0.5 to 0.5 across the "aperture" (processed.js APERTURE_RADIUS). Here that range is the rig: a camera moved
// by u * 2 * RIG_RADIUS_MM. A point at depth Z then moves by f * 2 * RIG_RADIUS_MM * (1 / Z - 1 / Z0) * u pixels, so lambda = 2 * RIG_RADIUS_MM * f * (1 / Z - 1 / Z0), with Z0 the depth
// that stays still (the middle of the scene).
import { parseLri } from './lri.js';
import { measureDepth } from './l16depth.js';
import { fuse } from './l16fusion.js';

// Half the distance the viewpoint may travel, in mm (the wide modules are about 70 mm apart at most).
export const RIG_RADIUS_MM = 24;

const sRGB = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

// An id for the photo (the file's own unique id), for the library and the caches.
export function l16PhotoId(header) {
  const hex = (n) => (n || 0).toString(16).padStart(16, '0');
  return `l16-${hex(header.image_unique_id_high)}${hex(header.image_unique_id_low)}`.slice(0, 40);
}

// Reads the whole file: { header, picture: { width, height, data (RGBA bytes) }, depth: { width, height, lambda }, ref, modules, near, far, pivotZ, focalPx }.
export function decodeL16(bytes, onProgress = () => {}) {
  onProgress('Reading the camera pictures', 0.02);
  const parsed = parseLri(bytes);
  const ref = parsed.header.image_reference_camera;
  if (!parsed.modules[ref]) throw new Error('This photo has no picture from its reference camera');
  const awb = (parsed.header.view_preferences && parsed.header.view_preferences.awb_gains) || {};
  const sd = parsed.header.sensor_data && parsed.header.sensor_data[0] && parsed.header.sensor_data[0].data;
  const black = sd && sd.black_level !== undefined ? sd.black_level : 42;
  const white = sd && sd.white_level !== undefined ? sd.white_level : 1023;
  const depth = measureDepth(bytes, parsed, { ref }, (stage, p) => onProgress(stage, 0.05 + 0.8 * p));
  const color = fuse(bytes, parsed, depth, { black, white, gains: [awb.r || 1, awb.gr || 1, awb.b || 1] }, (stage, p) => onProgress(stage, 0.85 + 0.12 * p), { grid: 2 });
  onProgress('Developing the picture', 0.97);
  const { width: w, height: h, rgb } = color;
  // exposure: the 99th percentile of green goes to 0.9, then the sRGB curve
  const greens = new Float32Array(w * h);
  for (let i = 0; i < greens.length; i++) greens[i] = rgb[3 * i + 1];
  greens.sort();
  const gain = 0.9 / Math.max(1e-4, greens[Math.floor(greens.length * 0.99)]);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) data[4 * i + c] = Math.round(255 * sRGB(Math.min(1, rgb[3 * i + c] * gain)));
    data[4 * i + 3] = 255;
  }
  // depth in lambda: relative to the middle of the scene
  const dw = depth.width;
  const dh = depth.height;
  const sorted = Float32Array.from(depth.invZ).sort();
  const inv0 = sorted[sorted.length >> 1];
  const f = depth.K[0] / 2; // the picture is half the sensor's size
  const k = 2 * RIG_RADIUS_MM * f;
  const lambda = new Float32Array(dw * dh);
  for (let i = 0; i < lambda.length; i++) lambda[i] = k * (depth.invZ[i] - inv0);
  onProgress('Done', 1);
  return {
    header: parsed.header,
    picture: { width: w, height: h, data },
    depth: { width: dw, height: dh, lambda },
    ref,
    modules: depth.modules,
    near: depth.near,
    far: depth.far,
    pivotZ: inv0 > 0 ? 1 / inv0 : 0,
    focalPx: f,
    stackFrames: parsed.stackFrames,
    cameras: color.used,
    // what the final render (core/l16render.js) works from
    bytes,
    parsed,
    measured: depth,
    colorOptions: { black, white, gains: [awb.r || 1, awb.gr || 1, awb.b || 1] },
    gain,
    k,
    inv0,
  };
}
