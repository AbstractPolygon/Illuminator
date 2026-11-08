// Looks: the color and tone of a photo's edits, kept as a file that can be shared and put on other photos. A look holds the Process settings (tone, color, curves, the film
// look and LUT, and optionally the white balance), the sharpening and noise reduction, and the local adjustments; not the focus, the viewpoint, the crop or the export
// settings, which belong to the photo. Pure functions on edits documents (see edits.js); the library keeps them (library/library.js) and ui/looks.js shows them.

import { EDITS_FORMAT, EDITS_VERSION } from '../edits.js';

export const LOOK_FORMAT = 'illuminator-look';
export const LOOK_VERSION = 1;
export const LOOK_SUFFIX = '.illuminator-look';

// Photo-specific controls left out of a look: the white balance (unless asked for), and the hot pixel search and multi-view noise reduction, which depend on the camera.
const WHITE_BALANCE = ['awb', 'wb-temperature', 'wb-tint'];
const PHOTO_SPECIFIC_DETAILS = ['nr-hot', 'mv-on', 'mv-blend'];

const pick = (group, skip) => Object.fromEntries(Object.entries(group || {}).filter(([id]) => !skip.includes(id)));

// A look from an edits document. `whiteBalance`: include the temperature and tint; `local`: include the local adjustments; `details`: include sharpening and noise reduction.
export function makeLook(edits, name, { whiteBalance = false, local = true, details = true } = {}) {
  if (!edits || typeof edits !== 'object') throw new Error('There are no settings to make a look from');
  const look = {
    format: LOOK_FORMAT,
    version: LOOK_VERSION,
    name: String(name || 'Look').trim() || 'Look',
    created: new Date().toISOString(),
    process: pick(edits.process, whiteBalance ? [] : WHITE_BALANCE),
  };
  if (details) look.details = pick(edits.details, PHOTO_SPECIFIC_DETAILS);
  if (local && edits.local && Object.keys(edits.local).length) look.local = { ...edits.local };
  return look;
}

// A look from the text of a look file. Throws for anything else.
export function parseLook(text) {
  let look;
  try {
    look = JSON.parse(text);
  } catch {
    throw new Error('This is not an Illuminator look file');
  }
  if (!look || look.format !== LOOK_FORMAT) throw new Error('This is not an Illuminator look file');
  if (look.version > LOOK_VERSION) throw new Error('This look was made by a newer Illuminator');
  for (const group of ['process', 'details', 'local']) {
    if (look[group] != null && (typeof look[group] !== 'object' || Array.isArray(look[group]))) throw new Error('This look file is damaged');
  }
  return { ...look, name: String(look.name || 'Look').trim() || 'Look' };
}

// An edits document with the look's settings put on it (the look's values win; everything else, the focus and viewpoint among it, stays). The local adjustments are replaced
// by the look's when it has some. The edits are not changed.
export function applyLookToEdits(edits, look) {
  const out = JSON.parse(JSON.stringify(edits || { format: EDITS_FORMAT, version: EDITS_VERSION }));
  for (const group of ['process', 'details']) {
    if (look[group]) out[group] = { ...(out[group] || {}), ...look[group] };
  }
  if (look.local && Object.keys(look.local).length) out.local = { ...look.local };
  out.modified = new Date().toISOString();
  return out;
}

// What a look holds, in words for its tooltip.
export function describeLook(look) {
  const parts = ['tone and color'];
  if (look.process && ('wb-temperature' in look.process || 'awb' in look.process)) parts.push('white balance');
  if (look.details && Object.keys(look.details).length) parts.push('sharpening and noise reduction');
  if (look.local && Object.keys(look.local).length) parts.push('local adjustments');
  return parts.join(', ');
}

export function lookFileName(name) {
  return `${String(name || 'Look').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'Look'}${LOOK_SUFFIX}`;
}
