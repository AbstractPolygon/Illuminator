// Reads a Lytro camera over USB from a web page (WebUSB), for browsers: the
// same commands as the desktop app's electron/lytro-protocol.cjs (vendor
// specific 16 byte SCSI style commands in bulk-only wrappers), on the
// camera's vendor specific interface. A browser does not let a page claim a
// mass storage interface, so the first generation camera (which has only
// that) cannot be read this way; a camera that also has a vendor interface
// (the ILLUM: interface 1) can, once the camera's WinUSB driver is installed
// for that interface on Windows (Zadig).

import { encodeJson, refFor, writeContainer } from '../core/lfp.js';

export const LYTRO_VENDOR = 0x24cf;
export const FIRST_GENERATION_PRODUCT = 0x00a1;
const PACKET = 65536;
const IO_TIMEOUT_MS = 8000;
const LOAD_TYPES = { hardware_info: 0, file: 1, picture_list: 2, picture: 5, calibration: 6, rawcompressedpicture: 7 };
const KIND_NAMES = { mass: 'mass storage', adb: 'Android debug (adb)', vendor: 'vendor specific' };

const latin1 = (bytes) => String.fromCharCode(...bytes);
const cString = (bytes) => {
  const end = bytes.indexOf(0);
  return latin1(bytes.subarray(0, end < 0 ? bytes.length : end));
};
const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export function command(code, ...params) {
  const cdb = new Uint8Array(16);
  cdb[0] = code;
  params.forEach((p, i) => { if (p !== undefined) cdb[2 + i] = p; });
  return cdb;
}

// WebUSB has no way to cancel one transfer, so a timeout calls `abort` (the
// transport resets the device) to make sure nothing stays pending.
const withTimeout = (promise, what, ms = IO_TIMEOUT_MS, abort = null) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(async () => {
      if (abort) {
        try { await abort(); } catch { /* the device may be gone */ }
      }
      reject(new Error(`${what}: the camera did not answer in time`));
    }, ms);
  });
  promise.catch(() => {}); // a transfer cancelled by the abort rejects late
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

// Bulk-only transport over a claimed interface of a WebUSB device.
export class WebUsbTransport {
  constructor(device, epIn, epOut, log = () => {}, interfaceNumber = null, timeoutMs = IO_TIMEOUT_MS) {
    this.device = device;
    this.epIn = epIn;
    this.epOut = epOut;
    this.interfaceNumber = interfaceNumber;
    this.timeoutMs = timeoutMs;
    this.tag = 0;
    this.log = log;
  }

  wrapper(cdb, size, toDevice) {
    const cbw = new Uint8Array(31);
    cbw.set([0x55, 0x53, 0x42, 0x43], 0);
    view(cbw).setUint32(4, ++this.tag, true);
    view(cbw).setUint32(8, size, true);
    cbw[12] = toDevice ? 0 : 0x80;
    cbw[14] = cdb.length;
    cbw.set(cdb, 15);
    return cbw;
  }

  abortPending() {
    return typeof this.device.reset === 'function' ? this.device.reset() : null;
  }

  async clearHalt(direction, endpoint) {
    try {
      await this.device.clearHalt(direction, endpoint);
    } catch (err) {
      this.log(`clear halt failed: ${err.message}`);
    }
  }

  // Reset recovery (Bulk-Only Transport 5.3.4): the class request 0xFF, then
  // both halts cleared, so the next command starts from a known state.
  async resetRecovery() {
    this.log('mass storage reset');
    if (this.interfaceNumber !== null) {
      try {
        await this.device.controlTransferOut({ requestType: 'class', recipient: 'interface', request: 0xff, value: 0, index: this.interfaceNumber });
      } catch (err) {
        this.log(`mass storage reset failed: ${err.message}`);
      }
    }
    await this.clearHalt('in', this.epIn);
    await this.clearHalt('out', this.epOut);
  }

  async out(data) {
    const res = await withTimeout(this.device.transferOut(this.epOut, data), 'send', this.timeoutMs, () => this.abortPending());
    if (res.status === 'stall') await this.clearHalt('out', this.epOut);
    if (res.status !== 'ok') throw new Error(`USB send failed (${res.status})`);
  }

