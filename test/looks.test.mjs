import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLook, parseLook, applyLookToEdits, describeLook, lookFileName, LOOK_FORMAT } from '../app/js/core/looks.js';

const edits = () => ({
  format: 'illuminator-edits', version: 1, photo: { id: 'p1' },
  process: { ev: 0.5, saturation: 10, awb: false, 'wb-temperature': 5200, 'wb-tint': 3, 'lut-data': '' },
  details: { 'sharp-amount': 40, 'nr-hot': true, 'mv-on': true, 'mv-blend': 50, 'nr-luminance': 20 },
  camera: { fstop: 3, focus: 0.4 }, geometry: { orientation: 'n' }, local: { 'local-masks': '[{"kind":"radial"}]' },
  view: { u: 1, v: 2 }, focusPoint: { x: 0.2, y: 0.3 },
});

test('a look keeps tone, color, sharpening and local adjustments, and leaves out what belongs to the photo', () => {
  const look = makeLook(edits(), '  Warm  ');
  assert.equal(look.format, LOOK_FORMAT);
  assert.equal(look.name, 'Warm');
  assert.deepEqual(Object.keys(look.process).sort(), ['ev', 'lut-data', 'saturation']);
  assert.deepEqual(look.details, { 'sharp-amount': 40, 'nr-luminance': 20 });
  assert.deepEqual(look.local, { 'local-masks': '[{"kind":"radial"}]' });
  for (const k of ['camera', 'geometry', 'view', 'focusPoint', 'photo']) assert.equal(k in look, false);
});

test('the white balance, the details and the local adjustments are options', () => {
  const wb = makeLook(edits(), 'x', { whiteBalance: true });
  assert.equal(wb.process['wb-temperature'], 5200);
  const bare = makeLook(edits(), 'x', { details: false, local: false });
  assert.equal('details' in bare, false);
  assert.equal('local' in bare, false);
  assert.throws(() => makeLook(null, 'x'));
});

test('a look file is read back, and anything else is refused', () => {
  const look = makeLook(edits(), 'Warm');
  assert.deepEqual(parseLook(JSON.stringify(look)), look);
  assert.throws(() => parseLook('not json'), /not an Illuminator look/);
  assert.throws(() => parseLook(JSON.stringify({ format: 'illuminator-edits' })), /not an Illuminator look/);
  assert.throws(() => parseLook(JSON.stringify({ ...look, version: 99 })), /newer/);
  assert.throws(() => parseLook(JSON.stringify({ ...look, process: [1] })), /damaged/);
  assert.equal(parseLook(JSON.stringify({ format: LOOK_FORMAT, version: 1, name: '' })).name, 'Look');
});

test('applying a look changes the look\'s settings and nothing else, and does not touch the original', () => {
  const look = makeLook({ process: { ev: -1, saturation: 30 }, details: { 'sharp-amount': 80 }, local: { 'local-masks': '[]x' } }, 'L');
  const photo = edits();
  const out = applyLookToEdits(photo, look);
  assert.equal(out.process.ev, -1);
  assert.equal(out.process.saturation, 30);
  assert.equal(out.process['wb-temperature'], 5200);
  assert.equal(out.details['sharp-amount'], 80);
  assert.equal(out.details['nr-hot'], true);
  assert.equal(out.local['local-masks'], '[]x');
  assert.deepEqual(out.camera, { fstop: 3, focus: 0.4 });
  assert.deepEqual(out.view, { u: 1, v: 2 });
  assert.equal(photo.process.ev, 0.5);
  // A look without local adjustments leaves the photo's.
  const noLocal = applyLookToEdits(photo, makeLook(photo, 'L', { local: false }));
  assert.equal(noLocal.local['local-masks'], '[{"kind":"radial"}]');
  // Edits that are missing get the look alone.
  assert.equal(applyLookToEdits(null, look).process.ev, -1);
});

test('a look is described and named as a file', () => {
  assert.match(describeLook(makeLook(edits(), 'x')), /tone and color, sharpening and noise reduction, local adjustments/);
  assert.match(describeLook(makeLook(edits(), 'x', { whiteBalance: true })), /white balance/);
  assert.equal(lookFileName('A/B: "c"'), 'A_B_ _c_.illuminator-look');
});
