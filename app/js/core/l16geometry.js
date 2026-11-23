// Camera models for the modules of a Light L16 photo, from the factory calibration in the file: intrinsics K (from the lens position), the pose (R, t) that takes
// the scene's frame to the camera, and the lens distortion. Units are millimeters for t and pixels for K. The scene frame is the reference camera's (A1 on a wide
// capture): its pose is the identity.
//
// Modules A1 to A5 are fixed (mirror type NONE) and carry their pose in the calibration. Modules B1 to B5 and C1 to C6 look through a mirror that tilts: their pose
// follows from the mirror system and the mirror's position (an actuator code, turned into an angle by the actuator mapping).

const DEG = Math.PI / 180;

const m3 = (o) => [o.x00, o.x01, o.x02, o.x10, o.x11, o.x12, o.x20, o.x21, o.x22];
const v3 = (o) => [o.x, o.y, o.z];

// The geometry message of a module in the header's calibration list.
export function moduleGeometry(header, id) {
  const cal = (header.module_calibration || []).find((c) => c.camera_id === id);
  return cal ? cal.geometry : null;
}

// Intrinsics at the module's lens position: the per focus matrices sorted by their focus (hall) code, fx, fy, cx, cy interpolated or extrapolated linearly in it.
export function intrinsics(geometry, lensPosition) {
  const list = (geometry.per_focus_calibration || [])
    .filter((b) => b.intrinsics && b.intrinsics.k_mat)
    .map((b) => ({ k: m3(b.intrinsics.k_mat), hall: b.focus_hall_code }));
  if (!list.length) throw new Error('This module has no intrinsics in its calibration');
  const K = list[0].k.slice();
  if (list.length === 1 || list.some((e) => e.hall === undefined)) return K;
  list.sort((a, b) => a.hall - b.hall);
  let a = list[0];
  let b = list[1];
  if (list.length > 2 && lensPosition >= list[1].hall) {
    a = list[1];
    b = list[2];
  }
  const span = b.hall - a.hall;
  if (Math.abs(span) < 0.001) throw new Error('Two focus codes in the calibration are equal');
  const t = (lensPosition - a.hall) / span;
  for (const j of [0, 4, 2, 5]) K[j] = a.k[j] + t * (b.k[j] - a.k[j]);
  return K;
}

// The pose of a fixed module: the canonical extrinsics.
function canonicalPose(geometry) {
  for (const b of geometry.per_focus_calibration || []) {
    const c = b.extrinsics && b.extrinsics.canonical;
    if (c) return { R: m3(c.rotation), T: v3(c.translation) };
  }
  throw new Error('This module has no pose in its calibration');
}

// ----- the movable mirror

function mirrorSystemOf(geometry) {
  for (const b of geometry.per_focus_calibration || []) {
    const mm = b.extrinsics && b.extrinsics.moveable_mirror;
    if (!mm || !mm.mirror_system) continue;
    const s = mm.mirror_system;
    const am = mm.mirror_actuator_mapping;
    const q = am.quadratic_model;
    return {
      sys: { axis: v3(s.rotation_axis), n0: v3(s.mirror_normal_at_zero_degrees), d: s.distance_mirror_plane_to_point_on_rotation_axis, cv: v3(s.real_camera_location), p0: v3(s.point_on_rotation_axis), r0: m3(s.real_camera_orientation), flip: !!s.flip_img_around_x },
      map: { coeffs: Array.from(q.model_coeffs), rLeft: !!q.use_rplus_for_left_segment, rRight: !!q.use_rplus_for_right_segment, inflection: q.inflection_value, mIn: am.actuator_length_offset, sIn: am.actuator_length_scale, mOut: am.mirror_angle_offset, sOut: am.mirror_angle_scale, type: am.transformation_type === 'TAN_HALF_THETA' ? 1 : 0 },
    };
  }
  return null;
}

// Actuator (hall) code -> mirror angle in degrees, through the quadratic model a r^2 + b r + c = 0 with coefficients linear in the normalized code.
export function mirrorAngle(map, hall) {
  const c = map.coeffs;
  const x = (hall - map.mIn) / map.sIn;
  const a = c[0] * x + c[3];
  const b = c[1] * x + c[4];
  const cc = c[2] * x + c[5];
  let disc = -4 * a * cc + b * b;
  if (Math.abs(disc) < 1e-5) disc = 0;
  let r0;
  let r1;
  if (disc < 0) r0 = r1 = b / (a * -2);
  else {
    const s = Math.sqrt(disc);
    r0 = (s - b) / (a + a);
    r1 = (-b - s) / (a + a);
  }
  const useFirst = hall < map.inflection ? map.rLeft : map.rRight;
  const r = useFirst ? r0 : r1;
  return map.type === 1 ? Math.atan(r) * (360 / Math.PI) : r * map.sOut + map.mOut;
}

