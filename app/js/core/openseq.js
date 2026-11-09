// Open-photo sequencing. Every open (a library photo, a dropped file, a script) takes the next number; work that belongs to an earlier number is stale and must not touch what
// is on show now. The page and the worker each keep one of these, and the worker echoes the number it was sent on its cache messages.

// The page side. `next()` starts an open, `current()` is the newest number, `isStale(n)` is for a message that carries a number (a missing one is accepted) and
// `superseded(n)` is for a continuation that must stop as soon as any other open began.
export function createOpenSequencer() {
  let seq = 0;
  let restoring = 0;
  return {
    next: () => ++seq,
    current: () => seq,
    isStale: (n) => n != null && n < seq,
    superseded: (n) => n !== seq,
    // A count, not a flag: two overlapping restores must not end each other's restoring, and a stray extra end() must not push it below zero.
    beginRestore: () => ++restoring,
    endRestore: () => (restoring = Math.max(0, restoring - 1)),
    restoring: () => restoring,
  };
}

// The worker side: an open older than one already received is refused, and an open overtaken while it waits stops at its next check. `message` is the error text.
export function createStaleGuard(message) {
  let newest = -1;
  let token = 0;
  return {
    // Throws for an old request; otherwise returns the open's own checks.
    begin(seq = null) {
      if (seq != null) {
        if (seq < newest) throw new Error(message);
        newest = seq;
      }
      const mine = ++token;
      const superseded = () => mine !== token || (seq != null && seq < newest);
      return {
        superseded,
        check() {
          if (superseded()) throw new Error(message);
        },
      };
    },
    newest: () => newest,
  };
}
