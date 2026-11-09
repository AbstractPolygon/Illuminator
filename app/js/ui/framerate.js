// frame rate: moved out of main.js. initFrameRate() runs where the section used to, with what it uses from the rest of the page.
import { FPS as DEFAULT_FPS } from '../core/keyframes.js';

// NTSC rates are not 29.97 and 59.94 but 30000/1001 and 60000/1001; rounded
// values drift by about a frame every 33 seconds against real NTSC video.
const EXACT_PRESETS = { '23.976': 24000 / 1001, '29.97': 30000 / 1001, '59.94': 60000 / 1001 };

// A frame rate typed as 24, 29.97, 29,97 or a fraction such as 30000/1001; NaN when it is none of those.
export function parseFrameRate(text) {
  const t = String(text).trim().replace(/\s+/g, '').replace(',', '.');
  const num = /^\d+(\.\d+)?$|^\.\d+$/;
  const frac = t.split('/');
  if (frac.length === 2 && num.test(frac[0]) && num.test(frac[1])) {
    const v = +frac[0] / +frac[1];
    return Number.isFinite(v) && v > 0 ? v : NaN;
  }
  return num.test(t) ? +t : NaN;
}

export function initFrameRate({ $, state, scheduleSave, animationSettingsChanged, showAnimationLength, renderTimeline, updateFrameLabel }) {
  const FPS_PRESETS = ['23.976', '24', '25', '29.97', '30', '48', '50', '59.94', '60'];

  // Shows the frame rate setting (#fps) in the preset list, or as custom.
  function showFrameRate() {
    const fps = Math.min(240, Math.max(1, +$('fps').value || DEFAULT_FPS));
    const preset = FPS_PRESETS.find((p) => Math.abs((EXACT_PRESETS[p] ?? +p) - fps) < 1e-3);
    if (!state.customFps || !preset) $('fps-preset').value = preset || 'custom';
    $('fps-custom').hidden = $('fps-preset').value !== 'custom';
    state.fps = fps;
  }

  function setFrameRate(fps) {
    // A viewpoint path or focus sweep keeps its length in seconds.
    const seconds = +$('frames').value / state.fps;
    $('fps').value = String(+(+fps).toFixed(6));
    showFrameRate();
    $('frames').value = Math.max(2, Math.round(seconds * state.fps));
    scheduleSave();
    animationSettingsChanged();
    showAnimationLength();
    renderTimeline();
    updateFrameLabel();
  }

  $('fps-preset').onchange = () => {
    const v = $('fps-preset').value;
    state.customFps = v === 'custom';
    if (state.customFps) {
      $('fps-custom').hidden = false;
      $('fps').focus();
      return;
    }
    setFrameRate(EXACT_PRESETS[v] ?? +v);
  };
  $('fps').onchange = () => {
    const fps = parseFrameRate($('fps').value);
    if (!Number.isFinite(fps)) {
      // Keep the current rate and say so, rather than quietly switching to 30 fps.
      $('fps').value = String(+state.fps.toFixed(6));
      $('fps').setCustomValidity('Enter a frame rate such as 24, 29.97 or 30000/1001.');
      $('fps').reportValidity();
      $('fps').setCustomValidity('');
      return;
    }
    setFrameRate(Math.min(240, Math.max(1, fps)));
  };
  return { showFrameRate };
}
