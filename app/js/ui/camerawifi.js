// + Connect over Wi-Fi (the sidebar, under the library; desktop app): the camera's Wi-Fi (electron/lytro-wifi.cjs; first generation, and the ILLUM
// where it speaks the same protocol or offers Android debugging). The person turns
// Wi-Fi on in the camera, chooses its network here and types its password; the app joins that network (electron/wifijoin.cjs) and reaches the
// camera, which then shows in the Camera section like a camera on USB, with its photos ready to import. The camera is dropped when it stops answering
// or on Disconnect. The password is handed to the system's Wi-Fi tool and not kept by the page.

export const WIFI_CAMERA_PREFIX = 'lytro:wifi:';

export function initCameraWifi({ $, native, importFromCamera }) {
  const dialog = $('camera-wifi-dialog');
  const select = $('camera-wifi-network');
  let connectedId = null;
  let busy = false;
  let networks = [];

  const status = (text, error = false) => {
    $('camera-wifi-status').textContent = text;
    $('camera-wifi-status').classList.toggle('error', error);
  };
  const chosen = () => networks.find((n) => n.name === select.value) || null;
  // (Electron puts the channel's name before the message)
  const message = (err) => String(err && err.message ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  function show() {
    $('camera-wifi-disconnect').hidden = !connectedId;
    $('camera-wifi-connect').disabled = busy || !chosen();
    $('camera-wifi-refresh').disabled = busy;
    // (no password for the network the computer is on already, nor for an open one)
    const net = chosen();
    $('camera-wifi-password').disabled = busy || !net || net.current || !net.secure;
  }

  // The camera's network first (the list puts Lytro networks first), then the others.
  async function loadNetworks() {
    busy = true;
    show();
    status('Looking for Wi-Fi networks…');
    try {
      networks = await native.cameraWifiNetworks();
      const keep = select.value;
      select.replaceChildren(...networks.map((n) => new Option(`${n.name}${n.current ? ' (joined)' : ''}${n.secure ? '' : ' (open)'}`, n.name)));
      if (networks.some((n) => n.name === keep)) select.value = keep;
      if (!networks.length) status('No Wi-Fi networks found. Turn on the camera\'s Wi-Fi, then press Refresh.', true);
      else status(connectedId ? 'A camera is connected over Wi-Fi.' : '');
    } catch (err) {
      networks = [];
      select.replaceChildren();
      status(`The Wi-Fi networks could not be listed: ${message(err)}`, true);
    }
    busy = false;
    show();
  }

  // The cameras the app knows (native.onCamerasChanged): the Wi-Fi one, if there is one.
  function camerasChanged(cams) {
    const wifi = (cams || []).find((c) => String(c.id).startsWith(WIFI_CAMERA_PREFIX));
    connectedId = wifi ? wifi.id : null;
    if (dialog.open && !busy && wifi) status(`Connected to ${wifi.label}: ${wifi.files.length} photo${wifi.files.length === 1 ? '' : 's'}.`);
    show();
  }

  function open() {
    $('camera-wifi-password').value = '';
    status(connectedId ? 'A camera is connected over Wi-Fi.' : '');
    show();
    dialog.showModal();
    loadNetworks();
  }

  async function connect() {
    const net = chosen();
    if (busy || !net) return;
    busy = true;
    show();
    status(net.current ? 'Connecting to the camera…' : `Joining ${net.name}, then connecting to the camera…`);
    const password = $('camera-wifi-password').value;
    $('camera-wifi-password').value = '';
    try {
      const got = await native.connectCameraWifi({ network: net.name, password, join: !net.current });
      if (got.via === 'adb') {
        // (Android debugging: the camera shows in the Camera section once its photos have been listed)
        status('Connected through Android debugging over Wi-Fi. The camera\'s photos show in the Camera section in a moment.');
        busy = false;
        show();
        return;
      }
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
      status(message(err), true);
    }
  }

  async function disconnect() {
    if (!connectedId) return;
    await native.disconnectCameraWifi(connectedId).catch(() => {});
    connectedId = null;
    status('Disconnected. This computer stays on the camera\'s network until you join another.');
    show();
  }

  select.onchange = () => show();
  $('camera-wifi-refresh').onclick = () => loadNetworks();
  $('camera-wifi-connect').onclick = (e) => {
    e.preventDefault();
    connect();
  };
  $('camera-wifi-password').onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      connect();
    }
  };
  $('camera-wifi-disconnect').onclick = (e) => {
    e.preventDefault();
    disconnect();
  };
  return { open, camerasChanged };
}
