// Large files that some hosts cannot serve whole. The hosted test page (an Artifact page) takes files of at most about 16 MB, so its copy of the app keeps the built in
// depth model (99 MB) and the machine-learning runtime's wasm file (22 MB) split into parts: `name.part0.wasm`, `name.part1.wasm`, ... (named .wasm only because the host serves that type unchanged) and `name.parts.json` ({ count, size }),
// made by scripts/pages/sync-test-page.mjs. Everywhere else (the desktop app, the web version) the whole file is there and read at once.

// The file at `url` as bytes: whole, or put back together from its parts. Throws when neither is there.
export async function fetchBig(url) {
  let whole = null;
  try {
    whole = await fetch(url);
  } catch {
    whole = null;
  }
  if (whole && whole.ok) return new Uint8Array(await whole.arrayBuffer());
  let list = null;
  try {
    const res = await fetch(`${url}.parts.json`);
    list = res.ok ? await res.json() : null;
  } catch {
    list = null;
  }
  if (!list || !(list.count > 0)) throw new Error(`Could not read ${url.split('/').pop()} from the app (${whole ? whole.status : 'not reachable'}).`);
  const parts = await Promise.all(Array.from({ length: list.count }, async (_, i) => {
    const res = await fetch(`${url}.part${i}.wasm`);
    if (!res.ok) throw new Error(`Could not read part ${i + 1} of ${url.split('/').pop()} (${res.status}).`);
    return new Uint8Array(await res.arrayBuffer());
  }));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  if (list.size && out.length !== list.size) throw new Error(`${url.split('/').pop()} did not come back whole (${out.length} of ${list.size} bytes).`);
  return out;
}
