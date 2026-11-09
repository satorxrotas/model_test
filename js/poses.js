// Procedural "model poses": stationary, looping poses with living motion —
// weight shifts, hip pops, sways — with both feet locked to the floor by IK.
import * as THREE from 'three';
import { aimBone } from './autoskin.js';
import { REF_MOTION as RM } from './refmotion.js';

const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3();

// Each pose returns per-frame parameters from phase p (0..1, loops seamlessly).
// Units: distances are fractions of body span (neck→ankle), angles in radians.
// Sides: L = character's left (+X).
// linear sample of a REF_MOTION channel at loop phase p (0..1)
function ref(ch, p) {
  const a = RM[ch], x = (((p % 1) + 1) % 1) * a.length, i = Math.floor(x), f = x - i;
  return a[i % a.length] * (1 - f) + a[(i + 1) % a.length] * f;
}

export const POSES = [
  {
    // measured from the reference clip and extended into a 14.4 s loop: the exact sweep + its mirror, twice,
    // with pelvis tilt, hip dip, torso leading the hips, breathing and a slow head turn
    id: 'p_ref', label: 'Reference sway (your clip)', duration: RM.duration,
    at: (s, c, p) => {
      const lean = ref('lean', p);
      return { hipPx: [ref('hipX', p), ref('hipY', p)], roll: ref('roll', p), spine: [lean, 0, ref('breath', p)], head: [-0.4 * lean, ref('headYaw', p), -0.5 * ref('breath', p)], swing: [0, 0] };
    },
  },
  {
    id: 'p_shift', label: 'Weight shift', duration: 5.5,
    at: (s, c) => ({ hip: [0.032 * s, -0.012, 0], roll: 0.06 * s, spine: [-0.035 * s, 0, 0], head: [0.02 * s, 0, 0], swing: [0.04 * c, -0.04 * c] }),
  },
  {
    id: 'p_hippop', label: 'Hip pop', duration: 6,
    at: (s, c) => ({ hip: [-0.05 + 0.007 * s, -0.02, 0.004], roll: -0.11 + 0.015 * s, yaw: 0.1, spine: [0.08 - 0.012 * s, -0.04, 0.01], head: [-0.03, 0.05 + 0.02 * c, 0],
      feet: { L: [-0.045, 0, 0.08] }, kneeIn: { L: 1 }, armOut: { R: 0.1 }, swing: [0.02 * c, 0.01 * c] }),
  },
  {
    id: 'p_handhip', label: 'Hand on hip', duration: 6,
    at: (s, c) => ({ hip: [0.036 + 0.007 * s, -0.016, 0], roll: 0.08 + 0.012 * s, yaw: -0.1, spine: [-0.055, 0.06 + 0.02 * s, 0], head: [0.035, -0.06, 0],
      feet: { R: [0.03, 0, 0.06] }, kneeIn: { R: 1 }, hands: { L: 'hip' }, swing: [0, 0.025 * c] }),
  },
  {
    id: 'p_power', label: 'Hands on hips', duration: 7,
    at: (s, c) => ({ hip: [0.006 * s, -0.02, 0], roll: 0.02 * s, yaw: -0.06 * s, spine: [0, 0.14 * s, -0.02], head: [0, -0.06 * s, 0.03],
      feet: { L: [0.05, 0, 0], R: [-0.05, 0, 0] }, hands: { L: 'hip', R: 'hip' } }),
  },
  {
    id: 'p_twist', label: 'Slow twist', duration: 8,
    at: (s, c) => ({ hip: [0, -0.012, 0], yaw: 0.22 * s, spine: [0, 0.2 * s, 0], head: [0, 0.12 * s, 0],
      feet: { L: [0.02, 0, 0], R: [-0.02, 0, 0] }, swing: [-0.12 * s, 0.12 * s] }),
  },
  {
    id: 'p_kneepop', label: 'Knee pop', duration: 4.5,
    at: (s, c) => ({ hip: [0.05 * s, -0.022 - 0.008 * Math.abs(c), 0], roll: 0.095 * s, spine: [-0.065 * s, 0.03 * s, 0], head: [0.03 * s, 0, 0],
      kneeIn: { L: Math.max(0, -s), R: Math.max(0, s) }, swing: [0.03 * c, -0.03 * c] }),
  },
  {
    id: 'p_hair', label: 'Hand in hair', duration: 6.5,
    at: (s, c) => ({ hip: [-0.035 + 0.006 * s, -0.016, 0], roll: -0.08 + 0.01 * s, yaw: 0.06, spine: [0.05, -0.05 + 0.02 * s, 0], head: [0.08 + 0.015 * s, 0.04, 0.03],
      feet: { L: [-0.03, 0, 0.06] }, kneeIn: { L: 1 }, hands: { L: 'head' }, swing: [0, 0.02 * c] }),
  },
  {
    id: 'p_lean', label: 'Lean back', duration: 6,
    at: (s, c) => ({ hip: [0.01 * s, -0.02, 0.035 + 0.006 * s], roll: 0.03 * s, spine: [-0.02 * s, 0.04 * s, -0.12 - 0.02 * s], head: [0, 0, 0.06],
      feet: { L: [0.03, 0, 0], R: [-0.03, 0, 0] }, swing: [-0.08, -0.08] }),
  },
];

