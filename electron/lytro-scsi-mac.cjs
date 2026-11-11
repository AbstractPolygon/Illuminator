// The first generation camera on macOS, with no special rights: the vendor commands of lytro-protocol.cjs go to the camera's SCSI device through
// IOKit's SCSITask interface (SCSITaskLib), the user-space route macOS offers for SCSI devices no system driver takes as a disk: "SCSITaskUserClient"
// devices (a device type macOS has no driver for) and "authoring" devices (CD and DVD type). It is the counterpart of lytro-scsi-win.cjs, which
// sends the same commands through the camera's disk on Windows as Lytro Desktop's service does. libusb cannot be used: macOS's storage driver
// keeps the camera's only USB interface, and taking it needs root or an Apple entitlement (LIBUSB_ERROR_ACCESS otherwise).
//
// The camera is found by its SCSI identity ("ZORAN" / "COACH6 (I62)", "Lytro" / "F01", "Lytro" / "8GB Camera"). Exclusive access is taken for the
// time the camera is open (macOS refuses it while a volume of the device is mounted: that volume is unmounted first, as any user may for a removable
// device). When the camera shows only as a plain disk, which no user-space SCSI route reaches, the error says so with what macOS reported.
//
// Interface layouts (Apple's SCSITaskLib.h, 64-bit): IUNKNOWN_C_GUTS (reserved, QueryInterface, AddRef, Release) then UInt16 version and revision,
// so the first method is at byte 40 and each next one 8 further. The IOKit calls come from `koffi` (loaded on demand); `api` can be replaced (tests).

const { execFileSync } = require('node:child_process');
const { LytroCamera } = require('./lytro-protocol.cjs');
const { isFirstGeneration } = require('./lytro-scsi-win.cjs');

const FIRST_GENERATION_PRODUCT = 0x00a1;
const TIMEOUT_MS = 100000;
const DATA_NONE = 0;
const DATA_OUT = 1; // kSCSIDataTransfer_FromInitiatorToTarget
const DATA_IN = 2; // kSCSIDataTransfer_FromTargetToInitiator
const IO_RETURN_BUSY = 0xe00002d5;
const IO_RETURN_EXCLUSIVE = 0xe00002c5;

const USER_CLIENT_DEVICE = 'SCSITaskUserClientDevice';
const AUTHORING_DEVICE = 'SCSITaskAuthoringDevice';

// UUIDs (SCSITaskLib.h, IOCFPlugIn.h).
const UUID = {
  plugInInterface: 'C244E858-109C-11D4-91D4-0050E4C6426F',
  taskDeviceUserClientType: '7D66678E-08A2-11D5-A1B8-0030657D052A',
  mmcDeviceUserClientType: '97ABCF2C-23CC-11D5-A0E8-003065704866',
  taskDeviceInterface: '1BBC4132-08A5-11D5-90ED-0030657D052A',
  mmcDeviceInterface: '1F651106-23CC-11D5-BBDB-003065704866',
};
const uuidBytes = (s) => Array.from(Buffer.from(s.replace(/-/g, ''), 'hex'));

// Byte offsets of the methods used, in each interface's function table.
const method = (i) => 40 + 8 * i;
const IUNKNOWN = { queryInterface: 8, release: 24 };
const MMC = { getSCSITaskDeviceInterface: method(12) };
const TASK_DEVICE = { isExclusiveAccessAvailable: method(0), obtainExclusiveAccess: method(3), releaseExclusiveAccess: method(4), createSCSITask: method(5) };
const TASK = { setCommandDescriptorBlock: method(3), setScatterGatherEntries: method(6), setTimeoutDuration: method(7), executeTaskSync: method(11), getSCSIServiceResponse: method(13) };

let loadError = null;
let lastScan = { seen: [] };

