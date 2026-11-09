'use strict';
// Files handed to the app by the system (double click on a .lfr/.lfp, "Open with", drag onto the icon): macOS sends
// them as open-file events, Windows and Linux as arguments of the process, or of a second one that the single instance
// lock turns into a 'second-instance' event. They go to the page as 'open-paths', the same { path, name, size }
// records the Open dialog returns; paths that arrive before the page has loaded wait in the queue.

function createOpenQueue({ describe, allow, getWindow, createWindow, isReady, cliMode = false, lytroPathsFrom }) {
  let pending = [];

  function flush() {
    const w = getWindow();
    if (!w || w.webContents.isLoading() || !pending.length) return Promise.resolve();
    const batch = pending;
    pending = [];
    return Promise.all(batch.map(async (file) => {
      try {
        const found = await describe(file);
        allow(file);
        return found;
      } catch {
        return null; // gone or unreadable
      }
    })).then((files) => {
      const ok = files.filter(Boolean);
      const target = getWindow();
      if (ok.length && target) {
        target.webContents.send('open-paths', ok);
        if (target.isMinimized()) target.restore();
        target.focus();
      }
    });
  }

  function open(paths) {
    pending.push(...paths);
    // macOS keeps the app running with no window; a file opened then needs one.
    if (paths.length && isReady() && !getWindow() && !cliMode) createWindow();
    return flush();
  }

  return {
    flush,
    open,
    size: () => pending.length,
    // The process arguments: argv[0] is the executable (and, unpackaged, the app folder), only files named after it count.
    fromArgv: (argv, cwd) => open(lytroPathsFrom(argv, cwd)),
    fromOpenFileEvent: (event, file) => {
      event.preventDefault();
      return open(lytroPathsFrom([file]));
    },
    // A second launch: the running window comes forward, then its files are opened.
    fromSecondInstance: (argv, cwd) => {
      const w = getWindow();
      if (w) {
        if (w.isMinimized()) w.restore();
        w.focus();
      }
      return open(lytroPathsFrom(argv.slice(1), cwd));
    },
  };
}

module.exports = { createOpenQueue };
