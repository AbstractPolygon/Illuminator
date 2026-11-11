// The first generation camera on macOS through IOKit's SCSITask interface (electron/lytro-scsi-mac.cjs): the interface method calls against a C
// stand-in laid out like Apple's headers (UUID by value, scatter-gather buffer, status and count written back); and, on a fake IOKit, which devices
// count as the camera, the unmount when macOS refuses exclusive access, the messages, and the transport the camera protocol runs on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const koffi = require('koffi');
const mac = require('../electron/lytro-scsi-mac.cjs');

// The stand-in for IOKit's interfaces (test/fixtures/iokit-fake), built with the C compiler where there is one.
function buildFake() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iokit-fake-'));
  const lib = path.join(dir, 'fake.so');
  try {
    execFileSync('cc', ['-shared', '-fPIC', '-O1', '-o', lib, fileURLToPath(new URL('./fixtures/iokit-fake/fake_scsitask.c', import.meta.url))], { stdio: 'ignore' });
  } catch {
    return null;
  }
  return lib;
}
const fakeLib = process.platform === 'win32' ? null : buildFake();

test('the SCSITask calls, against a C stand-in laid out like Apple\'s headers: interface by UUID, exclusive access, a read, a write, a refused command', { skip: !fakeLib && 'no C compiler' }, () => {
  const lib = koffi.load(fakeLib);
  const fake = {
    plugin: lib.func('void *fake_plugin()'),
    exclusive: lib.func('int fake_exclusive()'),
    released: lib.func('int fake_tasks_released()'),
    timeout: lib.func('uint32 fake_timeout()'),
    cdbSize: lib.func('uint8 fake_cdb_size()'),
    dir: lib.func('uint8 fake_dir()'),
    count: lib.func('uint64 fake_count()'),
  };
  const plugin = fake.plugin();
  assert.equal(mac.comQueryInterface(koffi, plugin, mac.UUID.mmcDeviceInterface), null, 'another interface is refused');
  const device = mac.comQueryInterface(koffi, plugin, mac.UUID.taskDeviceInterface);
  assert.ok(device);
  const ops = mac.taskOps(koffi);
  assert.equal(ops.obtainExclusive(device), 0);
  assert.equal(fake.exclusive(), 1);
  // A read: the data comes back from the scatter-gather buffer, as long as the device says it transferred.
  const cdb = Buffer.alloc(16);
  cdb[0] = 0xc4;
  const r = ops.execute(device, cdb, mac.DATA_IN, 10, null, 5000);
  assert.equal(r.status, 0);
  assert.equal(r.transferred, 10);
  assert.deepEqual([...r.data], Array.from({ length: 10 }, (_, i) => 0xc4 + i));
  assert.equal(fake.cdbSize(), 16);
  assert.equal(fake.dir(), mac.DATA_IN);
  assert.equal(fake.timeout(), 5000);
  // A write of 5 bytes, and a command without data (a 6 byte block).
  ops.execute(device, Buffer.from([0xc2, 0, 1]), mac.DATA_OUT, 5, Buffer.from('hello'), 1000);
  assert.equal(fake.dir(), mac.DATA_OUT);
  assert.equal(Number(fake.count()), 5);
  ops.execute(device, Buffer.from([0x00]), mac.DATA_NONE, 0, null, 1000);
  assert.equal(fake.cdbSize(), 6);
  const refused = ops.execute(device, Buffer.from([0x99]), mac.DATA_NONE, 0, null, 1000);
  assert.equal(refused.status, 2);
  assert.equal(fake.released(), 4, 'every task is released');
  ops.releaseExclusive(device);
  assert.equal(fake.exclusive(), 0);
});

test('interface layouts: method offsets from Apple\'s SCSITaskLib.h', () => {
  assert.equal(mac.MMC.getSCSITaskDeviceInterface, 40 + 8 * 12);
  assert.deepEqual(mac.TASK_DEVICE, { isExclusiveAccessAvailable: 40, obtainExclusiveAccess: 64, releaseExclusiveAccess: 72, createSCSITask: 80 });
  assert.deepEqual(mac.TASK, { setCommandDescriptorBlock: 64, setScatterGatherEntries: 88, setTimeoutDuration: 96, executeTaskSync: 128, getSCSIServiceResponse: 144 });
  assert.deepEqual(mac.uuidBytes('1BBC4132-08A5-11D5-90ED-0030657D052A').slice(0, 4), [0x1b, 0xbc, 0x41, 0x32]);
});

