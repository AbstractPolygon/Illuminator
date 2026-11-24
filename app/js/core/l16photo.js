// A Light L16 photo as a picture with a depth map, the form the app's "processed photo" path works with (core/processed.js): a developed picture, and depth in the unit that
// path turns into viewpoint shifts and blur (lambda: how far a pixel moves when the viewpoint moves by one unit, in pixels).
//
// The picture is the cameras of the reference's group merged on the reference's grid (core/l16fusion.js: at half size, 2080 x 1560 on the L16, for the quick views; the final render makes the full size picture and adds the telephoto cameras' detail; lens distortion corrected, noise
// lowered), white balanced and brought to a good exposure. The depth is measured between the modules of the group (core/l16depth.js).
//
// The viewpoint coordinates of the app run over -0.5 to 0.5 across the "aperture" (processed.js APERTURE_RADIUS). Here that range is the rig: a camera moved
// by u * 2 * RIG_RADIUS_MM. A point at depth Z then moves by f * 2 * RIG_RADIUS_MM * (1 / Z - 1 / Z0) * u pixels, so lambda = 2 * RIG_RADIUS_MM * f * (1 / Z - 1 / Z0), with Z0 the depth
// that stays still (the middle of the scene).
import { l16CacheKey, encodeL16Cache } from './l16-cache.js';
import { parseLri } from './lri.js';
import { measureDepth, measureDepthPooled } from './l16depth.js';
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
// What the capture says about the camera and the exposure (the reference camera's frame carries the exposure: nanoseconds, and the gain as a multiple of base ISO 100).
export function cameraInfoOf(parsed, ref) {
  const h = parsed.header;
  const frame = parsed.modules[ref] && parsed.modules[ref][0] && parsed.modules[ref][0].module;
  const t = h.image_time_stamp;
  const capture = {};
  if (t && t.year) {
    // (local time as the camera wrote it: shown as that wall clock time)
    capture.time = new Date(t.year, (t.month || 1) - 1, t.day || 1, t.hour || 0, t.minute || 0, t.second || 0).getTime();
  }
  if (frame && frame.sensor_exposure) capture.exposure = frame.sensor_exposure * 1e-9;
  if (frame && frame.sensor_analog_gain) capture.iso = Math.round(100 * frame.sensor_analog_gain * (frame.sensor_digital_gain || 1));
  if (h.image_focal_length) capture.focalLength = h.image_focal_length / 1000;
  return { make: 'Light', model: h.device_model_name || 'L16', capture };
}

const XYZ_D50_TO_SRGB = [3.1338561, -1.6168667, -0.4906146, -0.9787684, 1.9161415, 0.0334540, 0.0719453, -0.2289914, 1.4052427];
const mul3 = (a, b) => {
  const o = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[3 * i + j] += a[3 * i + k] * b[3 * k + j];
  return o;
};

// The matrix from the white balanced camera color to linear sRGB, from the reference camera's color calibration: each calibrated light (D65, A, F11) has a forward matrix (white balanced
// camera to XYZ D50), and the one for this capture's light is the mix of them by how near each light's red/green and blue/green ratios are to the capture's (the white balance gains
// say what the scene's neutral looks like to the camera). Null when the capture has no color calibration for the camera.
export function colorMatrixOf(parsed, ref) {
  const h = parsed.header;
  const gains = (h.view_preferences && h.view_preferences.awb_gains) || {};
  if (!(gains.r > 0) || !(gains.b > 0)) return null;
  const rg = 1 / gains.r;
  const bg = 1 / gains.b;
  const entries = [];
  for (const m of h.module_calibration || []) {
    if (m.camera_id !== ref) continue;
    for (const c of m.color || []) if (c.forward_matrix && c.rg_ratio > 0 && c.bg_ratio > 0) entries.push(c);
  }
  if (!entries.length) return null;
  const mat = new Array(9).fill(0);
  let total = 0;
  for (const c of entries) {
    const d2 = (c.rg_ratio - rg) ** 2 + (c.bg_ratio - bg) ** 2;
    const w = 1 / (d2 + 1e-4);
    const f = c.forward_matrix;
    const v = [f.x00, f.x01, f.x02, f.x10, f.x11, f.x12, f.x20, f.x21, f.x22].map((x) => x || 0);
    for (let i = 0; i < 9; i++) mat[i] += w * v[i];
    total += w;
  }
  return mul3(XYZ_D50_TO_SRGB, mat.map((x) => x / total));
}

