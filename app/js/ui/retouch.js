// Retouch: spot removal (core/retouch.js). The spots are kept as JSON in a hidden field, so they are saved with the photo's edits like every other control. The tool places a
// spot where the picture is clicked and draws the spots over the picture (a circle on the blemish, a dashed one on its source), which can be dragged.
import { parseSpots, defaultSpot, MAX_SPOTS } from '../core/retouch.js';

export function initRetouch({ $, state, canvas, engine, applySettingsSoon, scheduleSave, viewPoint, sourceFraction, canRender, showError, applyMatrix, stillDepth }) {
  const getSpots = () => parseSpots($('retouch-spots').value);
  const SLIDERS = { size: 'rt-size', feather: 'rt-feather', opacity: 'rt-opacity', depth: 'rt-depth', sdepth: 'rt-sdepth' };

  state.retouchSel = -1;
  state.retouchTool = false;

  function setSpots(spots, { final = true } = {}) {
    $('retouch-spots').value = JSON.stringify(spots);
    applySettingsSoon();
    if (final) scheduleSave();
    drawOverlay();
  }

  // ---------------------------------------------------------------- the list and the editor
  function renderList() {
    const spots = getSpots();
    if (state.retouchSel >= spots.length) state.retouchSel = spots.length - 1;
    $('rt-list').replaceChildren(...spots.map((s, i) => {
      const li = document.createElement('li');
      li.className = i === state.retouchSel ? 'current' : '';
      if (!s.on) li.classList.add('off');
      const name = Object.assign(document.createElement('button'), { type: 'button', className: 'mask-name', textContent: `Spot ${i + 1}${s.mode === 'clone' ? ' (clone)' : ''}` });
      name.onclick = () => select(i);
      const del = Object.assign(document.createElement('button'), { type: 'button', className: 'icon-only mask-del', title: 'Delete spot', textContent: '×' });
      del.setAttribute('aria-label', `Delete spot ${i + 1}`);
      del.onclick = (e) => {
        e.stopPropagation();
        remove(i);
      };
      li.append(name, del);
      return li;
    }));
    const s = spots[state.retouchSel];
    $('rt-editor').hidden = !s;
    if (s) {
      $('rt-mode').value = s.mode;
      $('rt-size').value = String(Math.round(s.r * 1000));
      $('rt-feather').value = String(Math.round(s.feather * 100));
      $('rt-opacity').value = String(Math.round(s.opacity * 100));
      $('rt-depth').value = String(s.depth);
      $('rt-sdepth').value = String(s.sdepth);
      showOutputs();
    }
    drawOverlay();
  }

  function showOutputs() {
    const out = (id, text) => {
      const o = document.querySelector(`output[for="${id}"]`);
      if (o) o.textContent = text;
    };
    out('rt-size', `${(+$('rt-size').value / 10).toFixed(1)}%`);
    out('rt-feather', `${$('rt-feather').value}%`);
    out('rt-opacity', `${$('rt-opacity').value}%`);
    out('rt-depth', (+$('rt-depth').value).toFixed(2));
    out('rt-sdepth', (+$('rt-sdepth').value).toFixed(2));
  }

  function select(i) {
    state.retouchSel = i;
    renderList();
  }

  function remove(i) {
    const spots = getSpots();
    if (!spots[i]) return;
    spots.splice(i, 1);
    if (state.retouchSel >= i) state.retouchSel = Math.max(spots.length ? 0 : -1, state.retouchSel - 1);
    setSpots(spots);
    renderList();
  }

  // Edits the selected spot from the editor's controls.
  function edit(change, { final = true } = {}) {
    const spots = getSpots();
    const s = spots[state.retouchSel];
    if (!s) return;
    Object.assign(s, change(s));
    setSpots(spots, { final });
  }
  $('rt-mode').onchange = () => {
    edit(() => ({ mode: $('rt-mode').value }));
    renderList();
  };
  const slide = (id, key, convert) => {
    $(id).oninput = () => {
      showOutputs();
      edit(() => ({ [key]: convert(+$(id).value) }), { final: false });
    };
    $(id).onchange = () => edit(() => ({ [key]: convert(+$(id).value) }));
    $(id).ondblclick = () => {
      const spots = getSpots();
      const s = spots[state.retouchSel];
      if (!s) return;
      const d = defaultSpot();
      $(id).value = String(key === 'r' ? Math.round(d.r * 1000) : key === 'feather' ? d.feather * 100 : key === 'opacity' ? d.opacity * 100 : 0);
      showOutputs();
      edit(() => ({ [key]: convert(+$(id).value) }));
    };
  };
  slide('rt-size', 'r', (v) => v / 1000);
  slide('rt-feather', 'feather', (v) => v / 100);
  slide('rt-opacity', 'opacity', (v) => v / 100);
  slide('rt-depth', 'depth', (v) => v);
  slide('rt-sdepth', 'sdepth', (v) => v);
  $('rt-delete').onclick = () => remove(state.retouchSel);

  $('rt-spot-tool').onclick = () => setTool(!state.retouchTool);
  $('rt-show').onchange = drawOverlay;

  function setTool(on) {
    state.retouchTool = on && !!state.info && state.mode === 'camera';
    $('rt-spot-tool').classList.toggle('active', state.retouchTool);
    $('rt-spot-tool').setAttribute('aria-pressed', String(state.retouchTool));
    canvas.style.cursor = state.retouchTool ? 'crosshair' : '';
    drawOverlay();
  }

  // ---------------------------------------------------------------- on the picture
  const srcW = () => (state.info && state.info.width) || canvas.width;
  const srcH = () => (state.info && state.info.height) || canvas.height;
  const toCanvas = (fx, fy) => (state.geom ? applyMatrix(state.geom.matrix, fx * state.geom.srcW, fy * state.geom.srcH) : [fx * canvas.width, fy * canvas.height]);
  const canvasScale = () => (state.geom ? Math.sqrt(Math.abs(state.geom.matrix[0] * state.geom.matrix[3] - state.geom.matrix[1] * state.geom.matrix[2])) || 1 : 1);

  function drawOverlay() {
    const o = $('retouch-overlay');
    const spots = getSpots();
    const show = $('rt-show').checked && (state.retouchTool || spots.length > 0) && state.info && state.mode === 'camera' && !state.fullRes;
    o.hidden = !show;
    if (!show) return;
    if (o.width !== canvas.width) o.width = canvas.width;
    if (o.height !== canvas.height) o.height = canvas.height;
    for (const k of ['width', 'height', 'left', 'top']) o.style[k] = canvas.style[k];
    const g = o.getContext('2d');
    g.clearRect(0, 0, o.width, o.height);
    const big = Math.max(srcW(), srcH()) * canvasScale();
    spots.forEach((s, i) => {
      const [x, y] = toCanvas(s.x, s.y);
      const [sx, sy] = toCanvas(s.sx, s.sy);
      const R = s.r * big;
      const sel = i === state.retouchSel;
      const line = Math.max(1.5, o.width / 600);
      g.lineWidth = sel ? line * 1.6 : line;
      g.strokeStyle = sel ? '#4da3ff' : 'rgba(255,255,255,0.85)';
      g.setLineDash([]);
      g.beginPath();
      g.arc(x, y, R, 0, 2 * Math.PI);
      g.stroke();
      g.setLineDash([line * 3, line * 3]);
      g.beginPath();
      g.arc(sx, sy, R, 0, 2 * Math.PI);
      g.stroke();
      g.setLineDash([]);
      g.globalAlpha = 0.6;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(sx, sy);
      g.stroke();
      g.globalAlpha = 1;
    });
  }

  // The depth map's value (focus units) at a point of the picture, or the current focus when it cannot be read.
  async function depthAt(fx, fy) {
    try {
      const res = await engine.request('focusAt', { x: fx * srcW(), y: fy * srcH(), u: state.camera.u, v: state.camera.v, depth: true });
      if (res && typeof res.alpha === 'number') return res.alpha;
    } catch {
      // (no depth yet: the focus is the best guess)
    }
    return +$('focus').value || 0;
  }

  async function addSpot(fx, fy) {
    const spots = getSpots();
    if (spots.length >= MAX_SPOTS) {
      showError(new Error(`A photo can have ${MAX_SPOTS} spots.`), 'Too many spots');
      return;
    }
    const d = defaultSpot();
    const r = state.retouchSel >= 0 && spots[state.retouchSel] ? spots[state.retouchSel].r : d.r;
    // The source starts beside the blemish, on the side with more room.
    const gap = 2.6 * r * Math.max(srcW(), srcH()) / srcW();
    const sx = fx + gap < 0.97 ? fx + gap : fx - gap;
    const spot = { ...d, x: fx, y: fy, r, sx, sy: fy, u0: state.camera.u || 0, v0: state.camera.v || 0, focus0: stillDepth() };
    spots.push(spot);
    state.retouchSel = spots.length - 1;
    setSpots(spots);
    renderList();
    // The scene's depth there, from the depth map: the spot follows the viewpoint by it.
    const [depth, sdepth] = await Promise.all([depthAt(fx, fy), depthAt(sx, fy)]);
    const now = getSpots();
    const mine = now.find((s) => s.id === spot.id);
    if (mine) {
      mine.depth = depth;
      mine.sdepth = sdepth;
      setSpots(now);
      renderList();
    }
  }

  // A press on the picture with the tool on: on a spot's circle it drags that spot (or its source); elsewhere it adds a spot.
  let drag = null;
  window.addEventListener('pointerdown', (event) => {
    if (!state.retouchTool || event.target !== canvas || event.button !== 0) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    const [fx, fy] = sourceFraction(event);
    const spots = getSpots();
    const big = Math.max(srcW(), srcH());
    const hit = (cx, cy, r) => Math.hypot((fx - cx) * srcW(), (fy - cy) * srcH()) <= Math.max(r * big, 8);
    // the selected spot first, then the others
    const order = [...spots.keys()].sort((a, b) => (b === state.retouchSel) - (a === state.retouchSel));
    for (const i of order) {
      const s = spots[i];
      const grab = hit(s.sx, s.sy, s.r) ? 'source' : hit(s.x, s.y, s.r) ? 'spot' : null;
      if (grab) {
        state.retouchSel = i;
        renderList();
        drag = { i, grab, fx, fy, orig: { ...s } };
        canvas.setPointerCapture(event.pointerId);
        return;
      }
    }
    addSpot(Math.min(1, Math.max(0, fx)), Math.min(1, Math.max(0, fy)));
  }, true);
  window.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const [fx, fy] = sourceFraction(event);
    const spots = getSpots();
    const s = spots[drag.i];
    if (!s) return;
    const dx = fx - drag.fx;
    const dy = fy - drag.fy;
    if (drag.grab === 'source') Object.assign(s, { sx: drag.orig.sx + dx, sy: drag.orig.sy + dy });
    else Object.assign(s, { x: drag.orig.x + dx, y: drag.orig.y + dy, sx: drag.orig.sx + dx, sy: drag.orig.sy + dy });
    setSpots(spots, { final: false });
  }, true);
  window.addEventListener('pointerup', async () => {
    if (!drag) return;
    const { i, grab } = drag;
    drag = null;
    // A moved spot or source is at another depth: read it again.
    const spots = getSpots();
    const s = spots[i];
    if (s) {
      const d = await depthAt(grab === 'source' ? s.sx : s.x, grab === 'source' ? s.sy : s.y);
      const now = getSpots();
      if (now[i]) {
        if (grab === 'source') now[i].sdepth = d;
        else now[i].depth = d;
        if (grab === 'spot') {
          const sd = await depthAt(now[i].sx, now[i].sy);
          if (now[i]) now[i].sdepth = sd;
        }
        setSpots(now);
        renderList();
      }
    } else setSpots(spots);
  }, true);

  // Escape leaves the tool.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.retouchTool) setTool(false);
  });

  renderList();
  return { getSpots, setSpots, renderList, drawOverlay, setTool, localSpots: () => $('retouch-spots').value };
}
