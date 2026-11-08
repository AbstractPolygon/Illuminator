// The command line: `Illuminator --cli <command> ...` (see wiki/Command-Line.md). It runs the app itself in a window nobody sees and drives it through the
// scripting interface (window.illuminator, app/js/ui/api.js), so a picture made here is the picture the app makes. The arguments are read by
// app/js/core/cliargs.js.

const path = require('node:path');
const fsp = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolves the exit code: 0 all went well, 1 a photo could not be made, 2 the command was not understood.
async function runCli(context) {
  // For scripts: the code in a file too, written as soon as it is known, before the page is closed (some systems end the process with a signal at shutdown, and the code would be lost).
  const at = context.args.findIndex((a) => a === '--exit-file' || a.startsWith('--exit-file='));
  const file = at < 0 ? null : context.args[at].includes('=') ? context.args[at].split('=').slice(1).join('=') : context.args[at + 1];
  const writeExit = (code) => {
    if (file) require('node:fs').writeFileSync(file, `${code}\n`);
  };
  const code = await runCliInner({ ...context, writeExit });
  writeExit(code);
  return code;
}

async function runCliInner({ args, BrowserWindow, allow, appDir, preload, version, writeExit }) {
  const { parseCli, USAGE, renderPlan, outputPath } = await import(pathToFileURL(path.join(appDir, 'js', 'core', 'cliargs.js')).href);
  const job = parseCli(args);
  const say = (text) => {
    if (!job.options.quiet) process.stderr.write(`${text}\n`);
  };
  if (job.errors.length) {
    for (const e of job.errors) process.stderr.write(`${e}\n`);
    process.stderr.write('Try: Illuminator --cli help\n');
    return 2;
  }
  if (job.command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (job.command === 'version') {
    process.stdout.write(`Illuminator ${version}\n`);
    return 0;
  }

  const win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 900,
    webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (event) => {
    // The page's errors reach the person who ran the command.
    const e = event.level === undefined ? event : event;
    if (e.level === 'error' || e.level === 3) process.stderr.write(`page: ${e.message}\n`);
  });
  const run = (code) => win.webContents.executeJavaScript(code, true);
  let exitCode = 1;
  try {
    await win.loadURL('app://lytro/index.html');
    for (let i = 0; i < 100 && (await run('typeof window.illuminator')) !== 'object'; i++) await delay(100);
    if ((await run('typeof window.illuminator')) !== 'object') throw new Error('The app did not start');

    if (job.command === 'controls') {
      process.stdout.write(`${JSON.stringify(await run('window.illuminator.controls()'), null, 2)}\n`);
      exitCode = 0;
      return 0;
    }

    const o = job.options;
    const timeoutMs = (o.timeout !== undefined ? +o.timeout : 1200) * 1000;
    let edits = null;
    if (o.edits) edits = JSON.parse(await fsp.readFile(o.edits, 'utf8'));
    const script = o.script ? await fsp.readFile(o.script, 'utf8') : null;
    const plan = job.command === 'render' ? renderPlan(job) : null;
    const wantFile = job.command === 'render' && !(script && !o.out && !o.format);
    let failed = 0;

    for (const photo of job.files) {
      const abs = path.resolve(photo);
      const started = Date.now();
      try {
        allow(abs);
        const code = `(async () => {
          const api = window.illuminator;
          const bytes = await window.lytroNative.readFile(${JSON.stringify(abs)});
          await api.open(${JSON.stringify(path.basename(abs))}, bytes, { edits: ${JSON.stringify(edits)} });
          if (${JSON.stringify(job.command)} === 'info') return { info: api.info() };
          const plan = ${JSON.stringify(plan)};
          if (Object.keys(plan.set).length) await api.set(plan.set);
          if (plan.camera) await api.camera(plan.camera);
          if (plan.fullSensor) await api.fullSensor(plan.fullSensor);
          let scripted;
          ${script ? `scripted = await (async (illuminator) => {\n${script}\n})(api);` : ''}
          const file = ${wantFile ? 'await api.export(plan.export)' : 'null'};
          return { file, scripted, info: api.info() };
        })()`;
        const result = await Promise.race([run(code), delay(timeoutMs).then(() => { throw new Error(`Gave up after ${timeoutMs / 1000} s (see --timeout)`); })]);
        if (job.command === 'info') {
          process.stdout.write(`${JSON.stringify(result.info, null, 2)}\n`);
          continue;
        }
        if (result.scripted !== undefined) process.stdout.write(`${JSON.stringify(result.scripted)}\n`);
        if (result.file) {
          const dest = outputPath(abs, o, { join: path.join, dirname: path.dirname, basename: path.basename, many: job.files.length > 1 });
          await fsp.mkdir(path.dirname(path.resolve(dest)), { recursive: true });
          await fsp.writeFile(dest, Buffer.from(result.file.bytes));
          say(`${photo} -> ${dest} (${(result.file.bytes.length / 1048576).toFixed(2)} MB, ${((Date.now() - started) / 1000).toFixed(1)} s)`);
        }
      } catch (err) {
        failed++;
        process.stderr.write(`${photo}: ${err && err.message ? err.message : err}\n`);
      }
    }
    exitCode = failed ? 1 : 0;
    return exitCode;
  } catch (err) {
    process.stderr.write(`${err && err.message ? err.message : err}\n`);
    exitCode = 1;
    return 1;
  } finally {
    writeExit(exitCode);
    // The page is closed and its processes given a moment to end before the app exits (exiting under them can crash on some systems).
    // Leaving the app's page first ends its workers cleanly.
    await win.loadURL('about:blank').catch(() => {});
    await delay(500);
    await new Promise((resolve) => {
      win.once('closed', resolve);
      win.close();
      setTimeout(resolve, 3000);
    });
    await delay(300);
  }
}

module.exports = { runCli };
