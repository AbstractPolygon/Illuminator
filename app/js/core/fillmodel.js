// AI fill for viewpoints past the lens edge (Camera > Perspective > Fill with AI): where a viewpoint moved on by the depth uncovers what no view of the photo saw (behind
// near objects, and at the picture's border), MI-GAN (Picsart AI Research, MIT license; "MI-GAN: A Simple Baseline for Image Inpainting on Mobile Devices", ICCV 2023)
// paints it from the picture around it, instead of the quick fill's stretched background. Its ONNX pipeline takes the whole picture and the mask (any size; it works on
// a 512 x 512 square around the area itself) and returns the picture with the area painted. Run with ONNX Runtime Web (vendored in app/vendor/ort), on the graphics card
// where WebGPU is, else on the processor (about 2 s for a 700 x 480 picture).
//
// The model is not part of the app's download: it is fetched when its box in Settings > Fill model is ticked, from the pinned revision of the repository that publishes it
// (Hugging Face, by the paper's first author), checked against its size and SHA-256, and kept in the browser's cache until the box is unticked.

import { sha256Hex } from './upscalemodels.js';
import { aiUpscaleAvailable } from './aiupscale.js';

const CACHE = 'illuminator-fill-models-v1';

export const FILL_MODEL = {
  id: 'migan',
  name: 'MI-GAN',
  note: 'fills what no view saw, MIT',
  url: 'https://huggingface.co/andraniksargsyan/migan/resolve/406830d0fa60666da0071c342ad2fbc8f30c5c64/migan_pipeline_v2.onnx',
  size: 28079181,
  sha256: '6f1f3530a1a2324b19752018ce756088b07973cda8d7d890034ace5c8a48c40b',
};

async function openCache() {
  try {
    return typeof caches !== 'undefined' ? await caches.open(CACHE) : null;
  } catch {
    return null;
  }
}

// 'none' (not downloaded), 'ready', or 'stale' (a file with another hash is kept).
export async function fillModelState(model = FILL_MODEL) {
  const cache = await openCache();
  const hit = cache && (await cache.match(model.url));
  if (!hit) return 'none';
  return hit.headers.get('x-sha256') === model.sha256 ? 'ready' : 'stale';
}

export async function removeFillModel(model = FILL_MODEL) {
  await releaseFillSession();
  const cache = await openCache();
  if (cache) await cache.delete(model.url);
}

// Downloads the model (`onProgress(0..1)`), checks it and keeps it. Throws when it cannot be downloaded or is not the file expected; nothing is kept then.
export async function downloadFillModel(onProgress = () => {}, model = FILL_MODEL) {
  const cache = await openCache();
  if (!cache) throw new Error('This browser cannot keep downloaded models.');
  const res = await fetch(model.url);
  if (!res.ok) throw new Error(`Could not download ${model.name}: ${res.status}`);
  const total = +res.headers.get('content-length') || model.size;
  const parts = [];
  let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    onProgress(Math.min(1, got / total));
  }
  const bytes = new Uint8Array(got);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  if (bytes.length !== model.size || (await sha256Hex(bytes)) !== model.sha256) throw new Error(`${model.name} did not download correctly. Try again.`);
  await cache.put(model.url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'x-sha256': model.sha256 } }));
}

async function readFillModel(model = FILL_MODEL) {
  const cache = await openCache();
  const hit = cache && (await cache.match(model.url));
  if (!hit || hit.headers.get('x-sha256') !== model.sha256) throw new Error(`${model.name} is not downloaded (Settings > Fill model).`);
  return new Uint8Array(await hit.arrayBuffer());
}

let pending = null;
async function session() {
  if (!pending) {
    pending = (async () => {
      const ort = await import('../../vendor/ort/ort.webgpu.min.mjs');
      ort.env.wasm.wasmPaths = new URL('../../vendor/ort/', import.meta.url).href;
      ort.env.wasm.numThreads = 1;
      const bytes = await readFillModel();
      let s = null;
      if (await aiUpscaleAvailable()) {
        try {
          s = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'] });
        } catch {
          s = null;
        }
      }
      s ??= await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
      return { ort, session: s };
    })().catch((e) => {
      pending = null;
      throw e;
    });
  }
  return pending;
}

// Frees the model's session (its weights, or the graphics card's buffers).
export async function releaseFillSession() {
  const p = pending;
  pending = null;
  try {
    const entry = await p;
    if (entry && typeof entry.session?.release === 'function') await entry.session.release();
  } catch {
    // nothing to release
  }
}

// The mask grown by `grow` pixels (a square), so the fill also takes the stretched border pixels around each area: 1 = fill.
export function growMask(holes, w, h, grow = 2) {
  if (!(grow > 0)) return holes;
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = 0;
      for (let i = Math.max(0, x - grow), e = Math.min(w - 1, x + grow); i <= e && !on; i++) on = holes[y * w + i];
      tmp[y * w + x] = on ? 1 : 0;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let on = 0;
      for (let j = Math.max(0, y - grow), e = Math.min(h - 1, y + grow); j <= e && !on; j++) on = tmp[j * w + x];
      out[y * w + x] = on;
    }
  }
  return out;
}

// The model's inputs from an RGBA picture and a mask (1 = fill): the picture as planar RGB bytes, as it is (the pipeline blends what is in the area into its edges:
// blacked out, the fills came back dark-rimmed; left as the quick fill made them, clean), and the mask the model wants (0 = fill, 255 = keep).
export function fillInputs(rgba, holes, w, h) {
  const n = w * h;
  const image = new Uint8Array(3 * n);
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    mask[i] = holes[i] ? 0 : 255;
    image[i] = rgba[i * 4];
    image[n + i] = rgba[i * 4 + 1];
    image[2 * n + i] = rgba[i * 4 + 2];
  }
  return { image, mask };
}

// The picture with the filled area from the model's planar RGB result; the rest stays exactly as it was.
export function fillOutput(rgba, result, holes, w, h) {
  const n = w * h;
  const out = new Uint8ClampedArray(rgba);
  for (let i = 0; i < n; i++) {
    if (!holes[i]) continue;
    out[i * 4] = result[i];
    out[i * 4 + 1] = result[n + i];
    out[i * 4 + 2] = result[2 * n + i];
    out[i * 4 + 3] = 255;
  }
  return out;
}

// Whether a mask has anything to fill.
export const hasHoles = (holes) => !!holes && holes.some((v) => v);

// Fills the masked area of a picture (ImageData, or anything drawable with width and height, such as an ImageBitmap) with the model. Returns ImageData of the same size.
export async function fillPicture(img, holes, { grow = 2 } = {}) {
  const w = img.width;
  const h = img.height;
  let data;
  if (typeof ImageData !== 'undefined' && img instanceof ImageData) data = img;
  else {
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    data = g.getImageData(0, 0, w, h);
  }
  if (!hasHoles(holes) || holes.length !== w * h) return data;
  const mask = growMask(holes, w, h, grow);
  const { ort, session: s } = await session();
  const { image, mask: m } = fillInputs(data.data, mask, w, h);
  const r = await s.run({ image: new ort.Tensor('uint8', image, [1, 3, h, w]), mask: new ort.Tensor('uint8', m, [1, 1, h, w]) });
  const result = r[s.outputNames[0]];
  if (!result || result.dims[2] !== h || result.dims[3] !== w) throw new Error('The fill model returned a picture of another size.');
  return new ImageData(fillOutput(data.data, result.data, mask, w, h), w, h);
}
