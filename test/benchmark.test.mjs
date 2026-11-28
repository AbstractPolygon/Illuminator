// The speed report's benchmark (core/benchmark.js) times the same steps in a graphics card worker and a processor-only one, and reports a step that failed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runBenchmark, benchmarkText, speedup, BENCH_STEPS } from '../app/js/core/benchmark.js';
import { formatDuration, reportText } from '../app/js/core/speedreport.js';

function fakeEngine(cpu, log, { failDepth = false } = {}) {
  return {
    worker: { terminate: () => log.push(`${cpu ? 'cpu' : 'gpu'} terminate`) },
    async request(type, args = {}) {
      log.push(`${cpu ? 'cpu' : 'gpu'} ${type}`);
      if (type === 'open') {
        assert.equal(args.depthCache, null, 'the kept depth is not used');
        assert.equal(args.l16Cache, null);
        assert.ok(args.bytes instanceof ArrayBuffer);
        return { hasRaw: true };
      }
      if (type === 'depthMap' && failDepth && cpu) throw new Error('out of memory');
      return {};
    },
  };
}

test('the benchmark runs every step on the card, then on the processor, and frees both workers', async () => {
  const log = [];
  const photo = { bytes: async () => new ArrayBuffer(8), open: { depthCache: { alpha: [1] }, id: 1 }, after: [['settings', { settings: {} }]] };
  const res = await runBenchmark((cpu) => fakeEngine(cpu, log), photo, { u: 0, v: 0 });
  assert.deepEqual(log, ['gpu open', 'gpu settings', 'gpu prepare', 'gpu depthMap', 'gpu view', 'gpu view', 'gpu terminate', 'cpu open', 'cpu settings', 'cpu prepare', 'cpu depthMap', 'cpu view', 'cpu view', 'cpu terminate']);
  assert.equal(res.rows.length, BENCH_STEPS.length);
  for (const r of res.rows) assert.ok(r.card >= 0 && r.processor >= 0);
  assert.deepEqual(res.errors, { card: null, processor: null });
});

test('a step that fails stops that run and is reported', async () => {
  const log = [];
  const photo = { bytes: async () => new ArrayBuffer(8), open: {}, after: [] };
  const res = await runBenchmark((cpu) => fakeEngine(cpu, log, { failDepth: true }), photo, {});
  assert.match(res.errors.processor, /out of memory/);
  assert.equal(res.rows.find((r) => r.name === 'Measuring depth').processor, null);
  assert.ok(log.includes('cpu terminate'));
  const text = benchmarkText(res, formatDuration).join('\n');
  assert.match(text, /processor run stopped: out of memory/);
  assert.match(reportText({ benchmark: benchmarkText(res, formatDuration) }), /Benchmark \(the open photo/);
});

test('the speed-up reads plainly', () => {
  assert.equal(speedup({ card: 100, processor: 450 }), '4.5x faster on the card');
  assert.equal(speedup({ card: 30, processor: 600 }), '20x faster on the card');
  assert.equal(speedup({ card: 200, processor: 100 }), '2.0x slower on the card');
  assert.equal(speedup({ card: null, processor: 100 }), '');
});
