// Keeps the Render Queue's list of job cards up to date without rebuilding it. A running job reports progress many times a second; a list rebuilt each time replaces the Cancel
// button under the pointer between the mouse going down and coming up, and the click is lost. Here a card stays the same element for as long as its job is in the list: only its
// numbers and text change, its buttons are replaced only when the set of buttons changes (a job starting, ending or being cancelled), and the list is touched only when the order does.

// `cards` maps a job id to its card. `build(job)` returns { el, update(job) }: the card's element, and a function that refreshes it from the job (called on every sync; it
// decides itself what to leave alone, such as buttons that are already right).
export function syncCards(list, jobs, cards, build) {
  const wanted = [];
  for (const job of jobs) {
    let card = cards.get(job.id);
    if (!card) {
      card = build(job);
      cards.set(job.id, card);
    }
    card.update(job);
    wanted.push(card.el);
  }
  pruneCards(cards, jobs);
  // Only a change of order (or a new or removed card) touches the list; a card that is already in its place is left alone.
  const have = Array.from(list.children);
  if (have.length !== wanted.length || wanted.some((el, i) => have[i] !== el)) {
    wanted.forEach((el, i) => {
      if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null);
    });
  }
}

// Drops the cards of jobs no longer in the list (removed or cleared), so they do not stay in memory while the queue view is closed and the list is not drawn.
export function pruneCards(cards, jobs) {
  const ids = new Set(jobs.map((j) => j.id));
  for (const [id, card] of cards) {
    if (!ids.has(id)) {
      card.el.remove();
      cards.delete(id);
    }
  }
}
