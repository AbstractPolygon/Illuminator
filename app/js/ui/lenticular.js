// Render Settings > Lenticular Print: a print to put under a lens sheet (core/lenticular.js). 3D: views across the lens aperture (the 3D section's
// viewpoints, more of them); Animation: the Animation section's frames, so a focus sweep refocuses as the print is tilted. Each picture is put through the
// crop, rotation and pivot, fills the print's size, and its strips are copied in; the file is a PNG at the printer's resolution. The sheet and printer
// settings belong to the equipment, not the photo, so they are kept in this browser rather than in the photo's edits.

import { lenticularPlan, stripMap, interlaceInto, coverRect, pickFrames, viewPositions, pitchTest, pngWithDpi } from '../core/lenticular.js';
import { geometry } from '../core/geometry.js';
import { toImageData } from '../engine.js';
import { download } from '../platform.js';

const STORE = 'illuminator.lenticular';
// (the print type and depth are the photo's, saved with its edits; these are the sheet's, the printer's and the print's)
const FIELDS = ['lent-lpi', 'lent-dpi', 'lent-pitch', 'lent-width', 'lent-height', 'lent-reverse'];

export function initLenticular({ $, state, engine, cameraParams, eyeParams, withPivotZoom, pivotFor, cropValues, drawGeometry, ensureAnimation, frameGeometry, showProgress, hideProgress, showError, baseName, showSliderValue }) {
  const settings = () => ({
    type: $('lent-type').value,
    lpi: $('lent-lpi').value,
    dpi: $('lent-dpi').value,
    pitch: $('lent-pitch').value,
    width: $('lent-width').value,
    height: $('lent-height').value,
    depth: +$('lent-depth').value,
    reverse: $('lent-reverse').checked,
  });
  const axis = (type) => (type === 'flip' ? 'y' : 'x');

  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (!saved) return;
      for (const id of FIELDS) {
        if (!(id in saved)) continue;
        const el = $(id);
        if (el.type === 'checkbox') el.checked = !!saved[id];
        else el.value = saved[id];
      }
    } catch {}
  }
  function remember() {
    try {
      localStorage.setItem(STORE, JSON.stringify(Object.fromEntries(FIELDS.map((id) => [id, $(id).type === 'checkbox' ? $(id).checked : $(id).value]))));
    } catch {}
  }

  // The line under the settings: how many pictures, and the file's size; or what is wrong with the settings.
  function showInfo() {
    const s = settings();
    $('lent-depth-row').hidden = s.type !== '3d';
    try {
      const plan = lenticularPlan(s);
      $('lent-info').textContent = `${plan.views} pictures under each lens · ${plan.width} × ${plan.height} px at ${plan.dpi} DPI. Print at 100%, without scaling.`;
      $('lent-info').classList.remove('error');
    } catch (err) {
      $('lent-info').textContent = err.message;
      $('lent-info').classList.add('error');
    }
  }

  // A picture through a geometry (or as it is), as a canvas.
  function shaped(img, g) {
    const w = g ? g.width : img.width;
    const h = g ? g.height : img.height;
    const c = Object.assign(document.createElement('canvas'), { width: Math.round(w), height: Math.round(h) });
    const x = c.getContext('2d');
    if (g) drawGeometry(x, img, g);
    else if (img instanceof ImageData) x.putImageData(img, 0, 0);
    else x.drawImage(img, 0, 0);
    return c;
  }

  // 3D: n views across the aperture, each through the crop, rotation and its pivot, as canvases (left viewpoint first).
  async function views3d(n, depth) {
    if (!(state.info && state.info.hasRaw)) throw new Error('A 3D lenticular print needs a photo with its light field (a raw Lytro photo).');
    const p = cameraParams();
    const reach = (state.info.radius || 4.5) * (depth / 100);
    const us = viewPositions(n, p.u, reach);
    const pivots = withPivotZoom(us.map((u) => pivotFor(u, p.v, p.alpha, eyeParams(p, u).aperture)));
    const base = { orientation: +$('orientation').value || 1, angle: +$('straighten').value, crop: cropValues() };
    const out = [];
    for (let i = 0; i < n; i++) {
      showProgress(`Rendering view ${i + 1} of ${n}`, i / n);
      const msg = await engine.request('view', eyeParams(p, us[i]), { onProgress: () => {} });
      if (!msg || !(msg.pixels || msg.bitmap)) throw new Error('Rendering the views was stopped.');
      const img = toImageData(msg);
      try {
        out.push(shaped(img, geometry(img.width, img.height, { ...base, ...(pivots[i] || {}) })));
      } finally {
        if (!(img instanceof ImageData) && img.close) img.close();
      }
    }
    return out;
  }

  // Animation: n of the animation's frames, evenly spaced from the first to the last, each through its geometry.
  async function viewsFlip(n) {
    if (!$('anim-on').checked) throw new Error('An animation lenticular print uses the Animation section\'s frames: turn on Animation and set it up (a focus sweep refocuses as the print is tilted).');
    showProgress('Rendering the animation', 0);
    await ensureAnimation();
    const frames = state.frames || [];
    if (frames.length < 2 || frames.some((f) => !f)) throw new Error('The animation has not finished rendering: try again when it plays.');
    const cache = new Map();
    return pickFrames(frames.length, n).map((i) => {
      if (!cache.has(i)) {
        const img = frames[i];
        cache.set(i, shaped(img, frameGeometry(i, img.width, img.height)));
      }
      return cache.get(i);
    });
  }

  async function savePng(canvas, name, dpi) {
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const png = pngWithDpi(new Uint8Array(await blob.arrayBuffer()), dpi);
    download(new Blob([png], { type: 'image/png' }), name);
  }

  async function savePrint() {
    if (!state.info) return;
    const s = settings();
    $('lent-btn').disabled = true;
    try {
      const plan = lenticularPlan(s);
      const pics = s.type === 'flip' ? await viewsFlip(plan.views) : await views3d(plan.views, s.depth);
      const W = plan.width;
      const H = plan.height;
      const a = axis(s.type);
      const map = stripMap(a === 'x' ? W : H, plan.views, plan.dpi, plan.pitch, s.reverse);
      const c = new OffscreenCanvas(W, H);
      const g = c.getContext('2d', { willReadFrequently: true });
      g.imageSmoothingQuality = 'high';
      const out = new Uint8ClampedArray(W * H * 4);
      for (let k = 0; k < pics.length; k++) {
        showProgress('Interleaving the pictures', k / pics.length);
        // (yield, so the progress shows)
        await new Promise((r) => setTimeout(r, 0));
        const pic = pics[k];
        const r = coverRect(pic.width, pic.height, W, H);
        g.clearRect(0, 0, W, H);
        g.drawImage(pic, r.sx, r.sy, r.sw, r.sh, 0, 0, W, H);
        interlaceInto(out, g.getImageData(0, 0, W, H).data, W, H, map, k, a);
      }
      g.putImageData(new ImageData(out, W, H), 0, 0);
      showProgress('Saving the print', 1);
      await savePng(c, `${baseName()}-lenticular-${s.type === 'flip' ? 'animation' : '3d'}-${plan.lpi}lpi-${plan.dpi}dpi.png`, plan.dpi);
    } catch (err) {
      showError(err);
    } finally {
      hideProgress();
      $('lent-btn').disabled = !state.info;
    }
  }

  async function saveTest() {
    const s = settings();
    try {
      const chart = pitchTest({ ...s, axis: axis(s.type) });
      const c = new OffscreenCanvas(chart.width, chart.height);
      const g = c.getContext('2d');
      g.putImageData(new ImageData(chart.data, chart.width, chart.height), 0, 0);
      g.fillStyle = '#000';
      g.textBaseline = 'middle';
      for (const l of chart.labels) {
        const size = Math.max(8, Math.min(l.h * 0.7, l.w / (l.text.length * 0.62)));
        g.font = `${Math.round(size)}px sans-serif`;
        g.fillText(l.text, l.x + size * 0.4, l.y + l.h / 2);
      }
      await savePng(c, `pitch-test-${s.lpi}lpi-${s.dpi}dpi-${axis(s.type) === 'x' ? 'upright' : 'across'}.png`, +s.dpi);
    } catch (err) {
      showError(err);
    }
  }

  restore();
  for (const id of FIELDS) {
    $(id).addEventListener('input', () => { showInfo(); remember(); });
    $(id).addEventListener('change', () => { showInfo(); remember(); });
  }
  $('lent-type').addEventListener('change', showInfo);
  $('lent-depth').addEventListener('input', () => showSliderValue($('lent-depth')));
  showSliderValue($('lent-depth'));
  // (a photo's edits set the type and depth without events: the depth row follows when the section is opened)
  $('lenticular-panel').addEventListener('toggle', () => { showInfo(); showSliderValue($('lent-depth')); });
  $('lent-btn').onclick = savePrint;
  $('lent-test-btn').onclick = saveTest;
  showInfo();
  return { showInfo };
}
