// Ready-made camera moves for the Animation panel: each fills the viewpoint, zoom and pan tracks of the keyframes (nothing else), so the move can be edited like any other
// keyframes and exported as a video. `radius` is the viewpoint range of the photo (state.info.radius: the Amount of the Viewpoint path is a share of it).

import { setKey, emptyAnimation } from './keyframes.js';

// What the list in the Animation panel shows: id, name and what it does.
export const CAMERA_MOVES = [
  { id: 'orbit', name: 'Orbit', hint: 'The viewpoint circles once around the subject; the end joins the start, so it loops.' },
  { id: 'parallax', name: 'Parallax sweep', hint: 'The viewpoint glides left, then right, then back; the near things slide against the far ones. Loops.' },
  { id: 'push', name: 'Slow push in', hint: 'Moves toward the subject: a slow zoom in with a little sideways drift.' },
  { id: 'pull', name: 'Slow pull out', hint: 'Moves away from the subject: a slow zoom out with a little sideways drift.' },
  { id: 'dolly', name: 'Dolly with parallax', hint: 'Zooms in while the viewpoint slides across, the move of a camera on a track.' },
  { id: 'float', name: 'Float (figure eight)', hint: 'A gentle figure eight of the viewpoint with a little zoom. Loops.' },
  { id: 'pan', name: 'Pan across', hint: 'Zooms in a little and pans from one side of the picture to the other.' },
];

const TRACKS_SET = ['view', 'zoom', 'panX', 'panY'];

// An animation of `length` seconds with the move `id`, or null for an unknown id. `base`: an animation whose other tracks are kept (the move's tracks replace its own).
export function cameraMove(id, { radius = 4.5, length = 4, base = null } = {}) {
  const r = radius * 0.85;
  const T = length;
  const anim = base ? { ...base, length: T, tracks: { ...base.tracks } } : emptyAnimation();
  anim.length = T;
  for (const k of TRACKS_SET) anim.tracks[k] = [];
  const key = (k, t, v) => setKey(anim, k, t, v);
  switch (id) {
    case 'orbit':
      for (let i = 0; i <= 8; i++) key('view', (T * i) / 8, [r * Math.cos((2 * Math.PI * i) / 8), r * Math.sin((2 * Math.PI * i) / 8)]);
      key('zoom', 0, 1);
      break;
    case 'parallax':
      key('view', 0, [-r, 0]);
      key('view', T / 2, [r, 0]);
      key('view', T, [-r, 0]);
      key('zoom', 0, 1);
      break;
    case 'push':
      key('view', 0, [-0.3 * r, 0]);
      key('view', T, [0.3 * r, 0]);
      key('zoom', 0, 1);
      key('zoom', T, 1.35);
      break;
    case 'pull':
      key('view', 0, [0.3 * r, 0]);
      key('view', T, [-0.3 * r, 0]);
      key('zoom', 0, 1.35);
      key('zoom', T, 1);
      break;
    case 'dolly':
      key('view', 0, [-0.8 * r, 0]);
      key('view', T, [0.8 * r, 0]);
      key('zoom', 0, 1);
      key('zoom', T, 1.4);
      break;
    case 'float':
      for (let i = 0; i <= 8; i++) key('view', (T * i) / 8, [0.5 * r * Math.sin((2 * Math.PI * i) / 8), 0.35 * r * Math.sin((4 * Math.PI * i) / 8)]);
      key('zoom', 0, 1.1);
      break;
    case 'pan':
      key('zoom', 0, 1.5);
      key('panX', 0, -0.8);
      key('panX', T, 0.8);
      key('panY', 0, 0);
      break;
    default:
      return null;
  }
  return anim;
}