function setWorldQuat(bone, qW) {
  bone.parent.updateMatrixWorld(true);
  bone.quaternion.copy(bone.parent.getWorldQuaternion(_q2).invert().multiply(qW));
  bone.updateMatrixWorld(true);
}
function rotateWorld(bone, axis, angle) {
  if (!angle) return;
  const qW = bone.getWorldQuaternion(new THREE.Quaternion());
  setWorldQuat(bone, _q.setFromAxisAngle(axis, angle).multiply(qW));
}
const wpos = (b) => b.getWorldPosition(new THREE.Vector3());

// Analytic two-bone IK: rotate a (upper) and b (lower) so c (end) reaches target; pole picks the bend plane.
function twoBoneIK(a, b, c, target, pole) {
  const pa = wpos(a), pb = wpos(b), pc = wpos(c);
  const l1 = pa.distanceTo(pb), l2 = pb.distanceTo(pc);
  const toT = target.clone().sub(pa);
  const d = Math.min(toT.length(), (l1 + l2) * 0.999);
  const u = toT.normalize();
  const v = pole.clone().sub(pa); v.sub(u.clone().multiplyScalar(v.dot(u))).normalize();
  const cosA = THREE.MathUtils.clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const elbow = pa.clone().add(u.clone().multiplyScalar(l1 * cosA)).add(v.multiplyScalar(l1 * Math.sqrt(1 - cosA * cosA)));
  aimBone(a, b, elbow);
  aimBone(b, c, pa.clone().add(u.multiplyScalar(d)));
}

