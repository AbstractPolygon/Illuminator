// Opens a photo in the app's real worker (app/js/worker.js) inside the page gpuPage gives, and collects what the worker hands the page to keep with the photo (the
// 'cache' and 'l16Cache' messages) and the camera view once the depth is measured. For the tests that compare those numbers with recorded ones
// (cache-results.test.mjs, real-photos.test.mjs).
//
//   const out = await openInWorker(page, { synthetic: { width: 1600, height: 1200 } });   // or { url: '/photos/<name>' } (gpuPage's `photos` folder)
//   out = { info, caches: [cache, ...], l16Cache: { key, depth, wide } | null, view: { width, height, rgba: number[] (sampled) } | null }
export async function openInWorker(page, { synthetic = null, url = null, settle = 2500, view = true } = {}) {
  return page.evaluate(
    async ({ synthetic, url, settle, view }) => {
      const w = new globalThis.Worker('/js/worker.js', { type: 'module' });
      let n = 0;
      const waits = new Map();
      const caches = [];
      let l16Bytes = null;
      let last = performance.now();
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'result' || m.type === 'error') {
          const f = waits.get(m.id);
          if (f) f(m);
          return;
        }
        if (m.type === 'cache') caches.push(m.cache);
        if (m.type === 'l16Cache') l16Bytes = new Uint8Array(m.bytes);
        if (m.type !== 'progress' && m.type !== 'timing') last = performance.now();
      };
      const req = (type, args = {}, transfer = []) =>
        new Promise((res, rej) => {
          const id = ++n;
          waits.set(id, (m) => (m.type === 'error' ? rej(new Error(`${type}: ${m.message}`)) : res(m)));
          w.postMessage({ type, id, ...args }, transfer);
        });
      // (until the worker has been quiet for `settle` ms: the depth and the caches arrive after the open's answer)
      const quiet = async () => {
        while (performance.now() - last < settle) await new Promise((r) => setTimeout(r, 200));
      };
      const args = synthetic ? { synthetic } : {};
      if (url) {
        const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
        args.bytes = bytes;
      }
      const opened = await req('open', args, args.bytes ? [args.bytes.buffer] : []);
      const info = opened.result;
      await req('depthMap', {});
      await quiet();
      // the camera view at the photo's starting settings (center, focus where it opened), as 64 x 48 samples of RGBA
      let shot = null;
      if (view) {
        const v = await req('view', { u: 0, v: 0, alpha: info.settings && Number.isFinite(info.settings.alpha) ? info.settings.alpha : 0, final: true });
        const r = v.result || v;
        let width = r.width || (r.bitmap && r.bitmap.width);
        let height = r.height || (r.bitmap && r.bitmap.height);
        let px = null;
        if (r.bitmap) {
          const c = new OffscreenCanvas(width, height);
          const g = c.getContext('2d');
          g.drawImage(r.bitmap, 0, 0);
          px = g.getImageData(0, 0, width, height).data;
        } else if (r.pixels) px = new Uint8ClampedArray(r.pixels);
        if (px && width && height) {
          const SW = 64;
          const SH = 48;
          const rgba = [];
          for (let y = 0; y < SH; y++) {
            for (let x = 0; x < SW; x++) {
              // (the mean of each sample's block)
              const x0 = Math.floor((x * width) / SW);
              const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / SW));
              const y0 = Math.floor((y * height) / SH);
              const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / SH));
              const s = [0, 0, 0, 0];
              for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) for (let k = 0; k < 4; k++) s[k] += px[4 * (yy * width + xx) + k];
              const a = (x1 - x0) * (y1 - y0);
              rgba.push(...s.map((q) => q / a));
            }
          }
          shot = { width, height, rgba };
        }
        if (r.bitmap && r.bitmap.close) r.bitmap.close();
      }
      let l16Cache = null;
      if (l16Bytes) {
        const { decodeL16Cache } = await import('/js/core/l16-cache.js');
        const c = decodeL16Cache(l16Bytes);
        if (c) l16Cache = { key: c.key, depth: { width: c.depth.width, height: c.depth.height, invZ: Array.from(c.depth.invZ), confidence: Array.from(c.depth.confidence) }, wide: { width: c.wide.width, height: c.wide.height, rgb: Array.from(c.wide.rgb) } };
      }
      w.terminate();
      // (typed arrays as plain arrays: they cross into the test as JSON)
      const plain = (c) => ({
        key: c.key,
        w: c.w,
        h: c.h,
        alpha: Array.from(c.alpha || []),
        open: c.open || null,
        lens: c.lens ? { dx: Array.from(c.lens.dx), dy: Array.from(c.lens.dy), key: c.lens.key } : null,
        extra: (c.extra || []).map((e) => ({ key: e.key, w: e.w, h: e.h, alpha: Array.from(e.alpha), confidence: Array.from(e.confidence) })),
      });
      return { info: { photoId: info.photoId, width: info.width, height: info.height, renderer: info.renderer }, caches: caches.map(plain), l16Cache, view: shot };
    },
    { synthetic, url, settle, view },
  );
}

