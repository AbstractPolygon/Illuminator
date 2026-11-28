// modes: moved out of main.js. initModes() runs where the section used to, with what it uses from the rest of the page.
export function initModes({ state, $, updateRenderButton, updateSpreadOverlay, hasDepth, isL16, setFullResMode, showDepthMethods, BOKEH_SHAPE, PREVIEW_IDS, canDrag, setFullRes, setDepthShown, layoutCanvas, setPlaying, renderGridInfo, renderTimeline, refresh, updateKeyButtons }) {

  // Without a photo nothing in the right sidebar can be used: every section's
  // settings (and the Render buttons) are disabled; the sections still open.
  function showSidebarEnabled() {
    const off = !state.info;
    for (const el of document.querySelectorAll('.controls > .panel > :not(summary), .controls > .render-actions')) el.inert = off;
    $('controls').classList.toggle('no-photo', off);
  }

  function setMode(mode) {
    showSidebarEnabled();
    // The Lenslets view compares the sensor with the picture shown before.
    if (mode === 'lenslets' && state.mode === 'camera' && state.lastImage && !state.lastImage.pair) state.lensPicture = state.lastImage;
    state.mode = mode;
    updateRenderButton();
    updateSpreadOverlay();
    for (const b of document.querySelectorAll('#modes button')) b.classList.toggle('active', b.dataset.mode === mode);
    for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== mode;
    const raw = !!(state.info && state.info.hasRaw);
    for (const b of document.querySelectorAll('#modes button')) b.disabled = !state.info || (!raw && b.dataset.mode !== 'camera');
    const camera = mode === 'camera';
    // Focus stacks bring their own blur; the depth effects need a depth map.
    const depthTools = hasDepth() && camera;
    const stack = !!(state.info && state.info.processed && state.info.processed.kind === 'focus');
    $('fullres-on').disabled = !raw || !camera;
    // The Full sensor choice is only for raw photos (it means nothing for the others); a Light L16 photo always renders in full.
    $('fullres-on').closest('label').hidden = !raw;
    if (isL16() && camera) {
      if (!state.fullResMode) setFullResMode(true);
    } else if (!raw || !camera) setFullResMode(false);
    for (const id of ['depth-btn', 'depth-grey', 'depth-contrast', 'depth-contrast-persp', 'spread-show', 'depth-smooth', 'depth-hq', 'depth-style', 'depth-blend', 'depth-model-blend', 'depth-objects', 'depth-objects-soft', 'depth-model-smooth', 'depth-model-curve', 'lytro-depth']) $(id).disabled = !depthTools;
    showDepthMethods();
    // Grayscale only changes the depth map's picture: it can be used while the map is shown.
    $('depth-grey').disabled = !depthTools || !state.depthShown;
    // Photos imported with a depth map edited in Lytro Desktop can use it.
    $('lytro-depth-row').hidden = !(state.info && state.info.userDepth);
    for (const id of ['fstop', 'bokeh', 'dof-depth', 'highlights', 'spread', 'spread-smooth', 'spread-blur', 'tilt-on', 'tilt-preset', 'tilt', 'tilt-rotation', 'tilt-show', ...BOKEH_SHAPE]) $(id).disabled = !depthTools || stack;
    if (!$('tilt-on').checked) for (const id of ['tilt', 'tilt-rotation', 'tilt-show']) $(id).disabled = true;
    $('mv-on').disabled = !raw;
    // Multi-view noise reduction merges a raw photo's views: the others have none, so it is not shown for them; Remove hot pixels works on every photo (the sensor of a raw photo,
    // the cameras of a Light L16 photo, the pictures of a processed one)
    $('mv-on').closest('label').hidden = !!state.info && !raw;
    $('mv-blend').closest('label').hidden = !!state.info && !raw;
    $('nr-hot').disabled = !state.info;
    // Pictures Lytro Desktop finished already have its look.
    $('base-look').disabled = !raw;
    $('detail').disabled = !raw;
    for (const id of ['stop-btn', 'key-prev', 'key-next', 'play-btn', 'loop-btn', 'webm-btn', 'scrub', ...PREVIEW_IDS]) $(id).disabled = !state.info || !camera || !$('anim-on').checked;
    $('png-btn').disabled = !state.info;
    $('quick-export-btn').disabled = !state.info;
    // (3D needs two viewpoints: every photo that can change its viewpoint, raw, Light L16 and processed ones with depth)
    $('stereo-btn').disabled = !canDrag() || !camera;
    $('lent-btn').disabled = !state.info || !camera;
    $('lent-preview-btn').disabled = !state.info || !camera;
    $('vr-btn').disabled = !canDrag() || !camera;
    $('stereo-on').disabled = !canDrag() || !camera;
    if (!state.info) return;
    setFullRes(false, { restore: false });
    // The depth map stays on through camera-mode changes (a new photo or leaving the camera view turns it off elsewhere).
    if (mode !== 'camera') setDepthShown(false, { restore: false });
    layoutCanvas();
    if (camera) {
      state.showingFrames = false;
    } else {
      setPlaying(false);
      state.showingFrames = false;
      renderGridInfo();
    }
    $('frame-label').textContent = '';
    renderTimeline();
    refresh();
    updateKeyButtons();
  }
  return { showSidebarEnabled, setMode };
}
