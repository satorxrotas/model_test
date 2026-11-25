// Armature, bones and actions for BlendScene. Matrices follow Blender's own conventions (column vectors,
// bone Y axis along head→tail, roll about it), so the rest pose matches exactly and Blender needs no edit-mode pass.

/* ---------- tiny 3x3 / quaternion helpers (Blender frame) ---------- */
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
// matrices as arrays of 3 columns
const mulMV = (M, v) => [M[0][0] * v[0] + M[1][0] * v[1] + M[2][0] * v[2], M[0][1] * v[0] + M[1][1] * v[1] + M[2][1] * v[2], M[0][2] * v[0] + M[1][2] * v[1] + M[2][2] * v[2]];
const mulMM = (A, B) => B.map((col) => mulMV(A, col));
const T = (M) => [[M[0][0], M[1][0], M[2][0]], [M[0][1], M[1][1], M[2][1]], [M[0][2], M[1][2], M[2][2]]];

// Blender's vec_roll_to_mat3_normalized
export function vecRollToMat3(nor, roll) {
  const [x, y, z] = nor; let theta = 1 + y; const alt = x * x + z * z;
  let B;
  if (theta > 6.1e-3 || alt > 2.5e-4 * 2.5e-4) {
    if (theta <= 6.1e-3) theta = alt * 0.5 + alt * alt * 0.125;
    B = [[1 - (x * x) / theta, -x, -(x * z) / theta], [x, y, z], [-(x * z) / theta, -z, 1 - (z * z) / theta]];
  } else B = [[-1, 0, 0], [0, -1, 0], [0, 0, 1]];
  return mulMM(axisAngle(nor, roll), B);
}
function axisAngle(a, ang) {
  const c = Math.cos(ang), s = Math.sin(ang), t = 1 - c, [x, y, z] = a;
  // columns
  return [[t * x * x + c, t * x * y + s * z, t * x * z - s * y], [t * x * y - s * z, t * y * y + c, t * y * z + s * x], [t * x * z + s * y, t * y * z - s * x, t * z * z + c]];
}
// roll that makes vecRollToMat3(dir, roll) match M (M's Y column = dir)
function rollOf(M) {
  const y = norm(M[1]), R0 = vecRollToMat3(y, 0);
  return Math.atan2(dot(cross(R0[0], M[0]), y), dot(R0[0], M[0]));
}
export function quatToMat3([w, x, y, z]) {
  return [[1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)], [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)], [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)]];
}
export function mat3ToQuat(M) { // columns → [w, x, y, z]
  const m00 = M[0][0], m11 = M[1][1], m22 = M[2][2], tr = m00 + m11 + m22;
  let w, x, y, z;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; w = 0.25 * s; x = (M[1][2] - M[2][1]) / s; y = (M[2][0] - M[0][2]) / s; z = (M[0][1] - M[1][0]) / s; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; w = (M[1][2] - M[2][1]) / s; x = 0.25 * s; y = (M[1][0] + M[0][1]) / s; z = (M[2][0] + M[0][2]) / s; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; w = (M[2][0] - M[0][2]) / s; x = (M[1][0] + M[0][1]) / s; y = 0.25 * s; z = (M[2][1] + M[1][2]) / s; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; w = (M[0][1] - M[1][0]) / s; x = (M[2][0] + M[0][2]) / s; y = (M[2][1] + M[1][2]) / s; z = 0.25 * s; }
  const l = Math.hypot(w, x, y, z); return [w / l, x / l, y / l, z / l];
}

