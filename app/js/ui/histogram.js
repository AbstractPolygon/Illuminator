// histogram: moved out of main.js. initHistogram() runs where the section used to, with what it uses from the rest of the page.
import { fNumberAt, F_STOPS } from '../core/fstops.js';
import { watchExactSliders } from './exactslider.js';
import { toImageData } from '../engine.js';
import { geometry } from '../core/geometry.js';

export function initHistogram({ engine, drawPeaking, refreshDepthRuler, $, canvas, state, ctx, hasDepth, openSeq, progressFor, hideProgress, geometrySettings, drawGeometry, showError }) {

  let histogramQueued = false;

  // At most once per frame: the picture can change on every pointer move. The histogram and focus peaking read the picture shown back, which (a picture from the graphics card)
  // waits until the card has finished all the worker's work: while the worker is busy they wait for it to finish, so the page is not held up.
  function scheduleHistogram() {
    if (histogramQueued) return;
    histogramQueued = true;
    const run = () => {
      if ([...engine.pending.values()].some((p) => p.type !== 'depthHistogram')) {
        setTimeout(() => requestAnimationFrame(run), 150);
        return;
      }
      histogramQueued = false;
      drawHistogram();
      drawPeaking();
      refreshDepthRuler();
    };
    requestAnimationFrame(run);
  }

  // RGB histogram of what the picture currently shows.
  let histogramCanvas = null;
  function drawHistogram() {
    const hc = $('histogram');
    const hctx = hc.getContext('2d');
    hctx.clearRect(0, 0, hc.width, hc.height);
    const w = canvas.width;
    const h = canvas.height;
    if (!state.info || !w || !h || canvas.classList.contains('hidden')) return;
    // About 250k pixels at most: a large picture is first drawn small (nearest pixels, so the values stay real ones) and only that is read back.
    let data;
    let step = 4;
    if (w * h <= 300000) {
      data = ctx.getImageData(0, 0, w, h).data;
    } else {
      const k = Math.sqrt(250000 / (w * h));
      const sw = Math.max(1, Math.round(w * k));
      const sh = Math.max(1, Math.round(h * k));
      histogramCanvas ||= document.createElement('canvas');
      if (histogramCanvas.width !== sw || histogramCanvas.height !== sh) {
        histogramCanvas.width = sw;
        histogramCanvas.height = sh;
      }
      const sctx = histogramCanvas.getContext('2d', { willReadFrequently: true });
      sctx.imageSmoothingEnabled = false;
      sctx.drawImage(canvas, 0, 0, w, h, 0, 0, sw, sh);
      data = sctx.getImageData(0, 0, sw, sh).data;
    }
    const bins = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    for (let i = 0; i < data.length; i += step) {
      bins[0][data[i]]++;
      bins[1][data[i + 1]]++;
      bins[2][data[i + 2]]++;
    }
    // Scale to the tallest bin, ignoring the clipped ends, with a square root
    // so shadows and highlights stay readable.
    let max = 1;
    for (const b of bins) for (let i = 1; i < 255; i++) max = Math.max(max, b[i]);
    const H = hc.height;
    const colors = ['rgba(255, 90, 90, 0.75)', 'rgba(90, 220, 110, 0.75)', 'rgba(100, 150, 255, 0.75)'];
    hctx.globalCompositeOperation = 'lighter';
    bins.forEach((b, c) => {
      hctx.fillStyle = colors[c];
      hctx.beginPath();
      hctx.moveTo(0, H);
      for (let i = 0; i < 256; i++) hctx.lineTo(i, H - Math.min(1, Math.sqrt(b[i] / max)) * (H - 2));
      hctx.lineTo(255, H);
      hctx.closePath();
      hctx.fill();
    });
    hctx.globalCompositeOperation = 'source-over';
  }

  // Aperture stops offered by the f-stop slider, smallest aperture first.


  // (the slider's position among the stops: between two, an animation's in-between f-number, core/fstops.js)
  function fNumber() {
    return fNumberAt($('fstop').value);
  }

  // The camera recorded the light field through its own aperture (f/2 on the
  // ILLUM). Stopping down uses a smaller part of it (synthetic aperture as a
  // fraction of the recorded one); opening up past it adds blur from the depth
  // map, scaled so the blur grows like a real lens's would.
  // Optical bokeh averages the camera's own views, which only refocuses: with the Depth slider moved, or Focus Spread or Tilt on, the blur has to come from the depth
  // map, and Natural is used (a note under Shape says so).
  function opticalInEffect() {
    if ($('bokeh').value !== 'optical') return false;
    const field = focusField();
    return +$('dof-depth').value === 0 && !(field.spread > 0 || field.smooth > 0 || field.blur > 0 || field.tilt.some((t) => t));
  }

  function apertureFor(n) {
    const native = (state.info && state.info.cam && state.info.cam.capture && state.info.cam.capture.fNumber) || 2;
    const ratio = native / n;
    const radius = state.info ? state.info.radius : 4.5;
    // Normally the blur is drawn from the depth map over the sharp single view
    // (or the multi-view denoised merge), like Lytro's own renders: whatever
    // is in focus keeps full sharpness. "Optical" instead refocuses by
    // averaging the views, which is softer but follows the real optics.
    if (!opticalInEffect()) return { aperture: 0, dof: ratio < 0.15 ? 0 : (radius * ratio) / 14 };
    // About one view's worth of the aperture: render that single view (fast).
    if (ratio < 0.15) return { aperture: 0, dof: 0 };
    if (ratio <= 1) return { aperture: ratio, dof: 0 };
    return { aperture: 1, dof: (radius * (ratio - 1)) / 14 };
  }

  // (the step back on a slider used by hand)
  watchExactSliders();

  function showFNumber() {
    const n = fNumber();
    // (a stop as it is named; an animation's f-number between the stops as it is, to two decimals)
    $('fstop-label').textContent = `f/${F_STOPS.includes(n) ? n : +n.toFixed(2)}`;
  }

  // Focus spread and tilt. Depth values run from -1.6 to 1.6, so full spread
  // keeps that whole range sharp around the focus depth, and full tilt changes
  // the focus depth by 1.6 from one edge of the picture to the other. The
  // tilted focus plane turns around the focus point (normalized x, y).
  // The focus field (spread and tilt) for the worker, from the controls, or
  // with any of them replaced by `v` (an animation frame's values).
  function focusField(v = {}) {
    // Tilt off: a flat plane of focus, the settings kept for later.
    const tilt = $('tilt-on').checked ? 1.6 * (v.tilt ?? +$('tilt').value) / 100 : 0;
    const angle = ((v.tiltRotation ?? +$('tilt-rotation').value) * Math.PI) / 180;
    return {
      spread: 1.6 * (v.spread ?? +$('spread').value) / 100,
      // Width of the soft edge of the sharp range, in the same units.
      smooth: 0.8 * (v.spreadSmooth ?? +$('spread-smooth').value) / 100,
      // Feathering of the spread in the picture: the blur radius map is smoothed over this many units of the depth of field strength (pixels = blur x
      // the image's pixels per unit; full Blur is the camera's own f/2 blur three focus units away).
      blur: (3 * (state.info ? state.info.radius : 4.5) / 14) * (v.spreadBlur ?? +$('spread-blur').value) / 100,
      tilt: [tilt * Math.cos(angle), tilt * Math.sin(angle)],
      point: [v.pointX ?? state.focusPoint.x, v.pointY ?? state.focusPoint.y],
    };
  }

  // Bokeh options for the worker: shape and highlights, and the focus field.
  const BOKEH_SHAPE = ['bokeh-blades', 'bokeh-oval', 'bokeh-rotation', 'bokeh-onion', 'bokeh-points', 'bokeh-inner', 'bokeh-width', 'bokeh-irregular', 'bokeh-ring-blur', 'bokeh-warp', 'bokeh-onion-on', 'bokeh-size', 'bokeh-spots', 'bokeh-cat', 'bokeh-swirl', 'bokeh-edge', 'bokeh-edge-fb', 'bokeh-bubble', 'bokeh-hole', 'bokeh-fringe', 'bokeh-hot', 'bokeh-grain', 'bokeh-diffraction', 'bokeh-streak', 'bokeh-streak-len', 'bokeh-streak-threshold', 'bokeh-outer', 'bokeh-star', 'bokeh-spikes', 'bokeh-ghosts', 'bokeh-fog', 'bokeh-dirt'];
  function bokehParams(v = {}) {
    const shape = $('bokeh').value === 'natural' ? 'smooth' : $('bokeh').value;
    return {
      shape,
      highlights: v.highlights ?? +$('highlights').value,
      // (keyframed: a frame's own values; blades in whole numbers)
      blades: Math.round(v.bokehBlades ?? +$('bokeh-blades').value),
      oval: shape === 'circle' ? (v.bokehOval ?? +$('bokeh-oval').value) / 100 : 0,
      rotation: v.bokehRotation ?? +$('bokeh-rotation').value,
      // (with Onion rings off, no ring is made or drawn)
      onion: shape === 'smooth' || shape === 'optical' || !$('bokeh-onion-on').checked ? 0 : (v.bokehOnion ?? +$('bokeh-onion').value) / 100,
      // the size of the balls, as a multiple of the lens's blur (applied where the blur is drawn)
      size: (v.bokehSize ?? +$('bokeh-size').value) / 100,
      // (a custom shape's image: white where light passes, see core/dof.js)
      image: shape === 'custom' ? $('bokeh-image').value : '',
      // Star and Heart (core/dof.js drawnShape)
      // (keyframed: a frame's own values; points in whole numbers)
      points: Math.round(v.bokehPoints ?? +$('bokeh-points').value),
      inner: (v.bokehInner ?? +$('bokeh-inner').value) / 100,
      width: (v.bokehWidth ?? +$('bokeh-width').value) / 100,
      outer: (v.bokehOuter ?? +$('bokeh-outer').value) / 100,
      // the onion skin's irregularity and ring blur, and dust spots (core/dof.js onionMap)
      irregular: (v.bokehIrregular ?? +$('bokeh-irregular').value) / 100,
      ringBlur: (v.bokehRingBlur ?? +$('bokeh-ring-blur').value) / 100,
      warp: (v.bokehWarp ?? +$('bokeh-warp').value) / 100,
      spots: shape === 'smooth' || shape === 'optical' ? 0 : (v.bokehSpots ?? +$('bokeh-spots').value) / 100,
      // The ball's character and the cat's-eye (core/dof.js): all off for Natural and Optical
      catEye: shape === 'smooth' || shape === 'optical' ? 0 : (v.bokehCat ?? +$('bokeh-cat').value) / 100,
      swirl: shape === 'smooth' || shape === 'optical' ? 0 : (v.bokehSwirl ?? +$('bokeh-swirl').value) / 100,
      edge: shape === 'smooth' || shape === 'optical' ? 0 : (v.bokehEdge ?? +$('bokeh-edge').value) / 100,
      edgeFB: shape === 'smooth' || shape === 'optical' ? 0 : (v.bokehEdgeFB ?? +$('bokeh-edge-fb').value) / 100,
      bubble: shape === 'smooth' || shape === 'optical' ? 0 : (v.bokehBubble ?? +$('bokeh-bubble').value) / 100,
      hole: shape === 'smooth' || shape === 'optical' ? 0 : (v.bokehHole ?? +$('bokeh-hole').value) / 100,
      fringe: shape === 'smooth' || shape === 'optical' ? 0 : (v.bokehFringe ?? +$('bokeh-fringe').value) / 100,
      hot: shape === 'smooth' || shape === 'optical' ? 0 : (v.bokehHot ?? +$('bokeh-hot').value) / 100,
      grain: shape === 'smooth' || shape === 'optical' ? 0 : (v.bokehGrain ?? +$('bokeh-grain').value) / 100,
      diffraction: shape === 'smooth' || shape === 'optical' ? 0 : (v.bokehDiffraction ?? +$('bokeh-diffraction').value) / 100,
      // Lens effects round bright points (core/bokehfx.js): independent of the ball's shape
      fxStreak: (v.bokehStreak ?? +$('bokeh-streak').value) / 100,
      fxStreakLen: (v.bokehStreakLen ?? +$('bokeh-streak-len').value) / 100,
      fxStreakThreshold: (v.bokehStreakThreshold ?? +$('bokeh-streak-threshold').value) / 100,
      fxStar: (v.bokehStar ?? +$('bokeh-star').value) / 100,
      fxSpikes: Math.round((v.bokehSpikes ?? +$('bokeh-spikes').value)),
      fxGhosts: (v.bokehGhosts ?? +$('bokeh-ghosts').value) / 100,
      fxFog: (v.bokehFog ?? +$('bokeh-fog').value) / 100,
      fxDirt: (v.bokehDirt ?? +$('bokeh-dirt').value) / 100,
      ...focusField(v),
    };
  }

  // Perspective > Reach: how far the viewpoint can move, as a multiple of the lens's opening (1 = what the camera recorded).
  function viewReach() {
    return Math.max(1, (+$('view-reach').value || 100) / 100);
  }

  function showViewpoint() {
    const r = (state.info && state.info.radius) || 1;
    const { u, v } = state.camera;
    const centered = Math.abs(u) < 1e-3 && Math.abs(v) < 1e-3;
    $('viewpoint').textContent = centered ? 'Center' : `${Math.round((100 * u) / r)}%, ${Math.round((100 * v) / r)}%`;
    // (Reset shows only while the viewpoint is moved)
    $('view-center').hidden = centered;
  }

  function showFocusPoint() {
    const { x, y } = state.focusPoint;
    $('focus-point').textContent = x === 0.5 && y === 0.5 ? 'Center' : `${Math.round(x * 100)}%, ${Math.round(y * 100)}%`;
  }

  // Show spread: tints what lies outside the sharp depth range, blue where
  // nearer and orange where farther. Drawn on its own canvas over the picture
  // (the histogram reads the picture). Requests are coalesced like the view.
  const spreadView = { busy: false, pending: false };
  async function updateSpreadOverlay() {
    const overlay = $('spread-overlay');
    // Show tilt: the same tint, measured from the tilted plane of focus alone
    // (no sharp range around it), fading in over a short distance from it.
    const tiltView = $('tilt-show').checked && $('tilt-on').checked;
    const on = ($('spread-show').checked || tiltView) && hasDepth() && state.mode === 'camera' && !state.depthShown;
    overlay.hidden = !on;
    if (!on) return;
    if (spreadView.busy) {
      spreadView.pending = true;
      return;
    }
    spreadView.busy = true;
    const gen = openSeq.current();
    try {
      const field = tiltView ? { ...focusField(), spread: 0, smooth: 0.3 } : focusField();
      const msg = await engine.request('spreadMask', { alpha: +$('focus').value, ...field }, { onProgress: progressFor(gen) });
      if (openSeq.superseded(gen)) return;
      hideProgress();
      if (msg && msg.pixels) {
        const mask = toImageData(msg);
        const g = state.geom;
        if (g) {
          // Through the same crop and rotation as the picture.
          overlay.width = canvas.width;
          overlay.height = canvas.height;
          const k = geometry(mask.width, mask.height, geometrySettings());
          const o = overlay.getContext('2d');
          drawGeometry(o, mask, k, canvas.width / k.width, false);
        } else {
          overlay.width = msg.width;
          overlay.height = msg.height;
          overlay.getContext('2d').putImageData(mask, 0, 0);
        }
      }
    } catch (err) {
      if (!openSeq.superseded(gen)) showError(err, 'Could not show the spread');
    } finally {
      spreadView.busy = false;
      if (spreadView.pending) {
        spreadView.pending = false;
        updateSpreadOverlay();
      }
    }
  }
  return { scheduleHistogram, fNumber, opticalInEffect, apertureFor, showFNumber, focusField, BOKEH_SHAPE, bokehParams, viewReach, showViewpoint, showFocusPoint, spreadView, updateSpreadOverlay };
}
