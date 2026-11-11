// Run inside a packaged macOS app by the desktop build (.github/workflows/desktop.yml), as `ELECTRON_RUN_AS_NODE=1 <app>/Contents/MacOS/Illuminator
// scripts/mac-app-check.cjs <app>/Contents/Resources/app.asar`: loads the app's own copies of the USB library and of the IOKit route to the first
// generation camera (lytro-scsi-mac.cjs, through koffi) for the app's architecture, lists USB devices and the SCSI devices macOS offers, and
// fails if either cannot be loaded or used.
const path = require('node:path');

const asar = path.resolve(process.argv[2]);
const usb = require(path.join(asar, 'node_modules', 'usb'));
const mac = require(path.join(asar, 'electron', 'lytro-scsi-mac.cjs'));
const devices = usb.getDeviceList();
const cameras = mac.listDevices();
const { loadError, seen } = mac.probe();
console.log(`${process.arch}: libusb sees ${devices.length} USB devices; IOKit SCSI scan: ${seen.length} devices (${seen.map((d) => `${d.vendor} ${d.product} type ${d.type} ${d.category || 'disk'}`).join('; ') || 'none'}), ${cameras.length} cameras`);
if (loadError) {
  console.error(`The IOKit route could not be loaded: ${loadError}`);
  process.exit(1);
}
