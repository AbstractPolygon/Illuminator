// The command line (desktop app: `Illuminator --cli ...`, see wiki/Command-Line.md): turns the arguments into a job. Pure, so it can be tested.

import { COLOR_SPACE_IDS } from './colorspace.js';

export const COMMANDS = ['render', 'info', 'controls', 'version', 'help'];
const FORMATS = ['png', 'png16', 'jpeg'];
const EXT = { png: 'png', png16: 'png', jpeg: 'jpg' };
const SIZES = ['1', '1.5', '2', '3', '4'];

export const USAGE = `Illuminator command line

  Illuminator --cli render <photo...> [options]   make pictures from light field photos
  Illuminator --cli info <photo>                  print the photo's details as JSON
  Illuminator --cli controls                      list the settings that can be changed, with their defaults
  Illuminator --cli version | help

Options for render:
  -o, --out <file|folder>     where to save: a file name for one photo, a folder for several
                              (default: next to each photo)
  --format png|png16|jpeg     file format (default: from the --out file name, else png)
  --quality <50-100>          JPEG quality
  --color-space <name>        srgb (default), p3, adobe, rec2020 or prophoto
  --size <1|1.5|2|3|4>        enlarge by this much (Photo Size)
  --f-number <n>              aperture, such as 2.8
  --focus <n>                 focus depth, -1.6 (near) to 1.6 (far)
  --view <u,v>                viewpoint, in sensor pixels within the lens
  --set <setting=value>       any setting from "controls" (repeat for more), e.g. --set ev=0.5
  --edits <file.json>         an edits document saved by Illuminator, applied on top
  --full-sensor               render from every sensor pixel
  --scale <n>  --passes <n>   full sensor scale and detail recovery
  --script <file.js>          run a script in the app after the photo is open; it gets \`illuminator\`
                              (the scripting interface) and may return a value
  --timeout <seconds>         give up on a photo after this long (default 1200)
  --quiet                     print only errors
  --exit-file <file>          write the exit code (0 all well, 1 a photo failed, 2 bad command) to this file
                              before the app shuts down, for scripts that must not miss it
`;

const needsValue = new Set(['-o', '--out', '--format', '--quality', '--color-space', '--size', '--f-number', '--focus', '--view', '--set', '--edits', '--scale', '--passes', '--script', '--timeout', '--exit-file']);

// args: what follows --cli. Returns { command, files, options, sets, errors }.
export function parseCli(args) {
  const out = { command: null, files: [], options: {}, sets: {}, errors: [] };
  const rest = [...args];
  if (!rest.length) {
    out.command = 'help';
    return out;
  }
  const first = rest.shift();
  if (first === '-h' || first === '--help') out.command = 'help';
  else if (first === '-v' || first === '--version') out.command = 'version';
  else if (COMMANDS.includes(first)) out.command = first;
  else {
    out.errors.push(`Unknown command "${first}". Try: ${COMMANDS.join(', ')}`);
    return out;
  }
  while (rest.length) {
    const a = rest.shift();
    if (a === '-h' || a === '--help') {
      out.command = 'help';
      continue;
    }
    if (a === '--quiet') {
      out.options.quiet = true;
      continue;
    }
    if (a === '--full-sensor') {
      out.options.fullSensor = true;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      let name = a;
      let value;
      const eq = a.indexOf('=');
      if (a.startsWith('--') && eq > 0) {
        name = a.slice(0, eq);
        value = a.slice(eq + 1);
      }
      if (!needsValue.has(name)) {
        out.errors.push(`Unknown option ${name}`);
        continue;
      }
      if (value === undefined) {
        if (!rest.length) {
          out.errors.push(`${name} needs a value`);
          continue;
        }
        value = rest.shift();
      }
      if (name === '--set') {
        const at = value.indexOf('=');
        if (at < 1) out.errors.push(`--set needs setting=value, not "${value}"`);
        else out.sets[value.slice(0, at)] = value.slice(at + 1);
      } else {
        out.options[{ '-o': 'out', '--out': 'out', '--format': 'format', '--quality': 'quality', '--color-space': 'colorSpace', '--size': 'size', '--f-number': 'fNumber', '--focus': 'focus', '--view': 'view', '--edits': 'edits', '--scale': 'scale', '--passes': 'passes', '--script': 'script', '--timeout': 'timeout', '--exit-file': 'exitFile' }[name]] = value;
      }
      continue;
    }
    out.files.push(a);
  }
  if (!out.errors.length) validate(out);
  return out;
}

function validate(job) {
  const { command, files, options: o } = job;
  const bad = (msg) => job.errors.push(msg);
  if (command === 'render' && !files.length) bad('render needs at least one photo');
  if (command === 'info' && files.length !== 1) bad('info needs one photo');
  if ((command === 'controls' || command === 'version' || command === 'help') && files.length && command !== 'help') bad(`${command} takes no files`);
  if (o.format && !FORMATS.includes(o.format)) bad(`--format must be one of ${FORMATS.join(', ')}`);
  if (o.colorSpace && !COLOR_SPACE_IDS.includes(o.colorSpace)) bad(`--color-space must be one of ${COLOR_SPACE_IDS.join(', ')}`);
  if (o.size && !SIZES.includes(o.size)) bad(`--size must be one of ${SIZES.join(', ')}`);
  if (o.quality && !(+o.quality >= 50 && +o.quality <= 100)) bad('--quality must be 50 to 100');
  for (const k of ['fNumber', 'focus', 'scale', 'passes', 'timeout']) if (o[k] !== undefined && !Number.isFinite(+o[k])) bad(`--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} needs a number`);
  if (o.view !== undefined && !/^-?[\d.]+,-?[\d.]+$/.test(o.view)) bad('--view needs u,v such as 1.5,-0.5');
  if (o.out && files.length > 1 && /\.(png|jpe?g)$/i.test(o.out)) bad('--out is a file name, but there are several photos: give a folder');
}

// The format for a photo: the option, else the extension of the output file, else png.
export function formatFor(options) {
  if (options.format) return options.format;
  if (options.out && /\.jpe?g$/i.test(options.out)) return 'jpeg';
  return 'png';
}

// The file to write for `photo` (no folder logic for paths here: `join` and `base` come from the caller's path module).
export function outputPath(photo, options, { join, dirname, basename, many }) {
  const format = formatFor(options);
  const stem = basename(photo).replace(/\.[^.]+$/, '');
  const ext = EXT[format];
  const out = options.out;
  if (out && !many && /\.[a-z0-9]+$/i.test(out)) return out;
  return join(out || dirname(photo), `${stem}.${ext}`);
}

// What the page is asked to do for a photo, as plain data: the page runs it through the scripting interface.
export function renderPlan(job) {
  const o = job.options;
  const set = { ...job.sets };
  const camera = {};
  if (o.fNumber !== undefined) camera.fNumber = +o.fNumber;
  if (o.focus !== undefined) camera.focus = +o.focus;
  if (o.view !== undefined) [camera.u, camera.v] = o.view.split(',').map(Number);
  return {
    set,
    camera: Object.keys(camera).length ? camera : null,
    fullSensor: o.fullSensor ? { scale: o.scale !== undefined ? +o.scale : undefined, passes: o.passes !== undefined ? +o.passes : undefined } : null,
    export: { format: formatFor(o), quality: o.quality !== undefined ? +o.quality : undefined, colorSpace: o.colorSpace || 'srgb', size: o.size !== undefined ? +o.size : 1 },
  };
}
