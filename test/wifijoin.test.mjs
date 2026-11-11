// Joining the camera's Wi-Fi network (electron/wifijoin.cjs): what each system's Wi-Fi tool prints is read right, and the tool is asked the right
// thing, with a stand-in for running it (no Wi-Fi card here). The password goes to the tool and nowhere else; on Windows its profile file is removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const w = require('../electron/wifijoin.cjs');

test('Linux: nmcli lines, with escaped colons, the joined network and open ones', () => {
  const text = [
    '*:Home\\:Net:72:WPA2',
    ' :LYTRO-0A1B:55:WPA2',
    ' :Cafe:90:--',
    ' ::40:WPA2', // a hidden network: no name
    ' :LYTRO-0A1B:30:WPA2', // the same network on another access point
  ].join('\n');
  const list = w.sortNetworks(w.parseNmcli(text));
  assert.deepEqual(list.map((n) => n.name), ['LYTRO-0A1B', 'Home:Net', 'Cafe'], 'Lytro first, then the joined one, then by signal');
  assert.deepEqual(list[0], { name: 'LYTRO-0A1B', signal: 55, secure: true, current: false });
  assert.equal(list[1].current, true);
  assert.equal(list[2].secure, false);
});

test('Windows: netsh networks and the network joined', () => {
  const nets = `
Interface name : Wi-Fi
There are 2 networks currently visible.

SSID 1 : Office
    Network type            : Infrastructure
    Authentication          : WPA2-Personal
    Encryption              : CCMP
    BSSID 1                 : aa:bb:cc:dd:ee:ff
         Signal             : 81%
SSID 2 : LYTRO-77
    Network type            : Infrastructure
    Authentication          : Open
    Encryption              : None
    BSSID 1                 : 11:22:33:44:55:66
         Signal             : 40%
`;
  const list = w.parseNetsh(nets);
  assert.deepEqual(list, [{ name: 'Office', signal: 81, secure: true, current: false }, { name: 'LYTRO-77', signal: 40, secure: false, current: false }]);
  assert.equal(w.parseNetshCurrent('    Name                   : Wi-Fi\r\n    SSID                   : Office\r\n    BSSID                  : aa:bb\r\n'), 'Office');
  assert.equal(w.parseNetshCurrent('    State : disconnected\n'), null);
});

test('macOS: system_profiler JSON, the device, the joined network and the others with their signal', () => {
  const json = JSON.stringify({ SPAirPortDataType: [{ spairport_airport_interfaces: [{
    _name: 'en0',
    spairport_current_network_information: { _name: 'Home', spairport_security_mode: 'spairport_security_mode_wpa2_personal' },
    spairport_airport_other_local_wireless_networks: [
      { _name: 'LYTRO-9', spairport_security_mode: 'spairport_security_mode_wpa2_personal', spairport_signal_noise: '-60 dBm / -90 dBm' },
      { _name: 'Guest', spairport_security_mode: 'spairport_security_mode_none' },
    ],
  }] }] });
  const r = w.parseSystemProfiler(json);
  assert.equal(r.device, 'en0');
  assert.deepEqual(r.networks, [
    { name: 'Home', signal: null, secure: true, current: true },
    { name: 'LYTRO-9', signal: 80, secure: true, current: false },
    { name: 'Guest', signal: null, secure: false, current: false },
  ]);
  assert.deepEqual(w.parseSystemProfiler('not json'), { device: null, networks: [] });
});

test('joining: the tool and arguments each system takes, and passwords a network cannot have are refused first', async () => {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'system_profiler') return JSON.stringify({ SPAirPortDataType: [{ spairport_airport_interfaces: [{ _name: 'en1' }] }] });
    return '';
  };
  await w.joinNetwork('LYTRO-9', 'password1', { platform: 'linux', exec });
  assert.deepEqual(calls.pop(), ['nmcli', 'device', 'wifi', 'connect', 'LYTRO-9', 'password', 'password1']);
  await w.joinNetwork('LYTRO-9', '', { platform: 'linux', exec });
  assert.deepEqual(calls.pop(), ['nmcli', 'device', 'wifi', 'connect', 'LYTRO-9'], 'an open network: no password');
  await w.joinNetwork('LYTRO-9', 'password1', { platform: 'darwin', exec });
  assert.deepEqual(calls.pop(), ['networksetup', '-setairportnetwork', 'en1', 'LYTRO-9', 'password1'], 'on the Wi-Fi device system_profiler names');
  await assert.rejects(w.joinNetwork('LYTRO-9', 'short', { platform: 'linux', exec }), /8 to 63 characters/);
  await assert.rejects(w.joinNetwork('', 'password1', { platform: 'linux', exec }), /Choose the camera's Wi-Fi network/);
  // macOS reports a wrong password on its output and still succeeds
  const wrong = async (cmd) => (cmd === 'system_profiler' ? '{}' : 'Could not find network LYTRO-9.');
  await assert.rejects(w.joinNetwork('LYTRO-9', 'password1', { platform: 'darwin', exec: wrong }), /Could not find network/);
});

test('Windows: a WPA2 profile with the password, added from a private temporary file that is removed afterwards', async () => {
  const calls = [];
  let profile = null;
  let profilePath = null;
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const f = args.find((a) => a.startsWith('filename='));
    if (f) {
      profilePath = f.slice('filename='.length);
      profile = fs.readFileSync(profilePath, 'utf8');
    }
    return '';
  };
  await w.joinNetwork('Cam & <Co>', 'p"ass\'word<1>', { platform: 'win32', exec, tmpdir: os.tmpdir });
  assert.deepEqual(calls[0].slice(0, 4), ['netsh', 'wlan', 'add', 'profile']);
  assert.deepEqual(calls[1], ['netsh', 'wlan', 'connect', 'name=Cam & <Co>', 'ssid=Cam & <Co>']);
  assert.match(profile, /<name>Cam &amp; &lt;Co&gt;<\/name>/);
  assert.match(profile, /<keyMaterial>p&quot;ass&apos;word&lt;1&gt;<\/keyMaterial>/);
  assert.match(profile, /<authentication>WPA2PSK<\/authentication>/);
  assert.equal(fs.existsSync(profilePath), false, 'the file with the password is gone');
  assert.equal(fs.existsSync(path.dirname(profilePath)), false);
  assert.match(w.windowsProfile('Open', ''), /<authentication>open<\/authentication>/);
  assert.doesNotMatch(w.windowsProfile('Open', ''), /keyMaterial/);
});

test('listing goes through each system\'s tool', async () => {
  const seen = [];
  const exec = async (cmd, args) => {
    seen.push([cmd, ...args].join(' '));
    if (cmd === 'nmcli' && args[0] === '-t') return ' :LYTRO-1:50:WPA2\n';
    if (cmd === 'netsh' && args[2] === 'networks') return 'SSID 1 : LYTRO-2\n Authentication : WPA2-Personal\n Signal : 60%\n';
    if (cmd === 'netsh') return ' SSID : LYTRO-2\n';
    return '{}';
  };
  assert.deepEqual((await w.listNetworks({ platform: 'linux', exec })).map((n) => n.name), ['LYTRO-1']);
  assert.deepEqual(await w.listNetworks({ platform: 'win32', exec }), [{ name: 'LYTRO-2', signal: 60, secure: true, current: true }]);
  assert.deepEqual(await w.listNetworks({ platform: 'darwin', exec }), []);
  assert.ok(seen.includes('nmcli device wifi rescan'));
});
