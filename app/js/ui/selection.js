// The library grid's selection: which photos are picked for a bulk action (delete). Plain logic, no page: main.js draws it.
export class Selection {
  constructor() {
    this.ids = new Set();
    this.anchor = null; // the photo a Shift-click range starts from
  }

  get size() {
    return this.ids.size;
  }

  has(id) {
    return this.ids.has(id);
  }

  // Adds the photo if it is not picked, takes it out if it is. It becomes the start of the next range.
  toggle(id) {
    if (this.ids.has(id)) this.ids.delete(id);
    else this.ids.add(id);
    this.anchor = id;
  }

  // Picks every photo from the anchor to `id` in `order` (the photos as the grid shows them), on top of what is picked. Without an anchor it picks just `id`.
  range(order, id) {
    const to = order.indexOf(id);
    const from = this.anchor == null ? -1 : order.indexOf(this.anchor);
    if (to < 0) return;
    if (from < 0) {
      this.ids.add(id);
    } else {
      const [a, b] = from <= to ? [from, to] : [to, from];
      for (let i = a; i <= b; i++) this.ids.add(order[i]);
    }
    this.anchor = id;
  }

  selectAll(order) {
    this.ids = new Set(order);
    this.anchor = order.length ? order[order.length - 1] : null;
  }

  clear() {
    this.ids.clear();
    this.anchor = null;
  }

  // Forgets photos that are no longer shown (deleted, or another album).
  keepOnly(order) {
    const shown = new Set(order);
    for (const id of [...this.ids]) if (!shown.has(id)) this.ids.delete(id);
    if (this.anchor != null && !shown.has(this.anchor)) this.anchor = null;
  }
}
