import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isFirstGeneration } = require('../electron/lytro-scsi-win.cjs');

test('the first generation camera is recognised by the names its disk reports', () => {
  for (const [vendor, product] of [['Lytro', '8GB Camera'], ['Lytro', '16GB Camera'], ['Lytro', 'F01'], ['ZORAN', 'COACH6 (I62)']]) {
    assert.equal(isFirstGeneration({ vendor, product }), true, `${vendor} ${product}`);
  }
});

test('other disks are not taken for the camera', () => {
  for (const [vendor, product] of [['WDC', 'WD5000AAKS-00YGA0'], ['Generic', 'MassStorageClass'], ['Samsung', 'SSD 870 EVO 2TB'], ['Lytro', 'ILLUM']]) {
    assert.equal(isFirstGeneration({ vendor, product }), false, `${vendor} ${product}`);
  }
  assert.equal(isFirstGeneration(null), false);
});

test('a short answer from the driver is returned as short, not padded with zeros', async () => {
  const { ScsiTransport, DATA_OFFSET } = require('../electron/lytro-scsi-win.cjs');
  const api = {
    ioctl(handle, code, inBuf, outBuf) {
      outBuf.fill(7, DATA_OFFSET, DATA_OFFSET + 10);
      outBuf.writeUInt32LE(10, 12); // DataTransferLength as the driver reports it
      return 0x38;
    },
  };
  const got = await new ScsiTransport(api, {}).read(Buffer.alloc(16), 65536);
  assert.equal(got.length, 10);
  assert.ok(got.every((b) => b === 7));
});