// The function types of the interface methods used (CFUUIDBytes is passed by value to QueryInterface).
function prototypes(koffi) {
  if (!prototypes.done) {
    koffi.struct('CFUUIDBytes', { b: koffi.array('uint8', 16) });
    prototypes.done = {
      queryInterface: koffi.proto('int32 QueryInterfaceFn(void *self, CFUUIDBytes iid, _Out_ void **ppv)'),
      release: koffi.proto('uint32 ReleaseFn(void *self)'),
      getTaskDevice: koffi.proto('void *GetTaskDeviceFn(void *self)'),
      boolOf: koffi.proto('uint8 BoolFn(void *self)'),
      status: koffi.proto('int32 StatusFn(void *self)'),
      create: koffi.proto('void *CreateFn(void *self)'),
      setCdb: koffi.proto('int32 SetCdbFn(void *task, uint8_t *cdb, uint8 size)'),
      setSg: koffi.proto('int32 SetSgFn(void *task, void *list, uint8 entries, uint64 count, uint8 direction)'),
      setTimeout: koffi.proto('int32 SetTimeoutFn(void *task, uint32 ms)'),
      execute: koffi.proto('int32 ExecuteFn(void *task, uint8_t *sense, _Out_ uint32 *status, _Out_ uint64 *count)'),
      response: koffi.proto('int32 ResponseFn(void *task, _Out_ uint32 *response)'),
    };
  }
  return prototypes.done;
}

// A method of a COM-style interface `obj` (a pointer to a pointer to its function table), called with `obj` as its first argument.
function comCall(koffi, obj, offset, type, ...args) {
  const table = koffi.decode(obj, 'void *');
  return koffi.call(koffi.decode(table, offset, 'void *'), type, obj, ...args);
}

// QueryInterface for the interface `id` (a UUID string): the interface pointer, or null.
function comQueryInterface(koffi, obj, id) {
  const out = [null];
  const r = comCall(koffi, obj, IUNKNOWN.queryInterface, prototypes(koffi).queryInterface, { b: uuidBytes(id) }, out);
  return r === 0 ? out[0] : null;
}

// The methods of an open SCSITaskDeviceInterface: exclusive access, and one command as an SCSITask (create, set the command block, the
// transfer and the timeout, run it, read the status, release it).
function taskOps(koffi) {
  const proto = prototypes(koffi);
  const call = (obj, offset, type, ...args) => comCall(koffi, obj, offset, type, ...args);
  return {
    obtainExclusive: (device) => call(device, TASK_DEVICE.obtainExclusiveAccess, proto.status) >>> 0,
    releaseExclusive: (device) => call(device, TASK_DEVICE.releaseExclusiveAccess, proto.status),
    // One command: { status (SCSI), response (service response), transferred, data (Buffer read, for DATA_IN) }.
    execute(device, cdb, direction, length, payload, timeoutMs) {
      const task = call(device, TASK_DEVICE.createSCSITask, proto.create);
      if (!task) throw new Error('macOS could not make a SCSI task for the camera');
      const mem = length ? koffi.alloc('uint8_t', length) : null;
      try {
        const block = Buffer.alloc(cdb.length <= 6 ? 6 : cdb.length <= 10 ? 10 : cdb.length <= 12 ? 12 : 16);
        cdb.copy(block, 0, 0, Math.min(block.length, cdb.length));
        let r = call(task, TASK.setCommandDescriptorBlock, proto.setCdb, block, block.length);
        if (r !== 0) throw new Error(`The command could not be set (IOKit error 0x${(r >>> 0).toString(16)})`);
        if (mem) {
          if (payload) koffi.encode(mem, koffi.array('uint8_t', length), Array.from(payload));
          const sg = Buffer.alloc(16);
          sg.writeBigUInt64LE(BigInt(koffi.address(mem)), 0);
          sg.writeBigUInt64LE(BigInt(length), 8);
          r = call(task, TASK.setScatterGatherEntries, proto.setSg, sg, 1, length, direction);
          if (r !== 0) throw new Error(`The transfer could not be set (IOKit error 0x${(r >>> 0).toString(16)})`);
        }
        call(task, TASK.setTimeoutDuration, proto.setTimeout, timeoutMs);
        const sense = Buffer.alloc(32);
        const status = [0];
        const count = [0];
        r = call(task, TASK.executeTaskSync, proto.execute, sense, status, count);
        if (r !== 0) throw new Error(`The camera could not be reached (IOKit error 0x${(r >>> 0).toString(16)})`);
        const response = [0];
        call(task, TASK.getSCSIServiceResponse, proto.response, response);
        const transferred = Number(count[0]);
        const data = mem && direction === DATA_IN ? Buffer.from(koffi.decode(mem, koffi.array('uint8_t', length, 'Typed'))).subarray(0, Math.min(length, transferred)) : Buffer.alloc(0);
        return { status: status[0], response: response[0], transferred, data, sense };
      } finally {
        if (mem) koffi.free(mem);
        call(task, IUNKNOWN.release, proto.release);
      }
    },
  };
}