/* ---------- armature ---------- */
// bones: [{ name, parent (index or -1), head [x,y,z], tail [x,y,z], xAxis? [x,y,z] }] in armature space (Blender frame)
export function addArmature(S, name, bones) {
  const f = S.f, ar = f.alloc('bArmature', 1, 'AR\0\0');
  f.set(ar, 'id.name', S.unique('AR', name)).set(ar, 'id.us', 1).set(ar, 'layer', 1).set(ar, 'layer_used', 1).set(ar, 'drawtype', 0).set(ar, 'deformflag', 1);
  const blocks = bones.map(() => f.alloc('Bone'));
  const info = bones.map((b) => {
    const dir = norm(sub(b.tail, b.head));
    let roll = 0;
    if (b.xAxis) { const R0 = vecRollToMat3(dir, 0), xa = norm(sub(b.xAxis, dir.map((d) => d * dot(b.xAxis, dir)))); roll = Math.atan2(dot(cross(R0[0], xa), dir), dot(R0[0], xa)); }
    return { R: vecRollToMat3(dir, roll), roll, length: len(sub(b.tail, b.head)) };
  });
  bones.forEach((b, i) => {
    const B = blocks[i], I = info[i], p = b.parent;
    f.set(B, 'name', b.name).set(B, 'arm_head', b.head).set(B, 'arm_tail', b.tail).set(B, 'arm_roll', I.roll).set(B, 'length', I.length);
    f.set(B, 'arm_mat', [...I.R[0], 0, ...I.R[1], 0, ...I.R[2], 0, ...b.head, 1]);
    if (p >= 0) {
      const P = info[p].R, Pt = T(P), bm = mulMM(Pt, I.R);
      f.set(B, 'bone_mat', bm.flat()).set(B, 'roll', rollOf(bm));
      f.set(B, 'head', mulMV(Pt, sub(b.head, bones[p].tail))).set(B, 'tail', mulMV(Pt, sub(b.tail, bones[p].tail)));
      f.set(B, 'parent', blocks[p]);
    } else {
      f.set(B, 'bone_mat', I.R.flat()).set(B, 'roll', I.roll).set(B, 'head', b.head).set(B, 'tail', b.tail);
    }
    const L = I.length;
    for (const [k, v] of [['dist', 0.25 * L], ['weight', 1], ['xwidth', 0.1 * L], ['zwidth', 0.1 * L], ['rad_head', 0.1 * L], ['rad_tail', 0.05 * L], ['ease1', 1], ['ease2', 1], ['scaleIn', 1], ['scaleOut', 1], ['scale_in_y', 1], ['scale_out_y', 1], ['scale_in', [1, 1, 1]], ['scale_out', [1, 1, 1]], ['size', [1, 1, 1]], ['layer', 1], ['segments', 1], ['flag', 0]]) {
      if (f.has('Bone', k)) f.set(B, k, v);
    }
  });
  // hierarchy lists
  const kids = bones.map(() => []), roots = [];
  bones.forEach((b, i) => (b.parent >= 0 ? kids[b.parent] : roots).push(blocks[i]));
  f.linkList(ar, 'bonebase', roots);
  blocks.forEach((B, i) => { if (kids[i].length) f.linkList(B, 'childbase', kids[i]); });
  // linkList rewrote next/prev of each sibling chain; roots and every child list are disjoint, so that's consistent
  f.add([ar, ...blocks]);
  return { data: ar, bones: info };
}

/* ---------- actions ---------- */
// channels: [{ bone, rot: Float32Array(frames*4) wxyz | null, loc: Float32Array(frames*3) | null }]
export function addAction(S, name, channels, frames, { fakeUser = true } = {}) {
  const f = S.f, ac = f.alloc('bAction', 1, 'AC\0\0');
  f.set(ac, 'id.name', S.unique('AC', name)).set(ac, 'id.us', fakeUser ? 1 : 0).set(ac, 'id.flag', fakeUser ? 512 : 0).set(ac, 'idroot', 0); // set when assigned (an unassigned object action crashes Blender 5.0's upgrade)
  const curves = [], data = [];
  const bez = f.struct('BezTriple').size;
  const curve = (path, idx, values, stride) => {
    const fc = f.alloc('FCurve'), bt = f.alloc('BezTriple', frames), rp = f.raw(new TextEncoder().encode(path + '\0'));
    const dv = new DataView(bt.data.buffer), vo = f.locate('BezTriple', 'vec').off, io = f.locate('BezTriple', 'ipo').off;
    const h1 = f.locate('BezTriple', 'h1').off, h2 = f.locate('BezTriple', 'h2').off;
    for (let k = 0; k < frames; k++) {
      const o = k * bez, v = values[k * stride + idx], fr = k + 1;
      for (let h = 0; h < 3; h++) { dv.setFloat32(o + vo + h * 12, fr + (h - 1) / 3, true); dv.setFloat32(o + vo + h * 12 + 4, v, true); }
      bt.data[o + io] = 1; // linear: every frame is keyed
      bt.data[o + h1] = 5; bt.data[o + h2] = 5; // auto-clamped handles
    }
    f.set(fc, 'bezt', bt).set(fc, 'totvert', frames).set(fc, 'rna_path', rp).set(fc, 'array_index', idx).set(fc, 'flag', 1 | 4).set(fc, 'color_mode', 0);
    curves.push(fc); data.push(fc, bt, rp);
  };
  for (const c of channels) {
    const base = `pose.bones["${c.bone.replace(/"/g, '\\"')}"]`;
    if (c.loc) for (let i = 0; i < 3; i++) curve(`${base}.location`, i, c.loc, 3);
    if (c.rot) for (let i = 0; i < 4; i++) curve(`${base}.rotation_quaternion`, i, c.rot, 4);
  }
  f.linkList(ac, 'curves', curves);
  f.add([ac, ...data]);
  return ac;
}

