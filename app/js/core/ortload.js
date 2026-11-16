// ONNX Runtime Web, loaded once for every model (depth, upscaling, fill, objects). Its wasm file comes from vendor/ort; where the host keeps it only in parts (the hosted
// test page, see core/bigfile.js) the parts are put back together and handed to the runtime.
import { fetchBig } from './bigfile.js';

const BASE = new URL('../../vendor/ort/', import.meta.url).href;
const WASM = 'ort-wasm-simd-threaded.jsep.wasm';
let loading = null;

export function loadOrt() {
  if (!loading) {
    loading = (async () => {
      const ort = await import('../../vendor/ort/ort.webgpu.min.mjs');
      ort.env.wasm.wasmPaths = BASE;
      ort.env.wasm.numThreads = 1;
      let whole = false;
      try {
        whole = (await fetch(BASE + WASM, { method: 'HEAD' })).ok;
      } catch {
        whole = false;
      }
      if (!whole) ort.env.wasm.wasmBinary = (await fetchBig(BASE + WASM)).buffer;
      return ort;
    })().catch((e) => {
      loading = null;
      throw e;
    });
  }
  return loading;
}
