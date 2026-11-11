// Joining a Wi-Fi network from the desktop app, for the first generation camera's network (electron/lytro-wifi.cjs): the nearby networks, and joining
// one with its password, through each system's own Wi-Fi tool, run without a shell:
//   Windows  netsh wlan (show networks; a WPA2 profile written to a temporary file, added, then connect)
//   macOS    system_profiler SPAirPortDataType -json (the networks it sees), networksetup -setairportnetwork <device> <name> <password>
//   Linux    nmcli (NetworkManager): device wifi list, device wifi connect <name> password <password>
// The password is passed to the tool and not kept by Illuminator (the system keeps the network as it does for any it joins). The parsers are pure,
// so they are tested without a Wi-Fi card.

const { execFile } = require('node:child_process');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const run = (cmd, args, { timeout = 20000 } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) {
      const text = String(stderr || stdout || '').trim();
      err.message = text ? `${err.message.split('\n')[0]}: ${text.slice(0, 300)}` : err.message;
      reject(err);
    } else resolve(String(stdout));
  });
});

// A Lytro camera's network: its name says so (the exact name is not documented; the camera's networks seen so far are not known either).
const looksLikeLytro = (name) => /lytro/i.test(name);

// [{ name, signal (0-100 or null), secure, current }], Lytro networks first, then by signal; no duplicates.
function sortNetworks(list) {
  const seen = new Map();
  for (const n of list) {
    if (!n.name) continue;
    const had = seen.get(n.name);
    if (!had || (n.signal ?? -1) > (had.signal ?? -1) || n.current) seen.set(n.name, { ...had, ...n, current: !!(n.current || (had && had.current)) });
  }
  return [...seen.values()].sort((a, b) => (looksLikeLytro(b.name) - looksLikeLytro(a.name)) || (b.current - a.current) || ((b.signal ?? -1) - (a.signal ?? -1)) || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- Linux (NetworkManager)
// `nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY device wifi list`: fields separated by ':', a ':' inside a field written as '\:'.
function parseNmcli(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    const fields = [];
    let cur = '';
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '\\' && i + 1 < line.length) cur += line[++i];
      else if (line[i] === ':') { fields.push(cur); cur = ''; } else cur += line[i];
    }
    fields.push(cur);
    const [inUse, name, signal, security] = fields;
    if (!name) continue;
    out.push({ name, signal: Number.isFinite(+signal) ? +signal : null, secure: !!security && security !== '--', current: inUse === '*' });
  }
  return out;
}

// ---------------------------------------------------------------- Windows (netsh)
// `netsh wlan show networks mode=bssid`: "SSID 1 : name", then "Signal : 80%" and "Authentication : WPA2-Personal" lines under it.
function parseNetsh(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    const ssid = /^SSID \d+\s*:\s?(.*)$/.exec(line);
    if (ssid) {
      cur = { name: ssid[1].trim(), signal: null, secure: false, current: false };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const signal = /^Signal\s*:\s*(\d+)%/.exec(line);
    if (signal) cur.signal = Math.max(cur.signal ?? 0, +signal[1]);
    const auth = /^Authentication\s*:\s*(.+)$/.exec(line);
    if (auth) cur.secure = !/^open$/i.test(auth[1].trim());
  }
  return out.filter((n) => n.name);
}

// `netsh wlan show interfaces`: the network now joined ("SSID : name", not "BSSID").
function parseNetshCurrent(text) {
  const m = /^\s*SSID\s*:\s?(.*)$/m.exec(String(text));
  return m ? m[1].trim() : null;
}

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// A WLAN profile for a WPA2-Personal network with its password (netsh wlan add profile). Open networks get no key.
function windowsProfile(name, password) {
  const n = xmlEscape(name);
  const security = password
    ? `<authEncryption><authentication>WPA2PSK</authentication><encryption>AES</encryption><useOneX>false</useOneX></authEncryption><sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>${xmlEscape(password)}</keyMaterial></sharedKey>`
    : '<authEncryption><authentication>open</authentication><encryption>none</encryption><useOneX>false</useOneX></authEncryption>';
  return `<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1"><name>${n}</name><SSIDConfig><SSID><name>${n}</name></SSID></SSIDConfig><connectionType>ESS</connectionType><connectionMode>manual</connectionMode><MSM><security>${security}</security></MSM></WLANProfile>`;
}

