// The keys that say what a saved cache (the measured depth, what opening works out) was made with, and the lens-grid tag that keeps pictures made with a recalibrated grid apart
// from the photo's first ones. They are pure functions of the worker's state so a test can check that a key changes with what the result depends on and with nothing else.
// A cache with another key is not used (see worker.js depthCacheFor and core/processed-cache.js).
import { CACHE_REV } from './cacherev.js';

export const DEPTH_CACHE_FORMAT = 1;
export const OPEN_CACHE_FORMAT = 1;

// The lens grid as a string when it differs from the one the photo opened with (the metadata's or the calibrated one), else undefined: a key made with the default grid is
// then the same as one made before grids could change.
export function gridTag(state) {
  const g = state.lf && state.lf.grid ? JSON.stringify(state.lf.grid) : null;
  return g && g !== state.openGrid ? g : undefined;
}

export function depthCacheKey(state) {
  const s = state.settings;
  return JSON.stringify({ rev: CACHE_REV, format: DEPTH_CACHE_FORMAT, photo: state.lf && state.lf.photoId, detail: s.detail, hot: s.hotPixels !== false, grid: gridTag(state) });
}

// What a measured depth depends on: the photo, the depth method and the settings that change the measurement (not the smoothing, contrast, blend or the model, which are
// applied to a measured depth).
export function depthMethodKey(state, style) {
  const s = state.settings;
  return JSON.stringify({ rev: CACHE_REV, photo: state.lf && state.lf.photoId, detail: s.detail, hot: s.hotPixels !== false, style, quality: s.depthQuality ?? 'normal', objects: !!s.depthObjects, lytro: !!(state.userDepth && s.lytroDepth !== false), guided: s.depthStyle === 'guided', grid: gridTag(state) });
}

export function openCacheKey(state) {
  const s = state.settings;
  return JSON.stringify({ rev: CACHE_REV, format: OPEN_CACHE_FORMAT, photo: state.lf && state.lf.photoId, hot: s.hotPixels !== false, wb: s.engineWb !== false, mod: s.engineModulation !== false });
}

// The cache read from the photo's folder, if it is the one for this raster: the same key (photo, settings, revision, grid) and size. null otherwise, so a cache written for
// another photo, another revision or another grid is measured again, not applied.
export function depthCacheFor(cacheIn, key, raster) {
  const c = cacheIn;
  return c && c.alpha && c.alpha.length && raster && c.key === key && c.w === raster.w && c.h === raster.h ? c : null;
}

// The depths of other depth methods kept with the photo, by their key. An entry whose key is not a JSON object counts as damaged (the page is asked to write the cache again),
// one made with another revision is skipped silently. Returns { methods: Map(key -> entry), damaged }.
export function keptMethods(depthCache) {
  const methods = new Map();
  let damaged = !!depthCache && !(depthCache.alpha && depthCache.key);
  for (const e of (depthCache && depthCache.extra) || []) {
    let k = null;
    try {
      k = JSON.parse(e.key);
    } catch {
      k = null;
    }
    if (!k || typeof k !== 'object') damaged = true;
    else if (k.rev === CACHE_REV) methods.set(e.key, { raw: { alpha: e.alpha, confidence: e.confidence, range: e.range, flat: e.flat }, parts: null, w: e.w, h: e.h });
  }
  return { methods, damaged };
}