// give an object AnimData with an active action
export function setAction(S, ob, action) {
  const f = S.f, ad = f.alloc('AnimData');
  f.set(ad, 'action', action).set(ad, 'act_influence', 1).set(ad, 'act_blendmode', 0).set(ad, 'act_extendmode', 0);
  f.set(action, 'idroot', 0x424f /* ID_OB */);
  f.set(ob, 'adt', ad); f.addData(ob, [ad]);
}

/* ---------- three.js skeleton → Blender bones + baked actions ---------- */
// three.js world space (Y up, +Z front) → Blender (Z up, −Y front)
export const zUp = (v) => [v.x, -v.z, v.y];
const qA = [Math.SQRT1_2, Math.SQRT1_2, 0, 0]; // +90° about X: three → Blender
const qmul = (a, b) => [a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3], a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2], a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1], a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]];
const qinv = (q) => [q[0], -q[1], -q[2], -q[3]];
export const toBlenderQuat = (q) => qmul(qmul(qA, [q.w, q.x, q.y, q.z]), qinv(qA)); // three Quaternion → Blender-frame wxyz

// skeleton: THREE.Skeleton at rest. Returns bone specs for addArmature (tails toward the main child).
export function skeletonBones(skeleton, rename = (n) => n) {
  const list = skeleton.bones, index = new Map(list.map((b, i) => [b, i]));
  const pos = list.map((b) => zUp(b.getWorldPosition(new b.position.constructor())));
  return list.map((b, i) => {
    const kids = b.children.filter((c) => index.has(c));
    const pref = kids.find((c) => /Spine|Neck|Head(?!Top)|ForeArm|Hand$|Leg$|Foot$|ToeBase|Arm$/.test(c.name) && !/Shoulder/.test(c.name)) || (kids.length === 1 ? kids[0] : null);
    let tail;
    if (pref) tail = pos[index.get(pref)];
    else if (kids.length) { const c = kids.map((k) => pos[index.get(k)]); tail = c.reduce((a, p) => add(a, p.map((v) => v / c.length)), [0, 0, 0]); }
    else { const p = b.parent && index.has(b.parent) ? pos[index.get(b.parent)] : sub(pos[i], [0, 0, 0.1]); const d = norm(sub(pos[i], p)); const l = Math.max(0.02, len(sub(pos[i], p)) * 0.5); tail = add(pos[i], d.map((v) => v * l)); }
    if (len(sub(tail, pos[i])) < 1e-4) tail = add(pos[i], [0, 0, 0.05]);
    // keep the bone's own X axis (from the rig) so rolls look like the source rig's
    const q = b.getWorldQuaternion(new (b.quaternion.constructor)()), M = quatToMat3(toBlenderQuat(q));
    return { name: rename(b.name), parent: b.parent && index.has(b.parent) ? index.get(b.parent) : -1, head: pos[i], tail, xAxis: M[0], restQ: toBlenderQuat(q) };
  });
}

// Bake a three.js clip on `root` (mixer) into Blender pose channels relative to the armature's rest.
// spec: bones from skeletonBones; arm: result of addArmature (rest rotations R).
export function bakeClip({ mixer, clip, root, skeleton, spec, arm, fps = 30, restPose, applyPose }) {
  const list = skeleton.bones, frames = Math.max(2, Math.round(clip.duration * fps) + 1);
  const rot = list.map(() => new Float32Array(frames * 4)), loc = new Float32Array(frames * 3);
  const action = mixer.clipAction(clip); mixer.stopAllAction(); action.reset().play();
  const R = arm.bones.map((b) => b.R), Rq = R.map(mat3ToQuat);
  const restInv = spec.map((s) => qinv(s.restQ)), V = new (list[0].position.constructor)(), Q = new (list[0].quaternion.constructor)();
  for (let k = 0; k < frames; k++) {
    mixer.setTime(Math.min(clip.duration, k / fps)); root.updateMatrixWorld(true);
    const P = list.map((b, i) => { b.getWorldQuaternion(Q); return qmul(qmul(toBlenderQuat(Q), restInv[i]), Rq[i]); }); // bone frame in armature space
    list.forEach((b, i) => {
      const p = spec[i].parent;
      // basis = R⁻¹ · R_parent · P_parent⁻¹ · P   (root: R⁻¹ · P)
      let q = p >= 0 ? qmul(qmul(qmul(qinv(Rq[i]), Rq[p]), qinv(P[p])), P[i]) : qmul(qinv(Rq[i]), P[i]);
      if (k && q[0] * rot[i][(k - 1) * 4] + q[1] * rot[i][(k - 1) * 4 + 1] + q[2] * rot[i][(k - 1) * 4 + 2] + q[3] * rot[i][(k - 1) * 4 + 3] < 0) q = q.map((v) => -v);
      rot[i].set(q, k * 4);
      if (p < 0) { const h = zUp(b.getWorldPosition(V)), d = sub(h, spec[i].head), l = mulMV(T(R[i]), d); loc.set(l, k * 3); }
    });
  }
  mixer.stopAllAction();
  if (restPose) applyPose(restPose); root.updateMatrixWorld(true);
  return { frames, channels: list.map((b, i) => ({ bone: spec[i].name, rot: rot[i], loc: spec[i].parent < 0 ? loc : null })) };
}