// ---------------------------------------------------------------- macOS
// `system_profiler SPAirPortDataType -json`: the interface, the network joined and the other networks it sees.
function parseSystemProfiler(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { device: null, networks: [] };
  }
  const out = [];
  let device = null;
  for (const top of data.SPAirPortDataType || []) {
    for (const iface of top.spairport_airport_interfaces || []) {
      if (!device && iface._name) device = iface._name;
      const cur = iface.spairport_current_network_information;
      if (cur && cur._name) out.push({ name: cur._name, signal: null, secure: !/none/i.test(String(cur.spairport_security_mode || '')), current: true });
      for (const n of iface.spairport_airport_other_local_wireless_networks || []) {
        const rssi = /(-?\d+)\s*dBm/.exec(String(n.spairport_signal_noise || ''));
        out.push({ name: n._name, signal: rssi ? Math.max(0, Math.min(100, 2 * (+rssi[1] + 100))) : null, secure: !/none/i.test(String(n.spairport_security_mode || '')), current: false });
      }
    }
  }
  return { device, networks: out };
}

// ---------------------------------------------------------------- the calls the app makes
async function listNetworks({ platform = process.platform, exec = run } = {}) {
  if (platform === 'win32') {
    const [nets, iface] = await Promise.all([exec('netsh', ['wlan', 'show', 'networks', 'mode=bssid']), exec('netsh', ['wlan', 'show', 'interfaces']).catch(() => '')]);
    const current = parseNetshCurrent(iface);
    return sortNetworks(parseNetsh(nets).map((n) => ({ ...n, current: n.name === current })));
  }
  if (platform === 'darwin') return sortNetworks(parseSystemProfiler(await exec('system_profiler', ['SPAirPortDataType', '-json'], { timeout: 30000 })).networks);
  // (a fresh scan first; a scan that is refused still leaves the last list)
  await exec('nmcli', ['device', 'wifi', 'rescan']).catch(() => {});
  return sortNetworks(parseNmcli(await exec('nmcli', ['-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list'])));
}

// Joins `name` with `password` (empty for an open network). Resolves when the system says it has joined; the camera may still take a few seconds
// to hand out an address.
async function joinNetwork(name, password = '', { platform = process.platform, exec = run, tmpdir = os.tmpdir } = {}) {
  name = String(name || '');
  password = String(password || '');
  if (!name || name.length > 32) throw new Error('Choose the camera\'s Wi-Fi network.');
  if (password && (password.length < 8 || password.length > 63)) throw new Error('A Wi-Fi password is 8 to 63 characters long.');
  if (platform === 'win32') {
    // The profile holds the password: written to a private temporary file, added, then the file is deleted.
    const dir = await fsp.mkdtemp(path.join(tmpdir(), 'illuminator-wifi-'));
    const file = path.join(dir, 'profile.xml');
    try {
      await fsp.writeFile(file, windowsProfile(name, password), { mode: 0o600 });
      await exec('netsh', ['wlan', 'add', 'profile', `filename=${file}`, 'user=current']);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    await exec('netsh', ['wlan', 'connect', `name=${name}`, `ssid=${name}`]);
    return;
  }
  if (platform === 'darwin') {
    const { device } = parseSystemProfiler(await exec('system_profiler', ['SPAirPortDataType', '-json'], { timeout: 30000 }));
    const out = await exec('networksetup', ['-setairportnetwork', device || 'en0', name, ...(password ? [password] : [])]);
    // networksetup reports a wrong password on its output and still exits 0
    if (/could not|failed|error/i.test(out)) throw new Error(out.trim());
    return;
  }
  await exec('nmcli', ['device', 'wifi', 'connect', name, ...(password ? ['password', password] : [])], { timeout: 45000 });
}

module.exports = { listNetworks, joinNetwork, parseNmcli, parseNetsh, parseNetshCurrent, parseSystemProfiler, windowsProfile, sortNetworks, looksLikeLytro };
