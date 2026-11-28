// The speed report's benchmark (Info > Speed > Run benchmark): the photo that is open is opened again in two fresh workers, one with the graphics card and one on the
// processor only, and the same steps are timed in each (opening, measuring the depth, the camera view at the current settings). It shows on this computer what the card
// gains, stage by stage, and goes into the copied speed report. The page's own worker is not touched, so what is on screen stays as it is.

export const BENCH_STEPS = [
  { key: 'open', name: 'Opening the photo' },
  { key: 'depth', name: 'Measuring depth' },
  { key: 'view', name: 'Camera view' },
  { key: 'view2', name: 'Camera view, again' },
];

// Runs the benchmark. makeEngine(cpu) gives a fresh Engine (cpu: processor only); photo = { bytes: () => Promise<ArrayBuffer>, open (the open request's other
// arguments), after: [[type, args]] (the requests that set up the worker after opening, in order) }; view = the view request's arguments; onStep(text) tells the page
// where it is. Returns { rows: [{ name, card, processor }] (ms, or null where a step failed), errors: { card, processor } }.
export async function runBenchmark(makeEngine, photo, view, onStep = () => {}) {
  const times = { card: {}, processor: {} };
  const errors = { card: null, processor: null };
  for (const mode of ['card', 'processor']) {
    const e = makeEngine(mode === 'processor');
    const timed = async (key, label, fn) => {
      onStep(`${label} (${mode === 'card' ? 'graphics card' : 'processor'})`);
      const t0 = performance.now();
      await fn();
      times[mode][key] = performance.now() - t0;
    };
    try {
      const bytes = await photo.bytes();
      let info = null;
      await timed('open', 'Opening', async () => {
        // (without what is kept with the photo, so the depth is really measured; the page's caches are not written: these engines have no onCache)
        info = await e.request('open', { ...photo.open, depthCache: null, l16Cache: null, ...(bytes ? { bytes } : {}) }, { transfer: bytes ? [bytes] : [] });
        for (const [type, args] of photo.after) await e.request(type, args);
        if (info && info.hasRaw) await e.request('prepare').catch(() => {});
      });
      await timed('depth', 'Measuring depth', () => e.request('depthMap', {}));
      await timed('view', 'Camera view', () => e.request('view', { ...view, final: true }));
      // (the same view a second time: what is kept between views is used)
      await timed('view2', 'Camera view', () => e.request('view', { ...view, final: true }));
    } catch (err) {
      errors[mode] = String((err && err.message) || err).slice(0, 160);
    } finally {
      if (e.worker) {
        try {
          e.worker.terminate();
        } catch {
          // already gone
        }
        e.worker = null;
      }
    }
  }
  const rows = BENCH_STEPS.map(({ key, name }) => ({ name, card: times.card[key] ?? null, processor: times.processor[key] ?? null }));
  return { rows, errors };
}

// How many times faster the card was (processor / card), as text; '' when either is missing.
export function speedup(row) {
  if (!(row.card > 0) || !(row.processor > 0)) return '';
  const r = row.processor / row.card;
  return r >= 1 ? `${r.toFixed(r < 10 ? 1 : 0)}x faster on the card` : `${(1 / r).toFixed(1 / r < 10 ? 1 : 0)}x slower on the card`;
}

// The benchmark as lines of text for the copied speed report (formatDuration from core/speedreport.js).
export function benchmarkText(result, formatDuration) {
  if (!result) return [];
  const lines = ['Benchmark (the open photo, graphics card / processor):'];
  for (const r of result.rows) lines.push(`  ${r.name}: ${formatDuration(r.card ?? NaN)} / ${formatDuration(r.processor ?? NaN)}${speedup(r) ? ` (${speedup(r)})` : ''}`);
  for (const [mode, e] of Object.entries(result.errors)) if (e) lines.push(`  The ${mode === 'card' ? 'graphics card' : 'processor'} run stopped: ${e}`);
  return lines;
}
