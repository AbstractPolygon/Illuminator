// A page for the graphics card tests: serves app/ on a free port, opens an empty page in headless Chromium (SwiftShader where there is no graphics card) and gives
// it to the test. Each test then imports the modules it needs inside page.evaluate (`await import('/js/gpu/...')`), makes a GpuRenderer and compares the card's result
// with the processor's.
//
//   const page = await gpuPage(t);   // null: skipped (no browser here), see helpers/playwright.mjs
//   if (!page) return;
//   const res = await page.evaluate(async () => { ... });
//
// `photos`: a folder served at /photos/<name>. The server and browser close when the test ends. In the page, `globalThis.makeGpu()` returns a GpuRenderer on a fresh WebGL2 context, or null when the context or
// float render targets are missing.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './playwright.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app');
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.wasm': 'application/wasm' };

const PAGE = `<!doctype html><meta charset=utf8><script type=module>
window.makeGpu = async () => {
  const { GpuRenderer } = await import('/js/gpu/renderer.js');
  const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
  if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
  return new GpuRenderer(gl);
};
window.ready = true;
</script>`;

export async function gpuPage(t, { timeout = 240000, photos = null } = {}) {
  const browser = await launchBrowser(t);
  if (!browser) return null;
  const server = http
    .createServer((q, r) => {
      const u = decodeURIComponent(q.url.split('?')[0]);
      if (u === '/t.html') {
        r.writeHead(200, { 'content-type': 'text/html' });
        return r.end(PAGE);
      }
      // (a folder of photos given by the test, at /photos/<name>)
      const inPhotos = photos && u.startsWith('/photos/');
      const base = inPhotos ? path.resolve(photos) : root;
      const f = path.join(base, path.normalize(inPhotos ? u.slice('/photos'.length) : u));
      if (!f.startsWith(base)) {
        r.writeHead(403);
        return r.end();
      }
      fs.readFile(f, (e, d) => {
        r.writeHead(e ? 404 : 200, { 'content-type': types[path.extname(u)] || 'application/octet-stream' });
        r.end(e ? undefined : d);
      });
    })
    .listen(0);
  t.after(async () => {
    await browser.close();
    server.close();
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(timeout);
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(`http://localhost:${server.address().port}/t.html`);
  await page.waitForFunction(() => globalThis.ready === true);
  return page;
}
