// zoomed in on a Light L16 photo: moved out of main.js. initL16Zoom() runs where the section used to, with what it uses from the rest of the page.
import { apply as applyMatrix } from '../core/geometry.js';
import { toImageData } from '../engine.js';

export function initL16Zoom({ $, state, showsCamera, canvas, engine, hideProgress, drag, fitScale, view, viewer, openSeq, showProgress, cameraParams, MAX_SCALE, clampView, nativeFactor, positionCropBox, watchLevel, lensZoomBy, renderLenslets, lensMinZoom, lensView }) {

  // Past the quick picture's own pixels, the part of the picture on the screen is made again at the zoom's resolution (the half size merge with the longer lens cameras' detail added through
  // the depth: the worker's l16Detail), and laid over the picture. Any change (zoom, pan, viewpoint, focus) takes it away until things settle. (not in automated runs, which take the full size)
  const detailLayer = $('detail-layer');
  let detailTimer = 0;
  let detailToken = 0;
  let detailRunning = false;
  const DETAIL_DELAY = 700;
  const DETAIL_MAX_SCALE = 6;
  function detailWanted() {
    return !!(state.info && state.info.processed && state.info.processed.hires && state.info.processed.levelWidths && (!navigator.webdriver || window.__forceDetail)
      && showsCamera() && state.lastImage && !state.lastImage.pair && canvas.width > 0 && !(state.showingFrames && state.frameScale && state.frameScale !== 1));
  }
  function hideDetail() {
    detailToken++;
    detailLayer.hidden = true;
    if (detailRunning) {
      detailRunning = false;
      engine.cancel('detail').catch(() => {});
      hideProgress();
    }
  }
  function scheduleDetail() {
    hideDetail();
    clearTimeout(detailTimer);
    detailTimer = 0;
    if (!detailWanted()) return;
    detailTimer = setTimeout(runDetail, DETAIL_DELAY);
  }
  async function runDetail() {
    detailTimer = 0;
    if (!detailWanted()) return;
    if (drag.on || state.view.busy || state.view.pending) {
      detailTimer = setTimeout(runDetail, DETAIL_DELAY);
      return;
    }
    // The canvas shows the picture through its geometry (orientation, straighten, crop): G maps the picture's pixels (srcW x srcH) to the canvas's.
    const g = state.geom;
    const G = g ? g.matrix : [1, 0, 0, 1, 0, 0];
    const inv = g ? g.inverse : G;
    const srcW = g ? g.srcW : canvas.width;
    const srcH = g ? g.srcH : canvas.height;
    const mag = Math.sqrt(Math.abs(G[0] * G[3] - G[1] * G[2]));
    const full = Math.max(...state.info.processed.levelWidths);
    const k = full / srcW;
    const scale = fitScale() * view.k;
    // (screen pixels per pixel of the largest level)
    let zs = (scale * mag * (window.devicePixelRatio || 1)) / k;
    if (zs <= 1.05) return;
    const left = parseFloat(canvas.style.left) || 0;
    const top = parseFloat(canvas.style.top) || 0;
    const vw = viewer.clientWidth;
    const vh = viewer.clientHeight;
    // The part of the canvas on the screen (canvas pixels) ...
    const x0 = Math.max(0, -left / scale);
    const y0 = Math.max(0, -top / scale);
    const x1 = Math.min(canvas.width, (vw - left) / scale);
    const y1 = Math.min(canvas.height, (vh - top) / scale);
    if (!(x1 > x0 && y1 > y0)) return;
    // ... and the part of the picture under it (the picture's pixels, a box round the turned corners).
    const corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => applyMatrix(inv, x, y));
    const sx0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0]))));
    const sy0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1]))));
    const sx1 = Math.min(srcW, Math.ceil(Math.max(...corners.map((c) => c[0]))));
    const sy1 = Math.min(srcH, Math.ceil(Math.max(...corners.map((c) => c[1]))));
    if (!(sx1 > sx0 && sy1 > sy0)) return;
    // (in the largest level's pixels; made at the screen's full resolution, however large the screen: the layer is made in tiles)
    const gw = (sx1 - sx0) * k;
    const gh = (sy1 - sy0) * k;
    zs = Math.min(DETAIL_MAX_SCALE, zs);
    const token = ++detailToken;
    detailRunning = true;
    const gen = openSeq.current();
    // (the message shows at once: the first time on a photo the cameras are lined up first, which takes a while)
    showProgress('Adding detail', 0);
    try {
      // The layer covers the part of the canvas on the screen, at the screen's resolution (r layer pixels per canvas pixel); the sharper picture is made in the picture's own
      // frame (dw x dh) and drawn onto the layer through the geometry, each piece as soon as it is made, so it fills in instead of appearing only at the end.
      const r = (scale * (window.devicePixelRatio || 1));
      detailLayer.width = Math.max(1, Math.round((x1 - x0) * r));
      detailLayer.height = Math.max(1, Math.round((y1 - y0) * r));
      const lctx = detailLayer.getContext('2d');
      lctx.setTransform(1, 0, 0, 1, 0, 0);
      lctx.clearRect(0, 0, detailLayer.width, detailLayer.height);
      detailLayer.style.left = `${left + x0 * scale}px`;
      detailLayer.style.top = `${top + y0 * scale}px`;
      detailLayer.style.width = `${(x1 - x0) * scale}px`;
      detailLayer.style.height = `${(y1 - y0) * scale}px`;
      detailLayer.hidden = false;
      const dw = Math.max(1, Math.round(gw * zs));
      const dh = Math.max(1, Math.round(gh * zs));
      const made = document.createElement('canvas');
      made.width = dw;
      made.height = dh;
      const mctx = made.getContext('2d');
      // made pixel -> picture pixel: sx0 + x * (sx1 - sx0) / dw; then G to the canvas, then to the layer.
      const ax = (sx1 - sx0) / dw;
      const ay = (sy1 - sy0) / dh;
      const T = [r * G[0] * ax, r * G[1] * ax, r * G[2] * ay, r * G[3] * ay, r * (G[0] * sx0 + G[2] * sy0 + G[4] - x0), r * (G[1] * sx0 + G[3] * sy0 + G[5] - y0)];
      let pending = 0;
      const paint = () => {
        pending = 0;
        if (token !== detailToken) return;
        lctx.setTransform(1, 0, 0, 1, 0, 0);
        lctx.clearRect(0, 0, detailLayer.width, detailLayer.height);
        lctx.setTransform(...T);
        lctx.imageSmoothingEnabled = true;
        lctx.imageSmoothingQuality = 'high';
        lctx.drawImage(made, 0, 0);
        lctx.setTransform(1, 0, 0, 1, 0, 0);
      };
      const { promise } = engine.job('l16Detail', 'detail', { ...cameraParams({ live: true }), gx0: sx0 * k, gy0: sy0 * k, gw, gh, zs }, {
        onProgress: (stage, p) => {
          if (token === detailToken && !openSeq.superseded(gen)) showProgress(stage === 'Rendering' ? 'Adding detail' : stage, p);
        },
        onFrame: (f) => {
          if (token !== detailToken || !f || !f.tile || !f.pixels) return;
          mctx.putImageData(new ImageData(new Uint8ClampedArray(f.pixels), f.width, f.height), f.x, f.y);
          if (!pending) pending = requestAnimationFrame(paint);
        },
      });
      const msg = await promise;
      if (token !== detailToken || !msg || !(msg.pixels || msg.bitmap)) return;
      const img = toImageData(msg);
      if (img.width === dw && img.height === dh) {
        if (img instanceof ImageData) mctx.putImageData(img, 0, 0);
        else mctx.drawImage(img, 0, 0);
      }
      if (pending) cancelAnimationFrame(pending);
      paint();
    } catch (err) {
      console.warn('Zoomed-in detail failed', err);
    } finally {
      if (token === detailToken) {
        detailRunning = false;
        hideProgress();
      }
    }
  }

  // A Light L16 photo with the viewpoint moved, once things settle: what the nearer things uncover is filled from the other cameras' own pictures (the worker's l16Holes), laid over the
  // stretched background the live view shows there. Any change takes it away.
  const holesLayer = $('holes-layer');
  let holesTimer = 0;
  let holesToken = 0;
  let holesRunning = false;
  function holesWanted() {
    return !!(state.info && state.info.processed && state.info.processed.hires && (!navigator.webdriver || window.__forceDetail) && showsCamera() && !state.geom
      && state.lastImage && !state.lastImage.pair && (state.camera.u || state.camera.v));
  }
  function hideHoles() {
    holesToken++;
    holesLayer.hidden = true;
    if (holesRunning) {
      holesRunning = false;
      engine.cancel('holes').catch(() => {});
    }
  }
  function scheduleHoles() {
    hideHoles();
    clearTimeout(holesTimer);
    holesTimer = 0;
    if (!holesWanted()) return;
    holesTimer = setTimeout(runHoles, DETAIL_DELAY);
  }
  function placeHoles() {
    for (const k of ['width', 'height', 'left', 'top']) holesLayer.style[k] = canvas.style[k];
  }
  async function runHoles() {
    holesTimer = 0;
    if (!holesWanted()) return;
    if (drag.on || state.view.busy || state.view.pending) {
      holesTimer = setTimeout(runHoles, DETAIL_DELAY);
      return;
    }
    const token = ++holesToken;
    holesRunning = true;
    try {
      const { promise } = engine.job('l16Holes', 'holes', { ...cameraParams({ live: true }) });
      const msg = await promise;
      if (token !== holesToken || !msg || !(msg.pixels || msg.bitmap)) return;
      const img = toImageData(msg);
      holesLayer.width = img.width;
      holesLayer.height = img.height;
      holesLayer.getContext('2d').putImageData(img, 0, 0);
      placeHoles();
      holesLayer.hidden = false;
    } catch (err) {
      console.warn('Filling from the other cameras failed', err);
    } finally {
      if (token === holesToken) holesRunning = false;
    }
  }

  function layoutCanvas() {
    const fit = fitScale();
    view.k = Math.min(MAX_SCALE / fit, Math.max(1, view.k));
    const scale = fit * view.k;
    const w = canvas.width * scale;
    const h = canvas.height * scale;
    clampView(w, h);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.style.left = `${viewer.clientWidth / 2 - view.cx * w}px`;
    canvas.style.top = `${viewer.clientHeight / 2 - view.cy * h}px`;
    // Show real pixels when inspecting detail.
    canvas.style.imageRendering = scale >= 2 ? 'pixelated' : 'auto';
    const overlay = $('spread-overlay');
    for (const k of ['width', 'height', 'left', 'top']) overlay.style[k] = canvas.style[k];
    for (const k of ['width', 'height', 'left', 'top']) $('peaking-overlay').style[k] = canvas.style[k];
    if (state.retouchUi) state.retouchUi.drawOverlay();
    canvas.classList.toggle('pannable', view.k > 1 && state.mode !== 'camera');
    // (a Light L16 photo's zoom is in its real pixels: its quick picture is half the camera's size, so 100% is two screen pixels to one canvas pixel)
    $('zoom-label').textContent = view.k === 1 ? 'Fit' : `${Math.round((scale / nativeFactor()) * 100)}%`;
    positionCropBox();
    $('zoom-out').disabled = view.k <= 1;
    $('zoom-in').disabled = scale >= MAX_SCALE - 1e-6;
    watchLevel();
    scheduleDetail();
    scheduleHoles();
  }

  // Zooms by `factor`, keeping the image point under (mx, my) (viewer
  // coordinates) in place; defaults to the middle of the viewer.
  function zoomBy(factor, mx = viewer.clientWidth / 2, my = viewer.clientHeight / 2) {
    const fit = fitScale();
    const before = fit * view.k;
    const w = canvas.width * before;
    const h = canvas.height * before;
    const left = viewer.clientWidth / 2 - view.cx * w;
    const top = viewer.clientHeight / 2 - view.cy * h;
    const px = (mx - left) / w;
    const py = (my - top) / h;
    view.k = Math.min(MAX_SCALE / fit, Math.max(1, view.k * factor));
    const after = fit * view.k;
    view.cx = px - (mx - viewer.clientWidth / 2) / (canvas.width * after);
    view.cy = py - (my - viewer.clientHeight / 2) / (canvas.height * after);
    layoutCanvas();
  }

  function zoomFit() {
    view.k = 1;
    layoutCanvas();
  }

  function zoomActual() {
    view.k = nativeFactor() / fitScale();
    layoutCanvas();
  }

  viewer.addEventListener('wheel', (event) => {
    if (!state.info) return;
    event.preventDefault();
    const rect = viewer.getBoundingClientRect();
    if (state.mode === 'lenslets') {
      lensZoomBy(Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0015)), event.clientX - rect.left, event.clientY - rect.top);
      return;
    }
    zoomBy(Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0015)), event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });

  // Drag to pan when zoomed in (Shift+drag in camera mode, where a plain drag
  // changes the viewpoint; a middle button drag anywhere). A drag suppresses the click that follows it.
  function startPan(event) {
    const scale = fitScale() * view.k;
    const start = { x: event.clientX, y: event.clientY, cx: view.cx, cy: view.cy };
    let moved = false;
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('panning');
    canvas.onpointermove = (e) => {
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (Math.hypot(dx, dy) > 3) moved = true;
      view.cx = start.cx - dx / (canvas.width * scale);
      view.cy = start.cy - dy / (canvas.height * scale);
      layoutCanvas();
    };
    canvas.onpointerup = () => {
      canvas.onpointermove = null;
      canvas.classList.remove('panning');
      // A middle button drag is followed by no click to suppress.
      state.suppressClick = moved && event.button === 0;
    };
  }

  new ResizeObserver(() => (state.mode === 'lenslets' ? renderLenslets() : layoutCanvas())).observe(viewer);
  const lenslets = () => state.mode === 'lenslets' && state.info && state.info.cam;
  $('zoom-in').onclick = () => (lenslets() ? lensZoomBy(1.5) : zoomBy(1.5));
  $('zoom-out').onclick = () => (lenslets() ? lensZoomBy(1 / 1.5) : zoomBy(1 / 1.5));
  $('zoom-label').onclick = () => (lenslets() ? lensZoomBy(lensMinZoom() / lensView.z) : zoomFit());
  $('zoom-1').onclick = () => (lenslets() ? lensZoomBy(1 / lensView.z) : zoomActual());
  return { scheduleDetail, scheduleHoles, layoutCanvas, startPan };
}
