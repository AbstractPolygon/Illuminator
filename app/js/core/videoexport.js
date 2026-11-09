// The pure parts of recording a video from the animation's frames (ui/export.js exportVideo): the order frames play in, when each one is due, and the loop that draws them
// and can be cancelled. The encoder (MediaRecorder) and the canvases stay in the page.

// A video needs at least two pictures: one frame is a still, not an animation.
export const MIN_VIDEO_FRAMES = 2;

// The frame numbers in the order they are recorded. A loop plays forward twice; ping-pong goes forward and back, without repeating the two end frames at the turns.
export function playOrder(count, loop) {
  const forward = Array.from({ length: count }, (_, i) => i);
  return loop === 'pingpong' ? [...forward, ...[...forward].reverse().slice(1, -1)] : [...forward, ...forward];
}

// The time of frame `i` in the animation (seconds), and the frame a time (a keyframe's) falls on. Round trips for whole frames at any rate, 30000/1001 included.
export const frameTime = (i, fps) => i / fps;
export const frameAtTime = (t, fps) => Math.round((t || 0) * fps);

// How many milliseconds to wait before drawing the n-th recorded frame, so frames go out on the frame rate's beat from the start time `t0` however long each took to prepare.
// Zero when the frame is already late.
export function frameWait(t0, n, fps, now) {
  return Math.max(0, t0 + (n * 1000) / fps - now);
}

// Records every frame of `order` on the beat. `prepare(n, frameIndex)` makes one (decoding, cropping, upscaling: as long as it takes), then the loop waits for the frame's
// time and calls `emit(prepared, n, frameIndex)`, the only call that puts a picture into the recording. `sleep(ms)` and `now()` are the clock; `cancelled()` is asked before
// each frame and again just before it is emitted, so a cancel stops at the next boundary and a frame prepared during it is never emitted (`discard` gets it instead, to free it).
// Returns { cancelled, emitted }.
export async function recordFrames(order, { prepare, emit, discard = () => {}, sleep, now, fps, cancelled = () => false, onProgress = () => {} }) {
  const t0 = now();
  let emitted = 0;
  for (let n = 0; n < order.length; n++) {
    if (cancelled()) return { cancelled: true, emitted };
    const prepared = await prepare(n, order[n]);
    const wait = frameWait(t0, n, fps, now());
    if (wait > 0) await sleep(wait);
    if (cancelled()) {
      discard(prepared, n, order[n]);
      return { cancelled: true, emitted };
    }
    emit(prepared, n, order[n]);
    emitted++;
    onProgress(n / order.length);
  }
  return { cancelled: false, emitted };
}

// The Cancel button's flag, kept on the page's state. A run clears it first, so a cancel pressed during an earlier run never stops the next one;
// `stopped(result)` also counts a cancel that arrives after the last frame was emitted (while the recorder is still flushing), which recordFrames cannot see.
export function cancelControl(state) {
  return {
    begin: () => { state.cancelVideo = false; },
    request: () => { state.cancelVideo = true; },
    isRequested: () => !!state.cancelVideo,
    stopped: (result) => !!(result && result.cancelled) || !!state.cancelVideo,
  };
}
