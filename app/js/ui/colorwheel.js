// The Color Grading panel: three tone wheels (shadows, midtones, highlights). A wheel sets a hue (the angle, red at the top, going clockwise) and a saturation (the distance from the
// middle); the same two numbers are the Hue and Saturation sliders below, and Luminance is a slider only. The wheels and the sliders always show the same values (the sliders are the
// settings: they are saved with the photo and read by the engine, see settingsmap.js).
import { GRADE_ZONES } from '../settingsmap.js';

const SIZE = 96; // CSS pixels

// The wheel's picture: hue around, saturation from the middle out (drawn once per pixel ratio and kept).
function wheelImage(px) {
  const img = new ImageData(px, px);
  const c = (px - 1) / 2;
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const dx = x - c;
      const dy = y - c;
      const r = Math.hypot(dx, dy) / c;
      const i = 4 * (y * px + x);
      if (r > 1) continue;
      const hue = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
      // HSV with saturation r and value 0.92
      const h = hue / 60;
      const f = h - Math.floor(h);
      const v = 0.92;
      const p = v * (1 - r);
      const q = v * (1 - r * f);
      const t = v * (1 - r * (1 - f));
      const rgb = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][Math.floor(h) % 6];
      img.data[i] = rgb[0] * 255;
      img.data[i + 1] = rgb[1] * 255;
      img.data[i + 2] = rgb[2] * 255;
      // the edge is soft by a pixel
      img.data[i + 3] = Math.min(1, (1 - r) * c) * 255;
    }
  }
  return img;
}

export function initColorGrading({ $, applySettingsSoon, showSliderValue }) {
  const panel = $('grade-panel');
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const px = Math.round(SIZE * ratio);
  let image = null;
  let active = 'shadows';

  const slider = (zone, what) => $(`grade-${zone}-${what}`);

  function draw(zone) {
    const canvas = panel.querySelector(`.grade-wheel[data-zone="${zone}"] canvas`);
    const g = canvas.getContext('2d');
    image ||= wheelImage(px);
    g.clearRect(0, 0, px, px);
    g.putImageData(image, 0, 0);
    // the puck: where the color sits
    const hue = +slider(zone, 'hue').value;
    const sat = +slider(zone, 'sat').value / 100;
    const c = (px - 1) / 2;
    const a = (hue * Math.PI) / 180;
    const x = c + Math.sin(a) * sat * c;
    const y = c - Math.cos(a) * sat * c;
    g.lineWidth = Math.max(1.5, ratio * 1.5);
    g.strokeStyle = '#fff';
    g.fillStyle = 'rgba(0, 0, 0, 0.35)';
    g.beginPath();
    g.arc(x, y, 5 * ratio, 0, 2 * Math.PI);
    g.fill();
    g.stroke();
  }

  function redraw() {
    for (const z of GRADE_ZONES) draw(z);
    for (const z of GRADE_ZONES) {
      panel.querySelector(`.grade-wheel[data-zone="${z}"]`).classList.toggle('active', z === active);
      panel.querySelector(`.grade-wheel[data-zone="${z}"] .wheel-name`).setAttribute('aria-pressed', String(z === active));
      panel.querySelector(`.grade-sliders[data-zone="${z}"]`).hidden = z !== active;
    }
  }

  function setActive(zone) {
    active = zone;
    redraw();
  }

  // Sets the hue and saturation sliders (and so the settings) from a pointer position on a wheel.
  function setFromPointer(zone, canvas, e) {
    const rect = canvas.getBoundingClientRect();
    const dx = e.clientX - (rect.left + rect.width / 2);
    const dy = e.clientY - (rect.top + rect.height / 2);
    const radius = rect.width / 2;
    const sat = Math.min(1, Math.hypot(dx, dy) / radius);
    const hue = Math.round(((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360) % 360;
    const h = slider(zone, 'hue');
    const s = slider(zone, 'sat');
    h.value = String(sat < 0.03 ? +h.value : hue);
    s.value = String(Math.round(sat * 100));
    for (const el of [h, s]) {
      showSliderValue(el);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    draw(zone);
  }

  for (const zone of GRADE_ZONES) {
    const wheel = panel.querySelector(`.grade-wheel[data-zone="${zone}"]`);
    const canvas = wheel.querySelector('canvas');
    canvas.width = px;
    canvas.height = px;
    canvas.style.width = `${SIZE}px`;
    canvas.style.height = `${SIZE}px`;
    let dragging = false;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      canvas.setPointerCapture(e.pointerId);
      setActive(zone);
      setFromPointer(zone, canvas, e);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (dragging) setFromPointer(zone, canvas, e);
    });
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      for (const what of ['hue', 'sat']) slider(zone, what).dispatchEvent(new Event('change', { bubbles: true }));
    };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);
    // a double-click takes the color away (saturation 0 and brightness as it was)
    canvas.addEventListener('dblclick', () => resetZone(zone));
    wheel.querySelector('.wheel-name').addEventListener('click', () => setActive(zone));
    // the sliders move the puck
    for (const what of ['hue', 'sat']) slider(zone, what).addEventListener('input', () => draw(zone));
    canvas.setAttribute('aria-label', `${wheel.querySelector('.wheel-name').textContent} color wheel: drag to choose a color, double-click to clear`);
  }

  function resetZone(zone) {
    for (const what of ['hue', 'sat', 'lum']) {
      const el = slider(zone, what);
      el.value = el.dataset.default;
      showSliderValue(el);
    }
    draw(zone);
    applySettingsSoon();
  }

  $('grade-reset').onclick = () => {
    for (const zone of GRADE_ZONES) resetZone(zone);
    for (const id of ['grade-blend', 'grade-balance']) {
      $(id).value = $(id).dataset.default;
      showSliderValue($(id));
    }
    applySettingsSoon();
  };

  redraw();
  return { redraw };
}