// The color matrix applied to linear rgb (3 per pixel), in place; what falls below zero is cut.
export function applyColorMatrix(rgb, m) {
  if (!m) return rgb;
  for (let i = 0; i < rgb.length; i += 3) {
    // (a channel past the sensor's white level, which the white balance gains lift above 1 in red and blue, is cut at it)
    const r = Math.min(1, rgb[i]);
    const g = Math.min(1, rgb[i + 1]);
    const b = Math.min(1, rgb[i + 2]);
    const R = m[0] * r + m[1] * g + m[2] * b;
    const G = m[3] * r + m[4] * g + m[5] * b;
    const B = m[6] * r + m[7] * g + m[8] * b;
    // Near the sensor's white level the channels are cut or bent unevenly, and the matrix turns that into a color cast (blown sky goes lavender): the color is taken out as the
    // brightest channel nears it.
    const top = Math.max(r, g, b);
    const t = Math.min(1, Math.max(0, (top - 0.5) / 0.4));
    const k = t * t * (3 - 2 * t);
    const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    let r2 = R + (Y - R) * k;
    let g2 = G + (Y - G) * k;
    let b2 = B + (Y - B) * k;
    // A color the matrix puts below zero (an edge's color fringe, which it strengthens) is moved toward gray until it is not, instead of cutting the channel (which leaves dark lines).
    const low = Math.min(r2, g2, b2);
    if (low < 0) {
      const y2 = 0.2126 * r2 + 0.7152 * g2 + 0.0722 * b2;
      if (y2 > 0) {
        const t = y2 / (y2 - low);
        r2 = y2 + (r2 - y2) * t;
        g2 = y2 + (g2 - y2) * t;
        b2 = y2 + (b2 - y2) * t;
      } else {
        r2 = g2 = b2 = 0;
      }
    }
    rgb[i] = Math.max(0, r2);
    rgb[i + 1] = Math.max(0, g2);
    rgb[i + 2] = Math.max(0, b2);
  }
  return rgb;
}

// The picture of the capture from the measured depth: the cameras merged at half size (`wide`, float, white balanced, before the color matrix), and the picture shown (8 bit sRGB,
// the color matrix and an exposure that puts the 99th percentile of green at 0.9). Made again when a setting that changes the merge changes (Remove hot pixels).
// `merged`: the cameras already merged (kept with the photo, core/l16-cache.js): only the picture is made from it.
export function developL16(bytes, parsed, depth, ref, colorOptions, onProgress = () => {}, merged = null) {
  const color = merged || fuse(bytes, parsed, depth, colorOptions, (stage, p) => onProgress(stage, 0.9 * p), { grid: 2 });
  onProgress('Developing the picture', 0.95);
  const { width: w, height: h } = color;
  const colorMatrix = colorMatrixOf(parsed, ref);
  // (the merged picture itself stays as the cameras recorded it, the zoomed-in views are made from it; the color matrix is applied to a copy for the picture shown)
  const rgb = applyColorMatrix(Float32Array.from(color.rgb), colorMatrix);
  const greens = new Float32Array(w * h);
  for (let i = 0; i < greens.length; i++) greens[i] = rgb[3 * i + 1];
  greens.sort();
  const gain = 0.9 / Math.max(1e-4, greens[Math.floor(greens.length * 0.99)]);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) data[4 * i + c] = Math.round(255 * sRGB(Math.min(1, rgb[3 * i + c] * gain)));
    data[4 * i + 3] = 255;
  }
  return { picture: { width: w, height: h, data }, gain, colorMatrix, wide: color, used: color.used };
}

