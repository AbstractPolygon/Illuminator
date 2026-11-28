// speed report: moved out of main.js. initSpeedReport() runs where the section used to, with what it uses from the rest of the page.
import { Timings, formatDuration, speedLimits, reportText } from '../core/speedreport.js';
import { VERSION } from '../version.js';
import { benchmarkText, speedup, runBenchmark } from '../core/benchmark.js';
import { Engine } from '../engine.js';

export function initSpeedReport({ engine, $, state, previewMirror, cameraParams, showNotice, fmt, renderInfo }) {

  // The Info panel's Speed block: how long each stage took on this computer (timed in the worker, engine.onTiming) and what limits it.
  const timings = new Timings();
  let speedQueued = false;
  engine.onTiming = (msg) => {
    timings.record(msg.stage, msg.ms, msg.where);
    scheduleSpeed();
  };

  // At most about once a second, and only while the Info panel is open.
  function scheduleSpeed() {
    if (speedQueued || !$('info').closest('details').open) return;
    speedQueued = true;
    setTimeout(() => {
      speedQueued = false;
      renderSpeed();
    }, 800);
  }

  async function renderSpeed() {
    const box = $('speed');
    box.hidden = !state.info;
    if (!state.info) return;
    try {
      state.speedFacts = await engine.request('speedFacts', {});
    } catch {
      // The report is only a guide: what it knew last time stays.
    }
    const facts = state.speedFacts || { renderer: 'CPU' };
    const rows = timings.rows();
    const dl = $('speed-stages');
    const cells = rows.length ? rows.map((r) => [r.name, `${formatDuration(r.last)}${r.count > 1 ? ` (best ${formatDuration(r.best)})` : ''}`]) : [['No timings yet', 'they appear as you work']];
    if (state.gpuMs != null) cells.push(['Graphics, per view', formatDuration(state.gpuMs)]);
    dl.replaceChildren(...cells.flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      return [dt, dd];
    }));
    $('speed-limits').replaceChildren(...speedLimits(facts, rows).map((l) => {
      const li = document.createElement('li');
      li.className = l.level;
      li.textContent = l.text;
      return li;
    }));
  }

  $('info').closest('details').addEventListener('toggle', () => {
    if ($('info').closest('details').open) renderSpeed();
  });

  function speedReportText() {
    return reportText({
      version: VERSION,
      platform: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      facts: state.speedFacts || { renderer: 'CPU' },
      rows: timings.rows(),
      gpuMs: state.gpuMs,
      photo: state.current ? state.current.name : '',
      benchmark: benchmarkText(benchResult, formatDuration),
    });
  }

  // The benchmark (core/benchmark.js): the open photo timed again in two workers of its own, on the graphics card and on the processor.
  let benchResult = null;
  let benchRunning = false;
  function showBenchmark(note = '') {
    const dl = $('speed-bench');
    const rows = benchResult ? benchResult.rows : [];
    const cells = [['Benchmark', note || 'graphics card / processor'], ...rows.map((r) => [r.name, `${formatDuration(r.card ?? NaN)} / ${formatDuration(r.processor ?? NaN)}${speedup(r) ? `, ${speedup(r)}` : ''}`])];
    for (const [mode, e] of Object.entries((benchResult && benchResult.errors) || {})) if (e) cells.push([mode === 'card' ? 'Graphics card run' : 'Processor run', `stopped: ${e}`]);
    dl.replaceChildren(...cells.flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      return [dt, dd];
    }));
    dl.hidden = false;
  }
  $('speed-bench-run').onclick = async () => {
    const photo = previewMirror.photoCopy();
    if (benchRunning || !photo || !state.info) return;
    benchRunning = true;
    const button = $('speed-bench-run');
    button.disabled = true;
    button.textContent = 'Running benchmark…';
    benchResult = null;
    showBenchmark('starting');
    try {
      benchResult = await runBenchmark((cpu) => new Engine({ cpu }), photo, cameraParams({ live: true }), (step) => showBenchmark(step));
      showBenchmark();
    } catch (err) {
      showBenchmark(`stopped: ${String((err && err.message) || err).slice(0, 120)}`);
    } finally {
      benchRunning = false;
      button.disabled = false;
      button.textContent = 'Run benchmark';
    }
  };

  $('speed-copy').onclick = async () => {
    const text = speedReportText();
    try {
      await navigator.clipboard.writeText(text);
      showNotice('Speed report copied', 'Paste it into a message.');
    } catch {
      showNotice('Speed report', text);
    }
  };

  // GPU time of a recent camera view (measured where the browser allows it).
  function gpuTimeText() {
    return `${state.gpuMs < 10 ? fmt(state.gpuMs, 1) : Math.round(state.gpuMs)} ms per view`;
  }

  function showGpuTime(ms) {
    const first = state.gpuMs == null;
    state.gpuMs = ms;
    if (first) {
      if (state.info) renderInfo();
      return;
    }
    const dd = [...$('info').querySelectorAll('dt')].find((dt) => dt.textContent === 'GPU time');
    if (dd) dd.nextElementSibling.textContent = gpuTimeText();
  }

  function renderGridInfo() {
    const info = state.info;
    if (!info || !info.grid) return;
    const g = info.grid;
    $('grid-info').textContent = `Pitch ${fmt(g.pitch, 3)} px, row step ${fmt(g.rowStep, 3)} px, rotation ${fmt(g.rotation * 1000, 3)} mrad, ` +
      `center (${fmt(g.ox, 2)}, ${fmt(g.oy, 2)}). Alignment score ${fmt(info.gridQuality, 3)}.`;
  }

  // The Camera and Lenslets buttons take the Render Queue view back to the photo (opening a photo from the library does not).
  for (const b of document.querySelectorAll('#modes button')) b.addEventListener('click', () => state.queueUi && state.queueUi.setView(false), true);
  return { timings, scheduleSpeed, speedReportText, gpuTimeText, showGpuTime, renderGridInfo };
}
