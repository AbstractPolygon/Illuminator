// The speed report (Info panel): how long each stage took on this computer,
// and what limits it. The worker times its stages (worker.js sends a
// 'timing' message when one finishes), the page keeps them here.

// Stages that are timed, and the name shown for each.
export const STAGE_NAMES = {
  open: 'Opening the photo',
  depth: 'Measuring depth',
  settings: 'Applying settings',
  view: 'Camera view',
  frames: 'Animation frames',
  refocusFrames: 'Animation frames',
  superRes: 'Full sensor render',
  superResPreview: 'Full sensor preview',
  focusAt: 'Click to focus',
  depthMap: 'Depth map picture',
  spreadMask: 'Show spread',
};

export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '–';
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

// Timings by stage: how many, the last, the best and the total.
export class Timings {
  constructor() {
    this.stages = new Map();
  }

  // `where`: 'graphics card' or 'processor' for stages that can be done on either, or null.
  record(stage, ms, where = null) {
    const name = STAGE_NAMES[stage];
    if (!name || !Number.isFinite(ms) || ms < 0) return;
    const s = this.stages.get(name) || { name, count: 0, last: 0, best: Infinity, total: 0, where: null };
    s.count++;
    s.last = ms;
    s.best = Math.min(s.best, ms);
    s.total += ms;
    if (where) s.where = where;
    this.stages.set(name, s);
  }

  // Stages in the order they were first timed.
  rows() {
    return [...this.stages.values()];
  }

  clear() {
    this.stages.clear();
  }
}

// What holds the speed back on this computer, as short statements, most important first.
// facts: { renderer ('GPU (name)' or 'CPU'), hardware (the graphics card is a real one), fallbacks [[step, error]], cores, memoryGB (or null) }
export function speedLimits(facts, rows = []) {
  const out = [];
  const { renderer = 'CPU', hardware = false, fallbacks = [], cores = 0, memoryGB = null } = facts;
  if (!/^GPU/.test(renderer)) {
    out.push({ level: 'warn', text: 'No graphics card is in use (the browser gives no WebGL 2). Depth, refocusing and full sensor renders run on the processor, which is many times slower. Updating the graphics driver or turning on hardware acceleration in the browser may help.' });
  } else if (!hardware) {
    out.push({ level: 'warn', text: `The graphics is a software renderer (${renderer.replace(/^GPU \(|\)$/g, '')}), which is no faster than the processor. A real graphics card or hardware acceleration in the browser would be much faster.` });
  }
  for (const [step, error] of fallbacks) out.push({ level: 'warn', text: `${step} stopped on the graphics card and was done on the processor instead, which is slower${error ? ` (${error})` : ''}.` });
  if (cores > 0 && cores <= 2) out.push({ level: 'info', text: `Only ${cores} processor ${cores === 1 ? 'core is' : 'cores are'} available, so steps done on the processor cannot be spread out much.` });
  if (memoryGB != null && memoryGB <= 4) out.push({ level: 'info', text: `The browser reports about ${memoryGB} GB of memory: large renders may be slow, or refused (see Settings > Memory).` });
  const slow = rows.filter((r) => r.count > 0).sort((a, b) => b.last - a.last)[0];
  if (slow && slow.last >= 2000) out.push({ level: 'info', text: `The slowest stage so far is “${slow.name}”: ${formatDuration(slow.last)} the last time.` });
  if (!out.length) out.push({ level: 'ok', text: 'Nothing found that holds it back: a graphics card is in use and no step had to fall back to the processor.' });
  return out;
}

// The report as plain text, to paste into a message.
export function reportText({ version = '', platform = '', facts = {}, rows = [], gpuMs = null, photo = '' }) {
  const lines = [`Illuminator ${version} speed report`];
  if (platform) lines.push(`System: ${platform}`);
  lines.push(`Rendering: ${facts.renderer || 'CPU'}${facts.hardware === false && /^GPU/.test(facts.renderer || '') ? ' (software)' : ''}`);
  if (facts.cores) lines.push(`Processor cores: ${facts.cores}`);
  if (facts.memoryGB != null) lines.push(`Memory reported: about ${facts.memoryGB} GB`);
  if (photo) lines.push(`Photo: ${photo}`);
  if (gpuMs != null) lines.push(`Graphics time per camera view: ${formatDuration(gpuMs)}`);
  lines.push('', 'Stages (last, best, times run):');
  if (!rows.length) lines.push('  none yet');
  for (const r of rows) lines.push(`  ${r.name}: ${formatDuration(r.last)}, ${formatDuration(r.best)}, ${r.count}×${r.where ? `, on the ${r.where}` : ''}`);
  lines.push('', 'What limits it:');
  for (const l of speedLimits(facts, rows)) lines.push(`  - ${l.text}`);
  return lines.join('\n');
}