// decodeL16 with the depth's steps made by helper workers side by side (`pool`, js/l16depthpool.js); the same result. Without a pool, or with what an earlier opening
// kept (`cache`), it is decodeL16.
export async function decodeL16Pooled(bytes, onProgress = () => {}, { hot = true, cache = null, pool = null } = {}) {
  if (!pool) return decodeL16(bytes, onProgress, { hot, cache });
  onProgress('Reading the camera pictures', 0.02);
  const parsed = parseLri(bytes);
  const ref = parsed.header.image_reference_camera;
  if (!parsed.modules[ref]) throw new Error('This photo has no picture from its reference camera');
  // (what an earlier opening kept, when it is for this photo and these settings: nothing to measure)
  if (cache && cache.key === l16CacheKey(l16PhotoId(parsed.header), hot)) return decodeL16(bytes, onProgress, { hot, cache, parsed });
  const depth = await measureDepthPooled(bytes, parsed, { ref }, (stage, p) => onProgress(stage, 0.05 + 0.8 * p), pool);
  return decodeL16(bytes, onProgress, { hot, parsed, depth });
}

// `hot`: hot and dead pixels taken out of the camera pictures (Remove hot pixels). `cache`: what an earlier opening measured (decodeL16Cache), used when its key is the
// photo's; otherwise the result carries `cacheOut`, the bytes to keep with the photo.
export function decodeL16(bytes, onProgress = () => {}, { hot = true, cache = null, parsed: given = null, depth: measured = null } = {}) {
  onProgress('Reading the camera pictures', 0.02);
  // (`parsed` and `depth` can be given: the depth measured by helper workers side by side, decodeL16Pooled)
  const parsed = given || parseLri(bytes);
  const ref = parsed.header.image_reference_camera;
  if (!parsed.modules[ref]) throw new Error('This photo has no picture from its reference camera');
  const awb = (parsed.header.view_preferences && parsed.header.view_preferences.awb_gains) || {};
  const sd = parsed.header.sensor_data && parsed.header.sensor_data[0] && parsed.header.sensor_data[0].data;
  const black = sd && sd.black_level !== undefined ? sd.black_level : 42;
  const white = sd && sd.white_level !== undefined ? sd.white_level : 1023;
  const key = l16CacheKey(l16PhotoId(parsed.header), hot);
  const kept = cache && cache.key === key && cache.depth && cache.wide ? cache : null;
  const depth = kept ? kept.depth : measured || measureDepth(bytes, parsed, { ref }, (stage, p) => onProgress(stage, 0.05 + 0.8 * p));
  const colorOptions = { black, white, gains: [awb.r || 1, awb.gr || 1, awb.b || 1], hot };
  const developed = developL16(bytes, parsed, depth, ref, colorOptions, (stage, p) => onProgress(stage, (kept ? 0.5 : 0.85) + (kept ? 0.45 : 0.12) * p), kept ? kept.wide : null);
  const { picture, gain, colorMatrix, wide: color } = developed;
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
    picture,
    depth: { width: dw, height: dh, lambda },
    ref,
    modules: depth.modules,
    near: depth.near,
    far: depth.far,
    pivotZ: inv0 > 0 ? 1 / inv0 : 0,
    focalPx: f,
    stackFrames: parsed.stackFrames,
    cameras: developed.used,
    // for the Info panel: { model, make, capture: { time (ms), exposure (s), iso, focalLength (m, 35 mm equivalent) } }
    camera: cameraInfoOf(parsed, ref),
    // the bytes to keep with the photo (core/l16-cache.js), when it was measured now
    cacheOut: kept ? null : encodeL16Cache({ key, depth, wide: developed.wide }),
    fromCache: !!kept,
    // what the final render (core/l16render.js) works from
    bytes,
    parsed,
    measured: depth,
    colorOptions,
    gain,
    colorMatrix,
    wide: color,  // the half size merge (float, white balanced, before the color matrix)
    k,
    inv0,
  };
}
