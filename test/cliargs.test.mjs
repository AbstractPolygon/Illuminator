import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseCli, formatFor, outputPath, renderPlan } from '../app/js/core/cliargs.js';

test('commands and photos', () => {
  const j = parseCli(['render', 'a.lfr', 'b.lfp', '-o', 'out']);
  assert.equal(j.command, 'render');
  assert.deepEqual(j.files, ['a.lfr', 'b.lfp']);
  assert.equal(j.options.out, 'out');
  assert.deepEqual(j.errors, []);
  assert.equal(parseCli([]).command, 'help');
  assert.equal(parseCli(['--version']).command, 'version');
  assert.match(parseCli(['nope']).errors[0], /Unknown command/);
});

test('settings, camera options and the equals form', () => {
  const j = parseCli(['render', 'a.lfr', '--set', 'ev=0.5', '--set=ignored', '--f-number=2.8', '--focus', '-0.3', '--view', '1.5,-2', '--color-space', 'p3', '--format', 'jpeg', '--quality', '85', '--size', '2']);
  assert.deepEqual(j.sets, { ev: '0.5' });
  assert.ok(j.errors.some((e) => /--set needs setting=value/.test(e)));
  const ok = parseCli(['render', 'a.lfr', '--set', 'ev=0.5', '--set', 'tone-contrast=20', '--f-number=2.8', '--focus', '-0.3', '--view', '1.5,-2', '--color-space', 'p3', '--format', 'jpeg', '--quality', '85', '--size', '2', '--full-sensor', '--scale', '2']);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(renderPlan(ok), {
    set: { ev: '0.5', 'tone-contrast': '20' },
    camera: { fNumber: 2.8, focus: -0.3, u: 1.5, v: -2 },
    fullSensor: { scale: 2, passes: undefined },
    export: { format: 'jpeg', quality: 85, colorSpace: 'p3', size: 2 },
  });
});

test('mistakes are reported', () => {
  const errs = (a) => parseCli(a).errors.join('; ');
  assert.match(errs(['render']), /at least one photo/);
  assert.match(errs(['render', 'a.lfr', '--format', 'gif']), /--format/);
  assert.match(errs(['render', 'a.lfr', '--color-space', 'lab']), /--color-space/);
  assert.match(errs(['render', 'a.lfr', '--size', '5']), /--size/);
  assert.match(errs(['render', 'a.lfr', '--quality', '20']), /--quality/);
  assert.match(errs(['render', 'a.lfr', '--focus', 'x']), /--focus needs a number/);
  assert.match(errs(['render', 'a.lfr', '--view', '3']), /--view/);
  assert.match(errs(['render', 'a.lfr', '--bogus']), /Unknown option --bogus/);
  assert.match(errs(['render', 'a.lfr', '--out']), /needs a value/);
  assert.match(errs(['render', 'a.lfr', 'b.lfr', '-o', 'x.png']), /several photos/);
  assert.match(errs(['info', 'a', 'b']), /one photo/);
});

test('output files', () => {
  const p = { join: path.posix.join, dirname: path.posix.dirname, basename: path.posix.basename };
  assert.equal(formatFor({}), 'png');
  assert.equal(formatFor({ out: 'x.JPG' }), 'jpeg');
  assert.equal(formatFor({ out: 'x.jpg', format: 'png16' }), 'png16');
  assert.equal(outputPath('/in/IMG_1.lfr', {}, { ...p, many: false }), '/in/IMG_1.png');
  assert.equal(outputPath('/in/IMG_1.lfr', { out: '/out/pic.jpg' }, { ...p, many: false }), '/out/pic.jpg');
  assert.equal(outputPath('/in/IMG_1.lfr', { out: '/out', format: 'jpeg' }, { ...p, many: true }), '/out/IMG_1.jpg');
  assert.equal(outputPath('/in/IMG_1.lfr', { format: 'png16' }, { ...p, many: true }), '/in/IMG_1.png');
  // the HDR formats
  assert.equal(formatFor({ out: 'x.tif' }), 'tiffhdr');
  assert.equal(formatFor({ out: 'x.TIFF' }), 'tiffhdr');
  assert.equal(outputPath('/in/IMG_1.lfr', { format: 'tiffhdr' }, { ...p, many: true }), '/in/IMG_1.tif');
  assert.equal(outputPath('/in/IMG_1.lfr', { format: 'jpeghdr', out: '/out', }, { ...p, many: true }), '/out/IMG_1.jpg');
  assert.equal(outputPath('/in/IMG_1.lfr', { out: '/out/hdr.tiff' }, { ...p, many: false }), '/out/hdr.tiff');
  assert.deepEqual(parseCli(['render', 'a.lfr', '--format', 'tiffhdr', '-o', 'a.tif']).errors, []);
  assert.deepEqual(parseCli(['render', 'a.lfr', '--format', 'tiffhdr', '-o', 'a.tiff']).errors, []);
  assert.match(parseCli(['render', 'a.lfr', '--format', 'tiffhdr', '-o', 'a.png']).errors.join(), /makes \.tif files/);
  assert.match(parseCli(['render', 'a.lfr', 'b.lfr', '-o', 'x.tif']).errors.join(), /file name, but there are several/);
});

test('values given as text become the control\'s kind, and only saved settings can be set', async () => {
  const { coerce, SETTABLE } = await import('../app/js/ui/api.js');
  assert.equal(coerce({ type: 'checkbox' }, 'true'), true);
  assert.equal(coerce({ type: 'checkbox' }, 'off'), false);
  assert.equal(coerce({ type: 'range', id: 'ev' }, '0.5'), 0.5);
  assert.throws(() => coerce({ type: 'range', id: 'ev' }, 'lots'), /needs a number/);
  assert.equal(coerce({ type: 'select-one' }, 'jpeg'), 'jpeg');
  for (const id of ['ev', 'fstop', 'photo-format', 'photo-colorspace', 'local-masks']) assert.ok(SETTABLE.has(id), id);
  assert.ok(!SETTABLE.has('open-btn'));
});
