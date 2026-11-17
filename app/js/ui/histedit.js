// Editing in the histogram: its width is split into five zones (Blacks, Shadows, Exposure, Highlights, Whites, dark to light); the zone
// under the pointer is lit and named, and dragging left or right moves that zone's slider (a drag across the whole histogram sweeps its whole range);
// a double-click puts the slider back. It moves the slider itself, so the picture, saving, undo and keyframes follow as from the slider.

export const HIST_ZONES = [
  { from: 0, to: 0.1, id: 'tone-blacks', name: 'Blacks' },
  { from: 0.1, to: 0.33, id: 'tone-shadows', name: 'Shadows' },
  { from: 0.33, to: 0.66, id: 'ev', name: 'Exposure' },
  { from: 0.66, to: 0.9, id: 'tone-highlights', name: 'Highlights' },
  { from: 0.9, to: 1, id: 'tone-whites', name: 'Whites' },
];

// The zone at x (0..1 across the histogram).
export function zoneAt(x) {
  return HIST_ZONES.find((z) => x >= z.from && x < z.to) || HIST_ZONES[HIST_ZONES.length - 1];
}

// The slider's value after a drag of dx (a fraction of the histogram's width) from `start`: the whole width is the whole range, kept to its steps.
export function draggedValue(el, start, dx) {
  const min = +el.min;
  const max = +el.max;
  const step = +el.step || 1;
  const v = start + dx * (max - min);
  return Math.min(max, Math.max(min, Math.round(v / step) * step));
}

export function initHistogramEditing({ $, showSliderValue, canEdit }) {
  const wrap = $('hist-wrap');
  const band = $('hist-zone');
  const label = $('hist-label');
  let drag = null;

  const xOf = (e) => {
    const r = wrap.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width)));
  };
  const show = (z) => {
    const el = $(z.id);
    band.hidden = false;
    band.style.left = `${z.from * 100}%`;
    band.style.width = `${(z.to - z.from) * 100}%`;
    const out = document.querySelector(`output[data-for="${z.id}"]`);
    label.textContent = `${z.name} ${out ? out.textContent : el.value}`;
    label.hidden = false;
  };
  const hide = () => {
    band.hidden = true;
    label.hidden = true;
  };
  const usable = (z) => canEdit() && !$(z.id).disabled;
  const send = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));

  wrap.addEventListener('pointermove', (e) => {
    if (drag) {
      const el = $(drag.zone.id);
      const v = draggedValue(el, drag.start, xOf(e) - drag.x0);
      if (+el.value !== v) {
        el.value = String(v);
        showSliderValue(el);
        send(el, 'input');
      }
      show(drag.zone);
      return;
    }
    const z = zoneAt(xOf(e));
    if (usable(z)) show(z);
    else hide();
  });
  wrap.addEventListener('pointerleave', () => {
    if (!drag) hide();
  });
  wrap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const z = zoneAt(xOf(e));
    if (!usable(z)) return;
    e.preventDefault();
    try {
      wrap.setPointerCapture(e.pointerId);
    } catch {
      // (a pointer the browser no longer tracks: the drag still follows the moves over the histogram)
    }
    drag = { zone: z, x0: xOf(e), start: +$(z.id).value, moved: false };
  });
  const end = (e) => {
    if (!drag) return;
    const el = $(drag.zone.id);
    if (+el.value !== drag.start) send(el, 'change');
    drag = null;
    if (e && e.type === 'pointercancel') hide();
  };
  wrap.addEventListener('pointerup', end);
  wrap.addEventListener('pointercancel', end);
  wrap.addEventListener('dblclick', (e) => {
    const z = zoneAt(xOf(e));
    if (!usable(z)) return;
    const el = $(z.id);
    el.value = el.dataset.default ?? '0';
    showSliderValue(el);
    send(el, 'input');
    send(el, 'change');
    show(z);
  });
}
