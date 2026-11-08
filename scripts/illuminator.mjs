#!/usr/bin/env node
// Runs the command line from a source checkout: `npm run cli -- render photo.lfr -o photo.png` (see wiki/Command-Line.md). It starts Electron on this
// folder with --cli. On Linux without a display it uses xvfb-run when that is installed, and as root it adds --no-sandbox (Electron needs it there).
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = createRequire(import.meta.url)('electron');
let command = electron;
// The app writes its exit code to a file as well: some systems end Electron with a signal at shutdown, and the code would be lost.
const exitFile = path.join(os.tmpdir(), `illuminator-cli-${process.pid}.txt`);
let args = [root, '--cli', ...process.argv.slice(2), '--exit-file', exitFile];
if (process.platform === 'linux') {
  if (process.getuid && process.getuid() === 0) args = ['--no-sandbox', ...args];
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && spawnSync('which', ['xvfb-run']).status === 0) {
    args = ['-a', command, ...args];
    command = 'xvfb-run';
  }
}
const child = spawn(command, args, { stdio: 'inherit' });
child.on('exit', (code) => {
  let written = null;
  try {
    written = parseInt(fs.readFileSync(exitFile, 'utf8'), 10);
    fs.unlinkSync(exitFile);
  } catch {
    // not written: the command did not get as far as running
  }
  process.exit(Number.isInteger(written) ? written : code ?? 1);
});
