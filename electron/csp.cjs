'use strict';
// The page's Content-Security-Policy, in one place. app/index.html carries it as a <meta> tag (the web build has no
// way to send headers) and electron/main.cjs sends it as a response header on app://; test/csp.test.mjs keeps the
// two identical. If the page is ever hit by script injection, this is what keeps that script away from the desktop
// bridge (window.lytroNative) and from sending data anywhere.
//
// Why each source is there:
//  script-src 'wasm-unsafe-eval'  ONNX Runtime compiles its WebAssembly (no eval of strings is allowed).
//  connect-src hosts              model downloads: huggingface.co answers with a redirect to a CDN under hf.co
//                                 (redirects are checked against connect-src too), upscaling models come from
//                                 raw.githubusercontent.com, the update check from api.github.com.
//  connect-src blob: data:        fetch() of object URLs and data URLs (picture and video export).
//  img/media blob: data:          thumbnails and the exported video are object URLs.
//  worker-src blob:               the render workers are module files, blob: covers workers the runtime may spawn.
//  frame-src 'self'               the Render Queue runs a hidden copy of the page in an iframe (?queue).
//  style-src 'self'               no inline style attributes or <style> are used; style.x = ... from script is allowed.
const POLICY = {
  'default-src': ["'self'"],
  'script-src': ["'self'", "'wasm-unsafe-eval'"],
  'style-src': ["'self'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'media-src': ["'self'", 'blob:'],
  'font-src': ["'self'", 'data:'],
  'connect-src': [
    "'self'",
    'https://huggingface.co',
    'https://*.huggingface.co',
    'https://*.hf.co',
    'https://raw.githubusercontent.com',
    'https://api.github.com',
    'blob:',
    'data:',
  ],
  'worker-src': ["'self'", 'blob:'],
  'frame-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'none'"],
};
// Only valid in a header (browsers ignore it in a <meta> tag): the page may be framed by itself (Render Queue) only.
const HEADER_ONLY = { 'frame-ancestors': ["'self'"] };

const toString = (p) => Object.entries(p).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');

module.exports = {
  POLICY,
  HEADER_ONLY,
  metaPolicy: toString(POLICY),
  headerPolicy: toString({ ...POLICY, ...HEADER_ONLY }),
};
