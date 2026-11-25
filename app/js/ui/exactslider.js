// Sliders that hold a value between their steps: an animation's in-between frames set a slider to the exact interpolated value (a slider snaps what it is given to
// its step, and the frames would move in steps), and the step comes back as soon as the slider is used by hand.

// Sets the slider to v exactly (its step put aside until it is next used).
export function setSliderExact(el, v) {
  if (el.step !== 'any') {
    el.dataset.step = el.step || '1';
    el.step = 'any';
  }
  el.value = v;
}

// The slider's step (what it steps in when used by hand), whether or not it is put aside.
export function sliderStep(el) {
  return +(el.dataset.step || el.step) || 1;
}

// The step back on a slider that is grabbed or keyed (the value snaps to it then).
export function watchExactSliders(root = document) {
  const restore = (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement) || el.type !== 'range' || !el.dataset.step) return;
    el.step = el.dataset.step;
    delete el.dataset.step;
  };
  root.addEventListener('pointerdown', restore, true);
  root.addEventListener('keydown', restore, true);
}