// Pose for an armature object (Blender always saves one; newer versions expect it): one channel per bone at rest.
export function addPose(S, ob, spec, arm) {
  const f = S.f, pose = f.alloc('bPose'), I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  f.set(pose, 'flag', 1 /* POSE_RECALC: rebuilt from the bones on load */).set(pose, 'iksolver', 0);
  for (const [k, v] of [['avs.path_step', 1], ['avs.path_sf', 1], ['avs.path_ef', 250], ['avs.path_bc', 10], ['avs.path_ac', 10]]) if (f.has('bPose', k)) f.set(pose, k, v);
  const chans = spec.map((b, i) => {
    const c = f.alloc('bPoseChannel'), R = arm.bones[i].R;
    f.set(c, 'name', b.name).set(c, 'size', [1, 1, 1]).set(c, 'quat', [1, 0, 0, 0]).set(c, 'rotAxis', [0, 1, 0]).set(c, 'rotmode', 0);
    f.set(c, 'custom_scale', 1); if (f.has('bPoseChannel', 'custom_scale_xyz')) f.set(c, 'custom_scale_xyz', [1, 1, 1]);
    for (const k of ['chan_mat', 'disp_mat', 'disp_tail_mat', 'constinv']) f.set(c, k, I4);
    f.set(c, 'pose_mat', [...R[0], 0, ...R[1], 0, ...R[2], 0, ...b.head, 1]).set(c, 'pose_head', b.head).set(c, 'pose_tail', b.tail);
    f.set(c, 'limitmin', [-Math.PI, -Math.PI, -Math.PI]).set(c, 'limitmax', [Math.PI, Math.PI, Math.PI]);
    for (const [k, v] of [['ikrotweight', 1], ['iklinweight', 0], ['ease1', 1], ['ease2', 1], ['scaleIn', 1], ['scaleOut', 1], ['scale_in_y', 1], ['scale_out_y', 1], ['scale_in', [1, 1, 1]], ['scale_out', [1, 1, 1]]]) if (f.has('bPoseChannel', k)) f.set(c, k, v);
    return c;
  });
  spec.forEach((b, i) => { if (b.parent >= 0) f.set(chans[i], 'parent', chans[b.parent]); });
  f.linkList(pose, 'chanbase', chans);
  f.set(ob, 'pose', pose);
  f.addData(ob, [pose, ...chans]);
  return pose;
}

// plain object action: curves = [{ path: 'location', index: 0, values: Float32Array(frames) }]
export function addObjectAction(S, ob, name, curves, frames) {
  const f = S.f, ac = f.alloc('bAction', 1, 'AC\0\0');
  f.set(ac, 'id.name', S.unique('AC', name)).set(ac, 'id.us', 1).set(ac, 'idroot', 0);
  const bez = f.struct('BezTriple').size, vo = f.locate('BezTriple', 'vec').off, io = f.locate('BezTriple', 'ipo').off, h1 = f.locate('BezTriple', 'h1').off, h2 = f.locate('BezTriple', 'h2').off;
  const out = [], fcs = [];
  for (const c of curves) {
    const fc = f.alloc('FCurve'), bt = f.alloc('BezTriple', frames), rp = f.raw(new TextEncoder().encode(c.path + '\0')), dv = new DataView(bt.data.buffer);
    for (let k = 0; k < frames; k++) { const o = k * bez; for (let h = 0; h < 3; h++) { dv.setFloat32(o + vo + h * 12, k + 1 + (h - 1) / 3, true); dv.setFloat32(o + vo + h * 12 + 4, c.values[k], true); } bt.data[o + io] = 1; bt.data[o + h1] = 5; bt.data[o + h2] = 5; }
    f.set(fc, 'bezt', bt).set(fc, 'totvert', frames).set(fc, 'rna_path', rp).set(fc, 'array_index', c.index).set(fc, 'flag', 1 | 4);
    fcs.push(fc); out.push(fc, bt, rp);
  }
  f.linkList(ac, 'curves', fcs); f.add([ac, ...out]);
  f.set(ac, 'id.us', 0); setAction(S, ob, ac); f.set(ac, 'id.us', 1);
  return ac;
}
