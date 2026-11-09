// The scripting interface: window.illuminator. A stable surface around the app for scripts, plugins and the command line (see wiki/Command-Line.md): open a
// photo, change its settings, make the picture, export it. It drives the same controls and code as the person at the keyboard, so what it makes is what the
// app makes. Everything that changes the picture resolves once the app has finished (nothing left to render).
//
// Events (illuminator.on): 'photoOpened' (the photo's details), 'rendered' (a picture was drawn), 'exported' ({ name, type, size }).
// Plugins: illuminator.use(fn) or illuminator.use({ name, setup(api) }) runs once, now, with the API.

import { EDIT_GROUPS } from '../edits.js';
import { COLOR_SPACE_IDS } from '../core/colorspace.js';

export const API_VERSION = 1;

// Requests that run in the background and do not hold up the picture.
const BACKGROUND = new Set(['cancel', 'prepare', 'stillStore', 'stillData', 'memoryLimits']);

// Every control a script may set (the ones saved with a photo).
export const SETTABLE = new Set(Object.values(EDIT_GROUPS).flat());

// A value for a control, from what a script or the command line gave (text such as "true" or "2.8" included).
export function coerce(el, value) {
  if (el.type === 'checkbox') return typeof value === 'string' ? /^(1|true|yes|on)$/i.test(value) : !!value;
  if (el.type === 'range' || el.type === 'number') {
    const n = +value;
    if (!Number.isFinite(n)) throw new Error(`${el.id} needs a number, not ${JSON.stringify(value)}`);
    return n;
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function initScriptingApi(host) {
  const { state, $, engine, version, openBytes, processedBytes, applyEdits, currentEdits, setCamera, setFullResMode, exportPhoto, exportVideo, speedReport } = host;
  const listeners = new Map();
  const plugins = [];

  function emit(name, detail) {
    for (const fn of listeners.get(name) || []) {
      try {
        fn(detail);
      } catch (err) {
        console.error(`illuminator: a ${name} listener failed`, err);
      }
    }
  }

  // Resolves when the app has nothing left to do: no request waiting in the worker and none started for a moment (a change is applied a little after it is made).
  async function settled(timeoutMs = 20 * 60 * 1000) {
    const start = performance.now();
    let quiet = 0;
    while (quiet < 5) {
      if (performance.now() - start > timeoutMs) throw new Error('Timed out waiting for the picture');
      await new Promise((r) => setTimeout(r, 120));
      quiet = [...engine.pending.values()].every((p) => BACKGROUND.has(p.type)) ? quiet + 1 : 0;
    }
  }

  const need = () => {
    if (!state.info) throw new Error('No photo is open: call open() first');
  };

  function control(id) {
    if (!SETTABLE.has(id)) throw new Error(`"${id}" is not a setting (see controls())`);
    const el = $(id);
    if (!el) throw new Error(`"${id}" is not in this page`);
    return el;
  }

  const api = {
    version,
    apiVersion: API_VERSION,
    colorSpaces: [...COLOR_SPACE_IDS],

    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return () => listeners.get(name).delete(fn);
    },

    use(plugin) {
      const entry = typeof plugin === 'function' ? { name: plugin.name || 'plugin', setup: plugin } : plugin;
      if (!entry || typeof entry.setup !== 'function') throw new Error('A plugin is a function, or { name, setup(api) }');
      plugins.push(entry.name || 'plugin');
      return entry.setup(api);
    },

    plugins: () => [...plugins],

    // Opens a photo from its bytes (an .LFR or .LFP file). Its saved edits are not read; the ones in the file (Lytro Desktop's, or in `sidecar`, the stack file kept beside it) are, and `edits` (an edits document, see getEdits) goes on top.
    async open(name, bytes, { edits = null, sidecar = null, userDepth = null, depthCache = null } = {}) {
      await openBytes(name, bytes, sidecar, { userDepth, depthCache });
      if (!state.info) throw new Error(`${name} could not be opened`);
      if (edits) await applyEdits(state.info, edits);
      await settled();
      return api.info();
    },

    // What the open photo's measuring (its depth and the like) made, as the file a library keeps next to a photo; null when nothing was measured. For the Render Queue.
    processed() {
      return processedBytes ? processedBytes() : null;
    },

    info() {
      need();
      const i = state.info;
      return {
        name: state.current ? state.current.name : null,
        raw: !!i.hasRaw,
        camera: i.cam ? `${i.cam.make || ''} ${i.cam.model || ''}`.trim() : null,
        sensor: i.cam && i.cam.width ? [i.cam.width, i.cam.height] : null,
        views: [i.width, i.height],
        renderer: i.renderer || null,
        picture: [$('view').width, $('view').height],
      };
    },

    // The controls a script may set, with their values now.
    controls() {
      return Object.fromEntries([...SETTABLE].filter((id) => $(id)).map((id) => {
        const el = $(id);
        return [id, el.type === 'checkbox' ? el.checked : el.type === 'range' || el.type === 'number' ? +el.value : el.value];
      }));
    },

    // Changes settings ({ id: value }, the ids of controls()): the way a person would, so every dependent step follows.
    async set(values) {
      need();
      for (const [id, v] of Object.entries(values)) {
        const el = control(id);
        const value = coerce(el, v);
        if (el.type === 'checkbox') el.checked = value;
        else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      await settled();
      return api.controls();
    },

    // The photo's settings as an edits document (what the app saves next to a photo), and the same put back.
    getEdits() {
      need();
      return currentEdits();
    },
    async setEdits(edits) {
      need();
      await applyEdits(state.info, edits);
      await settled();
    },

    // The camera: f-number, focus (depth value, -1.6 near to 1.6 far), viewpoint (u, v, sensor pixels within the lens).
    async camera(values) {
      need();
      await setCamera(values);
      await settled();
      return { fNumber: values.fNumber, focus: +$('focus').value, view: { ...state.camera } };
    },

    // Full sensor render (Render Settings > Full sensor): `scale` and `passes` as in the controls.
    async fullSensor({ scale, passes } = {}) {
      need();
      if (!state.info.hasRaw) throw new Error('This file has no raw light field to render');
      setFullResMode(true);
      const values = {};
      if (scale != null) values['still-scale'] = scale;
      if (passes != null) values['still-passes'] = passes;
      if (Object.keys(values).length) await api.set(values);
      $('render-btn').click();
      await settled();
    },

    // The picture as a file: { format: 'png' | 'png16' | 'jpeg', quality (50-100), colorSpace, size (Photo Size, 1 to 4) }. Resolves { name, type, bytes }.
    async export({ format = 'png', quality, colorSpace = 'srgb', size = 1 } = {}) {
      need();
      if (!COLOR_SPACE_IDS.includes(colorSpace)) throw new Error(`Unknown color space ${colorSpace}`);
      const values = { 'photo-format': format, 'photo-colorspace': colorSpace, 'photo-size': size };
      if (quality != null) values['photo-quality'] = quality;
      await api.set(values);
      const file = await exportPhoto();
      emit('exported', { name: file.name, type: file.type, size: file.bytes.length });
      return file;
    },

    // The animation as a video with the Video settings (Render Settings > Video; the animation must be on): resolves { name, type, bytes }.
    async exportVideo() {
      need();
      const file = await exportVideo();
      emit('exported', { name: file.name, type: file.type, size: file.bytes.length });
      return file;
    },

    // The speed report (Info panel) as text.
    async report() {
      return speedReport();
    },

    // What the app is still working on (the kinds of request waiting in the engine).
    busy: () => [...engine.pending.values()].map((p) => p.type),

    settled,
  };

  window.illuminator = api;
  return { api, emit };
}
