import test from 'node:test';
import assert from 'node:assert/strict';
import { nth } from '../app/js/core/l16photo.js';

test('nth gives the value a sorted copy has at k', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (const n of [1, 2, 3, 10, 101, 5000]) {
    for (const kind of ['random', 'few values', 'sorted', 'reversed', 'equal']) {
      const a = new Float32Array(n);
      for (let i = 0; i < n; i++) a[i] = kind === 'random' ? rnd() : kind === 'few values' ? Math.floor(rnd() * 4) : kind === 'sorted' ? i : kind === 'reversed' ? n - i : 0.5;
      const sorted = Float32Array.from(a).sort();
      for (const k of [0, Math.floor(n * 0.99), n - 1, Math.floor(n / 2)]) assert.equal(nth(Float32Array.from(a), k), sorted[k], `${kind} n=${n} k=${k}`);
    }
  }
});
