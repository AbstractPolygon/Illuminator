// The kinds of files the app opens, by name: light fields (Lytro, Light L16), and whatever app/js/extra.js adds. A Lytro sensor dump is a ".raw" file, known by its
// contents (core/decode.js).
import { EXTRA } from '../extra.js';

export const LIGHT_FIELD_EXTENSIONS = ['lfr', 'lfp', 'raw', 'lri'];
export const EXTRA_EXTENSIONS = EXTRA ? EXTRA.extensions : [];

const re = (exts) => new RegExp(`\\.(${[...new Set(exts)].join('|')})$`, 'i');
export const LIGHT_FIELD_FILE = re(LIGHT_FIELD_EXTENSIONS);
// Every file that can be a photo.
export const PHOTO_FILE = re([...LIGHT_FIELD_EXTENSIONS, ...EXTRA_EXTENSIONS]);
// For a file input's accept: every extension, in both cases (some systems match it exactly).
export const PHOTO_ACCEPT = [...new Set([...LIGHT_FIELD_EXTENSIONS, ...EXTRA_EXTENSIONS])].flatMap((e) => [`.${e}`, `.${e.toUpperCase()}`]).join(',');
