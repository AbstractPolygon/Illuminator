'use strict';
// The app:// scheme: the files of app/ served with the page's Content-Security-Policy as a header. Separate from
// Electron so the containment rules can be tested; `fetchFile(absolutePath)` is net.fetch of a file URL in main.cjs.

const nodePath = require('node:path');
const { headerPolicy } = require('./csp.cjs');

// Types written down instead of left to Chromium's guess for a file URL: module workers need a JavaScript type, and
// WebAssembly streaming compiles only application/wasm. Anything else keeps what the file fetch reported.
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const notFound = () => ({ status: 404, statusText: 'Not Found', headers: new Headers({ 'Content-Type': 'text/plain; charset=utf-8' }), body: 'Not found' });

function createAppProtocolHandler({ appDir, fetchFile, path = nodePath }) {
  const root = path.resolve(appDir);
  return async function handle(requestUrl) {
    let file;
    try {
      const { pathname } = new URL(requestUrl);
      const decoded = decodeURIComponent(pathname);
      if (decoded.includes('\0')) return notFound();
      file = path.normalize(path.join(root, decoded));
    } catch {
      return notFound(); // a malformed address or a bad %-escape
    }
    // The separator after the root: '/app2/x' must not pass for a file of '/app'.
    if (!file.startsWith(root + path.sep)) return notFound();
    const res = await fetchFile(file);
    const headers = new Headers(res.headers);
    const type = CONTENT_TYPES[path.extname(file).toLowerCase()];
    if (type && res.status < 400) headers.set('Content-Type', type);
    // Same policy as the <meta> tag in app/index.html, plus frame-ancestors (test/csp.test.mjs keeps them in step).
    headers.set('Content-Security-Policy', headerPolicy);
    return { status: res.status, statusText: res.statusText || '', headers, body: res.body };
  };
}

module.exports = { createAppProtocolHandler, CONTENT_TYPES };
