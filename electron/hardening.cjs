'use strict';
// What the page may do beyond itself, as pure predicates so the rules can be tested without a window. main.cjs only
// wires them to Electron's events.

// The page never leaves its own origin: every other address (links, redirects, a dropped file) is cancelled. A parsed
// URL instead of a prefix test, so 'app://lytro.evil/' or 'app:lytro' cannot slip through.
function isAllowedNavigation(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'app:' && u.hostname === 'lytro';
  } catch {
    return false;
  }
}

// Links to other sites open in the browser, never inside the app. Only http(s) goes out: javascript:, file:, app: and
// the rest are dropped (the system would hand them to whatever program is registered for them).
function classifyWindowOpen(url) {
  return /^https?:/i.test(String(url)) ? 'external' : 'deny';
}

// What the page may ask the system for: fullscreen, copying text to the clipboard and (for cameras) WebUSB, which the
// device handler narrows to Lytro cameras. Camera, microphone, location, notifications, MIDI, HID, serial and the rest are refused.
const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write', 'usb']);
const isAllowedPermission = (permission) => ALLOWED_PERMISSIONS.has(permission);

function installPermissions(ses) {
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(isAllowedPermission(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => isAllowedPermission(permission));
}

module.exports = { isAllowedNavigation, classifyWindowOpen, isAllowedPermission, installPermissions, ALLOWED_PERMISSIONS };
