// Lenticular prints: several pictures cut into strips one printer dot wide and interleaved, to be printed under a sheet of lenses (lenticules). Each lens
// covers one strip of every picture, so the eye sees one picture at a time and tilting the print changes it: views across the lens give 3D (lenses
// upright, tilt left and right), the frames of an animation give a flip that refocuses or moves (lenses across, tilt up and down).
//
// Pictures per lens: the printer's resolution over the sheet's lenses per inch (720 dpi / 60 lpi = 12), from the sheet's nominal count. Where each
// strip goes follows the measured pitch, from a pitch test printed on the same sheet, printer and paper (a "60 lpi" sheet often measures 59.7 to
// 60.3). The file is saved at the printer's resolution, with it written in the PNG, and must be printed at 100%, never scaled.
// Pure functions on RGBA pixel arrays; the page renders the pictures and draws the labels (ui/lenticular.js).

import { pngChunk } from './png16.js';

// The largest print made, in pixels (an RGBA copy of it is held in memory): a side, and the area.
export const MAX_SIDE = 32000;
export const MAX_AREA = 60e6;
export const MAX_VIEWS = 96;

// The print's plan: { views, width, height, pitch } from the sheet (lpi), printer (dpi), measured pitch (lpi; empty for the nominal) and print size
// (inches). Throws with a message a person can act on.
export function lenticularPlan({ lpi, dpi, pitch, width, height }) {
  lpi = +lpi;
  dpi = +dpi;
  pitch = pitch === '' || pitch == null || !(+pitch > 0) ? lpi : +pitch;
  width = +width;
  height = +height;
  if (!(lpi > 0)) throw new Error('Enter the lens sheet\'s lenses per inch (LPI), as printed on the sheet or its box.');
  if (!(dpi > 0)) throw new Error('Enter the printer\'s resolution in dots per inch (DPI).');
  if (!(width > 0) || !(height > 0)) throw new Error('Enter the print\'s width and height in inches.');
  if (Math.abs(pitch - lpi) > lpi * 0.1) throw new Error(`The measured pitch (${pitch}) is far from the sheet's ${lpi} LPI: enter the value of the clearest band of the pitch test.`);
  const views = Math.round(dpi / lpi);
  if (views < 2) throw new Error(`At ${dpi} DPI a ${lpi} LPI sheet has room for only one picture under each lens: choose a higher printer resolution or a coarser sheet.`);
  if (views > MAX_VIEWS) throw new Error(`${views} pictures under each lens is more than the ${MAX_VIEWS} the app makes: choose a lower printer resolution.`);
  const w = Math.round(width * dpi);
  const h = Math.round(height * dpi);
  if (w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_AREA) {
    throw new Error(`A ${width} × ${height} inch print at ${dpi} DPI is ${w} × ${h} pixels, more than the app can make at once. Choose a smaller print or a lower printer resolution.`);
  }
  return { views, width: w, height: h, pitch, dpi, lpi };
}

// Which picture each printer dot along the lens direction shows: n pictures under every lens, the lens period dpi / pitch dots. The strip on one side of
// a lens is seen from the other side, so picture 0 (the leftmost viewpoint, or the first frame) goes at the far end of each lens; `reverse` swaps that
// (for a print that looks inside out, or a flip that runs the wrong way).
export function stripMap(length, n, dpi, pitch, reverse = false) {
  const map = new Uint8Array(length);
  const step = pitch / dpi;
  for (let x = 0; x < length; x++) {
    const phase = ((x + 0.5) * step) % 1;
    const slot = Math.min(n - 1, Math.floor(phase * n));
    map[x] = reverse ? slot : n - 1 - slot;
  }
  return map;
}

// Copies picture k's strips (`view`, RGBA at the print's size) into the print `out`. `axis` 'x': the strips are columns (lenses upright, 3D); 'y': rows
// (lenses across, a flip).
export function interlaceInto(out, view, width, height, map, k, axis = 'x') {
  if (axis === 'x') {
    for (let x = 0; x < width; x++) {
      if (map[x] !== k) continue;
      for (let y = 0, i = x * 4; y < height; y++, i += width * 4) {
        out[i] = view[i];
        out[i + 1] = view[i + 1];
        out[i + 2] = view[i + 2];
        out[i + 3] = 255;
      }
    }
  } else {
    const row = width * 4;
    for (let y = 0; y < height; y++) {
      if (map[y] !== k) continue;
      out.set(view.subarray(y * row, (y + 1) * row), y * row);
      for (let i = y * row + 3; i < (y + 1) * row; i += 4) out[i] = 255;
    }
  }
}

// Which lens each printer dot along the lens direction lies under (the measured pitch decides).
export function lensMap(length, dpi, pitch) {
  const map = new Uint32Array(length);
  const step = pitch / dpi;
  for (let x = 0; x < length; x++) map[x] = Math.floor((x + 0.5) * step);
  return map;
}

// The number of lenses across `length` printer dots (the last one may be cut).
export function lensCount(length, dpi, pitch) {
  return Math.floor((length - 0.5) * (pitch / dpi)) + 1;
}

