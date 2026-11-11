// The first generation camera on macOS. It declares USB mass storage, so macOS's storage driver takes its only interface, and libusb may take
// it from that driver only for a process with Apple's com.apple.vm.device-access entitlement (granted to approved developers) or for root
// (libusb darwin_usb.c, "USB device capture requires either an entitlement ... or root privilege"); without either, claiming it fails with
// LIBUSB_ERROR_ACCESS. So the USB side runs in a helper with administrator rights, started once through macOS's own password dialog:
//
//   app (this module)  <-- a Unix socket in the person's temporary folder -->  helper (this file, run as root by Electron in Node mode)
//
// The helper opens the one device it is told (bus and address), takes the interface from the driver, and carries the camera's vendor commands
// (BulkTransport.read / write / waitReady of lytro-usb.cjs) for the app; the camera protocol itself (lytro-protocol.cjs) stays in the app. It does
// nothing else, and it ends, giving the interface back to macOS, when the app closes the connection or goes away.
//
// Messages are one JSON object per line: { id, op: 'read' | 'write' | 'ready' | 'timeout' | 'close', cdb, size, data, ms } with byte strings in
// base64; answers { id, ok: true, data } or { id, ok: false, error }. The helper's first line is { hello: true, interfaceNumber } or { hello: false, error }.

const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const HELPER_WAIT_MS = 120000;

// Line framing over a socket: calls onMessage(object) for each line.
function lines(socket, onMessage) {
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buf += chunk;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line) onMessage(JSON.parse(line));
    }
  });
}
const send = (socket, obj) => socket.write(`${JSON.stringify(obj)}\n`);

// ---------------------------------------------------------------- app side

// The transport the camera protocol uses, with every command carried by the helper.
class HelperTransport {
  constructor(socket) {
    this.socket = socket;
    this.next = 1;
    this.pending = new Map();
    this.closed = false;
    lines(socket, (m) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m.data !== undefined && m.data !== null ? Buffer.from(m.data, 'base64') : true);
      else p.reject(new Error(m.error));
    });
    const fail = () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('The connection to the camera helper was lost'));
      this.pending.clear();
    };
    socket.on('close', fail);
    socket.on('error', fail);
  }

  call(msg) {
    if (this.closed) return Promise.reject(new Error('The connection to the camera helper was lost'));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      send(this.socket, { id, ...msg });
    });
  }

  read(cdb, size) {
    return this.call({ op: 'read', cdb: cdb.toString('base64'), size });
  }

  async write(cdb, data) {
    await this.call({ op: 'write', cdb: cdb.toString('base64'), data: data.toString('base64') });
  }

  async waitReady(tries, delayMs) {
    return (await this.call({ op: 'ready', tries, delayMs })).toString() === '1';
  }

  setTimeout(ms) {
    this.call({ op: 'timeout', ms }).catch(() => {});
  }

  async close() {
    try {
      await this.call({ op: 'close' });
    } catch {
      // Already gone.
    }
    this.socket.destroy();
  }
}

// Quoting: a shell word, then an AppleScript string.
const shellWord = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const appleString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// The osascript arguments that start the helper as root, through macOS's password dialog, in the background.
function helperScript({ execPath, helperPath, socketPath, bus, address }) {
  const command = `ELECTRON_RUN_AS_NODE=1 ${shellWord(execPath)} ${shellWord(helperPath)} --serve ${shellWord(socketPath)} ${Number(bus)} ${Number(address)} > /dev/null 2>&1 &`;
  return ['-e', `do shell script ${appleString(command)} with prompt ${appleString('Illuminator needs your password to reach the Lytro camera over USB.')} with administrator privileges`];
}

