// The HDR JPEG container (core/ultrahdr.js): two JPEGs in one file with the metadata a viewer needs to find the second, and the gain formula. The two small JPEGs in test/fixtures
// were made by an ordinary encoder, so the bytes the container is put around are real.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildUltraHdr, readUltraHdr, applyGain, gainByte, GAIN_LOG2_MAX } from '../app/js/core/ultrahdr.js';

const fixture = (name) => new Uint8Array(fs.readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));
const base = fixture('hdr-base.jpg');
const gain = fixture('hdr-gain.jpg');

const text = (bytes) => new TextDecoder('latin1').decode(bytes);

test('the file holds the ordinary picture first, the gain map after it, and the Multi-Picture entries say where', () => {
  const file = buildUltraHdr(base, gain);
  const r = readUltraHdr(file);
  // both are whole JPEGs: SOI first, EOI last
  for (const part of [r.primary, r.gain]) {
    assert.deepEqual([part[0], part[1]], [0xff, 0xd8]);
    assert.deepEqual([part[part.length - 2], part[part.length - 1]], [0xff, 0xd9]);
  }
  assert.equal(r.primary.length + r.gain.length, file.length, 'nothing else in the file');
  assert.equal(file[0], 0xff);
  assert.ok(r.primary.length > base.length, 'the ordinary picture carries the added segments');
  // the picture data itself is untouched: the original's bytes from its first non-header segment on are all still there
  const scanStart = base.findIndex((b, i) => b === 0xff && base[i + 1] === 0xda);
  const scan = text(base.subarray(scanStart));
  assert.ok(text(r.primary).endsWith(scan), 'the compressed picture is as it was');
  const gainScan = text(gain.subarray(gain.findIndex((b, i) => b === 0xff && gain[i + 1] === 0xda)));
  assert.ok(text(r.gain).endsWith(gainScan));
});

test('the metadata names the gain map and its range, and the container lists both pictures', () => {
  const file = buildUltraHdr(base, gain);
  const r = readUltraHdr(file);
  assert.deepEqual(r.gainMeta, { min: 0, max: GAIN_LOG2_MAX, gamma: 1, capacityMax: GAIN_LOG2_MAX });
  const head = text(r.primary.subarray(0, 2000));
  assert.match(head, /http:\/\/ns\.adobe\.com\/xap\/1\.0\//);
  assert.match(head, /Item:Semantic="Primary"/);
  assert.match(head, new RegExp(`Item:Semantic="GainMap" Item:Mime="image/jpeg" Item:Length="${r.gain.length}"`));
  assert.match(head, /hdrgm:Version="1\.0"/);
  assert.match(text(r.gain.subarray(0, 1000)), /hdrgm:BaseRenditionIsHDR="False"/);
});

test('the segments added stay in the length a JPEG segment can have, and the JFIF header stays first', () => {
  const file = buildUltraHdr(base, gain);
  assert.deepEqual([file[2], file[3]], [0xff, 0xe0], 'APP0 (JFIF) right after SOI');
  let at = 2;
  const markers = [];
  while (file[at] === 0xff && file[at + 1] !== 0xda) {
    markers.push(file[at + 1]);
    at += 2 + ((file[at + 2] << 8) | file[at + 3]);
  }
  assert.deepEqual(markers.slice(0, 3), [0xe0, 0xe1, 0xe2], 'JFIF, then the XMP, then the Multi-Picture segment');
});

test('something that is not a JPEG, or a file with no gain map, is refused', () => {
  assert.throws(() => buildUltraHdr(new Uint8Array([1, 2, 3]), gain), /Not a JPEG/);
  assert.throws(() => buildUltraHdr(base, new Uint8Array([1, 2, 3])), /Not a JPEG/);
  assert.throws(() => readUltraHdr(base), /No Multi-Picture/);
});

test('the gain formula: nothing changes up to white, and a highlight comes back to the value it had', () => {
  assert.equal(gainByte(0), 0);
  assert.equal(gainByte(0.5), 0);
  assert.equal(gainByte(1), 0);
  assert.equal(gainByte(8), 255);
  assert.equal(gainByte(100), 255, 'held at the most a file holds');
  assert.equal(gainByte(NaN), 0);
  // the viewer's side
  const meta = { min: 0, max: GAIN_LOG2_MAX, gamma: 1 };
  assert.equal(applyGain(0.4, 0, meta), 0.4);
  for (const hdr of [1.5, 2, 3.7, 6, 8]) {
    // the picture clips at 1; the map holds the rest
    const back = applyGain(1, gainByte(hdr), meta);
    assert.ok(Math.abs(back - hdr) / hdr < 0.01, `${hdr} came back as ${back}`);
  }
  assert.equal(applyGain(1, 255, meta), 8);
});
