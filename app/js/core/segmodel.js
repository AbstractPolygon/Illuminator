// Object identification with MobileSAM (MIT license), run with ONNX Runtime
// Web (vendored in app/vendor/ort, with WebGPU). The two model files (about 45 MB) are
// downloaded once, when the setting is first turned on, and kept in the
// browser's cache. Used for depth edges (core/objects.js, core/segments.js).

import { nthSmallest } from './typed.js';

import { sha256Hex } from './upscalemodels.js';

// Pinned to one commit (not the mutable main branch) and checked against the SHA-256 and size of each file, as core/depthmodels.js does.
export const MODEL_REVISION = '0d3b403339b4674a82493d5e97964dd78089ddc8';
const MODEL_BASE = `https://huggingface.co/Acly/MobileSAM/resolve/${MODEL_REVISION}/`;
export const SEG_FILES = { encoder: 'mobile_sam_image_encoder.onnx', decoder: 'sam_mask_decoder_single.onnx' };
export const SEG_HASHES = {
  'mobile_sam_image_encoder.onnx': { size: 28157093, sha256: '580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749' },
  'sam_mask_decoder_single.onnx': { size: 16501323, sha256: '93915fc7c993ab9d59ab8c9ccd3bce37f7509c81ab4150a74abd4d2abbd8570d' },
};
const CACHE = 'illuminator-models-v1';

let loading = null;

async function hasWebGpu() {
  try {
    return !!(typeof navigator !== 'undefined' && navigator.gpu && (await navigator.gpu.requestAdapter()));
  } catch {
    return false;
  }
}