// Starts the helper for the device { key: 'bus:address', product } and connects to it: { camera, close, product, interfaceNumber }. Throws
// { code: 'cancelled' } when the person cancels the password dialog.
async function connectWithHelper(found, log = () => {}, { run = execFile, execPath = process.execPath, helperPath = __filename, waitMs = HELPER_WAIT_MS } = {}) {
  const { LytroCamera } = require('./lytro-protocol.cjs');
  const [bus, address] = String(found.key).split(':');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'illuminator-usb-'));
  const socketPath = path.join(dir, `${crypto.randomBytes(6).toString('hex')}.sock`);
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(socketPath, resolve).once('error', reject));
  let timer = null;
  const cleanup = () => {
    clearTimeout(timer);
    server.close();
    fs.rm(dir, { recursive: true, force: true }, () => {});
  };
  try {
    const accepted = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('The camera helper did not start')), waitMs);
      server.once('connection', (socket) => {
        clearTimeout(timer);
        resolve(socket);
      });
    });
    // (awaited below only once the dialog was answered: a cancel must not leave it to reject unheard)
    accepted.catch(() => {});
    log(`asking for administrator rights to reach the camera on ${found.key}`);
    await new Promise((resolve, reject) => {
      run('osascript', helperScript({ execPath, helperPath, socketPath, bus, address }), (err, _out, errText) => {
        if (!err) return resolve();
        const cancelled = /User canceled|-128/.test(`${errText || ''} ${err.message}`);
        const e = new Error(cancelled ? 'macOS needs your administrator password to reach the first generation camera over USB. Unplug the camera and plug it in again to be asked again.' : `The camera helper could not be started (${String(errText || err.message).trim()})`);
        e.code = cancelled ? 'cancelled' : 'failed';
        reject(e);
      });
    });
    const socket = await accepted;
    server.close();
    const hello = await new Promise((resolve, reject) => {
      let done = false;
      const onData = (chunk) => {
        const text = chunk.toString('utf8');
        const i = text.indexOf('\n');
        if (i < 0 || done) return;
        done = true;
        socket.off('data', onData);
        // Anything after the hello line is not expected before the first command.
        resolve(JSON.parse(text.slice(0, i)));
      };
      socket.on('data', onData);
      socket.once('close', () => { if (!done) reject(new Error('The camera helper closed before answering')); });
    });
    if (!hello.hello) throw new Error(`The camera helper could not open the camera (${hello.error})`);
    log(`the helper reaches the camera on interface ${hello.interfaceNumber}`);
    const transport = new HelperTransport(socket);
    const camera = new LytroCamera(transport, log);
    return {
      camera,
      product: found.product,
      interfaceNumber: hello.interfaceNumber,
      close: async () => {
        await transport.close();
        fs.rm(dir, { recursive: true, force: true }, () => {});
      },
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}

// ---------------------------------------------------------------- helper side (as root)

// Answers the app's messages on `socket` with `transport` (a BulkTransport); `release()` gives the interface back.
function serve(socket, transport, release) {
  let queue = Promise.resolve();
  const finish = async () => {
    await release();
    socket.destroy();
  };
  socket.on('close', () => { queue = queue.then(release); });
  lines(socket, (m) => {
    queue = queue.then(async () => {
      try {
        let data = null;
        if (m.op === 'read') data = (await transport.read(Buffer.from(m.cdb, 'base64'), m.size)).toString('base64');
        else if (m.op === 'write') await transport.write(Buffer.from(m.cdb, 'base64'), Buffer.from(m.data || '', 'base64'));
        else if (m.op === 'ready') data = Buffer.from((await transport.waitReady(m.tries, m.delayMs)) ? '1' : '0').toString('base64');
        else if (m.op === 'timeout') transport.setTimeout(m.ms);
        else if (m.op === 'close') {
          send(socket, { id: m.id, ok: true });
          await finish();
          return;
        } else throw new Error(`Unknown request ${m.op}`);
        send(socket, { id: m.id, ok: true, data });
      } catch (err) {
        send(socket, { id: m.id, ok: false, error: err.message });
      }
    });
  });
}

async function helperMain([socketPath, bus, address]) {
  const socket = net.createConnection(socketPath);
  await new Promise((resolve, reject) => socket.once('connect', resolve).once('error', reject));
  const usb = require('usb');
  const { BulkTransport, LYTRO_VENDOR, describeInterfaces } = require('./lytro-usb.cjs');
  let iface = null;
  let device = null;
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    try {
      if (iface) await new Promise((resolve) => iface.release(true, () => resolve()));
      if (iface) iface.attachKernelDriver();
    } catch {
      // macOS takes the device back when it is closed.
    }
    try {
      if (device) device.close();
    } catch {
      // Not open.
    }
    setTimeout(() => process.exit(0), 100);
  };
  try {
    device = usb.getDeviceList().find((d) => d.busNumber === Number(bus) && d.deviceAddress === Number(address) && d.deviceDescriptor.idVendor === LYTRO_VENDOR);
    if (!device) throw new Error(`no Lytro device at ${bus}:${address}`);
    device.open();
    const mass = describeInterfaces(device).find((i) => i.kind === 'mass' && i.bulkIn && i.bulkOut);
    if (!mass) throw new Error('the camera has no mass storage interface');
    iface = mass.iface;
    if (iface.isKernelDriverActive()) iface.detachKernelDriver();
    iface.claim();
    const transport = new BulkTransport(mass.bulkIn, mass.bulkOut, () => {}, 4000, { device, interfaceNumber: mass.number });
    send(socket, { hello: true, interfaceNumber: mass.number });
    serve(socket, transport, release);
  } catch (err) {
    send(socket, { hello: false, error: err.message });
    socket.end();
    await release();
  }
}

if (require.main === module && process.argv[2] === '--serve') {
  helperMain(process.argv.slice(3)).catch(() => process.exit(1));
}

module.exports = { connectWithHelper, HelperTransport, serve, helperScript, shellWord, appleString };
