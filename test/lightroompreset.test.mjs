import test from 'node:test';
import assert from 'node:assert/strict';
import { xmpToLook } from '../app/js/core/lightroompreset.js';
import { L16_LOOKS } from '../app/js/core/l16looks.js';
import { applyLookToEdits } from '../app/js/core/looks.js';

const XMP = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
 crs:Saturation="-4" crs:Vibrance="+10" crs:Exposure2012="+0.50" crs:Contrast2012="+12" crs:Highlights2012="-30" crs:Sharpness="40" crs:ColorNoiseReduction="25" crs:LuminanceSmoothing="5"
 crs:SaturationAdjustmentRed="+10" crs:SaturationAdjustmentOrange="+20" crs:SaturationAdjustmentYellow="0" crs:SaturationAdjustmentPurple="-30" crs:SaturationAdjustmentMagenta="-10" crs:HueAdjustmentRed="-9">
 <crs:ToneCurvePV2012><rdf:Seq><rdf:li>0, 10</rdf:li><rdf:li>255, 255</rdf:li></rdf:Seq></crs:ToneCurvePV2012></rdf:Description></rdf:RDF></x:xmpmeta>`;

test('a Lightroom preset becomes a look with the settings that have controls', () => {
  const { look, skipped } = xmpToLook(XMP, 'Mine');
  assert.equal(look.name, 'Mine');
  assert.equal(look.process.ev, 0.5);
  assert.equal(look.process['tone-contrast'], 12);
  assert.equal(look.process['tone-highlights'], -30);
  assert.equal(look.process.saturation, -4);
  assert.equal(look.process.vibrance, 10);
  assert.equal(look.process['hue-red'], 10);
  assert.equal(look.process['hue-yellow'], 10); // Orange and Yellow
  assert.equal(look.process['hue-magenta'], -20); // Purple and Magenta
  assert.equal(look.process['curve-points'], '0,0.0392;1,1');
  assert.equal(look.details['nr-color'], 25);
  assert.equal(look.details['nr-luminance'], 5);
  assert.deepEqual(skipped, ['hue and luminance of each color', 'sharpening']);
});

test('something that is not a preset is refused, a straight curve is left out', () => {
  assert.throws(() => xmpToLook('hello'), /not a Lightroom preset/);
  const flat = XMP.replace('0, 10', '0, 0');
  assert.equal('curve-points' in xmpToLook(flat).look.process, false);
});

test('the looks that come with the app for Light L16 photos put their settings on the edits', () => {
  assert.equal(L16_LOOKS.length, 2);
  for (const look of L16_LOOKS) {
    assert.ok(look.id.startsWith('builtin:'));
    const edits = applyLookToEdits({ format: 'x', process: { ev: 1, awb: true } }, look);
    assert.equal(edits.process.ev, look.process.ev);
    assert.equal(edits.process.awb, true); // the white balance stays the photo's
    assert.ok(edits.details['nr-color'] >= 0);
  }
});