  async in(length) {
    const res = await withTimeout(this.device.transferIn(this.epIn, length), 'receive', this.timeoutMs, () => this.abortPending());
    if (res.status === 'stall') {
      await this.clearHalt('in', this.epIn);
      throw new Error('USB receive stalled');
    }
    if (res.status === 'babble') throw new Error('USB receive overflowed');
    return new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength);
  }

  async sendCommand(cdb, size, toDevice) {
    const cbw = this.wrapper(cdb, size, toDevice);
    try {
      await this.out(cbw);
    } catch (err) {
      await this.resetRecovery();
      throw err;
    }
    return this.tag;
  }

  // One status wrapper, checked to answer command `tag`.
  async readStatus(tag) {
    const csw = await this.in(13);
    if (csw.length !== 13 || latin1(csw.subarray(0, 4)) !== 'USBS') throw new Error('The camera sent an unexpected status');
    const got = view(csw).getUint32(4, true);
    if (got !== tag) throw new Error(`The camera answered another command (status tag ${got}, expected ${tag})`);
    return { code: csw[12], residue: view(csw).getUint32(8, true) };
  }

  // The status of command `tag`; an answer out of step triggers reset recovery.
  async status(tag = this.tag) {
    let csw;
    try {
      csw = await this.readStatus(tag);
    } catch (err) {
      await this.resetRecovery();
      throw err;
    }
    if (csw.code === 2) {
      await this.resetRecovery();
      throw new Error('The camera reported a phase error');
    }
    if (csw.code !== 0) throw new Error(`The camera refused the command (status ${csw.code})`);
    return csw;
  }

  async waitReady(tries = 8, delayMs = 150) {
    for (let i = 0; i < tries; i++) {
      try {
        const tag = await this.sendCommand(new Uint8Array(16), 0, true);
        await this.status(tag);
        return true;
      } catch (err) {
        this.log(`not ready yet: ${err.message}`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return false;
  }

  // After a stall or timeout in the data phase: clear the halt and read the
  // status wrapper; if that does not work the exchange is out of step and
  // only the reset gets it back. Returns the status, or null.
  async recoverDataPhase(direction, endpoint, tag) {
    await this.clearHalt(direction, endpoint);
    try {
      const csw = await this.readStatus(tag);
      if (csw.code === 2) throw new Error('phase error');
      return csw;
    } catch (err) {
      this.log(`no valid status after the data phase: ${err.message}`);
      await this.resetRecovery();
      return null;
    }
  }

  async read(cdb, size) {
    const tag = await this.sendCommand(cdb, size, false);
    const parts = [];
    let got = 0;
    let failure = null;
    try {
      while (got < size) {
        const part = await this.in(Math.min(1 << 20, size - got));
        if (!part.length) break;
        parts.push(part);
        got += part.length;
      }
    } catch (err) {
      failure = err;
    }
    if (failure) {
      const csw = await this.recoverDataPhase('in', this.epIn, tag);
      // A stall that ended with a good status is a short answer, which the
      // caller checks; anything else failed.
      if (!csw || csw.code !== 0) throw failure;
      this.log(`data phase ended early (${failure.message}); the camera is in step again`);
    } else {
      await this.status(tag);
    }
    const all = new Uint8Array(got);
    let at = 0;
    for (const p of parts) {
      all.set(p, at);
      at += p.length;
    }
    return all;
  }

  async write(cdb, data) {
    const tag = await this.sendCommand(cdb, data.length, true);
    if (data.length) {
      try {
        await this.out(data);
      } catch (err) {
        await this.recoverDataPhase('out', this.epOut, tag);
        throw err;
      }
    }
    await this.status(tag);
  }
}

// The protocol, as electron/lytro-protocol.cjs (with Uint8Array).
export class LytroCamera {
  constructor(transport, log = () => {}) {
    this.t = transport;
    this.log = log;
  }

  query(id, size) {
    return this.t.read(command(0xc6, id), size);
  }

  async download(type, name = null) {
    const cdb = command(0xc2, LOAD_TYPES[type]);
    if (name === null) {
      await this.t.read(cdb, 0);
    } else {
      const bytes = new Uint8Array(name.length + 1);
      for (let i = 0; i < name.length; i++) bytes[i] = name.charCodeAt(i) & 0xff;
      await this.t.write(cdb, bytes);
    }
    const size = view(await this.query(0, 4)).getUint32(0, true);
    this.log(`load ${type}${name ? ` ${name}` : ''}: ${size} bytes`);
    if (!size) throw new Error(`The camera has no ${name || type}`);
    const out = new Uint8Array(size);
    let got = 0;
    let empty = 0;
    while (got < size) {
      const read = new Uint8Array(16);
      read[0] = 0xc4;
      read[2] = 1;
      view(read).setUint32(3, got, true);
      const want = Math.min(PACKET, size - got);
      const part = await this.t.read(read, want);
      if (!part.length) {
        // Retried a few times, then the download fails: truncated data must
        // never pass as a complete file.
        if (++empty >= 3) break;
        continue;
      }
      empty = 0;
      out.set(part.subarray(0, want), got);
      got += Math.min(part.length, want);
    }
    if (got < size) throw new Error(`The camera sent only ${got} of ${size} bytes of ${name || type}`);
    return out;
  }

  async hardwareInfo() {
    const d = await this.download('hardware_info');
    return { vendor: cString(d.subarray(0, 256)), serial: cString(d.subarray(256, 384)), build: cString(d.subarray(384, 512)), version: cString(d.subarray(512, 640)) };
  }

  async pictureList() {
    const b = await this.download('picture_list');
    const v = view(b);
    if (b.length < 12 || v.getUint32(0, true) !== 1) throw new Error('Unexpected picture list from the camera');
    const recordsPerItem = v.getUint32(8, true);
    const declared = v.getUint32(4, true);
    const RECORD = declared >= 124 && declared <= 512 ? declared : 128;
    const ROTATION = { 1: 0, 8: 90, 3: 180, 6: 270 };
    const pictures = [];
    for (let o = 12 + 8 * recordsPerItem; o + RECORD <= b.length; o += RECORD) {
      const folderPostfix = cString(b.subarray(o, o + 8));
      const prefix = cString(b.subarray(o + 8, o + 16));
      const folderNumber = v.getUint32(o + 16, true);
      const number = v.getUint32(o + 20, true);
      pictures.push({
        id: cString(b.subarray(o + 48, o + 96)),
        folder: `${String(folderNumber).padStart(3, '0')}${folderPostfix}`,
        prefix,
        number,
        starred: !!v.getUint32(o + 40, true),
        date: cString(b.subarray(o + 96, o + 124)),
        rotation: RECORD >= 128 ? ROTATION[v.getUint32(o + 124, true)] ?? 0 : 0,
        name: `${prefix}${String(number).padStart(4, '0')}`,
      });
    }
    return pictures;
  }

  static pathOf(picture, extension) {
    return `I:\\DCIM\\${picture.folder}\\${picture.name}.${extension}`;
  }
}

// The interfaces of a device in its active configuration.
export function describeInterfaces(device) {
  const out = [];
  for (const iface of (device.configuration && device.configuration.interfaces) || []) {
    const alt = iface.alternates[0];
    if (!alt) continue;
    const ep = (dir) => alt.endpoints.find((e) => e.direction === dir && e.type === 'bulk') || null;
    const kind = alt.interfaceClass === 8 ? 'mass' : alt.interfaceClass === 0xff ? (alt.interfaceSubclass === 0x42 && alt.interfaceProtocol === 1 ? 'adb' : 'vendor') : null;
    out.push({ number: iface.interfaceNumber, cls: alt.interfaceClass, sub: alt.interfaceSubclass, proto: alt.interfaceProtocol, bulkIn: ep('in') && ep('in').endpointNumber, bulkOut: ep('out') && ep('out').endpointNumber, kind });
  }
  return out;
}

// Which interfaces to try the protocol on: the vendor ones (a browser cannot
// claim a mass storage interface, and an adb one speaks adb).
export function candidateInterfaces(infos) {
  return infos.filter((i) => i.kind === 'vendor' && i.bulkIn && i.bulkOut);
}

export function describe(infos) {
  return infos.map((i) => `${i.number}: class ${i.cls.toString(16)}/${i.sub.toString(16)}/${i.proto.toString(16)} ${KIND_NAMES[i.kind] || 'other'}${i.bulkIn && i.bulkOut ? '' : ' (no bulk endpoints)'}`).join('; ');
}

// Opens the device and finds the interface that answers the camera protocol:
// { camera, info, pictures, product, interfaceNumber, report, close }. Throws an
// Error whose message tells what was tried (and `report` holds the same).
export async function connectWebUsb(device, log = () => {}) {
  const lines = [];
  const note = (line) => {
    lines.push(line);
    log(line);
  };
  const fail = (message) => Object.assign(new Error(message), { report: lines.join('\n') });
  try {
    await device.open();
    if (!device.configuration) await device.selectConfiguration(1);
  } catch (err) {
    throw fail(`The camera could not be opened by the browser (${err.message}).`);
  }
  note(`device ${device.vendorId.toString(16)}:${device.productId.toString(16)} ${device.productName || ''}`.trim());
  const infos = describeInterfaces(device);
  note(`interfaces: ${describe(infos)}`);
  const candidates = candidateInterfaces(infos);
  if (!candidates.length) {
    try { await device.close(); } catch { /* already closed */ }
    throw fail(infos.some((i) => i.kind === 'adb')
      ? 'This camera offers a vendor interface only for Android debugging (adb). The browser version cannot use that: use the desktop app, or USB debugging with adb.'
      : infos.some((i) => i.kind === 'mass')
        ? `This camera is a USB drive${infos.some((i) => i.cls === 3) ? ' with a HID (control) interface' : ''} to the computer. A browser cannot claim either over USB (it keeps drives and HID devices from pages), so its photos are read from its drive: choose the drive's DCIM folder. The desktop app reads the camera over USB itself.`
        : `The camera has no interface a browser can use (${describe(infos) || 'none listed'}).`);
  }
  const failures = [];
  for (const c of candidates) {
    try {
      await device.claimInterface(c.number);
    } catch (err) {
      failures.push(`interface ${c.number} cannot be claimed (${err.message})`);
      note(failures[failures.length - 1]);
      continue;
    }
    const transport = new WebUsbTransport(device, c.bulkIn, c.bulkOut, note, c.number);
    const camera = new LytroCamera(transport, note);
    try {
      await transport.waitReady();
      const info = await camera.hardwareInfo();
      note(`interface ${c.number} answers the camera protocol: ${JSON.stringify(info)}`);
      const pictures = await camera.pictureList();
      note(`${pictures.length} pictures`);
      const close = async () => {
        try { await device.releaseInterface(c.number); } catch { /* gone */ }
        try { await device.close(); } catch { /* gone */ }
      };
      return { camera, info, pictures, product: device.productId, interfaceNumber: c.number, report: lines.join('\n'), close };
    } catch (err) {
      failures.push(`interface ${c.number}: ${err.message}`);
      note(failures[failures.length - 1]);
      try { await device.releaseInterface(c.number); } catch { /* not claimed */ }
    }
  }
  try { await device.close(); } catch { /* already closed */ }
  const windows = /windows/i.test(typeof navigator !== 'undefined' ? navigator.userAgent : '');
  throw fail(`The camera did not answer (${failures.join('; ')}).${windows ? ' On Windows the interface needs its WinUSB driver (Zadig), for the ILLUM interface 1, not the mass storage one.' : ''}`);
}

// A picture off the camera as the file the app opens: the ILLUM's .LFR file
// where the camera has one, else (first generation) its RAW and TXT parts put
// together as a .LFP.
export async function downloadPicture(camera, picture, product, log = () => {}) {
  if (product !== FIRST_GENERATION_PRODUCT) {
    try {
      return { name: `${picture.folder}_${picture.name}.LFR`, data: await camera.download('file', LytroCamera.pathOf(picture, 'LFR')) };
    } catch (err) {
      log(`no .LFR file for ${picture.name}: ${err.message}`);
    }
  }
  const raw = await camera.download('file', LytroCamera.pathOf(picture, 'RAW'));
  const txt = await camera.download('file', LytroCamera.pathOf(picture, 'TXT'));
  const parsed = JSON.parse(new TextDecoder().decode(txt).replace(/\0+$/, ''));
  const metaBytes = encodeJson(parsed.metadata || parsed);
  const privBytes = encodeJson(parsed.privateMetadata || parsed.private || {});
  const toc = { picture: { frameArray: [{ frame: { metadataRef: await refFor(metaBytes), privateMetadataRef: await refFor(privBytes), imageRef: await refFor(raw) } }] } };
  const { bytes } = await writeContainer([
    { type: 'LFC', data: metaBytes },
    { type: 'LFC', data: privBytes },
    { type: 'LFC', data: raw },
    { type: 'LFM', data: encodeJson(toc) },
  ]);
  return { name: `${picture.folder}_${picture.name}.lfp`, data: bytes };
}
