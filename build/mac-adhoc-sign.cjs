// electron-builder afterPack hook: an ad-hoc signature for the macOS app.
//
// There is no Developer ID certificate (docs/code-signing.md), so electron-builder skips signing. But packing changes the bundle (Info.plist, the app's name, app.asar),
// which breaks the signature Electron's binaries came with, and Apple Silicon refuses to run code whose signature is missing or broken: macOS then says the app "is damaged
// and can't be opened". An ad-hoc signature (no certificate, `codesign --sign -`) makes the bundle valid again; Gatekeeper still asks once, as for any app from outside the
// App Store that is not notarized (System Settings > Privacy & Security > Open Anyway).
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
};
