// animation: moved out of main.js. initAnimation() runs where the section used to, with what it uses from the rest of the page.
import { valueAt, frameCount } from '../core/keyframes.js';
import { toImageData } from '../engine.js';

export function initAnimation({ cameraParams, $, keyframeFrames, liveFraming, state, viewReach, engine, withPivotZoom, pivotFor, combineMotion, showProgress, hideProgress, draw, showError, cancelSharp, setFullRes, updatePreviewStatus, canRender, previewMirror, updatePlayhead, setDepthShown, showPlayIcon, previewAt }) {

  function pathPoint(kind, t) {
    const a = 2 * Math.PI * t;
    switch (kind) {
      case 'horizontal': return [Math.sin(a), 0];
      case 'vertical': return [0, Math.sin(a)];
      case 'figure8': return [Math.sin(a), 0.7 * Math.sin(2 * a)];
      case 'diagonal': return [Math.sin(a) * Math.SQRT1_2, Math.sin(a) * Math.SQRT1_2];
      default: return [Math.cos(a), Math.sin(a)];
    }
  }

  function animationRequest() {
    const p = cameraParams();
    const keyed = $('anim').value === 'keyframes' ? keyframeFrames() : null;
    if (keyed) {
      return { type: 'frames', kind: 'frames', loop: 'loop', values: [], framing: keyed.framing, args: { path: keyed.path, alpha: p.alpha, aperture: p.aperture, dof: p.dof, bokeh: p.bokeh } };
    }
    if ($('anim').value === 'keyframes') {
      // Fewer than two keyframes: the current view only.
      return { type: 'frames', kind: 'frames', loop: 'loop', values: [], framing: [liveFraming()], args: { path: [{ u: p.u, v: p.v }], alpha: p.alpha, aperture: p.aperture, dof: p.dof, bokeh: p.bokeh } };
    }
    if ($('anim').value === 'focus') {
      const n = +$('steps').value;
      // Near and Far may be keyframed: step i is at i / frame rate.
      const alphas = Array.from({ length: n }, (_, i) => {
        const t = i / state.fps;
        const near = valueAt(state.anim, 'near', t) ?? +$('near').value;
        const far = valueAt(state.anim, 'far', t) ?? +$('far').value;
        return near + ((far - near) * i) / (n - 1);
      });
      // A small aperture would show little change: sweep at least wide open.
      const aperture = Math.max(p.aperture, 1);
      return { type: 'refocusFrames', kind: 'refocus', loop: 'pingpong', values: alphas, args: { alphas, u: p.u, v: p.v, aperture, dof: p.dof, bokeh: p.bokeh } };
    }
    const n = +$('frames').value;
    const path = Array.from({ length: n }, (_, i) => {
      // Amount may be keyframed: frame i is at i / frame rate.
      const r = state.info.radius * viewReach() * (valueAt(state.anim, 'amount', i / state.fps) ?? +$('amount').value);
      const [x, y] = pathPoint($('path').value, i / n);
      return { u: x * r, v: y * r };
    });
    return { type: 'frames', kind: 'frames', loop: 'loop', values: [], args: { path, alpha: p.alpha, aperture: p.aperture, dof: p.dof, bokeh: p.bokeh } };
  }

  function resetAnimation() {
    engine.cancel('frames');
    engine.cancel('refocus');
    state.frames = [];
    state.frameValues = [];
    state.animKey = null;
    state.animDone = null;
    state.index = 0;
    state.direction = 1;
    state.showingFrames = false;
    setPlaying(false);
    $('scrub').max = 0;
    $('scrub').value = 0;
  }

  // Renders the animation frames unless they match the current settings.
  // Each frame's pivot, pan and zoom for an animation request (see ensureAnimation).
  function framePivotsOf(req) {
    const pivots = withPivotZoom(req.type === 'frames'
      ? req.args.path.map((f) => pivotFor(f.u, f.v, f.alpha ?? req.args.alpha, f.aperture ?? req.args.aperture, f.pivot ?? null))
      : req.args.alphas.map((alpha) => pivotFor(req.args.u, req.args.v, alpha, req.args.aperture)));
    return req.framing ? pivots.map((p, i) => combineMotion(p, req.framing[i])) : pivots;
  }

  // The animation without rendering it: every frame's render settings (for a 'frames' job) and its pivot, pan and zoom. For work that needs only some of the frames, such as a
  // lenticular print.
  function animationPlan() {
    const req = animationRequest();
    const a = req.args;
    const list = req.type === 'frames'
      ? a.path.map((f) => ({ u: f.u, v: f.v, alpha: f.alpha ?? a.alpha, aperture: f.aperture ?? a.aperture, dof: f.dof ?? a.dof, bokeh: f.bokeh ?? a.bokeh, masks: f.masks || null, color: f.color || null }))
      : a.alphas.map((alpha) => ({ u: a.u, v: a.v, alpha, aperture: a.aperture, dof: a.dof, bokeh: a.bokeh }));
    return { list, pivots: framePivotsOf(req) };
  }

  // Animation > Preview > Resolution: the frames are kept at a half, third or quarter of their size.
  const previewDivisor = () => Math.max(1, +$('pv-res').value || 1);
  async function previewFrame(msg, div) {
    const src = msg.bitmap || toImageData(msg);
    if (div === 1) return msg.bitmap || createImageBitmap(src);
    const w = Math.max(1, Math.round(src.width / div));
    const h = Math.max(1, Math.round(src.height / div));
    const small = await createImageBitmap(src, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
    if (msg.bitmap && msg.bitmap.close) msg.bitmap.close();
    return small;
  }

  function ensureAnimation() {
    const req = animationRequest();
    const div = previewDivisor();
    const key = JSON.stringify([req.type, req.args, div]);
    if (key === state.animKey) return state.animDone;
    engine.cancel(req.kind === 'frames' ? 'refocus' : 'frames');
    state.animKey = key;
    state.frames = new Array(req.type === 'frames' ? req.args.path.length : req.args.alphas.length);
    state.framePivots = framePivotsOf(req);
    // Zoomed frames are drawn into a canvas this much larger, so the zoom is
    // resampled once (straight to the screen) instead of blown up twice.
    state.frameScale = Math.min(3, Math.max(1, ...state.framePivots.map((p) => (p && p.zoom) || 1)));
    state.frameValues = req.values;
    state.loop = req.loop;
    // The playhead stays where it was (it was only ever reset to the start here, so any re-render sent it back to the beginning).
    state.index = Math.min(state.frames.length - 1, Math.max(0, Math.round((state.keyTime || 0) * state.fps)));
    state.direction = 1;
    $('scrub').max = Math.max(0, state.frames.length - 1);
    const { promise } = engine.job(req.type, req.kind, req.args, {
      onProgress: showProgress,
      onFrame: async (msg) => {
        hideProgress();
        if (state.animKey !== key) return;
        state.frames[msg.index] = await previewFrame(msg, div);
        if (state.showingFrames && msg.index === state.index) {
          showFrame(msg.index);
        } else if (state.showingFrames && !state.frames[state.index]) {
          // The frame at the playhead is still to come: show this one meanwhile, without moving the playhead to it.
          if (!state.fullRes && !state.depthShown) draw(state.frames[msg.index]);
          updateFrameLabel();
        } else {
          updateFrameLabel();
        }
      },
    });
    state.animDone = promise.then(() => hideProgress(), (err) => showError(err));
    return state.animDone;
  }

  // Whether any frame of the animation is not rendered yet (the array has empty slots, which some() and every() skip).
  function framesMissing() {
    for (let i = 0; i < state.frames.length; i++) if (!state.frames[i]) return true;
    return false;
  }

  // The follow-up processing after a change (the sharp preview, the full sensor render, noise reduction and Detail recovery) waits until the time slider or playhead has been
  // still for a moment, so it does not start while it is still being moved.
  const SEEK_SETTLE = 1500;
  const seekSettled = () => performance.now() - (state.lastSeek || 0) >= SEEK_SETTLE;
  const seekWait = () => Math.max(50, SEEK_SETTLE - (performance.now() - (state.lastSeek || 0)));

  // The time slider moved: whatever was still being processed for the picture that was on show stops (the preview's frames keep what is rendered so far, and its Render
  // preview button starts the rest again).
  function stopProcessing() {
    state.lastSeek = performance.now();
    clearTimeout(state.nrFinalTimer);
    cancelSharp();
    if (state.recoveryRunning) engine.cancel('superres').catch(() => {});
    // The full resolution render (or its picture on show) gives way to the quick view again: frames are not drawn while it is up. This stops its render at once.
    if (state.fullRes) setFullRes(false, { restore: false });
    if (state.animKey && framesMissing()) {
      engine.cancel('frames');
      engine.cancel('refocus');
      state.animKey = null;
      hideProgress();
      updatePreviewStatus();
    }
  }

  // One frame of the animation by itself (the slider moved to a frame that is not rendered). While one is being made, moves that follow wait and only the newest position is made
  // next, so a drag keeps showing frames as they finish instead of cancelling each one before it is done.
  let singleBusy = false;
  let singlePending = null;
  function renderSingleFrame(i) {
    if (singleBusy) {
      singlePending = i;
      return;
    }
    if (!state.info || !canRender()) return;
    const f = animationPlan().list[i];
    if (!f) return;
    singleBusy = true;
    const div = previewDivisor();
    const { promise } = previewMirror.quick().job('frames', 'frames', { path: [f], alpha: f.alpha, aperture: f.aperture, dof: f.dof, bokeh: f.bokeh }, {
      quick: true,
      onFrame: async (msg) => {
        if (state.frames[i] || state.fullRes || state.depthShown) return;
        draw(await previewFrame(msg, div));
      },
    });
    promise.catch(() => {}).finally(() => {
      singleBusy = false;
      const next = singlePending;
      singlePending = null;
      if (next !== null && !state.frames[next]) renderSingleFrame(next);
    });
  }

  // A camera or animation setting changed: the frames are stale.
  function invalidateAnimation() {
    // The playhead stays on the frame that was showing (while frames play, only
    // their index moves, not the playhead's time).
    if (state.showingFrames && state.frames.length > 1) state.keyTime = (state.drawFrame ?? state.index) / state.fps;
    if (state.animKey) {
      engine.cancel('frames');
      engine.cancel('refocus');
    }
    state.animKey = null;
    state.frames = [];
    state.frameValues = [];
    updateFrameLabel();
  }

  // The play bar's readout: current frame of all frames, and the time of the
  // length (shown whenever the animation is on).
  function updateFrameLabel() {
    updatePreviewStatus();
    const n = state.frames.length;
    const animOn = $('anim-on').checked && state.mode === 'camera' && state.info;
    if (!animOn && (!n || !state.showingFrames)) {
      if (!state.fullRes) $('frame-label').textContent = '';
      return;
    }
    const keyframes = $('anim').value === 'keyframes';
    const expected = keyframes ? frameCount(state.anim, state.fps) : Math.max(1, +$($('anim').value === 'focus' ? 'steps' : 'frames').value);
    // Keyframes without an animation yet render one frame: count the length.
    const total = keyframes ? expected : n || expected;
    // The play bar's slider spans the whole animation, rendered or not, so it
    // can be dragged at once.
    $('scrub').max = String(Math.max(0, expected - 1));
    const index = n > 1 && state.showingFrames ? state.index : Math.round((state.keyTime || 0) * state.fps);
    const i = Math.min(total - 1, Math.max(0, index));
    const ready = state.frames.filter(Boolean).length;
    const val = state.showingFrames ? state.frameValues[state.index] : undefined;
    $('frame-label').textContent = `Frame ${i + 1} / ${total} · ${(i / state.fps).toFixed(2)} / ${((total - 1) / state.fps).toFixed(2)} s` +
      (n && ready < n ? ` (rendering ${ready})` : '') +
      (val !== undefined ? ` · focus ${val.toFixed(2)}` : '');
    if (typeof updatePlayhead === 'function') updatePlayhead();
  }

  function showFrame(i) {
    const f = state.frames[i];
    state.drawFrame = i;
    // The time of the frame on show is the playhead's, so it stays there when the frames are dropped or the camera view comes back.
    state.keyTime = i / state.fps;
    if (f && !state.fullRes && !state.depthShown) draw(f);
    $('scrub').value = i;
    updateFrameLabel();
  }

  function advance() {
    const n = state.frames.length;
    if (n < 2) return;
    let next = state.index + state.direction;
    if (!state.repeat && (next >= n || (state.loop === 'pingpong' && next < 0))) {
      // Played once (a focus sweep: there and back): stop at the end.
      if (state.loop === 'pingpong' && next >= n) {
        state.direction = -state.direction;
        next = state.index + state.direction;
      } else {
        setPlaying(false);
        return;
      }
    } else if (state.loop === 'pingpong') {
      if (next >= n || next < 0) {
        state.direction = -state.direction;
        next = state.index + state.direction;
      }
    } else {
      next = (next + n) % n;
    }
    // Wait for frames that are still rendering.
    if (state.frames[next]) state.index = next;
  }

  function tick(t) {
    if (state.playing && state.frames.length > 1 && t - state.lastTick >= 1000 / state.fps) {
      state.lastTick = t;
      advance();
      showFrame(state.index);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // The preview's frames are all rendered for the animation as it is now (Render preview, or a play that rendered them).
  function previewRendered() {
    if (!state.animKey || !state.frames.length || !state.frames.every(Boolean)) return false;
    const req = animationRequest();
    return state.animKey === JSON.stringify([req.type, req.args, previewDivisor()]);
  }

  // Play without a rendered preview: the playhead moves at the frame rate and each moment is shown the way the slider shows it (the live view for keyframes,
  // a quick frame for a viewpoint or focus sweep), only the newest one being made, so playback skips frames instead of waiting for them.
  const live = { on: false, t0: 0, start: 0, shown: -1, loop: null, n: 1 };

  function startLivePlay() {
    updateFrameLabel(); // (the slider's length is the animation's)
    // The number of frames, from the animation's plan (the slider's length can change while it plays).
    const n = Math.max(1, animationPlan().list.length || +$('scrub').max + 1);
    live.n = n;
    live.on = true;
    live.t0 = performance.now();
    live.start = (state.keyTime || 0) >= (n - 1) / state.fps ? 0 : state.keyTime || 0;
    live.shown = -1;
    live.loop = animationRequest().loop;
    setFullRes(false, { restore: false });
    setDepthShown(false, { restore: false });
    showPlayIcon(true);
    requestAnimationFrame(liveTick);
  }

  function stopLivePlay() {
    if (!live.on) return;
    live.on = false;
    if (!state.playing) showPlayIcon(false);
  }

  function liveTick(now) {
    if (!live.on) return;
    const n = live.n;
    const len = n / state.fps;
    let t = live.start + (now - live.t0) / 1000;
    if (live.loop === 'pingpong') {
      // there and back
      if (!state.repeat && t >= 2 * len) {
        stopLivePlay();
        return;
      }
      t %= 2 * len;
      if (t >= len) t = 2 * len - t;
    } else if (t >= len) {
      if (!state.repeat) {
        stopLivePlay();
        return;
      }
      t %= len;
    }
    const i = Math.min(n - 1, Math.max(0, Math.floor(t * state.fps)));
    if (i !== live.shown) {
      live.shown = i;
      showLiveFrame(i);
    }
    requestAnimationFrame(liveTick);
  }

  function showLiveFrame(i) {
    $('scrub').value = i;
    if (state.frames[i] && state.animKey) {
      state.showingFrames = true;
      state.index = i;
      showFrame(i);
      return;
    }
    state.keyTime = i / state.fps;
    if ($('anim').value === 'keyframes') {
      // (the live view: not the frames, without stopping the play)
      state.showingFrames = false;
      previewAt(state.keyTime);
    } else {
      renderSingleFrame(i);
    }
    updateFrameLabel();
  }

  function setPlaying(p) {
    if (p && !$('anim-on').checked) return;
    if (!p) stopLivePlay();
    if (p && !previewRendered()) {
      state.playing = false;
      startLivePlay();
      return;
    }
    state.playing = p;
    showPlayIcon(p);
    if (p) {
      // Played to the end without repeating: start over.
      if (!state.repeat && state.loop !== 'pingpong' && state.frames.length > 1 && state.index >= state.frames.length - 1) {
        state.index = 0;
        state.keyTime = 0;
      }
      if (!state.repeat && state.loop === 'pingpong' && state.direction < 0 && state.index <= 0) state.direction = 1;
      setFullRes(false, { restore: false });
      setDepthShown(false, { restore: false });
      state.showingFrames = true;
      ensureAnimation();
      showFrame(state.index);
    }
  }

  // Shows the live camera view again after playing or scrubbing.
  function backToCamera() {
    if (!state.showingFrames) return;
    setPlaying(false);
    state.showingFrames = false;
    updateFrameLabel();
  }
  return { animationRequest, resetAnimation, animationPlan, ensureAnimation, framesMissing, seekSettled, seekWait, stopProcessing, renderSingleFrame, invalidateAnimation, updateFrameLabel, showFrame, live, stopLivePlay, setPlaying, backToCamera };
}
