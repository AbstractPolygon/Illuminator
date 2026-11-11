// + Camera over Wi-Fi (the sidebar, under the library; desktop app): the first generation camera's Wi-Fi (electron/lytro-wifi.cjs). The person turns Wi-Fi on in the
// camera and joins its network on this computer; Connect then reaches the camera, and it shows in the Camera section like a camera on USB, with its
// photos ready to import. The camera is dropped when it stops answering or on Disconnect.

export const WIFI_CAMERA_PREFIX = 'lytro:wifi:';

export function initCameraWifi({ $, native, importFromCamera }) {
  const dialog = $('camera-wifi-dialog');
  let connectedId = null;
  let busy = false;

  const status = (text, error = false) => {
    $('camera-wifi-status').textContent = text;
    $('camera-wifi-status').classList.toggle('error', error);
  };

  function show() {
    $('camera-wifi-disconnect').hidden = !connectedId;
    $('camera-wifi-connect').disabled = busy;
  }

  // The cameras the app knows (native.onCamerasChanged): the Wi-Fi one, if there is one.
  function camerasChanged(cams) {
    const wifi = (cams || []).find((c) => String(c.id).startsWith(WIFI_CAMERA_PREFIX));
    connectedId = wifi ? wifi.id : null;
    if (dialog.open && !busy) status(wifi ? `Connected to ${wifi.label}: ${wifi.files.length} photo${wifi.files.length === 1 ? '' : 's'}.` : '');
    show();
  }

  function open() {
    status(connectedId ? 'A camera is connected over Wi-Fi.' : '');
    show();
    dialog.showModal();
  }

  async function connect() {
    if (busy) return;
    busy = true;
    show();
    status('Connecting to the camera…');
    try {
      const got = await native.connectCameraWifi($('camera-wifi-address').value.trim());
      connectedId = got.id;
      status(`Connected to ${got.label}: ${got.count} photo${got.count === 1 ? '' : 's'}.`);
      busy = false;
      show();
      // Straight to the camera's photos.
      dialog.close();
      if (importFromCamera) importFromCamera();
    } catch (err) {
      busy = false;
      show();
      status(String(err && err.message ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true);
    }
  }

  async function disconnect() {
    if (!connectedId) return;
    await native.disconnectCameraWifi(connectedId).catch(() => {});
    connectedId = null;
    status('Disconnected.');
    show();
  }

  $('camera-wifi-connect').onclick = (e) => {
    e.preventDefault();
    connect();
  };
  $('camera-wifi-disconnect').onclick = (e) => {
    e.preventDefault();
    disconnect();
  };
  return { open, camerasChanged };
}
