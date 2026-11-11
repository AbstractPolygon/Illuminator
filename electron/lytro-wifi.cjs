// The first generation Lytro camera over Wi-Fi. With Wi-Fi turned on (camera firmware 1.2 or later), the camera makes a Wi-Fi network; once the
// computer has joined it, the camera answers on TCP at 10.100.1.1, port 5678, with the same commands it takes over USB (electron/lytro-protocol.cjs).
// The framing is the one worked out by the Lytro Meltdown project and implemented in ea's lytroctrl (connections.py, commands.py):
//
//   request and answer: a 28 byte header, then `length` bytes of data
//     0  uint32  0xFAAA55AF (sync)
//     4  uint32  length: of the data sent with a request, or of the data wanted (a read); of the data that follows, in an answer
//     8  uint32  flags: 1 when the request carries no data, 0 when it does; the camera sets 2 in its answers
//     12 16 bytes the command block, as over USB (C2 00 02 load the picture list, C6 00 00 size of what is loaded, C4 00 00 read the next part, ...)
//   all little endian.
//
// The camera reads the loaded item from its start, part after part, with `C4 00 00` (lytroctrl's way; the offset form used over USB is not known to
// work over Wi-Fi), so this transport says `sequential` and LytroCamera.download asks for the parts in order. One request at a time: the camera
// answers in order and has one loaded item.

const net = require('node:net');

const SYNC = 0xfaaa55af;
const HEADER = 28;
const DEFAULT_HOST = '10.100.1.1';
const DEFAULT_PORT = 5678;
const CONNECT_TIMEOUT_MS = 8000;
const ANSWER_TIMEOUT_MS = 20000;
// The most data one answer may say it holds: a picture is about 16 MB, so a header claiming far more is not a header.
const MAX_ANSWER = 64 * 1024 * 1024;

// The 28 byte header and the command block of a request.
function frame(cdb, length, hasData) {
  if (cdb.length !== 16) throw new Error('A camera command is 16 bytes');
  const h = Buffer.alloc(HEADER);
  h.writeUInt32LE(SYNC, 0);
  h.writeUInt32LE(length >>> 0, 4);
  h.writeUInt32LE(hasData ? 0 : 1, 8);
  cdb.copy(h, 12);
  return h;
}

// Reads the camera's answers off a socket: header, then data, however TCP splits them.
class AnswerReader {
  constructor() {
    this.chunks = [];
    this.size = 0;
    this.waiting = null; // { resolve, reject, timer }
    this.failed = null;
  }

  push(chunk) {
    this.chunks.push(chunk);
    this.size += chunk.length;
    this.deliver();
  }

  fail(err) {
    if (this.failed) return;
    this.failed = err;
    if (this.onFail) this.onFail(err);
    if (this.waiting) {
      clearTimeout(this.waiting.timer);
      const { reject } = this.waiting;
      this.waiting = null;
      reject(err);
    }
  }

  // The next whole answer: { flags, cdb, data }.
  next(timeoutMs) {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A late answer would be taken for the answer to the next request: the connection is over.
        this.waiting = null;
        const err = new Error('The camera did not answer in time');
        this.failed = err;
        if (this.onFail) this.onFail(err);
        reject(err);
      }, timeoutMs);
      this.waiting = { resolve, reject, timer };
      this.deliver();
    });
  }

  deliver() {
    if (!this.waiting || this.size < HEADER) return;
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    this.chunks = [all];
    const sync = all.readUInt32LE(0);
    if (sync !== SYNC) return this.fail(new Error(`The camera's answer does not start as expected (${sync.toString(16)})`));
    const length = all.readUInt32LE(4);
    if (length > MAX_ANSWER) return this.fail(new Error(`The camera's answer says it is ${length} bytes long`));
    if (all.length < HEADER + length) return;
    const answer = { flags: all.readUInt32LE(8), cdb: Buffer.from(all.subarray(12, HEADER)), data: Buffer.from(all.subarray(HEADER, HEADER + length)) };
    const rest = all.subarray(HEADER + length);
    this.chunks = rest.length ? [rest] : [];
    this.size = rest.length;
    clearTimeout(this.waiting.timer);
    const { resolve } = this.waiting;
    this.waiting = null;
    resolve(answer);
  }
}

// A transport for LytroCamera over an open socket: read(cdb, size) and write(cdb, data), one at a time.
function socketTransport(socket, log = () => {}, { answerTimeoutMs = ANSWER_TIMEOUT_MS } = {}) {
  const reader = new AnswerReader();
  reader.onFail = () => socket.destroy();
  socket.on('data', (chunk) => reader.push(chunk));
  socket.on('error', (err) => reader.fail(new Error(`The Wi-Fi connection to the camera failed: ${err.message}`)));
  socket.on('close', () => reader.fail(new Error('The camera closed the Wi-Fi connection')));
  let queue = Promise.resolve();
  const exchange = (head, data) => {
    const run = queue.then(async () => {
      socket.write(data && data.length ? Buffer.concat([head, data]) : head);
      return reader.next(answerTimeoutMs);
    });
    queue = run.catch(() => {});
    return run;
  };
  return {
    // The camera reads a loaded item from its start, a part per request (see above).
    sequential: true,
    async read(cdb, size) {
      const answer = await exchange(frame(cdb, size, false));
      log(`wifi ${cdb.subarray(0, 3).toString('hex')} -> ${answer.data.length} bytes`);
      return answer.data;
    },
    async write(cdb, data) {
      const answer = await exchange(frame(cdb, data.length, true), data);
      log(`wifi ${cdb.subarray(0, 3).toString('hex')} + ${data.length} bytes -> ${answer.data.length} bytes`);
      return answer.data;
    },
  };
}

// Opens the connection: { camera, close, product, host, port } (product: the first generation camera's USB product id, so the rest of the app treats
// it as that camera).
async function connect({ host = DEFAULT_HOST, port = DEFAULT_PORT, connectTimeoutMs = CONNECT_TIMEOUT_MS, answerTimeoutMs } = {}, log = () => {}) {
  const { LytroCamera } = require('./lytro-protocol.cjs');
  const { FIRST_GENERATION_PRODUCT } = require('./lytro-usb.cjs');
  const socket = await new Promise((resolve, reject) => {
    const s = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error(`No camera answered at ${host}. Is this computer on the camera's Wi-Fi network?`));
    }, connectTimeoutMs);
    s.once('connect', () => {
      clearTimeout(timer);
      resolve(s);
    });
    s.once('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not reach a camera at ${host}: ${err.message}. Is this computer on the camera's Wi-Fi network?`));
    });
  });
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 10000);
  log(`wifi: connected to ${host}:${port}`);
  const camera = new LytroCamera(socketTransport(socket, log, { answerTimeoutMs }), log);
  return { camera, close: () => socket.destroy(), product: FIRST_GENERATION_PRODUCT, host, port };
}

module.exports = { connect, socketTransport, frame, AnswerReader, SYNC, HEADER, DEFAULT_HOST, DEFAULT_PORT };
