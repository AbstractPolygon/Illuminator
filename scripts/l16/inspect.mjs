import fs from 'node:fs';
import { parseLri } from '../../app/js/core/lri.js';
for (const f of process.argv.slice(2)) {
  const t0 = Date.now();
  const bytes = new Uint8Array(fs.readFileSync(f));
  const r = parseLri(bytes);
  const h = r.header;
  console.log(f, 'parsed in', Date.now() - t0, 'ms; blocks', r.blocks.length, r.blocks.map((b) => b.type).join(''), 'stackFrames', r.stackFrames);
  console.log(' model', h.device_model_name, 'fw', h.device_fw_version, 'ref', h.image_reference_camera, 'focal', h.image_focal_length);
  for (const [id, frames] of Object.entries(r.modules)) {
    const m = frames[0].module, s = m.sensor_data_surface;
    console.log(' ', id, 'frames', frames.length, 'size', s.size.x + 'x' + s.size.y, s.format, 'stride', s.row_stride, 'gain', m.sensor_analog_gain, 'exp', m.sensor_exposure, 'lens', m.lens_position, 'mirror', m.mirror_position, 'flip', m.sensor_is_horizontal_flip, m.sensor_is_vertical_flip, 'redOverride', JSON.stringify(m.sensor_bayer_red_override));
  }
  console.log(' viewPrefs keys', Object.keys(r.viewPreferences || {}).join(','));
  console.log(' header keys', Object.keys(h).join(','));
  console.log(' calibrations', (h.module_calibration || []).length, 'sensor_data', (h.sensor_data || []).length);
}
