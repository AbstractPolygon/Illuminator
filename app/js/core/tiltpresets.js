// One-click starting points for the Tilt controls (Camera > Tilt > Preset). Each is a set of control values (ids of the page's controls, as the scripting
// interface takes them); `fNumber` picks the aperture. The look depends on the photo's depth: a miniature needs a scene that recedes (a street seen from
// above, a table), where the sharp band then follows the ground.

export const TILT_PRESETS = {
  miniature: {
    name: 'Miniature (horizontal band)',
    help: 'A sharp band across the picture with strong blur above and below, and richer color: the toy-model look',
    values: { 'tilt-on': true, tilt: 55, 'tilt-rotation': 0, spread: 6, 'spread-smooth': 40, 'spread-blur': 30, fNumber: 1.4, 'dof-depth': -40, saturation: 25 },
  },
  miniatureVertical: {
    name: 'Miniature (vertical band)',
    help: 'The same look with the sharp band running up and down',
    values: { 'tilt-on': true, tilt: 55, 'tilt-rotation': 90, spread: 6, 'spread-smooth': 40, 'spread-blur': 30, fNumber: 1.4, 'dof-depth': -40, saturation: 25 },
  },
  landscape: {
    name: 'Landscape tilt',
    help: 'A gentle tilt that keeps the ground sharp from near to far, with soft sky and background',
    values: { 'tilt-on': true, tilt: 25, 'tilt-rotation': 0, spread: 20, 'spread-smooth': 50, 'spread-blur': 20, fNumber: 2.8, 'dof-depth': 0 },
  },
  diagonal: {
    name: 'Diagonal tilt',
    help: 'A sharp plane running across the picture at an angle, for a dreamy, tilt-lens feel',
    values: { 'tilt-on': true, tilt: 40, 'tilt-rotation': 45, spread: 10, 'spread-smooth': 50, 'spread-blur': 25, fNumber: 2, 'dof-depth': -20 },
  },
  off: {
    name: 'Tilt off',
    help: 'Turns the tilt off and brings back the flat plane of focus',
    values: { 'tilt-on': false, tilt: 0, 'tilt-rotation': 0 },
  },
};

export const TILT_PRESET_IDS = Object.keys(TILT_PRESETS);

export function tiltPreset(id) {
  return TILT_PRESETS[id] || null;
}
