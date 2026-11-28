// focus peaking: moved out of main.js. initPeaking() runs where the section used to, with what it uses from the rest of the page.
import { PEAKING_MAX_PIXELS, peakingPixels } from '../core/peaking.js';

export function initPeaking({ $, state, canvas, showSliderValue }) {

  // Focus peaking: marks the sharp edges of the picture in green. Looks at the
  // picture as shown (read small, about a million pixels at most): an edge is
  // marked where the brightness changes quickly from one pixel to the next,
  // which blurred edges do not. Drawn on its own canvas over the picture.
  let peakingScratch = null;
  function drawPeaking() {
    const overlay = $('peaking-overlay');
    const on = $('focus-peaking').checked && state.info && state.mode === 'camera' && !state.depthShown && !canvas.classList.contains('hidden') && !(state.lastImage && state.lastImage.pair);
    overlay.hidden = !on;
    if (!on) return;
    const w = canvas.width;
    const h = canvas.height;
    if (!w || !h) return;
    const k = Math.min(1, Math.sqrt(PEAKING_MAX_PIXELS / (w * h)));
    const sw = Math.max(2, Math.round(w * k));
    const sh = Math.max(2, Math.round(h * k));
    peakingScratch ||= document.createElement('canvas');
    if (peakingScratch.width !== sw || peakingScratch.height !== sh) {
      peakingScratch.width = sw;
      peakingScratch.height = sh;
    }
    const sctx = peakingScratch.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(canvas, 0, 0, w, h, 0, 0, sw, sh);
    const data = sctx.getImageData(0, 0, sw, sh).data;
    // Level 0..100 to a threshold from 0.30 (few edges) down to 0.03 (nearly every edge).
    const threshold = 0.3 - 0.0027 * +$('peaking-level').value;
    const out = peakingPixels(data, sw, sh, threshold);
    if (overlay.width !== sw) overlay.width = sw;
    if (overlay.height !== sh) overlay.height = sh;
    overlay.getContext('2d').putImageData(new ImageData(out, sw, sh), 0, 0);
    for (const key of ['width', 'height', 'left', 'top']) overlay.style[key] = canvas.style[key];
  }

  $('focus-peaking').onchange = drawPeaking;
  $('peaking-level').oninput = () => {
    showSliderValue($('peaking-level'));
    drawPeaking();
  };
  return { drawPeaking };
}