// A fake IOKit: one camera device answering hardware info as the camera does, and the commands it was sent.
function fakeApi({ category = mac.AUTHORING_DEVICE, busyOnce = false, candidates } = {}) {
  const info = Buffer.alloc(640);
  info.write('Lytro', 0);
  info.write('B5151500001', 256);
  let loaded = null;
  let busy = busyOnce;
  const log = { unmounted: [], exclusive: 0, released: 0, closed: 0, commands: [] };
  return {
    log,
    candidates: () => candidates || [
      { id: '4294971234', cls: 'IOSCSIPeripheralDeviceType05', category, vendor: 'ZORAN', product: 'COACH6 (I62)', type: 5, bsd: 'disk4' },
      { id: '4294970000', cls: 'IOSCSIPeripheralDeviceType00', category: null, vendor: 'APPLE', product: 'SSD', type: 0, bsd: 'disk0' },
    ],
    open: () => ({ device: 'dev', close: () => { log.closed++; } }),
    obtainExclusive() {
      if (busy) { busy = false; return mac.IO_RETURN_BUSY; }
      log.exclusive++;
      return 0;
    },
    releaseExclusive: () => { log.released++; },
    unmount: (bsd) => log.unmounted.push(bsd),
    execute(device, cdb, direction, length, payload) {
      log.commands.push([cdb[0].toString(16), direction, length]);
      if (cdb[0] === 0xc2) { loaded = info; return { status: 0, data: Buffer.alloc(0) }; }
      if (cdb[0] === 0xc6) { const b = Buffer.alloc(4); b.writeUInt32LE(loaded.length); return { status: 0, data: b.subarray(0, length) }; }
      if (cdb[0] === 0xc4) { const off = cdb.readUInt32LE(3); return { status: 0, data: loaded.subarray(off, off + length) }; }
      return { status: 2, data: Buffer.alloc(0) };
    },
  };
}

test('finding the camera: only a camera device macOS offers to apps, keyed by its registry entry', () => {
  const api = fakeApi();
  const found = mac.listDevices(api);
  assert.equal(found.length, 1);
  assert.equal(found[0].key, 'scsi-mac:4294971234');
  assert.equal(found[0].product, 0xa1);
  // the same camera as a plain disk (type 0): no user-space route, and the message says what macOS showed
  const disk = fakeApi({ candidates: [{ id: '1', cls: 'IOSCSIPeripheralDeviceType00', category: null, vendor: 'Lytro', product: 'F01', type: 0, bsd: 'disk4' }] });
  assert.equal(mac.listDevices(disk).length, 0);
});

test('opening: exclusive access, with the camera volume unmounted first when macOS says busy; the camera protocol runs on it; closing gives it back', async () => {
  const api = fakeApi({ busyOnce: true });
  const [found] = mac.listDevices(api);
  const opened = await mac.connect(found, () => {}, api);
  assert.deepEqual(api.log.unmounted, ['disk4']);
  assert.equal(api.log.exclusive, 1);
  const info = await opened.camera.hardwareInfo();
  assert.equal(info.vendor, 'Lytro');
  assert.equal(info.serial, 'B5151500001');
  // C2 without data, C6 and C4 reading from the camera
  assert.deepEqual(api.log.commands[0], ['c2', mac.DATA_NONE, 0]);
  assert.ok(api.log.commands.some(([op, dir]) => op === 'c4' && dir === mac.DATA_IN));
  await opened.close();
  assert.equal(api.log.released, 1);
  assert.equal(api.log.closed, 1);
});

test('a refused command and another program holding the camera are errors a person can act on', async () => {
  const api = fakeApi();
  const t = new mac.MacScsiTransport(api, 'dev');
  await assert.rejects(t.read(Buffer.from([0x99]), 4), /refused the command \(SCSI status 2\)/);
  const held = { ...fakeApi(), obtainExclusive: () => 0xe00002c5 };
  const [found] = mac.listDevices(held);
  await assert.rejects(mac.connect(found, () => {}, held), /Another program has the camera open/);
});
