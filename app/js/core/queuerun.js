// Running one job of the render queue (ui/queue.js pump). The job list and its status rules are in core/renderqueue.js; this is the part between them and the hidden copy of the
// app that does the work: cancel ends the wait at once, but the work itself runs on until it ends, so nothing it finishes afterwards may count.

// Called by a job's runner right before it saves its output: a job cancelled (or otherwise no longer running) meanwhile throws, so a cancelled job writes no file.
export function assertRunning(job) {
  if (job.status !== 'running') throw new Error('Cancelled');
}

// Starts the next waiting job and runs it with `run(job)`. `setAbort(fn | null)` hands the caller the function that stops the wait (the cancel button calls it) and clears it
// when the job is over. Returns { job, failed, cancelled } or null when nothing may start.
export async function runNext(queue, run, setAbort = () => {}) {
  const job = queue.next();
  if (!job) return null;
  queue.start(job);
  const stopped = new Promise((_, reject) => {
    setAbort(() => reject(new Error('Cancelled')));
  });
  // The race loser must not become an unhandled rejection when the job ends first.
  stopped.catch(() => {});
  try {
    const output = await Promise.race([run(job), stopped]);
    queue.finish(job, output);
  } catch (err) {
    // A job cancelled while it ran is already marked; only a still running job has failed.
    if (job.status === 'running') queue.fail(job, err);
  } finally {
    setAbort(null);
  }
  return { job, failed: job.status === 'failed', cancelled: job.status === 'cancelled' };
}