function macApi() {
  if (process.platform !== 'darwin') return null;
  let koffi;
  try {
    koffi = require('koffi');
  } catch (err) {
    loadError = err.message;
    return null;
  }
  let io;
  let cf;
  try {
    io = koffi.load('/System/Library/Frameworks/IOKit.framework/IOKit');
    cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  } catch (err) {
    loadError = err.message;
    return null;
  }
  const UTF8 = 0x08000100;
  const f = {
    IOServiceMatching: io.func('void *IOServiceMatching(const char *name)'),
    IOServiceGetMatchingServices: io.func('int32 IOServiceGetMatchingServices(uint32 mainPort, void *matching, _Out_ uint32 *existing)'),
    IOIteratorNext: io.func('uint32 IOIteratorNext(uint32 iterator)'),
    IOServiceGetMatchingService: io.func('uint32 IOServiceGetMatchingService(uint32 mainPort, void *matching)'),
    IORegistryEntryIDMatching: io.func('void *IORegistryEntryIDMatching(uint64 entryID)'),
    IORegistryEntryGetRegistryEntryID: io.func('int32 IORegistryEntryGetRegistryEntryID(uint32 entry, _Out_ uint64 *entryID)'),
    IOObjectRelease: io.func('int32 IOObjectRelease(uint32 object)'),
    IORegistryEntryCreateCFProperty: io.func('void *IORegistryEntryCreateCFProperty(uint32 entry, void *key, void *allocator, uint32 options)'),
    IORegistryEntrySearchCFProperty: io.func('void *IORegistryEntrySearchCFProperty(uint32 entry, const char *plane, void *key, void *allocator, uint32 options)'),
    IOCreatePlugInInterfaceForService: io.func('int32 IOCreatePlugInInterfaceForService(uint32 service, void *pluginType, void *interfaceType, _Out_ void **theInterface, _Out_ int32 *theScore)'),
    IODestroyPlugInInterface: io.func('int32 IODestroyPlugInInterface(void *iface)'),
    CFStringCreateWithCString: cf.func('void *CFStringCreateWithCString(void *allocator, const char *s, uint32 encoding)'),
    CFStringGetCString: cf.func('bool CFStringGetCString(void *s, _Out_ uint8_t *buffer, long size, uint32 encoding)'),
    CFGetTypeID: cf.func('unsigned long CFGetTypeID(void *cf)'),
    CFStringGetTypeID: cf.func('unsigned long CFStringGetTypeID()'),
    CFNumberGetTypeID: cf.func('unsigned long CFNumberGetTypeID()'),
    CFNumberGetValue: cf.func('bool CFNumberGetValue(void *number, int32 type, _Out_ int32 *value)'),
    CFUUIDCreateFromString: cf.func('void *CFUUIDCreateFromString(void *allocator, void *uuidString)'),
    CFRelease: cf.func('void CFRelease(void *cf)'),
  };
  const proto = prototypes(koffi);
  const cfString = (s) => f.CFStringCreateWithCString(null, s, UTF8);
  const uuid = (s) => {
    const str = cfString(s);
    const u = f.CFUUIDCreateFromString(null, str);
    f.CFRelease(str);
    return u;
  };
  // A CF value as a JS string or number (null for anything else), released.
  const fromCF = (v) => {
    if (!v) return null;
    try {
      const t = f.CFGetTypeID(v);
      if (t === f.CFStringGetTypeID()) {
        const buf = Buffer.alloc(256);
        return f.CFStringGetCString(v, buf, buf.length, UTF8) ? buf.toString('utf8', 0, buf.indexOf(0)).trim() : null;
      }
      if (t === f.CFNumberGetTypeID()) {
        const out = [0];
        return f.CFNumberGetValue(v, 3, out) ? out[0] : null;
      }
      return null;
    } finally {
      f.CFRelease(v);
    }
  };
  const own = (entry, key) => {
    const k = cfString(key);
    try {
      return fromCF(f.IORegistryEntryCreateCFProperty(entry, k, null, 0));
    } finally {
      f.CFRelease(k);
    }
  };
  // kIORegistryIterateRecursively (1), with kIORegistryIterateParents (2) to look up the tree.
  const search = (entry, key, up) => {
    const k = cfString(key);
    try {
      return fromCF(f.IORegistryEntrySearchCFProperty(entry, 'IOService', k, null, up ? 3 : 1));
    } finally {
      f.CFRelease(k);
    }
  };
  const call = (obj, offset, type, ...args) => comCall(koffi, obj, offset, type, ...args);
  const queryInterface = (obj, id) => comQueryInterface(koffi, obj, id);
  return {
    // The SCSI devices macOS offers to apps, and the plain disks next to them (for the message): [{ id, cls, category, vendor, product, type, bsd }],
    // `id` the registry entry ID (stable while the device is plugged in).
    candidates() {
      const out = [];
      for (const cls of ['IOSCSIPeripheralDeviceNub', 'IOSCSIPeripheralDeviceType05', 'IOSCSIPeripheralDeviceType00']) {
        const it = [0];
        if (f.IOServiceGetMatchingServices(0, f.IOServiceMatching(cls), it) !== 0) continue;
        for (let s = f.IOIteratorNext(it[0]); s; s = f.IOIteratorNext(it[0])) {
          const id = [0n];
          f.IORegistryEntryGetRegistryEntryID(s, id);
          out.push({
            id: String(id[0]),
            cls,
            category: own(s, 'SCSITaskDeviceCategory'),
            vendor: search(s, 'Vendor Identification', true),
            product: search(s, 'Product Identification', true),
            type: search(s, 'Peripheral Device Type', true),
            bsd: search(s, 'BSD Name', false),
          });
          f.IOObjectRelease(s);
        }
        f.IOObjectRelease(it[0]);
      }
      return out;
    },
    // The SCSITaskDeviceInterface of a candidate: { device, close } (exclusive access not taken yet).
    open({ id, category }) {
      const service = f.IOServiceGetMatchingService(0, f.IORegistryEntryIDMatching(BigInt(id)));
      if (!service) throw new Error('The camera is no longer there');
      const mmc = category === AUTHORING_DEVICE;
      const typeId = uuid(mmc ? UUID.mmcDeviceUserClientType : UUID.taskDeviceUserClientType);
      const plugInId = uuid(UUID.plugInInterface);
      const plugin = [null];
      const score = [0];
      const r = f.IOCreatePlugInInterfaceForService(service, typeId, plugInId, plugin, score);
      f.IOObjectRelease(service);
      f.CFRelease(typeId);
      f.CFRelease(plugInId);
      if (r !== 0 || !plugin[0]) throw new Error(`macOS would not open the camera's SCSI device (IOKit error 0x${(r >>> 0).toString(16)})`);
      let mmcInterface = null;
      let device = null;
      if (mmc) {
        mmcInterface = queryInterface(plugin[0], UUID.mmcDeviceInterface);
        if (mmcInterface) device = call(mmcInterface, MMC.getSCSITaskDeviceInterface, proto.getTaskDevice);
      } else {
        device = queryInterface(plugin[0], UUID.taskDeviceInterface);
      }
      const close = () => {
        if (device && !mmc) call(device, IUNKNOWN.release, proto.release);
        if (mmcInterface) call(mmcInterface, IUNKNOWN.release, proto.release);
        f.IODestroyPlugInInterface(plugin[0]);
      };
      if (!device) {
        close();
        throw new Error("macOS gave no SCSI task interface for the camera's device");
      }
      return { device, close };
    },
    ...taskOps(koffi),
    unmount(bsd) {
      execFileSync('diskutil', ['unmountDisk', `/dev/${bsd}`], { stdio: 'ignore', timeout: 30000 });
    },
  };
}

