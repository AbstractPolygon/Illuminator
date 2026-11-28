// info: moved out of main.js. initInfo() runs where the section used to, with what it uses from the rest of the page.

export function initInfo({ $, state, scheduleSpeed, updateKeyButtons, gpuTimeText, renderGridInfo }) {

  function fmt(v, digits = 2) {
    return typeof v === 'number' ? v.toFixed(digits) : v;
  }

  // Resolution and Scale options show the picture size they give for this
  // photo.
  const RESOLUTION_NAMES = { 1: '1× (fast)', 1.5: '1.5×', 2: '2×' };
  const L16_SCALE_NAMES = { 1: '1× camera size', 1.5: '1.5×', 2: '2×', 2.5: '2.5×', 3: '3×', 4: '4×' };
  const SCALE_NAMES = { 2: '2× lens grid', 3: '3× lens grid', 4: '4× lens grid' };
  function showResolutionSizes() {
    const label = (select, names, sizes) => {
      for (const o of select.options) {
        const size = sizes && sizes[o.value];
        o.textContent = `${names[o.value]}${size ? ` — ${size[0]}×${size[1]} px` : ''}`;
      }
    };
    label($('detail'), RESOLUTION_NAMES, state.info && state.info.sizes);
    label($('still-scale'), SCALE_NAMES, state.info && state.info.stillSizes);
    // A Light L16 photo's sizes: the camera's size (4160 x 3120) times each
    const native = state.info && state.info.processed && state.info.processed.native;
    for (const o of $('l16-resolution').options) {
      const k = +o.value;
      o.textContent = `${L16_SCALE_NAMES[o.value]}${native ? ` — ${Math.round(native[0] * k)}×${Math.round(native[1] * k)} px` : ''}`;
    }
    showPhotoSizes();
  }

  // Photo > Size options show the saved photo's size: the picture as shown
  // (through crop and rotation; with Full sensor on but not yet rendered, the
  // size its still will have) times each option.
  const PHOTO_SIZE_NAMES = { 1: 'Native', 1.5: '1.5×', 2: '2×', 3: '3×', 4: '4×' };
  function showPhotoSizes() {
    let base = state.info && state.photoBase ? [...state.photoBase] : null;
    if (base && state.fullResMode && !state.fullRes && state.info.stillSizes && state.info.sizes) {
      const still = state.info.stillSizes[$('still-scale').value];
      const view = state.info.sizes[$('detail').value];
      if (still && view) base = base.map((v) => v * (still[0] / view[0]));
    }
    for (const o of $('photo-size').options) {
      const k = +o.value;
      o.textContent = `${PHOTO_SIZE_NAMES[o.value] || `${k}×`}${base ? ` — ${Math.round(base[0] * k)}×${Math.round(base[1] * k)} px` : ''}`;
    }
  }

  function renderInfo() {
    showResolutionSizes();
    scheduleSpeed();
    if (state.queueUi) state.queueUi.render();
    if (state.looks) state.looks.render();
    updateKeyButtons();
    const info = state.info;
    const rows = [];
    if (state.current) rows.push(['File', state.current.name]);
    if (info.hasRaw) {
      const c = info.cam.capture || {};
      rows.push(['Camera', `${info.cam.make || ''} ${info.cam.model}`.trim()]);
      if (c.time) rows.push(['Taken', new Date(c.time).toLocaleString()]);
      if (c.exposure) rows.push(['Shutter', c.exposure >= 1 ? `${fmt(c.exposure, 1)} s` : `1/${Math.round(1 / c.exposure)} s`]);
      if (c.fNumber) rows.push(['Aperture', `f/${fmt(c.fNumber, 1)}`]);
      if (c.focalLength) rows.push(['Focal length', `${fmt(c.focalLength * 1000, 1)} mm`]);
      if (c.iso) rows.push(['ISO', Math.round(c.iso)]);
      rows.push(['Sensor', `${info.cam.width}×${info.cam.height}, ${info.cam.bits} bit`]);
      rows.push(['Views', `${info.width}×${info.height}`]);
      rows.push(['Lens pitch', `${fmt(info.grid.pitch, 3)} px`]);
      if (info.hotPixels) rows.push(['Hot pixels fixed', info.hotPixels.toLocaleString()]);
      if (info.renderer) rows.push(['Rendering', info.renderer]);
      if (state.gpuMs != null) rows.push(['GPU time', gpuTimeText()]);
    } else if (info.processed) {
      const p = info.processed;
      const kinds = { warp: 'All-in-focus image', single: 'Single image', focus: 'Focus stack', perspective: 'Perspective views' };
      if (info.cam) rows.push(['Camera', `${info.cam.make || ''} ${info.cam.model || ''}`.trim()]);
      const c = (info.cam && info.cam.capture) || {};
      if (c.time) rows.push(['Taken', new Date(c.time).toLocaleString()]);
      // (a Light L16 photo: the exposure of its reference camera, and the 35 mm equivalent focal length)
      if (p.source === 'l16') {
        if (c.exposure) rows.push(['Shutter', c.exposure >= 1 ? `${fmt(c.exposure, 1)} s` : `1/${Math.round(1 / c.exposure)} s`]);
        if (c.focalLength) rows.push(['Focal length', `${fmt(c.focalLength * 1000, 0)} mm (35 mm equivalent)`]);
        if (c.iso) rows.push(['ISO', c.iso]);
      }
      rows.push(['Content', `${kinds[p.kind] || p.kind}${p.count > 1 ? ` (${p.count})` : ''}${p.hasDepth ? ' with depth map' : ''}`]);
      rows.push(['Size', `${info.width}×${info.height}`]);
    }
    $('info').replaceChildren(...rows.flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      return [dt, dd];
    }));
    renderGridInfo();
  }
  return { fmt, showResolutionSizes, showPhotoSizes, renderInfo };
}
