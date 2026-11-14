import test from 'node:test';
import assert from 'node:assert/strict';
import { Selection } from '../app/js/ui/selection.js';

const order = ['a', 'b', 'c', 'd', 'e'];

test('toggle picks and unpicks a photo', () => {
  const s = new Selection();
  s.toggle('b');
  assert.ok(s.has('b') && s.size === 1);
  s.toggle('b');
  assert.equal(s.size, 0);
});

test('a range runs from the last photo clicked, in either direction', () => {
  const s = new Selection();
  s.toggle('b');
  s.range(order, 'd');
  assert.deepEqual([...s.ids].sort(), ['b', 'c', 'd']);
  s.clear();
  s.toggle('d');
  s.range(order, 'b');
  assert.deepEqual([...s.ids].sort(), ['b', 'c', 'd']);
});

test('a range without a start picks just that photo; a range adds to what is picked', () => {
  const s = new Selection();
  s.range(order, 'c');
  assert.deepEqual([...s.ids], ['c']);
  s.toggle('a');
  s.range(order, 'b');
  assert.deepEqual([...s.ids].sort(), ['a', 'b', 'c']);
});

test('select all, clear, and forgetting photos that are no longer shown', () => {
  const s = new Selection();
  s.selectAll(order);
  assert.equal(s.size, 5);
  s.keepOnly(['a', 'b']);
  assert.deepEqual([...s.ids].sort(), ['a', 'b']);
  assert.equal(s.anchor, null);
  s.clear();
  assert.equal(s.size, 0);
});
