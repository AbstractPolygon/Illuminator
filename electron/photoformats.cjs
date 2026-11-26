// The photo file extensions the app opens: the same list as app/js/core/photoformats.js (an ES module the main process cannot load directly).
const LIGHT_FIELD_EXTENSIONS = ['lfr', 'lfp', 'raw', 'lri'];
const CAMERA_RAW_EXTENSIONS = [];
const PLAIN_IMAGE_EXTENSIONS = [];
const ALL = [...LIGHT_FIELD_EXTENSIONS];
const PHOTO_FILE = new RegExp(`\\.(${ALL.join('|')})$`, 'i');

module.exports = { LIGHT_FIELD_EXTENSIONS, CAMERA_RAW_EXTENSIONS, PLAIN_IMAGE_EXTENSIONS, PHOTO_EXTENSIONS: ALL, PHOTO_FILE };