const describe = (c) => `${c.vendor || '?'} ${c.product || '?'} (type ${c.type ?? '?'}${c.category ? `, ${c.category}` : ''}${c.bsd ? `, ${c.bsd}` : ''})`;

// First generation cameras macOS lets an app send SCSI commands to: [{ key, candidate, product }].
function listDevices(api = macApi()) {
  if (!api) {
    lastScan = { seen: [] };
    return [];
  }
  const found = [];
  const seen = [];
  let candidates = [];
  try {
    candidates = api.candidates();
  } catch (err) {
    loadError = err.message;
  }
  for (const c of candidates) {
    const camera = isFirstGeneration({ vendor: c.vendor || '', product: c.product || '' });
    seen.push(c);
    if (camera && (c.category === USER_CLIENT_DEVICE || c.category === AUTHORING_DEVICE) && !found.some((d) => d.candidate.vendor === c.vendor && d.candidate.bsd === c.bsd && d.candidate.category === c.category)) {
      found.push({ key: `scsi-mac:${c.id}`, candidate: c, product: FIRST_GENERATION_PRODUCT });
    }
  }
  lastScan = { seen };
  return found;
}

// Why no camera was found this way (for the message shown when the camera is on USB but could not be used).
function scanStatus() {
  if (process.platform !== 'darwin') return '';
  if (loadError) return `The macOS call library (koffi) could not be loaded in this build: ${loadError}`;
  const cams = lastScan.seen.filter((c) => isFirstGeneration({ vendor: c.vendor || '', product: c.product || '' }));
  if (cams.length) return `macOS shows the camera only as a disk (${cams.map(describe).join('; ')}), which apps cannot send the camera's commands to.`;
  return `macOS lists no SCSI device that is the camera (${lastScan.seen.map(describe).join('; ') || 'none'}).`;
}