// Reflected camera center and the camera to scene rotation for mirror angle theta (degrees): the real camera mirrored in the tilted mirror plane.
function reflect(s, thetaDeg) {
  let [ax, ay, az] = s.axis;
  const norm = Math.hypot(ax, ay, az);
  ax /= norm;
  ay /= norm;
  az /= norm;
  const phi = thetaDeg * DEG;
  const c = Math.cos(phi);
  const sn = Math.sin(phi);
  const oc = 1 - c;
  // rotation about the axis by phi (Rodrigues)
  const r00 = c + ax * ax * oc;
  const r10 = ax * ay * oc + az * sn;
  const r01 = ax * ay * oc - az * sn;
  const r11 = ay * ay * oc + c;
  const r02 = ax * az * oc + ay * sn;
  const r12 = ay * az * oc - ax * sn;
  const r20 = ax * az * oc - ay * sn;
  const r21 = ay * az * oc + ax * sn;
  const r22 = az * az * oc + c;
  const [n0x, n0y, n0z] = s.n0;
  const n = [n0x * r00 + n0y * r01 + n0z * r02, n0x * r10 + n0y * r11 + n0z * r12, n0x * r20 + n0y * r21 + n0z * r22];
  // reflection I - 2 n n^T, then the camera's orientation through it
  const H = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) H[3 * i + j] = i === j ? 1 - 2 * n[i] * n[j] : -2 * n[i] * n[j];
  const P = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) P[3 * i + j] = s.r0[j] * H[3 * i] + s.r0[3 + j] * H[3 * i + 1] + s.r0[6 + j] * H[3 * i + 2];
  const col = s.flip ? 1 : 0; // the reflection turns the handedness: one column flips
  P[col] = -P[col];
  P[3 + col] = -P[3 + col];
  P[6 + col] = -P[6 + col];
  const d = [s.p0[0] + s.d * n[0] - s.cv[0], s.p0[1] + s.d * n[1] - s.cv[1], s.p0[2] + s.d * n[2] - s.cv[2]];
  const dot = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
  const k = dot + dot;
  return { center: [k * n[0] + s.cv[0], k * n[1] + s.cv[1], k * n[2] + s.cv[2]], P };
}

// Scene to camera (R, t) for a mirror angle: R = P^T, t = -R C. (The y coefficient of t takes R(0,1) in place of R(1,0), as the factory calibration was made.)
export function mirrorPose(s, thetaDeg) {
  const { center: C, P } = reflect(s, thetaDeg);
  const R = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) R[3 * i + j] = P[3 * j + i];
  const t = [-(C[2] * R[2] + C[1] * R[1] + R[0] * C[0]), -(C[2] * R[5] + C[1] * R[4] + R[1] * C[0]), -(C[2] * R[8] + R[7] * C[1] + R[6] * C[0])];
  return { R, T: t };
}

// ----- distortion

// Ideal (undistorted) pixel position -> the position in the sensor image, by the module's polynomial (coefficients k1, k2, p1, p2 and k3 when present).
export function makeDistortion(geometry) {
  const poly = geometry.distortion && geometry.distortion.polynomial;
  if (!poly) return (x, y) => [x, y];
  const c = poly.coeffs;
  const k1 = c[0];
  const k2 = c[1];
  const p1 = c[2];
  const p2 = c[3];
  const k3 = c.length > 4 ? c[4] : 0;
  const nx = poly.normalization.x;
  const ny = poly.normalization.y;
  const cx = poly.distortion_center.x;
  const cy = poly.distortion_center.y;
  return (x, y) => {
    const u = (x - cx) / nx;
    const v = (y - cy) / ny;
    const r2 = u * u + v * v;
    const uv2 = 2 * u * v;
    const s = 1 + ((k3 * r2 + k2) * r2 + k1) * r2;
    return [cx + nx * (p1 * uv2 + p2 * (r2 + 2 * u * u) + s * u), cy + ny * (p2 * uv2 + p1 * (r2 + 2 * v * v) + s * v)];
  };
}

// The camera model of one module frame: { id, K (3x3 row-major), R, T (mm), distort(x, y), width, height, reference }.
export function cameraModel(header, frame) {
  const mod = frame.module;
  const id = mod.id;
  const geometry = moduleGeometry(header, id);
  if (!geometry) throw new Error(`Module ${id} has no geometry in its calibration`);
  const K = intrinsics(geometry, mod.lens_position);
  const scale = mod.sensor_data_surface.data_scale;
  const sx = scale && scale.x ? scale.x : 1;
  const sy = scale && scale.y ? scale.y : 1;
  K[0] *= sx;
  K[2] *= sx;
  K[4] *= sy;
  K[5] *= sy;
  let pose;
  if (geometry.mirror_type === 'MOVABLE') {
    const ms = mirrorSystemOf(geometry);
    if (!ms) throw new Error(`Module ${id} has a movable mirror but no mirror calibration`);
    pose = mirrorPose(ms.sys, mirrorAngle(ms.map, mod.mirror_position || 0));
  } else pose = canonicalPose(geometry);
  return { id, K, R: pose.R, T: pose.T, distort: makeDistortion(geometry), width: mod.sensor_data_surface.size.x, height: mod.sensor_data_surface.size.y, mirrorType: geometry.mirror_type };
}