// A short description of a list of numbers that survives small differences between machines: its size, mean, spread, range and the means of `parts` equal parts (or
// of a grid of blocks when the width and height are given), each rounded to 5 significant digits.
export function fingerprint(values, width = 0, height = 0, parts = 48) {
  const n = values.length;
  const r = (x) => (Number.isFinite(x) ? Number(x.toPrecision(5)) : null);
  if (!n) return { n: 0 };
  let s = 0;
  let s2 = 0;
  let lo = Infinity;
  let hi = -Infinity;
  let bad = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) {
      bad++;
      continue;
    }
    s += v;
    s2 += v * v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const m = s / Math.max(1, n - bad);
  const blocks = [];
  const ch = width && height && width * height === n ? 1 : width && height && n % (width * height) === 0 ? n / (width * height) : 0;
  if (ch) {
    // a grid of 8 x 6 blocks, every channel
    const GX = 8;
    const GY = 6;
    for (let by = 0; by < GY; by++) {
      for (let bx = 0; bx < GX; bx++) {
        for (let k = 0; k < ch; k++) {
          let t = 0;
          let c = 0;
          for (let y = Math.floor((by * height) / GY); y < Math.floor(((by + 1) * height) / GY); y++) {
            for (let x = Math.floor((bx * width) / GX); x < Math.floor(((bx + 1) * width) / GX); x++) {
              const v = values[(y * width + x) * ch + k];
              if (Number.isFinite(v)) {
                t += v;
                c++;
              }
            }
          }
          blocks.push(r(c ? t / c : NaN));
        }
      }
    }
  } else {
    for (let p = 0; p < parts; p++) {
      let t = 0;
      let c = 0;
      for (let i = Math.floor((p * n) / parts); i < Math.floor(((p + 1) * n) / parts); i++) {
        if (Number.isFinite(values[i])) {
          t += values[i];
          c++;
        }
      }
      blocks.push(r(c ? t / c : NaN));
    }
  }
  return { n, bad, mean: r(m), sd: r(Math.sqrt(Math.max(0, s2 / Math.max(1, n - bad) - m * m))), min: r(lo), max: r(hi), blocks };
}

// The differences between two fingerprints larger than `tol` times the recorded range (plus a little), as readable lines; [] when they agree.
export function compareFingerprints(name, want, got, tol = 0.004) {
  if (!want || !got) return want === got ? [] : [`${name}: ${want ? 'missing now' : 'new'}`];
  if (want.n !== got.n) return [`${name}: ${want.n} values recorded, ${got.n} now`];
  if (!want.n) return [];
  if ((want.bad || 0) !== (got.bad || 0)) return [`${name}: ${want.bad || 0} values not finite when recorded, ${got.bad || 0} now`];
  const range = Math.max(Math.abs(want.max - want.min), Math.abs(want.mean) * 1e-3, 1e-6);
  const lim = tol * range;
  const out = [];
  for (const k of ['mean', 'sd', 'min', 'max']) if (Math.abs(want[k] - got[k]) > lim) out.push(`${name}.${k}: ${want[k]} recorded, ${got[k]} now`);
  let worst = 0;
  let at = -1;
  for (let i = 0; i < want.blocks.length; i++) {
    const a = want.blocks[i];
    const b = got.blocks[i];
    const d = a === null || b === null ? (a === b ? 0 : Infinity) : Math.abs(a - b);
    if (d > worst) {
      worst = d;
      at = i;
    }
  }
  if (worst > lim) out.push(`${name}: part ${at} is ${got.blocks[at]} now, ${want.blocks[at]} recorded (the parts may differ by ${lim.toPrecision(3)})`);
  return out;
}
