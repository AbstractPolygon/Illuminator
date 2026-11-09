// Runs the camera scan one at a time with exactly one timer armed. A scan
// asked for while another is running is queued as one more scan after it, so
// overlapping requests (a plug-in event, the page listing cameras) never start
// a second polling chain or scan the same device twice at once.

function createScanner({ scan, nextDelay, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let running = null;
  let again = false;
  let timer = null;

  async function loop() {
    try {
      do {
        again = false;
        clearTimer(timer);
        timer = null;
        await scan();
      } while (again);
    } finally {
      // Same tick as the last `again` check: a request cannot slip in between.
      running = null;
      clearTimer(timer);
      timer = setTimer(() => { timer = null; request(); }, nextDelay());
    }
  }

  // Resolves when the scan this request led to (or was merged into) is done.
  function request() {
    if (running) {
      again = true;
      return running;
    }
    running = loop().catch(() => {});
    return running;
  }

  return { request, isRunning: () => !!running, hasTimer: () => timer !== null };
}

module.exports = { createScanner };
