// The Content-Security-Policy: the <meta> tag in app/index.html (web build) and the response header of the app://
// scheme (desktop) must stay identical (the header adds frame-ancestors, which a <meta> tag cannot carry), must stay
// strict, and must let through the hosts the code fetches from.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const csp = require('../electron/csp.cjs');
const html = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');

const parse = (s) => new Map(s.split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const [name, ...src] = d.split(/\s+/); return [name, src]; }));
const metaMatch = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/);
const meta = metaMatch ? parse(metaMatch[1]) : null;

test('index.html carries exactly one CSP meta tag, equal to electron/csp.cjs', () => {
  assert.ok(metaMatch, 'meta tag missing');
  assert.equal(html.match(/http-equiv="Content-Security-Policy"/g).length, 1);
  assert.equal(metaMatch[1], csp.metaPolicy);
  // The policy must come before any script or stylesheet it is meant to govern.
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<link rel="stylesheet"'));
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script'));
});

test('the Electron header is the meta policy plus frame-ancestors', () => {
  const header = parse(csp.headerPolicy);
  assert.deepEqual(header.get('frame-ancestors'), ["'self'"]);
  header.delete('frame-ancestors');
  assert.deepEqual([...header], [...meta]);
  assert.ok(!meta.has('frame-ancestors'), 'frame-ancestors is ignored in a <meta> tag');
  // main.cjs must actually send it on app:// responses.
  assert.match(main, /require\('\.\/csp\.cjs'\)/);
  assert.match(main, /headers\.set\('Content-Security-Policy', headerPolicy\)/);
});

test('the policy is strict', () => {
  const all = [...meta.values()].flat();
  assert.ok(!all.includes("'unsafe-eval'"));
  assert.ok(!meta.get('script-src').includes("'unsafe-inline'"));
  assert.ok(!all.includes("'unsafe-inline'"), 'no inline styles are needed, so none are allowed');
  assert.deepEqual(meta.get('default-src'), ["'self'"]);
  assert.deepEqual(meta.get('script-src'), ["'self'", "'wasm-unsafe-eval'"]);
  assert.deepEqual(meta.get('object-src'), ["'none'"]);
  assert.deepEqual(meta.get('base-uri'), ["'self'"]);
  assert.deepEqual(meta.get('form-action'), ["'none'"]);
  assert.deepEqual(meta.get('frame-src'), ["'self'"]);
  for (const [name, src] of meta) assert.ok(!src.includes('*') && !src.includes('http:') && !src.includes('https:'), `${name} is too wide`);
  // The one policy that allows more than the page itself is connect-src, and only for named hosts.
  assert.ok(meta.get('worker-src').includes('blob:'));
});

test('connect-src covers every host the code fetches from', () => {
  const files = ['core/depthmodels.js', 'core/segmodel.js', 'core/upscalemodels.js', 'core/upscalemodels-data.js', 'ui/updates.js'];
  // github.com is only a link people click (a page opened in the browser), never fetched.
  const linkOnly = new Set(['github.com']);
  const hosts = new Set();
  for (const f of files) {
    const text = fs.readFileSync(new URL(`../app/js/${f}`, import.meta.url), 'utf8');
    for (const m of text.matchAll(/https:\/\/([a-z0-9.-]+)/gi)) hosts.add(m[1].toLowerCase());
  }
  for (const h of linkOnly) hosts.delete(h);
  assert.ok(hosts.has('huggingface.co') && hosts.has('raw.githubusercontent.com') && hosts.has('api.github.com'), `scan found ${[...hosts]}`);
  const sources = meta.get('connect-src').filter((s) => s.startsWith('https://')).map((s) => s.slice(8));
  const covers = (src, host) => (src.startsWith('*.') ? host.endsWith(src.slice(1)) : src === host);
  for (const h of hosts) assert.ok(sources.some((s) => covers(s, h)), `${h} is not in connect-src`);
  // Hugging Face answers a model download with a redirect to its CDN, checked against connect-src too.
  assert.ok(sources.some((s) => covers(s, 'us.aws.cdn.hf.co')));
  assert.ok(meta.get('connect-src').includes('blob:') && meta.get('connect-src').includes('data:'));
});

test('no code in app/js needs inline styles or string evaluation', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : e.name.endsWith('.js') ? [`${d}/${e.name}`] : []));
  const bad = [];
  for (const f of walk(fileURLToPath(new URL('../app/js', import.meta.url)))) {
    const text = fs.readFileSync(f, 'utf8');
    if (/\bstyle=["'\\]|setAttribute\(\s*['"]style['"]|\beval\(|new Function\(|<style/.test(text)) bad.push(f);
  }
  assert.deepEqual(bad, []);
  assert.ok(!/\sstyle=|<style|\son[a-z]+=/i.test(html), 'index.html has inline style or handlers');
});
