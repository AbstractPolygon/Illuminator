import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const script = fileURLToPath(new URL('../scripts/serve.mjs', import.meta.url));

// Raw request line, so the client does not tidy the malformed path first.
function raw(port, target) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: target, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

test('dev server survives malformed paths and stays inside the app folder', async () => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [script, '--port', String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve) => child.stdout.once('data', resolve));
    assert.equal(await raw(port, '/%E0%A4%A'), 400);
    assert.equal(await raw(port, '/%00'), 400);
    assert.equal(await raw(port, '/..%2fpackage.json'), 403);
    assert.equal(await raw(port, '/'), 200);
    assert.equal(await raw(port, '/nope.js'), 404);
  } finally {
    child.kill();
  }
});
