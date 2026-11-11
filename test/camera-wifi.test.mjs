// The first generation camera over Wi-Fi (electron/lytro-wifi.cjs) against a stand-in camera: a TCP server here that speaks the framing lytroctrl
// uses (a 28 byte header with the sync word, length and flags, then the 16 byte command block, then the data) and answers the same commands as the
// camera on USB. It splits its answers into small pieces, as TCP may, and the tests check what the app sends as well as what it reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const wifi = require('../electron/lytro-wifi.cjs');
const { LytroCamera } = require('../electron/lytro-protocol.cjs');
const camera = require('../electron/camera.cjs');
const { createIpc } = require('../electron/ipc.cjs');

const PICTURES = [
  { prefix: 'IMG_', folder: 100, postfix: 'PHOTO', number: 1, id: 'sha1-aaaa', date: '2026-10-01T10:00:00.000Z' },
  { prefix: 'IMG_', folder: 100, postfix: 'PHOTO', number: 2, id: 'sha1-bbbb', date: '2026-10-01T10:05:00.000Z', starred: true },
];

function pictureList(pictures) {
  const head = Buffer.alloc(12 + 8);
  head.writeUInt32LE(1, 0);
  head.writeUInt32LE(128, 4);
  head.writeUInt32LE(1, 8);
  return Buffer.concat([head, ...pictures.map((p) => {
    const b = Buffer.alloc(128);
    b.write(p.postfix, 0, 'latin1');
    b.write(p.prefix, 8, 'latin1');
    b.writeUInt32LE(p.folder, 16);
    b.writeUInt32LE(p.number, 20);
    b.writeUInt32LE(p.starred ? 1 : 0, 40);
    b.write(p.id, 48, 'latin1');
    b.write(p.date, 96, 'latin1');
    b.writeUInt32LE(1, 124);
    return b;
  })]);
}

