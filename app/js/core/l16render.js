// The final render of a Light L16 photo: the whole picture at full size or larger, made in tiles so that memory stays bounded, with the telephoto cameras' detail (core/l16hires.js).
// The quick views the app shows while you work are made at half size from the merged wide cameras (core/l16photo.js); this is made only when Render is pressed.
//
// For each tile (with a margin that the viewpoint's shift and the blur reach into), the picture is made at the output scale (wide merge at full size, enlarged, with the telephoto
// detail), turned into a small processed picture with the depth at that scale, and put through the same camera render the quick views use (viewpoint, blur, color); the margin
// is dropped and the tile written into the output.
import { fuse } from './l16fusion.js';
import { renderRegion, telephotoModules, estimateCorrections } from './l16hires.js';
import { applyColorMatrix } from './l16photo.js';

const sRGB = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

// How large the picture will be: { width, height } for `scale` (output pixels per sensor pixel of the reference camera; 1 is the camera's own size).
export function finalSize(l16, scale) {
  const w = l16.picture.width * 2;
  const h = l16.picture.height * 2;
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

// Renders the picture. `renderTile({ data (RGBA8 sRGB), width, height, lambda (depth in output pixels of shift per unit of viewpoint) })` returns the finished RGBA8 pixels of a tile
// (the worker's camera render); `margin` (output pixels) is what a tile needs around it. `cancelled()` stops the render. Returns { width, height, pixels: Uint8ClampedArray }.
// `wide` (the merged wide picture, float, as core/l16fusion.js makes it) and `grid` (sensor pixels per pixel of it) can be given, for a picture made from the half size merge; `window` ({ x, y, w, h },
// output pixels) makes only that part of the picture (what is returned is the window).
export async function renderL16Final(l16, { scale, margin, depthLambda, renderTile, onProgress = () => {}, cancelled = () => false, tile = 768, wide: givenWide = null, grid = 1, window = null, onTile = null }) {
  const { bytes, parsed, measured: depth, colorOptions: opts, gain, colorMatrix } = l16;
  const mods = telephotoModules(parsed, depth.ref, [2, Infinity]);
  const { width: W, height: H } = finalSize(l16, scale);
  // each camera's registration corrected for this capture (measured on the half size merge): the wide cameras for the full size merge, the longer lens ones for the detail.
  // The whole picture's once a photo for a whole render; for a part (the zoomed-in view, `window`) only round that part, which is much quicker, kept for the next view inside it.
  let corrections = l16.corrections || null;
  if (!corrections && l16.wide && window && givenWide) {
    const f = l16.wide.width / W;
    const ww = l16.wide.width;
    const wh = l16.wide.height;
    // (the part on the screen, with room round it, and at least a fifth of the picture each way so the fit has enough to go on)
    const cx = (window.x + window.w / 2) * f;
    const cy = (window.y + window.h / 2) * f;
    const hw = Math.min(ww, Math.max(ww / 5, window.w * f * 1.3)) / 2;
    const hh = Math.min(wh, Math.max(wh / 5, window.h * f * 1.3)) / 2;
    const need = { x0: (window.x - margin) * f, y0: (window.y - margin) * f, x1: (window.x + window.w + margin) * f, y1: (window.y + window.h + margin) * f };
    const kept = (l16.localCorrections || []).find((c) => c.area.x0 <= need.x0 && c.area.y0 <= need.y0 && c.area.x1 >= need.x1 && c.area.y1 >= need.y1);
    if (kept) corrections = kept.corrections;
    else {
      const x0 = Math.max(0, Math.min(ww - 2 * hw, cx - hw));
      const y0 = Math.max(0, Math.min(wh - 2 * hh, cy - hh));
      const area = { x0, y0, x1: x0 + 2 * hw, y1: y0 + 2 * hh };
      onProgress('Aligning the cameras', 0);
      corrections = estimateCorrections(bytes, parsed, depth, l16.wide, 2, [...depth.modules, ...mods], opts, (p) => onProgress('Aligning the cameras', p), area);
      l16.localCorrections = [{ area, corrections }, ...(l16.localCorrections || [])].slice(0, 8);
    }
  } else if (!corrections && l16.wide) {
    onProgress('Aligning the cameras', 0);
    corrections = l16.corrections = estimateCorrections(bytes, parsed, depth, l16.wide, 2, [...depth.modules, ...mods], opts, (p) => onProgress('Aligning the cameras', p));
  }
  let wide = givenWide;
  if (!wide) {
    onProgress('Merging the cameras at full size', 0.03);
    wide = fuse(bytes, parsed, depth, opts, (stage, p) => onProgress(stage, 0.03 + 0.07 * p), { grid: 1, corrections });
  }
  const win = window || { x: 0, y: 0, w: W, h: H };
  const out = new Uint8ClampedArray(win.w * win.h * 4);
  // every camera with a longer lens than the reference (the 70 mm and the 150 mm ones, which see the middle of the picture)
  const rawCache = new Map();
  // `depthLambda` is the depth the quick views use (smoothed), in lambda of the half size picture; at output pixels it is that times 2 * scale (the half size picture's pixel is 2 sensor pixels)
  const sOut = 2 * scale;
  const lambdaFor = (rx0, ry0, rw, rh) => {
    const d = depthLambda;
    const lam = new Float32Array(rw * rh);
    for (let y = 0; y < rh; y++) {
      const fy = Math.min(d.height - 1.001, Math.max(0, ((ry0 + y + 0.5) / H) * d.height - 0.5));
      const iy = fy | 0;
      const ty = fy - iy;
      for (let x = 0; x < rw; x++) {
        const fx = Math.min(d.width - 1.001, Math.max(0, ((rx0 + x + 0.5) / W) * d.width - 0.5));
        const ix = fx | 0;
        const tx = fx - ix;
        const a = d.lambda[iy * d.width + ix] * (1 - tx) + d.lambda[iy * d.width + ix + 1] * tx;
        const b = d.lambda[(iy + 1) * d.width + ix] * (1 - tx) + d.lambda[(iy + 1) * d.width + ix + 1] * tx;
        lam[y * rw + x] = sOut * (a * (1 - ty) + b * ty);
      }
    }
    return lam;
  };
  const tilesX = Math.ceil(win.w / tile);
  const tilesY = Math.ceil(win.h / tile);
  let done = 0;
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      if (cancelled()) return null;
      onProgress('Rendering', 0.1 + (0.9 * done) / (tilesX * tilesY));
      const X0 = win.x + tx * tile;
      const Y0 = win.y + ty * tile;
      const tw = Math.min(tile, win.x + win.w - X0);
      const th = Math.min(tile, win.y + win.h - Y0);
      const rx0 = Math.max(0, X0 - margin);
      const ry0 = Math.max(0, Y0 - margin);
      const rx1 = Math.min(W, X0 + tw + margin);
      const ry1 = Math.min(H, Y0 + th + margin);
      const rw = rx1 - rx0;
      const rh = ry1 - ry0;
      const region = renderRegion(bytes, parsed, depth, wide, { x0: rx0 / (scale * grid), y0: ry0 / (scale * grid), w: rw / (scale * grid), h: rh / (scale * grid), scale: scale * grid, grid, corrections }, mods, opts, () => {}, rawCache);
      applyColorMatrix(region.rgb, colorMatrix);
      const data = new Uint8ClampedArray(rw * rh * 4);
      for (let i = 0; i < rw * rh; i++) {
        for (let c = 0; c < 3; c++) data[4 * i + c] = Math.round(255 * sRGB(Math.min(1, region.rgb[3 * i + c] * gain)));
        data[4 * i + 3] = 255;
      }
      // (`window`: where the tile sits in the whole picture, for what is placed on the whole picture: retouching spots)
      const finished = renderTile({ data, width: region.width, height: region.height, lambda: lambdaFor(rx0, ry0, region.width, region.height), window: { x: rx0, y: ry0, width: W, height: H } });
      // the tile without its margin, into the output
      const rwp = region.width;
      for (let y = 0; y < th; y++) {
        const src = 4 * ((Y0 - ry0 + y) * rwp + (X0 - rx0));
        out.set(finished.subarray(src, src + 4 * tw), 4 * ((Y0 - win.y + y) * win.w + (X0 - win.x)));
      }
      // (each finished tile, without its margin, as soon as it is made: { x, y (in the window), width, height, pixels })
      if (onTile) {
        const px = new Uint8ClampedArray(tw * th * 4);
        for (let y = 0; y < th; y++) px.set(out.subarray(4 * ((Y0 - win.y + y) * win.w + (X0 - win.x)), 4 * ((Y0 - win.y + y) * win.w + (X0 - win.x) + tw)), 4 * y * tw);
        onTile({ x: X0 - win.x, y: Y0 - win.y, width: tw, height: th, pixels: px });
      }
      done++;
      // let the worker's messages (cancel, other requests) through between tiles
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  return { width: win.w, height: win.h, pixels: out };
}