class MacScsiTransport {
  constructor(api, device, timeoutMs = TIMEOUT_MS) {
    this.api = api;
    this.device = device;
    this.timeoutMs = timeoutMs;
  }

  run(cdb, direction, length, payload = null) {
    const r = this.api.execute(this.device, cdb, direction, length, payload, this.timeoutMs);
    if (r.status !== 0) throw new Error(`The camera refused the command (SCSI status ${r.status})`);
    return r;
  }

  async read(cdb, size) {
    return Buffer.from(this.run(cdb, size ? DATA_IN : DATA_NONE, size).data);
  }

  async write(cdb, data) {
    this.run(cdb, data.length ? DATA_OUT : DATA_NONE, data.length, data);
  }

  setTimeout(ms) {
    this.timeoutMs = ms;
  }

  async waitReady() {
    return true;
  }
}

// Opens a camera found by listDevices: { camera, close, product }.
async function connect({ candidate }, log = () => {}, api = macApi()) {
  if (!api) throw new Error('This computer cannot reach the camera through its SCSI device (the macOS call library is not available in this build).');
  const { device, close } = api.open(candidate);
  let r = api.obtainExclusive(device);
  if (r === IO_RETURN_BUSY && candidate.bsd) {
    log(`${candidate.bsd} is mounted: unmounting it to reach the camera`);
    try {
      api.unmount(candidate.bsd);
    } catch (err) {
      log(`unmount failed: ${err.message}`);
    }
    r = api.obtainExclusive(device);
  }
  if (r !== 0) {
    close();
    throw new Error(r === IO_RETURN_EXCLUSIVE ? 'Another program has the camera open (close Lytro Desktop, which keeps the camera to itself) and try again.' : r === IO_RETURN_BUSY ? "macOS has the camera's volume in use: eject it in the Finder and try again." : `macOS would not give the camera to Illuminator (IOKit error 0x${r.toString(16)}).`);
  }
  log(`${describe(candidate)}: opened`);
  return {
    camera: new LytroCamera(new MacScsiTransport(api, device), log),
    product: FIRST_GENERATION_PRODUCT,
    close: async () => {
      try {
        api.releaseExclusive(device);
      } finally {
        close();
      }
    },
  };
}

module.exports = { prototypes, comCall, comQueryInterface, taskOps, listDevices, connect, scanStatus, MacScsiTransport, UUID, uuidBytes, MMC, TASK_DEVICE, TASK, IUNKNOWN, DATA_IN, DATA_OUT, DATA_NONE, USER_CLIENT_DEVICE, AUTHORING_DEVICE, IO_RETURN_BUSY };
