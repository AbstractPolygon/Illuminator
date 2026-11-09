// A long job in the worker (a render, a depth measurement, a view build) reads the photo's state once, awaits for seconds, and must then find out whether another photo was
// opened meanwhile. The guard remembers what the job started with and compares it against the live value, so each site says "stale()" instead of repeating the comparison.

// `read` returns the live value (for example `() => state.sampler`); the value at the time of the call is the job's.
export function makeJobGuard(read) {
  const held = read();
  return {
    stale: () => read() !== held,
    current: () => read() === held,
    // For jobs that end by throwing rather than returning a cancelled marker.
    throwIfStale: (message = 'The photo changed while this was running.') => {
      if (read() !== held) throw new Error(message);
    },
  };
}
