// Render Settings > Lenticular Print: a print to put under a lens sheet (core/lenticular.js). 3D: views across the lens aperture (the 3D section's
// viewpoints, more of them); Animation: the Animation section's frames, so a focus sweep refocuses as the print is tilted. Each picture is put through the
// crop, rotation and pivot, fills the print's size, and its strips are copied in; the file is a PNG at the printer's resolution. The sheet and printer
// settings belong to the equipment, not the photo, so they are kept in this browser rather than in the photo's edits.

import { lenticularPlan, stripMap, lensMap, lensCount, interlaceLensInto, coverRect, pickFrames, viewPositions, pitchTest, pngWithDpi } from '../core/lenticular.js';
import { geometry } from '../core/geometry.js';
import { toImageData } from '../engine.js';
import { download } from '../platform.js';

const STORE = 'illuminator.lenticular';
// (the print type and depth are the photo's, saved with its edits; these are the sheet's, the printer's and the print's)
const FIELDS = ['lent-lpi', 'lent-dpi', 'lent-pitch', 'lent-width', 'lent-height', 'lent-reverse'];

export function initLenticular({ $, state, engine, cameraParams, eyeParams, withPivotZoom, pivotFor, cropValues, drawGeometry, animationPlan, invalidateAnimation, showNotice, showProgress, hideProgress, showError, baseName, showSliderValue }) {
  const settings = () => ({
    type: $('lent-type').value,
    tilt: $('lent-tilt').value,
    lpi: $('lent-lpi').value,
    dpi: $('lent-dpi').value,
    pitch: $('lent-pitch').value,
    width: $('lent-width').value,
    height: $('lent-height').value,
    depth: +$('lent-depth').value,
    reverse: $('lent-reverse').checked,
  });
  // (Tilt left and right: upright lenses, strips in columns; up and down: lenses across, strips in rows)
  const axisOf = (s) => (s.tilt === 'ud' ? 'y' : 'x');
  const isAnimation = (type) => type === 'anim';

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
    $('lent-depth-row').hidden = isAnimation(s.type);
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
  async function views3d(n, depth, axis = 'x') {
    if (!(state.info && state.info.hasRaw)) throw new Error('A 3D lenticular print needs a photo with its light field (a raw Lytro photo).');
    const p = cameraParams();
    // (Movement past 100%: the views beyond the lens's opening are made by the worker from the edge view and the depth map)
    const reach = (state.info.radius || 4.5) * (depth / 100);
    // Across the lens left to right, or (tilting up and down) top to bottom.
    const points = viewPositions(n, axis === 'x' ? p.u : p.v, reach).map((t) => (axis === 'x' ? { u: t, v: p.v } : { u: p.u, v: t }));
    // With the aperture closed each view is a single viewpoint, as the picture shows it (and it can reach farther: see the worker's singleViewEdge); open, each view
    // looks through a smaller part of the aperture, as the 3D section's eyes do.
    const viewParams = (q) => (p.aperture > 0 ? { ...eyeParams(p, q.u), v: q.v } : { ...p, u: q.u, v: q.v });
    const pivots = withPivotZoom(points.map((q) => pivotFor(q.u, q.v, p.alpha, viewParams(q).aperture)));
    const base = { orientation: +$('orientation').value || 1, angle: +$('straighten').value, crop: cropValues() };
    const out = [];
    for (let i = 0; i < n; i++) {
      if (run && run.stopped) throw STOPPED;
      showProgress(`Rendering view ${i + 1} of ${n}`, i / n);
      const msg = await engine.request('view', viewParams(points[i]), { onProgress: () => {} });
      if (!msg || !(msg.pixels || msg.bitmap)) throw STOPPED;
      const img = toImageData(msg);
      try {
        out.push(shaped(img, geometry(img.width, img.height, { ...base, ...(pivots[i] || {}) })));
      } finally {
        if (!(img instanceof ImageData) && img.close) img.close();
      }
    }
    return out;
  }

  // Animation: n of the animation's frames, evenly spaced from its first frame to its last, each through its crop, rotation, pivot, pan and zoom. Only those frames are
  // rendered (in one 'frames' job, as the animation renders them), so the animation need not have been played or finished.
  async function viewsFlip(n) {
    if (!$('anim-on').checked) throw new Error('An animation lenticular print uses the Animation section\'s animation: turn on Animation and set it up (a focus sweep refocuses as the print is tilted).');
    const { list, pivots } = animationPlan();
    if (list.length < 2) throw new Error('The animation has only one frame: add a second keyframe, or choose Viewpoint or Focus sweep in the Animation section.');
    const picks = pickFrames(list.length, n);
    const unique = [...new Set(picks)];
    const shots = new Array(unique.length);
    let done = 0;
    showProgress('Rendering the animation frames', 0);
    const { promise } = engine.job('frames', 'frames', { path: unique.map((i) => list[i]) }, {
      onProgress: () => {},
      onFrame: async (msg) => {
        shots[msg.index] = msg.bitmap || (await createImageBitmap(toImageData(msg)));
        done++;
        showProgress(`Rendering frame ${done} of ${unique.length}`, done / unique.length);
      },
    });
    await promise;
    // (the job takes the place of any animation frames still rendering for playback: those are made again when the animation plays)
    if ((state.frames || []).some((f) => !f)) invalidateAnimation();
    if (run && run.stopped) throw STOPPED;
    if (shots.some((x) => !x)) throw new Error('Rendering the animation frames was stopped.');
    const base = { orientation: +$('orientation').value || 1, angle: +$('straighten').value, crop: cropValues() };
    const made = new Map(unique.map((i, k) => {
      const img = shots[k];
      const pic = shaped(img, geometry(img.width, img.height, { ...base, ...(pivots[i] || {}) }));
      if (img.close) img.close();
      return [i, pic];
    }));
    return picks.map((i) => made.get(i));
  }

  // Preview and Save print can be stopped: while one renders, its button reads Stop.
  const STOPPED = new Error('stopped');
  let run = null;
  function begin(button) {
    run = { stopped: false, button, label: button.textContent };
    button.textContent = 'Stop';
    button.disabled = false;
    for (const id of ['lent-preview-btn', 'lent-btn']) if ($(id) !== button) $(id).disabled = true;
    return run;
  }
  function end() {
    if (!run) return;
    run.button.textContent = run.label;
    run = null;
    for (const id of ['lent-preview-btn', 'lent-btn']) $(id).disabled = !state.info;
  }
  function stop() {
    if (!run) return;
    run.stopped = true;
    run.button.disabled = true;
    // (an animation's frames: the job ends at its next frame)
    engine.cancel('frames');
  }
  // A failure, or nothing at all when it was stopped.
  function failed(err) {
    hideProgress();
    if (err === STOPPED || (run && run.stopped)) showNotice('Lenticular rendering stopped.');
    else showError(err);
  }

  async function savePng(canvas, name, dpi) {
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const png = pngWithDpi(new Uint8Array(await blob.arrayBuffer()), dpi);
    download(new Blob([png], { type: 'image/png' }), name);
  }

  // Preview: the print as it looks through the sheet. Tilt picks the picture seen (between two pictures, both, as a lens shows them in passing); Lens
  // detail keeps one stripe per lens across the lenses, the detail the print has that way. Play rocks the print back and forth.
  const preview = { pics: null, lensPics: null, playing: 0, t: 0.5, n: 0 };
  async function openPreview() {
    if (run) return stop();
    if (!state.info) return;
    const s = settings();
    begin($('lent-preview-btn'));
    try {
      const plan = lenticularPlan(s);
      const pics = isAnimation(s.type) ? await viewsFlip(plan.views) : await views3d(plan.views, s.depth, axisOf(s));
      const a = axisOf(s);
      // Shown at most 760 px on its long side.
      const k = Math.min(1, 760 / Math.max(plan.width, plan.height));
      const PW = Math.max(1, Math.round(plan.width * k));
      const PH = Math.max(1, Math.round(plan.height * k));
      const lenses = Math.max(1, Math.round(((a === 'x' ? plan.width : plan.height) / plan.dpi) * plan.pitch));
      const order = s.reverse ? pics.slice().reverse() : pics;
      preview.pics = [];
      preview.lensPics = [];
      for (const pic of order) {
        const r = coverRect(pic.width, pic.height, PW, PH);
        const full = Object.assign(document.createElement('canvas'), { width: PW, height: PH });
        const fg = full.getContext('2d');
        fg.imageSmoothingQuality = 'high';
        fg.drawImage(pic, r.sx, r.sy, r.sw, r.sh, 0, 0, PW, PH);
        // One sample per lens across the lenses, drawn back as stripes.
        const few = Object.assign(document.createElement('canvas'), { width: a === 'x' ? lenses : PW, height: a === 'x' ? PH : lenses });
        const wg = few.getContext('2d');
        wg.imageSmoothingQuality = 'high';
        wg.drawImage(pic, r.sx, r.sy, r.sw, r.sh, 0, 0, few.width, few.height);
        const striped = Object.assign(document.createElement('canvas'), { width: PW, height: PH });
        const sg = striped.getContext('2d');
        sg.imageSmoothingEnabled = false;
        sg.drawImage(few, 0, 0, PW, PH);
        preview.pics.push(full);
        preview.lensPics.push(striped);
      }
      preview.n = order.length;
      const c = $('lent-preview-canvas');
      c.width = PW;
      c.height = PH;
      $('lent-preview-note').textContent = isAnimation(s.type)
        ? `Animation, as the print is tilted ${a === 'y' ? 'up and down' : 'left and right'} · ${plan.views} frames sampled from the animation · ${lenses} lenses ${a === 'y' ? 'down' : 'across'} the ${s.width} × ${s.height} inch print.`
        : `3D, as the print is tilted ${a === 'y' ? 'up and down' : 'left and right'} · ${plan.views} views · ${lenses} lenses ${a === 'y' ? 'down' : 'across'} the ${s.width} × ${s.height} inch print.${a === 'x' ? ' On the print each eye sees a different view, so the depth itself shows only there.' : ''}`;
      $('lent-preview-tilt').value = 500;
      drawPreview();
      hideProgress();
      end();
      $('lent-preview-dialog').showModal();
    } catch (err) {
      failed(err);
    } finally {
      end();
    }
  }
  function drawPreview() {
    if (!preview.pics) return;
    const list = $('lent-preview-lenses').checked ? preview.lensPics : preview.pics;
    const t = (+$('lent-preview-tilt').value / 1000) * (preview.n - 1);
    const i = Math.min(preview.n - 1, Math.floor(t));
    const f = t - i;
    const g = $('lent-preview-canvas').getContext('2d');
    g.globalAlpha = 1;
    g.drawImage(list[i], 0, 0);
    if (f > 0 && i + 1 < preview.n) {
      g.globalAlpha = f;
      g.drawImage(list[i + 1], 0, 0);
      g.globalAlpha = 1;
    }
  }
  function stopPlay() {
    if (preview.playing) cancelAnimationFrame(preview.playing);
    preview.playing = 0;
    $('lent-preview-play').textContent = 'Play';
  }
  function play() {
    if (preview.playing) return stopPlay();
    $('lent-preview-play').textContent = 'Stop';
    const start = performance.now() - (+$('lent-preview-tilt').value / 1000) * 1500;
    const step = (now) => {
      // Back and forth across the whole tilt every 3 seconds.
      const p = ((now - start) / 1500) % 2;
      $('lent-preview-tilt').value = Math.round((p <= 1 ? p : 2 - p) * 1000);
      drawPreview();
      preview.playing = requestAnimationFrame(step);
    };
    preview.playing = requestAnimationFrame(step);
  }
  $('lent-preview-btn').onclick = openPreview;
  $('lent-preview-tilt').addEventListener('input', () => { stopPlay(); drawPreview(); });
  $('lent-preview-lenses').addEventListener('change', drawPreview);
  $('lent-preview-play').onclick = play;
  $('lent-preview-dialog').addEventListener('close', () => {
    stopPlay();
    preview.pics = null;
    preview.lensPics = null;
  });

  async function savePrint() {
    if (run) return stop();
    if (!state.info) return;
    const s = settings();
    begin($('lent-btn'));
    try {
      const plan = lenticularPlan(s);
      const pics = isAnimation(s.type) ? await viewsFlip(plan.views) : await views3d(plan.views, s.depth, axisOf(s));
      const W = plan.width;
      const H = plan.height;
      const a = axisOf(s);
      const length = a === 'x' ? W : H;
      const map = stripMap(length, plan.views, plan.dpi, plan.pitch, s.reverse);
      const lens = lensMap(length, plan.dpi, plan.pitch);
      const lenses = lensCount(length, plan.dpi, plan.pitch);
      // Each picture at one column (or row) per lens: all the detail the print shows of it.
      const LW = a === 'x' ? lenses : W;
      const LH = a === 'x' ? H : lenses;
      const small = new OffscreenCanvas(LW, LH);
      const sg = small.getContext('2d', { willReadFrequently: true });
      sg.imageSmoothingQuality = 'high';
      const out = new Uint8ClampedArray(W * H * 4);
      for (let k = 0; k < pics.length; k++) {
        showProgress('Interleaving the pictures', k / pics.length);
        // (yield, so the progress shows and Stop can be pressed)
        await new Promise((r) => setTimeout(r, 0));
        if (run && run.stopped) throw STOPPED;
        const pic = pics[k];
        const r = coverRect(pic.width, pic.height, W, H);
        sg.clearRect(0, 0, LW, LH);
        sg.drawImage(pic, r.sx, r.sy, r.sw, r.sh, 0, 0, LW, LH);
        interlaceLensInto(out, sg.getImageData(0, 0, LW, LH).data, W, H, map, lens, lenses, k, a);
      }
      const c = new OffscreenCanvas(W, H);
      const g = c.getContext('2d');
      g.putImageData(new ImageData(out, W, H), 0, 0);
      showProgress('Saving the print', 1);
      await savePng(c, `${baseName()}-lenticular-${isAnimation(s.type) ? 'animation' : '3d'}-${plan.lpi}lpi-${plan.dpi}dpi.png`, plan.dpi);
    } catch (err) {
      failed(err);
    } finally {
      hideProgress();
      end();
    }
  }

  async function saveTest() {
    const s = settings();
    try {
      const chart = pitchTest({ ...s, axis: axisOf(s) });
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
      await savePng(c, `pitch-test-${s.lpi}lpi-${s.dpi}dpi-${axisOf(s) === 'x' ? 'upright' : 'across'}.png`, +s.dpi);
    } catch (err) {
      showError(err);
    }
  }

  // Lens sheet: a standard sheet fills in its LPI; Custom shows the field to type another. On opening, the saved count picks its sheet in the list.
  function showPreset() {
    const preset = $('lent-lpi-preset');
    const lpi = String(+$('lent-lpi').value);
    preset.value = [...preset.options].some((o) => o.value === lpi) ? lpi : 'custom';
    $('lent-lpi-row').hidden = preset.value !== 'custom';
  }
  $('lent-lpi-preset').addEventListener('change', () => {
    const v = $('lent-lpi-preset').value;
    if (v !== 'custom') $('lent-lpi').value = v;
    $('lent-lpi-row').hidden = v !== 'custom';
    if (v === 'custom') $('lent-lpi').focus();
    showInfo();
    remember();
  });

  restore();
  showPreset();
  for (const id of FIELDS) {
    $(id).addEventListener('input', () => { showInfo(); remember(); });
    $(id).addEventListener('change', () => { showInfo(); remember(); });
  }
  $('lent-type').addEventListener('change', showInfo);
  $('lent-tilt').addEventListener('change', showInfo);
  $('lent-depth').addEventListener('input', () => showSliderValue($('lent-depth')));
  showSliderValue($('lent-depth'));
  // (a photo's edits set the type and depth without events: the depth row follows when the section is opened)
  $('lenticular-panel').addEventListener('toggle', () => { showInfo(); showSliderValue($('lent-depth')); });
  $('lent-btn').onclick = savePrint;
  $('lent-test-btn').onclick = saveTest;
  showInfo();
  return { showInfo };
}
