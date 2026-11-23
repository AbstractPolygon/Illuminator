// Looks that come with the app for Light L16 photos: the two Lightroom presets Light made for the L16's pictures (the essential one, and the one for pop), as far as this app has controls for
// their settings (core/lightroompreset.js: exposure, tone, saturation of each color, the tone curve and noise reduction; not the hue and luminance of each color or the sharpening).
export const L16_LOOKS = [
  {
    id: 'builtin:l16-essential',
    format: 'illuminator-look',
    version: 1,
    name: 'Light L16 Essential',
    process: {
      ev: 0.33, 'tone-contrast': 9, 'tone-highlights': -43, 'tone-shadows': 43, 'tone-whites': 0, 'tone-blacks': -5, 'tone-clarity': 0, 'tone-dehaze': 0, saturation: -1, vibrance: 9,
      'curve-points': '0,0.0196;0.1255,0.0863;0.251,0.2196;0.502,0.502;0.7529,0.7686;1,0.9804',
      'hue-red': -15, 'hue-yellow': -6, 'hue-green': -23, 'hue-cyan': 8, 'hue-blue': 3, 'hue-magenta': -11,
    },
    details: { 'nr-luminance': 3, 'nr-color': 68 },
  },
  {
    id: 'builtin:l16-pop',
    format: 'illuminator-look',
    version: 1,
    name: 'Light L16 Pop',
    process: {
      ev: 0.25, 'tone-contrast': 5, 'tone-highlights': 20, 'tone-shadows': 20, 'tone-whites': 0, 'tone-blacks': -15, 'tone-clarity': 35, 'tone-dehaze': 0, saturation: 0, vibrance: 0,
      'curve-points': '0,0.0196;1,0.9804',
      'hue-red': 7, 'hue-yellow': 0, 'hue-green': 29, 'hue-cyan': 0, 'hue-blue': 19, 'hue-magenta': -16.5,
    },
    details: { 'nr-luminance': 0, 'nr-color': 25 },
  },
];

// The looks that come with the app for a Lytro raw photo: the base look, which was a separate choice under Tone (Lytro Desktop's contrast and color, or flat).
export const BASE_LOOKS = [
  { id: 'builtin:desktop-classic', format: 'illuminator-look', version: 1, name: 'Desktop Classic', process: { 'base-look': 'lytro' } },
  { id: 'builtin:flat', format: 'illuminator-look', version: 1, name: 'Flat', process: { 'base-look': 'flat' } },
];
