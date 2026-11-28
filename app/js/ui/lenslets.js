// lenslets: moved out of main.js. initLenslets() runs where the section used to, with what it uses from the rest of the page.
export function initLenslets({ state, viewer, lensView, canvas, $, cameraParams, engine, view, layoutCanvas, ctx, scheduleHistogram, showError }) {

  // Lenslets mode: the raw sensor, zoomed and moved like a map (scroll to
  // zoom, drag to move); lensView is declared with the other view state.
  const LENS_MAX_ZOOM = 32;
  let lensBusy = false;
  let lensAgain = false;

  function lensMinZoom() {
    const cam = state.info.cam;
    return Math.min(viewer.clientWidth / cam.width, viewer.clientHeight / cam.height);
  }

  function lensClamp() {
    const cam = state.info.cam;
    if (lensView.x == null) {
      lensView.x = cam.width / 2;
      lensView.y = cam.height / 2;
    }
    lensView.z = Math.min(LENS_MAX_ZOOM, Math.max(lensMinZoom(), lensView.z));
    // Keep the sensor in view; centered along a side that fits entirely.
    const hw = viewer.clientWidth / (2 * lensView.z);
    const hh = viewer.clientHeight / (2 * lensView.z);
    lensView.x = hw * 2 >= cam.width ? cam.width / 2 : Math.min(cam.width - hw, Math.max(hw, lensView.x));
    lensView.y = hh * 2 >= cam.height ? cam.height / 2 : Math.min(cam.height - hh, Math.max(hh, lensView.y));
  }

  // Zooms by `factor` keeping the sensor point under (mx, my) in place.
  function lensZoomBy(factor, mx = viewer.clientWidth / 2, my = viewer.clientHeight / 2) {
    if (!state.info || !state.info.cam) return;
    lensClamp();
    const sx = lensView.x + (mx - viewer.clientWidth / 2) / lensView.z;
    const sy = lensView.y + (my - viewer.clientHeight / 2) / lensView.z;
    lensView.z *= factor;
    lensClamp();
    lensView.x = sx - (mx - viewer.clientWidth / 2) / lensView.z;
    lensView.y = sy - (my - viewer.clientHeight / 2) / lensView.z;
    renderLenslets();
  }

  function lensDrag(event) {
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('panning');
    const start = { x: event.clientX, y: event.clientY, sx: lensView.x, sy: lensView.y };
    canvas.onpointermove = (e) => {
      lensView.x = start.sx - (e.clientX - start.x) / lensView.z;
      lensView.y = start.sy - (e.clientY - start.y) / lensView.z;
      renderLenslets();
    };
    canvas.onpointerup = () => {
      canvas.onpointermove = null;
      canvas.classList.remove('panning');
    };
  }

  async function renderLenslets() {
    if (!state.info || !state.info.cam || state.mode !== 'lenslets') return;
    if (lensBusy) {
      lensAgain = true;
      return;
    }
    lensBusy = true;
    try {
      lensClamp();
      const ow = Math.max(1, Math.round(viewer.clientWidth));
      const oh = Math.max(1, Math.round(viewer.clientHeight));
      const { z } = lensView;
      const w = ow / z;
      const h = oh / z;
      const x0 = lensView.x - w / 2;
      const y0 = lensView.y - h / 2;
      const scale = +$('still-scale').value;
      const p = cameraParams();
      const msg = await engine.request('rawCrop', { x0, y0, w, h, ow, oh, scale, alpha: p.alpha, allInFocus: !(p.aperture > 0) });
      if (state.mode !== 'lenslets' || !msg) return;
      canvas.width = ow;
      canvas.height = oh;
      view.k = 1;
      view.cx = view.cy = 0.5;
      layoutCanvas();
      $('zoom-label').textContent = `${Math.round(z * 100)}%`;
      $('zoom-out').disabled = z <= lensMinZoom() + 1e-9;
      $('zoom-in').disabled = z >= LENS_MAX_ZOOM - 1e-9;
      ctx.putImageData(new ImageData(new Uint8ClampedArray(msg.pixels), ow, oh), 0, 0);
      ctx.lineWidth = 1.5;
      const circles = $('lens-circles').checked && msg.rUse * z >= 6;
      for (let i = 0; i < msg.centers.length; i += 2) {
        const cx = msg.centers[i] * z;
        const cy = msg.centers[i + 1] * z;
        if (circles) {
          ctx.strokeStyle = 'rgba(77, 182, 255, 0.75)';
          ctx.beginPath();
          ctx.arc(cx, cy, msg.rUse * z, 0, 2 * Math.PI);
          ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(242, 179, 61, 0.9)';
        ctx.beginPath();
        ctx.arc(cx, cy, Math.min(2.5, msg.pitch * z * 0.15), 0, 2 * Math.PI);
        ctx.stroke();
      }
      canvas.classList.remove('hidden');
      canvas.classList.add('pannable');
      scheduleHistogram();
      $('frame-label').textContent = `sensor ${Math.max(0, Math.round(x0))}–${Math.round(x0 + w)}, ${Math.max(0, Math.round(y0))}–${Math.round(y0 + h)}`;
      showLensSampling(msg, scale);
    } catch (err) {
      showError(err);
    } finally {
      lensBusy = false;
      if (lensAgain) {
        lensAgain = false;
        renderLenslets();
      }
    }
  }

  // Sidebar: the coverage map and the matching part of the rendered picture.
  function showLensSampling(msg, scale) {
    const cov = $('lens-coverage');
    const patch = $('lens-patch');
    const cctx = cov.getContext('2d');
    const pctx = patch.getContext('2d');
    for (const id of ['lens-patch', 'lens-patch-title']) $(id).hidden = false;
    // Coverage: the splat weight each output pixel gets, against the mean.
    const { cw, ch } = msg;
    const data = new Float32Array(msg.coverage);
    let sum = 0;
    for (const v of data) sum += v;
    const mean = sum / data.length || 1;
    const img = new ImageData(cw, ch);
    const STOPS = [[18, 12, 28], [150, 40, 60], [230, 120, 40], [240, 210, 90], [250, 250, 225]];
    for (let i = 0; i < data.length; i++) {
      const t = Math.min(1, data[i] / mean / 2);
      const f = t * (STOPS.length - 1);
      const k = Math.min(STOPS.length - 2, Math.floor(f));
      const a = f - k;
      for (let c = 0; c < 3; c++) img.data[4 * i + c] = STOPS[k][c] * (1 - a) + STOPS[k + 1][c] * a;
      img.data[4 * i + 3] = 255;
    }
    // Both views keep one size, the viewer's shape across the sidebar; the
    // window is fitted inside it.
    const VW = 560;
    const VH = Math.round((VW * viewer.clientHeight) / Math.max(1, viewer.clientWidth));
    for (const c of [cov, patch]) {
      if (c.width !== VW || c.height !== VH) {
        c.width = VW;
        c.height = VH;
      }
    }
    const place = (c2d, src, sx, sy, sw, sh) => {
      const k = Math.min(VW / sw, VH / sh);
      c2d.fillStyle = '#000';
      c2d.fillRect(0, 0, VW, VH);
      c2d.imageSmoothingEnabled = false;
      c2d.drawImage(src, sx, sy, sw, sh, (VW - sw * k) / 2, (VH - sh * k) / 2, sw * k, sh * k);
    };
    const tmp = Object.assign(document.createElement('canvas'), { width: cw, height: ch });
    tmp.getContext('2d').putImageData(img, 0, 0);
    place(cctx, tmp, 0, 0, cw, ch);

    // The same part of the last full sensor render, or else of the picture.
    const still = state.lensStill;
    const src = still ? still.img : state.lensPicture;
    if (!src) {
      for (const id of ['lens-patch', 'lens-patch-title']) $(id).hidden = true;
      return;
    }
    const k = src.width / msg.baseW;
    const [bx0, by0, bx1, by1] = msg.box;
    const sw = (bx1 - bx0) * k;
    const sh = (by1 - by0) * k;
    let drawable = src;
    if (src instanceof ImageData) {
      drawable = Object.assign(document.createElement('canvas'), { width: src.width, height: src.height });
      drawable.getContext('2d').putImageData(src, 0, 0);
    }
    place(pctx, drawable, bx0 * k, by0 * k, sw, sh);
    $('lens-patch-title').textContent = still ? `Last Full sensor render (${still.scale}×)` : 'Camera view';
  }
  return { lensMinZoom, lensZoomBy, lensDrag, renderLenslets };
}