/** Bakes every pose into an AnimationClip on the given rig. `base` = clip whose first frame is the neutral stance. */
export function bakePoses({ character, bones, base, span, fps = 30 }) {
  // neutral stance from the first frame of the base clip
  const baseVals = new Map();
  for (const t of base.tracks) baseVals.set(t.name, t.values.slice(0, t.getValueSize()));
  const all = []; character.traverse((o) => o.isBone && all.push(o));
  const applyBase = () => {
    for (const b of all) {
      const q = baseVals.get(`${b.name}.quaternion`); if (q) b.quaternion.fromArray(q);
    }
    const hp = baseVals.get(`${bones.Hips.name}.position`); if (hp) bones.Hips.position.fromArray(hp);
    character.updateMatrixWorld(true);
  };
  applyBase();
  const base0 = {
    hips: wpos(bones.Hips), hipsQ: bones.Hips.getWorldQuaternion(new THREE.Quaternion()),
    foot: { L: wpos(bones.LeftFoot), R: wpos(bones.RightFoot) },
    footQ: { L: bones.LeftFoot.getWorldQuaternion(new THREE.Quaternion()), R: bones.RightFoot.getWorldQuaternion(new THREE.Quaternion()) },
    hipW: Math.abs(wpos(bones.LeftUpLeg).x - wpos(bones.RightUpLeg).x),
  };
  const side = { L: 'Left', R: 'Right' }, sign = { L: 1, R: -1 };

  const clips = [];
  for (const pose of POSES) {
    const frames = Math.round(pose.duration * fps) + 1;
    const times = new Float32Array(frames);
    const qv = all.map(() => new Float32Array(frames * 4));
    const pv = new Float32Array(frames * 3);
    for (let f = 0; f < frames; f++) {
      const t = f / fps, ph = (t / pose.duration) * Math.PI * 2;
      times[f] = t;
      const P = pose.at(Math.sin(ph), Math.cos(ph), t / pose.duration);
      applyBase();

      // pelvis
      if (P.hipPx) {
        // video pixels -> body units: hips-to-feet height in the clip = RM.pxHipsToFeet px
        const k = (base0.hips.y - (base0.foot.L.y + base0.foot.R.y) / 2) / RM.pxHipsToFeet / span;
        P.hip = [P.hipPx[0] * k, -P.hipPx[1] * k, 0];
      }
      const hp = base0.hips.clone().add(new THREE.Vector3(...(P.hip || [0, 0, 0])).multiplyScalar(span));
      bones.Hips.position.copy(bones.Hips.parent.worldToLocal(hp));
      const qh = new THREE.Quaternion().setFromAxisAngle(Y, P.yaw || 0).multiply(new THREE.Quaternion().setFromAxisAngle(Z, P.roll || 0));
      setWorldQuat(bones.Hips, qh.multiply(base0.hipsQ.clone()));

      // spine + head: [roll(Z), yaw(Y), pitch(X)] spread over the chain
      const [sr, sy, sp] = P.spine || [0, 0, 0];
      for (const n of ['Spine', 'Spine1', 'Spine2']) { rotateWorld(bones[n], Z, sr / 3); rotateWorld(bones[n], Y, sy / 3); rotateWorld(bones[n], X, sp / 3); }
      const [hr, hy, hpch] = P.head || [0, 0, 0];
      rotateWorld(bones.Neck, Z, hr / 2); rotateWorld(bones.Head, Z, hr / 2);
      rotateWorld(bones.Neck, Y, hy / 2); rotateWorld(bones.Head, Y, hy / 2);
      rotateWorld(bones.Head, X, hpch);

      // legs: feet locked to the floor, knees bend naturally (optionally inward)
      for (const k of ['L', 'R']) {
        const S = side[k];
        const off = (P.feet && P.feet[k]) || [0, 0, 0];
        const target = base0.foot[k].clone().add(new THREE.Vector3(...off).multiplyScalar(span));
        const knee = wpos(bones[`${S}Leg`]);
        const kin = (P.kneeIn && P.kneeIn[k]) || 0;
        const pole = knee.add(new THREE.Vector3(-sign[k] * kin * 0.25 * span, 0, 0.5 * span));
        twoBoneIK(bones[`${S}UpLeg`], bones[`${S}Leg`], bones[`${S}Foot`], target, pole);
        // keep the sole flat; a bent-in knee lifts the heel a touch
        const fq = base0.footQ[k].clone();
        if (kin) fq.premultiply(_q.setFromAxisAngle(X, 0.18 * kin));
        setWorldQuat(bones[`${S}Foot`], fq);
      }

      // arms
      for (const k of ['L', 'R']) {
        const S = side[k], mode = P.hands && P.hands[k];
        if (mode) {
          const hq = bones.Hips.getWorldQuaternion(new THREE.Quaternion());
          let target, pole;
          const sh = wpos(bones[`${S}Arm`]);
          if (mode === 'hip') {
            target = wpos(bones.Hips).add(new THREE.Vector3(sign[k] * base0.hipW * 1.12, span * 0.045, -span * 0.02).applyQuaternion(hq));
            pole = sh.clone().add(new THREE.Vector3(sign[k] * span * 0.35, -span * 0.4, -span * 0.45));
          } else {
            const hd = bones.Head.getWorldQuaternion(new THREE.Quaternion());
            target = wpos(bones.Head).add(new THREE.Vector3(sign[k] * span * 0.075, span * 0.07, -span * 0.03).applyQuaternion(hd));
            pole = sh.clone().add(new THREE.Vector3(sign[k] * span * 0.5, span * 0.25, -span * 0.1));
          }
          twoBoneIK(bones[`${S}Arm`], bones[`${S}ForeArm`], bones[`${S}Hand`], target, pole);
          // relax the wrist so the hand follows the forearm
          setWorldQuat(bones[`${S}Hand`], bones[`${S}ForeArm`].getWorldQuaternion(new THREE.Quaternion()));
        } else {
          const sw = P.swing ? P.swing[k === 'L' ? 0 : 1] : 0;
          rotateWorld(bones[`${S}Arm`], X, sw);
          const out = (P.armOut && P.armOut[k]) || 0;
          rotateWorld(bones[`${S}Arm`], Z, sign[k] * out);
          rotateWorld(bones[`${S}ForeArm`], X, -0.08 + sw * 0.5);
        }
      }

      all.forEach((b, i) => b.quaternion.toArray(qv[i], f * 4));
      bones.Hips.position.toArray(pv, f * 3);
    }
    const tracks = all.map((b, i) => new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, qv[i]));
    tracks.push(new THREE.VectorKeyframeTrack(`${bones.Hips.name}.position`, times, pv));
    clips.push(Object.assign(new THREE.AnimationClip(pose.id, pose.duration, tracks), { label: pose.label }));
  }
  return clips;
}
