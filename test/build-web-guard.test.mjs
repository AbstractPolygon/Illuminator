import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('build-web refuses an output folder that would delete the source', () => {
  for (const out of ['app', '.', 'app/js', '..']) {
    const r = spawnSync(process.execPath, ['scripts/build-web.mjs', '--out', path.resolve(root, out)], { cwd: root });
    assert.equal(r.status, 1, out);
  }
  assert.ok(fs.existsSync(path.join(root, 'app', 'index.html')));
});
