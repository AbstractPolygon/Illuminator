// Retouch: spot removal, the healing brush and red-eye (core/retouch.js). The spots are kept as JSON in a hidden field, so they are saved with the photo's edits like every other
// control. A tool places a spot where the picture is clicked (or a stroke where it is painted) and the spots are drawn over the picture (a circle on the blemish, a dashed one on
// its source), which can be dragged.
import { parseSpots, defaultSpot, MAX_SPOTS } from '../core/retouch.js';

export function initRetouch({ $, state, canvas, engine, applySettingsSoon, scheduleSave, viewPoint, sourceFraction, canRender, showError, applyMatrix, stillDepth }) {
  const getSpots = () => parseSpots($('retouch-spots').value);

  state.retouchSel = -1;
  state.retouchTool = null; // 'select' | 'spot' | 'brush' | 'redeye'
  const TOOLS = { select: 'rt-select-tool', spot: 'rt-spot-tool', brush: 'rt-brush-tool', redeye: 'rt-redeye-tool' };
  const BRUSH_SIZE = 0.015;
  const EYE_SIZE = 0.012;

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
      const name = Object.assign(document.createElement('button'), { type: 'button', className: 'mask-name', textContent: spotName(s, i) });
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
      $('rt-sdepth-row').hidden = s.mode === 'redeye';
      showOutputs();
    }
    drawOverlay();
  }

  // A spot's name: its kind and number among those of the kind.
  function spotName(s, i) {
    const kind = s.mode === 'redeye' ? 'Red-eye' : s.path ? 'Brush' : 'Spot';
    const n = getSpots().slice(0, i + 1).filter((x) => (x.mode === 'redeye' ? 'Red-eye' : x.path ? 'Brush' : 'Spot') === kind).length;
    return `${kind} ${n}${s.mode === 'clone' ? ' (clone)' : ''}`;
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

  for (const [name, id] of Object.entries(TOOLS)) $(id).onclick = () => setTool(state.retouchTool === name ? null : name);
  $('rt-show').onchange = drawOverlay;

  // `tool`: 'spot', 'brush', 'redeye', or null/false for none.
  function setTool(tool) {
    state.retouchTool = tool && state.info && state.mode === 'camera' ? tool : null;
    for (const [name, id] of Object.entries(TOOLS)) {
      $(id).classList.toggle('active', state.retouchTool === name);
      $(id).setAttribute('aria-pressed', String(state.retouchTool === name));
    }
    canvas.style.cursor = state.retouchTool === 'select' ? 'default' : state.retouchTool ? 'crosshair' : '';
    if (state.retouchTool) document.dispatchEvent(new Event('retouch-tool'));
    drawOverlay();
  }

  // ---------------------------------------------------------------- on the picture
  const srcW = () => (state.info && state.info.width) || canvas.width;
  const srcH = () => (state.info && state.info.height) || canvas.height;
  const toCanvas = (fx, fy) => (state.geom ? applyMatrix(state.geom.matrix, fx * state.geom.srcW, fy * state.geom.srcH) : [fx * canvas.width, fy * canvas.height]);
  const canvasScale = () => (state.geom ? Math.sqrt(Math.abs(state.geom.matrix[0] * state.geom.matrix[3] - state.geom.matrix[1] * state.geom.matrix[2])) || 1 : 1);

  // The stroke being painted (picture fractions), shown until it is let go.
  let painting = null;

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
    const line = Math.max(1, o.width / 1400);
    const trace = (pts, R, alpha) => {
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.globalAlpha = alpha;
      g.lineWidth = 2 * R;
      g.beginPath();
      pts.forEach(([px, py], n) => (n ? g.lineTo(px, py) : g.moveTo(px, py)));
      if (pts.length === 1) g.lineTo(pts[0][0] + 0.01, pts[0][1]);
      g.stroke();
      g.globalAlpha = 1;
    };
    spots.forEach((s, i) => {
      const sel = i === state.retouchSel;
      const R = s.r * big;
      const color = sel ? '#4da3ff' : 'rgba(255,255,255,0.85)';
      g.setLineDash([]);
      g.strokeStyle = color;
      if (s.path && s.path.length > 1) {
        // a stroke: the painted band, and its dashed copy at the source
        const pts = s.path.map(([px, py]) => toCanvas(px, py));
        g.strokeStyle = sel ? '#4da3ff' : '#ffffff';
        trace(pts, R, sel ? 0.2 : 0.12);
        g.lineWidth = line;
        g.setLineDash([]);
        g.beginPath();
        g.arc(pts[0][0], pts[0][1], R, 0, 2 * Math.PI);
        g.stroke();
        const off = [s.sx - s.x, s.sy - s.y];
        const spts = s.path.map(([px, py]) => toCanvas(px + off[0], py + off[1]));
        g.strokeStyle = color;
        g.lineWidth = line * (sel ? 1.4 : 1);
        g.setLineDash([line * 4, line * 4]);
        g.lineCap = 'butt';
        g.beginPath();
        spts.forEach(([px, py], n) => (n ? g.lineTo(px, py) : g.moveTo(px, py)));
        g.stroke();
        g.setLineDash([]);
        g.globalAlpha = 0.6;
        g.lineWidth = line;
        g.beginPath();
        g.moveTo(pts[0][0], pts[0][1]);
        g.lineTo(spts[0][0], spts[0][1]);
        g.stroke();
        g.globalAlpha = 1;
        return;
      }
      const [x, y] = toCanvas(s.x, s.y);
      g.lineWidth = sel ? line * 1.4 : line;
      g.beginPath();
      g.arc(x, y, R, 0, 2 * Math.PI);
      g.stroke();
      if (s.mode === 'redeye') return;
      const [sx, sy] = toCanvas(s.sx, s.sy);
      g.setLineDash([line * 4, line * 4]);
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
    if (painting) {
      g.strokeStyle = '#4da3ff';
      trace(painting.points.map(([px, py]) => toCanvas(px, py)), BRUSH_SIZE * big, 0.2);
      // where its source will be (the dashed copy beside the stroke)
      const gap = sourceGap(Math.max(...painting.points.map((p) => p[0])), BRUSH_SIZE);
      g.lineWidth = line;
      g.setLineDash([line * 4, line * 4]);
      g.lineCap = 'butt';
      g.beginPath();
      painting.points.forEach(([px, py], n) => {
        const [cx, cy] = toCanvas(px + gap, py);
        if (n) g.lineTo(cx, cy);
        else g.moveTo(cx, cy);
      });
      g.stroke();
      g.setLineDash([]);
    }
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

  // How far (in x) a source starts from the blemish: beside it, on the side with more room.
  const sourceGap = (maxX, r) => {
    const gap = (2.6 * r * Math.max(srcW(), srcH())) / srcW();
    return maxX + gap < 0.97 ? gap : -gap;
  };

  // Adds a spot of `kind` ('spot' heals a blemish, 'redeye' corrects an eye, 'brush' is a stroke along `points`) and reads its depth from the depth map.
  async function addSpot(kind, points) {
    const spots = getSpots();
    if (spots.length >= MAX_SPOTS) {
      showError(new Error(`A photo can have ${MAX_SPOTS} spots.`), 'Too many spots');
      return;
    }
    const d = defaultSpot();
    const [fx, fy] = points[0];
    const same = (x) => (kind === 'redeye' ? x.mode === 'redeye' : kind === 'brush' ? !!x.path : x.mode !== 'redeye' && !x.path);
    const last = spots.filter(same).pop();
    const r = last ? last.r : kind === 'brush' ? BRUSH_SIZE : kind === 'redeye' ? EYE_SIZE : d.r;
    const xs = points.map((p) => p[0]);
    const sx = kind === 'redeye' ? fx : fx + sourceGap(Math.max(...xs), r);
    const spot = { ...d, mode: kind === 'redeye' ? 'redeye' : 'heal', x: fx, y: fy, r, sx, sy: fy, u0: state.camera.u || 0, v0: state.camera.v || 0, focus0: stillDepth() };
    if (kind === 'redeye') Object.assign(spot, { feather: 0.2, opacity: 1 });
    if (kind === 'brush') Object.assign(spot, { path: points.map((p) => [p[0], p[1]]), feather: 0.4 });
    spots.push(spot);
    state.retouchSel = spots.length - 1;
    setSpots(spots);
    renderList();
    // The scene's depth there, from the depth map: the spot follows the viewpoint by it.
    const [depth, sdepth] = await Promise.all([depthAt(fx, fy), kind === 'redeye' ? Promise.resolve(0) : depthAt(sx, fy)]);
    const now = getSpots();
    const mine = now.find((x) => x.id === spot.id);
    if (mine) {
      mine.depth = depth;
      mine.sdepth = sdepth;
      setSpots(now);
      renderList();
    }
  }

  // The distance (in pixels of the picture) from a point to a spot's blemish area: its circle, or its stroke.
  function distanceTo(s, fx, fy, offset = [0, 0]) {
    const px = fx * srcW();
    const py = fy * srcH();
    const pts = (s.path && s.path.length > 1 ? s.path : [[s.x, s.y]]).map(([x, y]) => [(x + offset[0]) * srcW(), (y + offset[1]) * srcH()]);
    let best = Infinity;
    for (let n = 0; n < pts.length; n++) {
      const [ax, ay] = pts[n];
      const [bx, by] = pts[Math.min(n + 1, pts.length - 1)];
      const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
      const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / len2)) : 0;
      best = Math.min(best, Math.hypot(px - (ax + (bx - ax) * t), py - (ay + (by - ay) * t)));
    }
    return best;
  }

  // A press on the picture with a tool on: on a spot or its source it drags that; otherwise the tool adds a spot (or starts a stroke).
  let drag = null;
  window.addEventListener('pointerdown', (event) => {
    if (!state.retouchTool || event.target !== canvas || event.button !== 0) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    const [fx, fy] = sourceFraction(event);
    const x = Math.min(1, Math.max(0, fx));
    const y = Math.min(1, Math.max(0, fy));
    if (state.retouchTool === 'brush') {
      painting = { points: [[x, y]], pointer: event.pointerId };
      canvas.setPointerCapture(event.pointerId);
      drawOverlay();
      return;
    }
    const spots = getSpots();
    const big = Math.max(srcW(), srcH());
    // the selected spot first, then the others
    const order = [...spots.keys()].sort((a, b) => (b === state.retouchSel) - (a === state.retouchSel));
    for (const i of order) {
      const s = spots[i];
      const reach = Math.max(s.r * big, 8);
      // whichever of the spot and its source is nearer (they can overlap)
      const dSpot = distanceTo(s, fx, fy);
      const dSource = s.mode !== 'redeye' ? distanceTo(s, fx, fy, [s.sx - s.x, s.sy - s.y]) : Infinity;
      const grab = Math.min(dSpot, dSource) > reach ? null : dSource < dSpot ? 'source' : 'spot';
      if (grab) {
        state.retouchSel = i;
        renderList();
        drag = { i, grab, fx, fy, orig: JSON.parse(JSON.stringify(s)) };
        canvas.setPointerCapture(event.pointerId);
        return;
      }
    }
    if (state.retouchTool === 'select') {
      // nothing under the pointer: nothing selected
      state.retouchSel = -1;
      renderList();
      drawOverlay();
      return;
    }
    addSpot(state.retouchTool, [[x, y]]);
  }, true);
  window.addEventListener('pointermove', (event) => {
    if (painting) {
      const [fx, fy] = sourceFraction(event);
      const last = painting.points[painting.points.length - 1];
      // a new point once the pointer has moved a fifth of the brush
      if (Math.hypot((fx - last[0]) * srcW(), (fy - last[1]) * srcH()) > 0.2 * BRUSH_SIZE * Math.max(srcW(), srcH())) {
        painting.points.push([Math.min(1, Math.max(0, fx)), Math.min(1, Math.max(0, fy))]);
        drawOverlay();
      }
      return;
    }
    if (!drag) return;
    const [fx, fy] = sourceFraction(event);
    const spots = getSpots();
    const s = spots[drag.i];
    if (!s) return;
    const dx = fx - drag.fx;
    const dy = fy - drag.fy;
    if (drag.grab === 'source') Object.assign(s, { sx: drag.orig.sx + dx, sy: drag.orig.sy + dy });
    else {
      Object.assign(s, { x: drag.orig.x + dx, y: drag.orig.y + dy, sx: drag.orig.sx + dx, sy: drag.orig.sy + dy });
      if (drag.orig.path) s.path = drag.orig.path.map(([px, py]) => [px + dx, py + dy]);
    }
    setSpots(spots, { final: false });
  }, true);
  window.addEventListener('pointerup', async () => {
    if (painting) {
      const { points } = painting;
      painting = null;
      // thin the stroke to at most 40 points, keeping both ends
      const keep = points.length > 40 ? points.filter((_, n) => n === points.length - 1 || n % Math.ceil(points.length / 40) === 0) : points;
      if (keep.length === 1) keep.push([keep[0][0] + 0.001, keep[0][1]]);
      await addSpot('brush', keep);
      return;
    }
    if (!drag) return;
    const { i, grab } = drag;
    drag = null;
    // A moved spot or source is at another depth: read it again.
    const spots = getSpots();
    const s = spots[i];
    if (!s) return;
    const d = await depthAt(grab === 'source' ? s.sx : s.x, grab === 'source' ? s.sy : s.y);
    const now = getSpots();
    if (!now[i]) return;
    if (grab === 'source') now[i].sdepth = d;
    else {
      now[i].depth = d;
      if (now[i].mode !== 'redeye') now[i].sdepth = await depthAt(now[i].sx, now[i].sy);
    }
    setSpots(now);
    renderList();
  }, true);

  // Escape leaves the tool.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.retouchTool) setTool(false);
  });

  renderList();
  return { getSpots, setSpots, renderList, drawOverlay, setTool, localSpots: () => $('retouch-spots').value };
}