// The stand-in camera. `files`: camera path -> bytes. `behavior`: { chunk (most bytes a read hands out), split (bytes per TCP write), silentAfter
// (stop answering after this many requests), closeAfter, badSync }. Returns { port, requests, close }.
async function fakeWifiCamera(files, { chunk = 40000, split = 997, silentAfter = Infinity, closeAfter = Infinity, badSync = false } = {}) {
  const requests = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    let loaded = Buffer.alloc(0);
    let cursor = 0;
    const answer = (cdb, data = Buffer.alloc(0)) => {
      const head = Buffer.alloc(28);
      head.writeUInt32LE(badSync ? 0x12345678 : wifi.SYNC, 0);
      head.writeUInt32LE(data.length, 4);
      head.writeUInt32LE(2, 8);
      cdb.copy(head, 12);
      const all = Buffer.concat([head, data]);
      for (let at = 0; at < all.length; at += split) socket.write(all.subarray(at, at + split));
    };
    socket.on('data', (chunkIn) => {
      pending = Buffer.concat([pending, chunkIn]);
      for (;;) {
        if (pending.length < 28) return;
        const length = pending.readUInt32LE(4);
        const flags = pending.readUInt32LE(8);
        const hasData = flags === 0;
        if (hasData && pending.length < 28 + length) return;
        const req = { sync: pending.readUInt32LE(0), length, flags, cdb: Buffer.from(pending.subarray(12, 28)), data: hasData ? Buffer.from(pending.subarray(28, 28 + length)) : null };
        pending = pending.subarray(28 + (hasData ? length : 0));
        requests.push(req);
        if (requests.length > closeAfter) {
          socket.destroy();
          return;
        }
        if (requests.length > silentAfter) continue;
        const [cls, , cmd] = req.cdb;
        if (cls === 0xc2 && cmd === 0) {
          const b = Buffer.alloc(640);
          b.write('Lytro, Inc.', 0, 'latin1');
          b.write('A5120012', 256, 'latin1');
          b.write('b1', 384, 'latin1');
          b.write('1.2.1', 512, 'latin1');
          loaded = b;
          cursor = 0;
          answer(req.cdb);
        } else if (cls === 0xc2 && cmd === 2) {
          loaded = pictureList(PICTURES);
          cursor = 0;
          answer(req.cdb);
        } else if (cls === 0xc2 && cmd === 1) {
          const name = req.data.subarray(0, req.data.indexOf(0)).toString('latin1');
          loaded = files[name] || Buffer.alloc(0);
          cursor = 0;
          answer(req.cdb);
        } else if (cls === 0xc6 && cmd === 0) {
          const b = Buffer.alloc(4);
          b.writeUInt32LE(loaded.length, 0);
          answer(req.cdb, b);
        } else if (cls === 0xc6 && cmd === 6) {
          const b = Buffer.alloc(4);
          b.writeFloatLE(64.5, 0);
          answer(req.cdb, b);
        } else if (cls === 0xc4 && cmd === 0) {
          const part = loaded.subarray(cursor, cursor + Math.min(chunk, length));
          cursor += part.length;
          answer(req.cdb, part);
        } else {
          answer(req.cdb);
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    requests,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const raw = Buffer.alloc(300000);
for (let i = 0; i < raw.length; i++) raw[i] = (i * 31 + (i >> 9)) & 255;
const FILES = {
  'I:\\DCIM\\100PHOTO\\IMG_0002.RAW': raw,
  'I:\\DCIM\\100PHOTO\\IMG_0002.TXT': Buffer.from('{"picture":{}}'),
  'I:\\DCIM\\100PHOTO\\IMG_0001.RAW': raw.subarray(0, 1000),
  'I:\\DCIM\\100PHOTO\\IMG_0001.TXT': Buffer.from('{"picture":{}}'),
};

test('the request header: sync word, length, flags, then the 16 byte command block', () => {
  const cdb = Buffer.alloc(16);
  cdb[0] = 0xc6;
  const read = wifi.frame(cdb, 4, false);
  assert.equal(read.length, 28);
  assert.deepEqual([...read.subarray(0, 12)], [0xaf, 0x55, 0xaa, 0xfa, 4, 0, 0, 0, 1, 0, 0, 0]);
  assert.equal(read[12], 0xc6);
  const write = wifi.frame(cdb, 20, true);
  assert.equal(write.readUInt32LE(8), 0, 'a request that carries data has flags 0');
  assert.throws(() => wifi.frame(Buffer.alloc(3), 0, false), /16 bytes/);
});

test('hardware info, battery, picture list and a 300 KB file, read part after part over TCP', async () => {
  const cam = await fakeWifiCamera(FILES);
  const opened = await wifi.connect({ host: '127.0.0.1', port: cam.port });
  try {
    const c = opened.camera;
    assert.deepEqual(await c.hardwareInfo(), { vendor: 'Lytro, Inc.', serial: 'A5120012', build: 'b1', version: '1.2.1' });
    assert.equal(await c.battery(), 64.5);
    const list = await c.pictureList();
    assert.deepEqual(list.map((p) => p.name), ['IMG_0001', 'IMG_0002']);
    assert.equal(list[1].starred, true);
    const got = await c.download('file', LytroCamera.pathOf(list[1], 'RAW'));
    assert.ok(got.equals(raw), 'the file came across whole');
    // what was sent: every request starts with the sync word; reads carry no data (flags 1) and ask for the next part with C4 00 00
    assert.ok(cam.requests.every((r) => r.sync === wifi.SYNC));
    const reads = cam.requests.filter((r) => r.cdb[0] === 0xc4);
    assert.ok(reads.length >= 8, `${reads.length} reads for 300 KB in 40 KB parts`);
    assert.ok(reads.every((r) => r.cdb[2] === 0 && r.flags === 1 && r.length <= 0xffff));
    const load = cam.requests.find((r) => r.cdb[0] === 0xc2 && r.cdb[2] === 1);
    assert.equal(load.flags, 0);
    assert.equal(load.data.toString('latin1'), 'I:\\DCIM\\100PHOTO\\IMG_0002.RAW\0', 'the path, ending in a zero byte');
    assert.equal(load.length, load.data.length);
    await assert.rejects(c.download('file', 'I:\\nothing'), /no I:\\nothing/);
  } finally {
    opened.close();
    await cam.close();
  }
});

test('a camera that stops answering, closes the connection or sends something else fails the request, and never hands back part of a file', async () => {
  // silent: the request times out and the connection is over (a late answer must not be taken for the next one)
  let cam = await fakeWifiCamera(FILES, { silentAfter: 2 });
  let opened = await wifi.connect({ host: '127.0.0.1', port: cam.port, answerTimeoutMs: 300 });
  await opened.camera.hardwareInfo().catch(() => {});
  await assert.rejects(opened.camera.pictureList(), /did not answer in time|closed/);
  await assert.rejects(opened.camera.battery(), /did not answer in time|closed/);
  opened.close();
  await cam.close();
  // closed in the middle of a file
  cam = await fakeWifiCamera(FILES, { closeAfter: 6 });
  opened = await wifi.connect({ host: '127.0.0.1', port: cam.port, answerTimeoutMs: 2000 });
  await assert.rejects(opened.camera.download('file', 'I:\\DCIM\\100PHOTO\\IMG_0002.RAW'), /closed/);
  opened.close();
  await cam.close();
  // not the camera's framing
  cam = await fakeWifiCamera(FILES, { badSync: true });
  opened = await wifi.connect({ host: '127.0.0.1', port: cam.port, answerTimeoutMs: 2000 });
  await assert.rejects(opened.camera.hardwareInfo(), /does not start as expected/);
  opened.close();
  await cam.close();
});

test('no camera at the address: a plain message about joining its network', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(wifi.connect({ host: '127.0.0.1', port, connectTimeoutMs: 2000 }), /camera's Wi-Fi network/);
});

test('where to look for a camera on the network joined: the fixed address, then the first address of each private network', () => {
  const ifaces = {
    lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
    wlan0: [{ address: '192.168.42.17', netmask: '255.255.255.0', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
    eth0: [{ address: '10.1.2.3', netmask: '255.255.0.0', family: 'IPv4', internal: false }],
    tun0: [{ address: '100.64.0.5', netmask: '255.192.0.0', family: 'IPv4', internal: false }],
  };
  assert.deepEqual(camera.wifiCandidates(ifaces), ['10.100.1.1', '192.168.42.1', '10.1.0.1']);
  assert.deepEqual(camera.wifiCandidates({ wlan0: [{ address: '10.100.1.1', netmask: '255.255.255.0', family: 'IPv4', internal: false }] }), ['10.100.1.1'], 'the computer itself is not a candidate');
});

test('the port probe finds what is open and what is not', async () => {
  const server = net.createServer((s) => s.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const open = server.address().port;
  const closedServer = net.createServer();
  await new Promise((resolve) => closedServer.listen(0, '127.0.0.1', resolve));
  const closed = closedServer.address().port;
  await new Promise((resolve) => closedServer.close(resolve));
  try {
    assert.deepEqual(await camera.probeWifi({ hosts: ['127.0.0.1'], ports: [closed, open], timeoutMs: 1000 }), [{ host: '127.0.0.1', open: [open] }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Android debugging over the network: adb connect, and a failure reported plainly', async () => {
  const seen = [];
  const ok = async (cmd, args) => { seen.push(args); return 'connected to 192.168.42.1:5555\n'; };
  assert.equal(await camera.adbConnectWifi('192.168.42.1', ok), '192.168.42.1:5555');
  assert.deepEqual(seen[0], ['connect', '192.168.42.1:5555']);
  await assert.rejects(camera.adbConnectWifi('192.168.42.1', async () => 'failed to connect to 192.168.42.1:5555'), /did not connect/);
  await assert.rejects(camera.adbConnectWifi('192.168.42.1', async () => null), /is adb installed/);
});

test('connected over Wi-Fi, the camera is listed with the others, its photos import as a light field file, and it is dropped when it stops answering', async () => {
  const cam = await fakeWifiCamera(FILES);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wifi-import-'));
  try {
    const entry = await camera.connectWifi({ host: '127.0.0.1', port: cam.port, keepAliveMs: 200 });
    assert.equal(entry.id, 'lytro:wifi:127.0.0.1');
    assert.equal(entry.label, 'Lytro camera A5120012 (Wi-Fi)');
    assert.equal(entry.kind, 'lytro');
    const listed = await camera.listCameras({ roots: [], adb: false, lytro: false });
    assert.deepEqual(listed.map((c) => c.id), ['lytro:wifi:127.0.0.1']);
    assert.deepEqual(listed[0].files.map((f) => f.name), ['IMG_0001', 'IMG_0002']);
    const written = await camera.importFiles(entry, ['sha1-bbbb'], dir);
    assert.equal(written.length, 1);
    assert.match(path.basename(written[0]), /^100PHOTO_IMG_0002\.lfp$/);
    const bytes = await fsp.readFile(written[0]);
    assert.ok(bytes.length > raw.length, 'the raw picture is in the file');
    assert.equal(bytes.subarray(1, 4).toString('latin1'), 'LFP', 'a light field file');
    // the keep-alive asks for the hardware info while idle
    const before = cam.requests.length;
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(cam.requests.length > before, 'asked the camera something while idle');
    // switched off: dropped from the list at the next keep-alive
    await cam.close();
    for (let i = 0; i < 40 && (await camera.listCameras({ roots: [], adb: false, lytro: false })).length; i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(await camera.listCameras({ roots: [], adb: false, lytro: false }), []);
  } finally {
    await camera.disconnectWifi('lytro:wifi:127.0.0.1');
    await cam.close().catch(() => {});
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('connect: joins the chosen network with its password, then reaches the camera, trying again while the computer gets an address', async () => {
  const calls = [];
  let failures = 2;
  let probed = [];
  const fakeCamera = {
    ...camera,
    connectWifiAuto: async (o) => {
      calls.push(['camera', o]);
      if (failures-- > 0) throw new Error('No camera answered at 10.100.1.1');
      return { id: 'lytro:wifi:10.100.1.1', label: 'Lytro camera A5120012 (Wi-Fi)', files: [{}, {}] };
    },
    probeWifi: async () => probed,
    adbConnectWifi: async (host) => { calls.push(['adb', host]); return `${host}:5555`; },
    disconnectWifi: async () => true,
  };
  const wifiJoin = {
    listNetworks: async () => [{ name: 'LYTRO-1234', signal: 80, secure: true, current: false }],
    joinNetwork: async (name, password) => { calls.push(['join', name, password]); },
  };
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'wifi-ipc-'));
  let soon = 0;
  const { handlers } = createIpc({
    fs: require('node:fs'), fsp, path, os, dialog: {}, shell: {}, app: { getPath: (n) => path.join(base, n) }, camera: fakeCamera, wifiJoin, wifiWaitMs: 10000,
    getSettings: () => ({ libraryDir: base }), saveSettings: async () => {}, getCameras: () => [], summary: () => [], pollCameras: async () => {}, scanSoon: () => { soon++; },
    withWin: (o) => [o], videoMemory: async () => ({}), lfpModule: async () => ({}), memoryReserve: { ram: 0, vram: 0 },
  });
  try {
    assert.deepEqual(await handlers['camera-wifi-networks'](), [{ name: 'LYTRO-1234', signal: 80, secure: true, current: false }]);
    const got = await handlers['camera-wifi-connect']({ network: 'LYTRO-1234', password: 'secret-pass' });
    assert.deepEqual(got, { id: 'lytro:wifi:10.100.1.1', label: 'Lytro camera A5120012 (Wi-Fi)', count: 2, via: 'lytro' });
    assert.deepEqual(calls[0], ['join', 'LYTRO-1234', 'secret-pass']);
    assert.equal(calls.filter((c) => c[0] === 'camera').length, 3, 'tried again until the camera answered');
    assert.deepEqual(calls[1], ['camera', {}], 'the page cannot choose an address');
    assert.equal(soon, 1);
    // already on the camera's network: no join, one try
    calls.length = 0;
    failures = 1;
    await assert.rejects(handlers['camera-wifi-connect']({ network: 'LYTRO-1234', join: false }), /No camera answered on this network/);
    assert.deepEqual(calls, [['camera', {}]]);
    // an ILLUM that does not speak the first generation protocol but offers Android debugging: connected that way
    calls.length = 0;
    failures = 99;
    probed = [{ host: '10.100.1.1', open: [] }, { host: '192.168.42.1', open: [80, 5555] }];
    const viaAdb = await handlers['camera-wifi-connect']({ network: 'ILLUM-1', join: false });
    assert.equal(viaAdb.via, 'adb');
    assert.deepEqual(calls.at(-1), ['adb', '192.168.42.1']);
    // neither: the open ports are reported
    probed = [{ host: '192.168.42.1', open: [80, 8080] }];
    await assert.rejects(handlers['camera-wifi-connect']({ network: 'ILLUM-1', join: false }), /Open ports: 192\.168\.42\.1: 80, 8080/);
    // nothing chosen
    await assert.rejects(handlers['camera-wifi-connect']({ network: '' }), /Choose the camera's Wi-Fi network/);
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});
