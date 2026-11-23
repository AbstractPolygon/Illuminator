// Lightroom and Camera Raw presets (.xmp files with "crs:" develop settings) as Illuminator looks (core/looks.js). The settings that have a control here are carried over: exposure, contrast,
// highlights, shadows, whites, blacks, texture, clarity, dehaze, saturation, vibrance, the tone curve, the saturation of each color (the eight of Lightroom onto the six here), and the noise
// reduction. What has none (hue and luminance of each color, sharpening, vignette, defringe, split toning, the parametric curve) is listed in `skipped`.

const attr = (text, name) => {
  const m = new RegExp(`crs:${name}\\s*=\\s*"([^"]*)"`).exec(text);
  return m ? m[1] : null;
};
const num = (text, name) => {
  const v = attr(text, name);
  if (v === null) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

// The tone curve: the points "x, y" of its list (0 to 255), as "x,y;x,y" in 0 to 1, or null when it is the straight line or absent.
function curveOf(text) {
  const m = /<crs:ToneCurvePV2012>([\s\S]*?)<\/crs:ToneCurvePV2012>/.exec(text);
  if (!m) return null;
  const points = [...m[1].matchAll(/<rdf:li>\s*([-\d.]+)\s*,\s*([-\d.]+)\s*<\/rdf:li>/g)].map((p) => [parseFloat(p[1]) / 255, parseFloat(p[2]) / 255]);
  if (points.length < 2) return null;
  if (points.every(([x, y]) => Math.abs(x - y) < 1e-3)) return null;
  const clamp = (v) => Math.min(1, Math.max(0, v));
  return points.map(([x, y]) => `${+clamp(x).toFixed(4)},${+clamp(y).toFixed(4)}`).join(';');
}

const SKIPPED = [
  ['hue and luminance of each color', /(HueAdjustment|LuminanceAdjustment)\w+="(?!0")[^"]*"/],
  ['sharpening', /Sharpness="(?!0")/],
  ['vignette', /VignetteAmount="(?!0")/],
  ['defringe', /Defringe\w+Amount="(?!0")/],
  ['split toning', /SplitToning\w*Saturation="(?!0")/],
  ['parametric curve', /Parametric(Shadows|Darks|Lights|Highlights)="(?!0")/],
];

// Returns { look: { format, version, name, process, details }, skipped: [what had no control] }.
export function xmpToLook(text, name = 'Preset') {
  if (!/<x:xmpmeta/.test(text) || !/crs:/.test(text)) throw new Error('This is not a Lightroom preset');
  const process = {};
  const details = {};
  const set = (group, id, value, scale = 1) => {
    if (value !== null && value !== undefined && Number.isFinite(value)) group[id] = +(value * scale).toFixed(4);
  };
  set(process, 'ev', num(text, 'Exposure2012'));
  set(process, 'tone-contrast', num(text, 'Contrast2012'));
  set(process, 'tone-highlights', num(text, 'Highlights2012'));
  set(process, 'tone-shadows', num(text, 'Shadows2012'));
  set(process, 'tone-whites', num(text, 'Whites2012'));
  set(process, 'tone-blacks', num(text, 'Blacks2012'));
  set(process, 'tone-texture', num(text, 'Texture'));
  set(process, 'tone-clarity', num(text, 'Clarity2012'));
  set(process, 'tone-dehaze', num(text, 'Dehaze'));
  set(process, 'saturation', num(text, 'Saturation'));
  set(process, 'vibrance', num(text, 'Vibrance'));
  const curve = curveOf(text);
  if (curve) process['curve-points'] = curve;
  // the saturation of each color: Orange joins Yellow, Purple joins Magenta
  const sat = (c) => num(text, `SaturationAdjustment${c}`);
  const mean = (...v) => {
    const have = v.filter((x) => x !== null);
    return have.length ? have.reduce((a, b) => a + b, 0) / have.length : null;
  };
  set(process, 'hue-red', sat('Red'));
  set(process, 'hue-yellow', mean(sat('Orange'), sat('Yellow')));
  set(process, 'hue-green', sat('Green'));
  set(process, 'hue-cyan', sat('Aqua'));
  set(process, 'hue-blue', sat('Blue'));
  set(process, 'hue-magenta', mean(sat('Purple'), sat('Magenta')));
  set(details, 'nr-luminance', num(text, 'LuminanceSmoothing'));
  set(details, 'nr-color', num(text, 'ColorNoiseReduction'));
  const skipped = SKIPPED.filter(([, re]) => re.test(text)).map(([what]) => what);
  return { look: { format: 'illuminator-look', version: 1, name, process, details }, skipped };
}