async function modelBytes(name, onProgress) {
  const url = MODEL_BASE + name;
  let cache = null;
  try {
    cache = await caches.open(CACHE);
    const hit = await cache.match(url);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  } catch {
    cache = null;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download ${name}: ${res.status}`);
  const total = +res.headers.get('content-length') || 0;
  const parts = [];
  let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (total && onProgress) onProgress(got / total);
  }
  const bytes = new Uint8Array(got);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  const expect = SEG_HASHES[name];
  if (expect && (bytes.length !== expect.size || (await sha256Hex(bytes)) !== expect.sha256)) throw new Error(`${name} did not download correctly. Try again.`);
  try {
    if (cache) await cache.put(url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }));
  } catch {
    // Not kept: downloaded again next time.
  }
  return bytes;
}

// The model sessions; loaded once. `onProgress(stage, 0..1)`.
// Frees a session's (GPU) memory; a session that is already gone or cannot release is ignored.
async function releaseSession(s) {
  try {
    if (typeof s?.release === 'function') await s.release();
  } catch {
    // nothing to release
  }
}

// Frees a tensor's memory (a GPU buffer for the encoder's output); CPU tensors have nothing to free.
function disposeTensor(t) {
  try {
    if (typeof t?.dispose === 'function') t.dispose();
  } catch {
    // already disposed
  }
}

export function loadSegModel(onProgress = () => {}) {
  loading ??= (async () => {
    const ort = await import('../../vendor/ort/ort.webgpu.min.mjs');
    ort.env.wasm.wasmPaths = new URL('../../vendor/ort/', import.meta.url).href;
    ort.env.wasm.numThreads = 1;
    const enc = await modelBytes(SEG_FILES.encoder, (p) => onProgress('Downloading object model', p * 0.65));
    const dec = await modelBytes(SEG_FILES.decoder, (p) => onProgress('Downloading object model', 0.65 + p * 0.35));
    onProgress('Loading object model', 1);
    // Both models run on the graphics card when there is one (WebGPU), else on the CPU. On the card the encoder's embeddings stay there
    // and go straight into the decoder (no download and upload for each of the 54 points); if the decoder cannot run there the
    // embeddings are fetched once and a CPU decoder takes over (see findObjectMasks).
    const cpu = { executionProviders: ['wasm'] };
    let encoder = null;
    let decoder = null;
    let device = 'cpu';
    if (await hasWebGpu()) {
      try {
        decoder = await ort.InferenceSession.create(dec, { executionProviders: ['webgpu'] });
        encoder = await ort.InferenceSession.create(enc, { executionProviders: ['webgpu'], preferredOutputLocation: { image_embeddings: 'gpu-buffer' } });
        device = 'gpu';
      } catch {
        // The decoder session may exist when the encoder failed: release it, or its GPU buffers stay until the page closes.
        await releaseSession(decoder);
        encoder = null;
        decoder = null;
      }
      if (!encoder) {
        // the encoder alone on the card (the earlier arrangement), the decoder on the CPU
        try {
          encoder = await ort.InferenceSession.create(enc, { executionProviders: ['webgpu'] });
          device = 'gpu-encoder';
        } catch {
          encoder = null;
        }
      }
    }
    encoder ??= await ort.InferenceSession.create(enc, cpu);
    decoder ??= await ort.InferenceSession.create(dec, cpu);
    return { ort, encoder, decoder, device, decoderBytes: dec };
  })().catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

// The encoder's input: the picture (linear 0..1, 3 per pixel, w x h) as sRGB 0..255, exposed so its 99.5th percentile of brightness is white,
// scaled so its long side is 1024. (gpu/regions.js does the same on the graphics card; pass it as `prep`.)
export function segmentInput(rgb, w, h) {
  const n = w * h;
  const luma = new Float32Array(n);
  for (let i = 0; i < n; i++) luma[i] = 0.2126 * rgb[3 * i] + 0.7152 * rgb[3 * i + 1] + 0.0722 * rgb[3 * i + 2];
  const white = Math.max(1e-4, nthSmallest(luma, Math.floor(n * 0.995)));
  const scale = 1024 / Math.max(w, h);
  const nw = Math.round(w * scale);
  const nh = Math.round(h * scale);
  const input = new Float32Array(nw * nh * 3);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, x / scale);
      const sy = Math.min(h - 1, y / scale);
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(w - 1, x0 + 1);
      const y1 = Math.min(h - 1, y0 + 1);
      const ax = sx - x0;
      const ay = sy - y0;
      for (let c = 0; c < 3; c++) {
        const g = (xx, yy) => rgb[3 * (yy * w + xx) + c];
        const v = (g(x0, y0) * (1 - ax) + g(x1, y0) * ax) * (1 - ay) + (g(x0, y1) * (1 - ax) + g(x1, y1) * ax) * ay;
        input[(y * nw + x) * 3 + c] = 255 * Math.min(1, Math.max(0, v / white)) ** (1 / 2.2);
      }
    }
  }
  return { input, nw, nh, scale };
}

// Masks of the objects in a picture. `rgb`: linear 0..1, 3 per pixel, w x h.
// A grid of `cols` x `rows` points is tried; each gives the mask of the
// object under it. The masks are made at `scale` of the picture's size (much
// faster). Returns { w, h, masks: [{ bin, area, quality }] } for core/objects.js.
export async function findObjectMasks(model, rgb, w, h, { cols = 9, rows = 6, scale: outScale = 0.5, onProgress = () => {}, prep = null } = {}) {
  const { ort, encoder, decoder } = model;
  const { input, nw, nh, scale } = (prep && prep(rgb, w, h)) || segmentInput(rgb, w, h);
  onProgress('Finding objects', 0);
  let embeddings = (await encoder.run({ input_image: new ort.Tensor('float32', input, [nh, nw, 3]) })).image_embeddings;
  try {
    let decode = decoder;
    const mw = Math.max(8, Math.round(w * outScale));
    const mh = Math.max(8, Math.round(h * outScale));
    const masks = [];
    const total = cols * rows;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const feeds = (emb) => ({
          image_embeddings: emb,
          point_coords: new ort.Tensor('float32', new Float32Array([(((i + 0.5) / cols) * w) * scale, (((j + 0.5) / rows) * h) * scale]), [1, 1, 2]),
          point_labels: new ort.Tensor('float32', new Float32Array([1]), [1, 1]),
          mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
          has_mask_input: new ort.Tensor('float32', new Float32Array([0]), [1]),
          orig_im_size: new ort.Tensor('float32', new Float32Array([mh, mw]), [2]),
        });
        let out;
        try {
          out = await decode.run(feeds(embeddings));
        } catch (e) {
          // the decoder could not run on the card: fetch the embeddings once and finish on the CPU
          if (model.device !== 'gpu' || decode !== decoder) throw e;
          const data = await embeddings.getData();
          const gpuEmbeddings = embeddings;
          embeddings = new ort.Tensor('float32', data, embeddings.dims);
          disposeTensor(gpuEmbeddings);
          model.cpuDecoder ??= await ort.InferenceSession.create(model.decoderBytes, { executionProviders: ['wasm'] });
          decode = model.cpuDecoder;
          out = await decode.run(feeds(embeddings));
        }
        const m = out.masks.data;
        const bin = new Uint8Array(mw * mh);
        let area = 0;
        for (let k = 0; k < mw * mh; k++) {
          if (m[k] > 0) {
            bin[k] = 1;
            area++;
          }
        }
        masks.push({ bin, area, quality: out.iou_predictions.data[0] });
        onProgress('Finding objects', (j * cols + i + 1) / total);
      }
    }
    return { w: mw, h: mh, masks };
  } finally {
    // each call makes ~4 MB of GPU embeddings; they are not garbage collected
    disposeTensor(embeddings);
  }
}