// As interlaceInto, but picture k comes at one column (or row) per lens: `view` is lenses x height ('x') or width x lenses ('y'), the picture scaled to that size. Under
// each lens a picture has one strip (two at most, where the pitch does not divide the printer's dots evenly), so this keeps all the detail the print can show, and costs
// a picture's readback of 1 / pictures-per-lens of the print instead of the whole print.
export function interlaceLensInto(out, view, width, height, map, lens, lenses, k, axis = 'x') {
  if (axis === 'x') {
    for (let x = 0; x < width; x++) {
      if (map[x] !== k) continue;
      const j = Math.min(lenses - 1, lens[x]);
      for (let y = 0, i = x * 4, s = j * 4; y < height; y++, i += width * 4, s += lenses * 4) {
        out[i] = view[s];
        out[i + 1] = view[s + 1];
        out[i + 2] = view[s + 2];
        out[i + 3] = 255;
      }
    }
  } else {
    const row = width * 4;
    for (let y = 0; y < height; y++) {
      if (map[y] !== k) continue;
      const j = Math.min(lenses - 1, lens[y]);
      out.set(view.subarray(j * row, (j + 1) * row), y * row);
      for (let i = y * row + 3; i < (y + 1) * row; i += 4) out[i] = 255;
    }
  }
}

// The part of a w x h picture that fills a W x H print (centered, cut to the print's shape): { sx, sy, sw, sh } in the picture.
export function coverRect(w, h, W, H) {
  const k = Math.max(W / w, H / h);
  const sw = Math.min(w, W / k);
  const sh = Math.min(h, H / k);
  return { sx: (w - sw) / 2, sy: (h - sh) / 2, sw, sh };
}

// Which of an animation's `length` frames each of `count` pictures shows: evenly spaced from the first frame to the last (a frame repeats when the
// animation has fewer frames than the print has pictures).
export function pickFrames(length, count) {
  if (count === 1 || length === 1) return Array.from({ length: count }, () => 0);
  return Array.from({ length: count }, (_, i) => Math.round((i * (length - 1)) / (count - 1)));
}

// The viewpoints of a 3D print: n positions evenly across [-reach, reach] around `center`, left to right.
export function viewPositions(n, center, reach) {
  return Array.from({ length: n }, (_, i) => center + (n === 1 ? 0 : -reach + (2 * reach * i) / (n - 1)));
}

// The pitch test chart: bands interlaced at pitches around the sheet's (lpi + (i - mid) * step), each half black and half white under every lens.
// Seen through the sheet, the band whose pitch matches the sheet and printer flips evenly between black and white as it is tilted; the others show wide
// stripes. Returns { width, height, data (RGBA), labels: [{ x, y, w, h, text }] } (the page writes each band's pitch in its label box).
export function pitchTest({ lpi, dpi, width, height, axis = 'x', step = 0.1, count = 11 }) {
  const plan = lenticularPlan({ lpi, dpi, width, height });
  const W = plan.width;
  const H = plan.height;
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const n = plan.views;
  // Bands across the other direction; a label box at the start of each, a quarter inch deep.
  const across = axis === 'x' ? H : W;
  const label = Math.min(Math.round(dpi / 4), Math.floor(across / count / 3));
  const labels = [];
  const mid = (count - 1) / 2;
  for (let b = 0; b < count; b++) {
    const p = +(plan.lpi + (b - mid) * step).toFixed(4);
    const start = Math.round((b * across) / count);
    const end = Math.round(((b + 1) * across) / count);
    const map = stripMap(axis === 'x' ? W : H, n, dpi, p);
    const black = (v) => v < n / 2;
    for (let a = start + label; a < end - Math.max(1, Math.round(label / 4)); a++) {
      if (axis === 'x') {
        for (let x = 0; x < W; x++) if (black(map[x])) data.fill(0, (a * W + x) * 4, (a * W + x) * 4 + 3);
      } else {
        for (let y = 0; y < H; y++) if (black(map[y])) data.fill(0, (y * W + a) * 4, (y * W + a) * 4 + 3);
      }
    }
    const text = `${p.toFixed(2)} LPI`;
    labels.push(axis === 'x' ? { x: 0, y: start, w: W, h: label, text } : { x: start, y: 0, w: end - start, h: label, text, vertical: true });
  }
  return { width: W, height: H, data, labels, views: n };
}

// A PNG file with its resolution written in (pHYs, dots per meter), so a print dialog sizes it to the inch; any resolution it had is replaced.
export function pngWithDpi(png, dpi) {
  const ppm = Math.round(dpi / 0.0254);
  const phys = new Uint8Array(9);
  const v = new DataView(phys.buffer);
  v.setUint32(0, ppm);
  v.setUint32(4, ppm);
  phys[8] = 1;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const parts = [png.subarray(0, 8)];
  let at = 8;
  while (at + 12 <= png.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(png[at + 4], png[at + 5], png[at + 6], png[at + 7]);
    if (type !== 'pHYs') parts.push(png.subarray(at, at + 12 + len));
    if (type === 'IHDR') parts.push(pngChunk('pHYs', phys));
    at += 12 + len;
  }
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
