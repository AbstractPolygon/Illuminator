// The first generation camera on macOS (electron/lytro-usb-mac.cjs): the app's side and the administrator helper's side over a real Unix socket,
// with a fake camera transport in the helper and a fake osascript that starts it; the password dialog's cancel; and the quoting of the command.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { connectWithHelper, serve, helperScript, shellWord, appleString } = require('../electron/lytro-usb-mac.cjs');
const { command } = require('../electron/lytro-protocol.cjs');

// A camera that answers hardware info (C2 00 then C6 00 for its size, then C4 reads by offset) as the first generation camera does.
function fakeCamera() {
  const info = Buffer.alloc(640);
  info.write('Lytro', 0);
  info.write('A123456789', 256);
  let loaded = null;
  const calls = [];
  return {
    calls,
    async read(cdb, size) {
      calls.push(cdb[0].toString(16));
      if (cdb[0] === 0xc2) { loaded = info; return Buffer.alloc(0); }
      if (cdb[0] === 0xc6 && cdb[1] === 0) { const b = Buffer.alloc(4); b.writeUInt32LE(loaded.length); return b.subarray(0, size); }
      if (cdb[0] === 0xc4) { const off = cdb.readUInt32LE(3); return loaded.subarray(off, off + size); }
      throw new Error('unexpected command');
    },
    async write() {},
    async waitReady() { return true; },
    setTimeout() {},
  };
}

test('macOS helper: the camera protocol runs in the app, every command carried by the helper', async () => {
  const cam = fakeCamera();
  let released = 0;
  const run = (cmd, args, cb) => {
    assert.equal(cmd, 'osascript');
    const socketPath = /--serve '([^']+)'/.exec(args[1])[1];
    // The helper as root would do this: connect, say hello, serve.
    const s = net.createConnection(socketPath, () => {
      s.write(`${JSON.stringify({ hello: true, interfaceNumber: 0 })}\n`);
      serve(s, cam, async () => { released++; });
    });
    cb(null, '', '');
  };
  const opened = await connectWithHelper({ key: '20:5', product: 0xa1 }, () => {}, { run, execPath: '/x/Illuminator', helperPath: '/x/helper.cjs' });
  assert.equal(opened.interfaceNumber, 0);
  const info = await opened.camera.hardwareInfo();
  assert.equal(info.vendor, 'Lytro');
  assert.equal(info.serial, 'A123456789');
  assert.ok(cam.calls.includes('c2') && cam.calls.includes('c4'));
  await opened.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(released >= 1, 'the helper gives the interface back when the app closes');
});

test('macOS helper: cancelling the password dialog says how to be asked again', async () => {
  const run = (cmd, args, cb) => cb(Object.assign(new Error('exit 1'), { code: 1 }), '', 'execution error: User canceled. (-128)');
  await assert.rejects(connectWithHelper({ key: '1:2', product: 0xa1 }, () => {}, { run }), (err) => err.code === 'cancelled' && /plug it in again/.test(err.message));
});

test('macOS helper: a camera error in the helper reaches the app as an error, not a hang', async () => {
  const cam = { ...fakeCamera(), async read() { throw new Error('The camera refused the command (status 1)'); } };
  const run = (cmd, args, cb) => {
    const socketPath = /--serve '([^']+)'/.exec(args[1])[1];
    const s = net.createConnection(socketPath, () => {
      s.write(`${JSON.stringify({ hello: true, interfaceNumber: 0 })}\n`);
      serve(s, cam, async () => {});
    });
    cb(null, '', '');
  };
  const opened = await connectWithHelper({ key: '3:4', product: 0xa1 }, () => {}, { run });
  await assert.rejects(opened.camera.hardwareInfo(), /refused the command/);
  await opened.close();
});

test('macOS helper: the command is quoted for the shell, then for AppleScript', () => {
  assert.equal(shellWord("a b'c"), `'a b'\\''c'`);
  assert.equal(appleString('say "hi" \\'), '"say \\"hi\\" \\\\"');
  const args = helperScript({ execPath: '/Applications/Illuminator.app/Contents/MacOS/Illuminator', helperPath: "/tmp/it's/h.cjs", socketPath: '/tmp/s.sock', bus: 20, address: 5 });
  assert.equal(args[0], '-e');
  assert.match(args[1], /^do shell script ".*ELECTRON_RUN_AS_NODE=1 .*--serve '\/tmp\/s.sock' 20 5 > \/dev\/null 2>&1 &" with prompt ".*" with administrator privileges$/);
  // (shell word inside an AppleScript string: the quote of "it's" survives both)
  assert.ok(args[1].includes(`'/tmp/it'\\\\''s/h.cjs'`));
  assert.ok(command(0xc2, 0).length === 16);
});
