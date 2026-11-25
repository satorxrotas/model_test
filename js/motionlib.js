// Motion library shared by Motion Studio and Image to Blend: clip retargeting and the list of motions.
import * as THREE from 'three';
import { bonesByName, snapshotPose, applyPose } from './autoskin.js';
import { POSES, bakePoses } from './poses.js';

export const MOVES = [
  { id: 'idle', label: 'Idle', src: 'men', clip: 'idle' },
  { id: 'walkloop', label: 'Seamless walk', src: 'men', clip: 'walk', loop: 1 },
  { id: 'walk', label: 'Walk', src: 'men', clip: 'walk' },
  { id: 'run', label: 'Run', src: 'men', clip: 'run' },
  { id: 'samba', label: 'Dance', src: 'women', clip: 'SambaDance' },
  { id: 'agree', label: 'Nod', src: 'men', clip: 'agree' },
  { id: 'shake', label: 'Head shake', src: 'men', clip: 'headShake' },
];

// World-space delta retargeting between two humanoid rigs that share bone names.
// target_world(t) = source_world(t) * inv(source_rest_world) * target_rest_world
export function retargetClipFor({ src, clip, character, bones, span, fps = 30 }) {
  const srcRoot = src.scene;
  const srcBones = bonesByName(srcRoot);
  // measure the source rest pose in T-pose when the rig ships one
  const tpose = src.animations.find((a) => /t-?pose/i.test(a.name));
  if (tpose) { const tm = new THREE.AnimationMixer(srcRoot); tm.clipAction(tpose).play(); tm.setTime(0); tm.stopAllAction(); tm.uncacheRoot(srcRoot); }
  srcRoot.updateMatrixWorld(true);
  character.updateMatrixWorld(true);
  const order = [];
  character.traverse((o) => { if (o.isBone) { const n = o.name.replace(/^mixamorig[:_]?/, ''); if (srcBones[n]) order.push([n, o]); } });
  const restS = {}, restT = {};
  for (const [n, tb] of order) { restS[n] = srcBones[n].getWorldQuaternion(new THREE.Quaternion()); restT[n] = tb.getWorldQuaternion(new THREE.Quaternion()); }
  const W = (bs, n) => bs[n].getWorldPosition(new THREE.Vector3());
  const srcSpan = W(srcBones, 'Neck').y - (W(srcBones, 'LeftFoot').y + W(srcBones, 'RightFoot').y) / 2;
  const ratio = span / srcSpan;
  const hipsRestS = W(srcBones, 'Hips'), hipsRestT = W(bones, 'Hips');
  const hipsParentInv = bones.Hips.parent.matrixWorld.clone().invert();

  const smix = new THREE.AnimationMixer(srcRoot);
  smix.clipAction(clip).play();
  const frames = Math.max(2, Math.floor(clip.duration * fps + 1e-6) + 1);
  const times = new Float32Array(frames);
  const qv = Object.fromEntries(order.map(([n]) => [n, new Float32Array(frames * 4)]));
  const pv = new Float32Array(frames * 3);
  const worldT = {}, q = new THREE.Quaternion(), pq = new THREE.Quaternion(), v = new THREE.Vector3();
  for (let f = 0; f < frames; f++) {
    const t = Math.min(clip.duration, f / fps); times[f] = t;
    smix.setTime(t); srcRoot.updateMatrixWorld(true);
    for (const [n, tb] of order) {
      const ws = srcBones[n].getWorldQuaternion(q);
      const wt = (worldT[n] ||= new THREE.Quaternion()).copy(ws).multiply(restS[n].clone().invert()).multiply(restT[n]);
      const parentName = tb.parent.isBone ? tb.parent.name.replace(/^mixamorig[:_]?/, '') : null;
      const parentW = parentName && worldT[parentName] ? worldT[parentName] : tb.parent.getWorldQuaternion(pq);
      const local = parentW.clone().invert().multiply(wt);
      local.toArray(qv[n], f * 4);
    }
    v.copy(W(srcBones, 'Hips')).sub(hipsRestS).multiplyScalar(ratio).add(hipsRestT).applyMatrix4(hipsParentInv);
    v.toArray(pv, f * 3);
  }
  smix.stopAllAction(); smix.uncacheRoot(srcRoot);
  const tracks = order.map(([n, tb]) => new THREE.QuaternionKeyframeTrack(`${tb.name}.quaternion`, times, qv[n]));
  tracks.push(new THREE.VectorKeyframeTrack(`${bones.Hips.name}.position`, times, pv));
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}


// Re-time a cyclic clip to exactly `period` seconds on whole frames, with its last frame identical to its first
// and any drift spread over the cycle, so it repeats with no hitch (and whole-second videos end where they start).
export function makeSeamless(clip, period = 1, fps = 30) {
  const N = Math.max(2, Math.round(period * fps)), dur = clip.duration;
  const times = Float32Array.from({ length: N + 1 }, (_, k) => k / fps);
  const tracks = clip.tracks.map((tr) => {
    const n = tr.getValueSize(), it = tr.createInterpolant(), vals = new Float32Array((N + 1) * n);
    const start = Float32Array.from(it.evaluate(0)), end = Float32Array.from(it.evaluate(dur));
    const quat = tr instanceof THREE.QuaternionKeyframeTrack;
    for (let k = 0; k < N; k++) {
      const v = it.evaluate((k / N) * dur);
      for (let j = 0; j < n; j++) vals[k * n + j] = quat ? v[j] : v[j] - (end[j] - start[j]) * (k / N);
    }
    vals.set(vals.subarray(0, n), N * n); // close the loop exactly
    return new tr.constructor(tr.name, times, vals);
  });
  return new THREE.AnimationClip(clip.name, N / fps, tracks);
}

// Build the requested motions for a character: figs = { women, men } from loadFigure, own = the character's figure id.
// Returns AnimationClips named by motion id (model poses are p_* ids from poses.js).
export function buildMotions({ figs, own, character, bones, span, ids }) {
  const out = [], byId = {};
  const need = new Set(ids); if ([...need].some((i) => i.startsWith('p_'))) need.add('idle');
  for (const m of MOVES) {
    if (!need.has(m.id)) continue;
    const src = figs[m.src].gltf, clip = src.animations.find((a) => a.name === m.clip); if (!clip) continue;
    let baked;
    if (m.src === own) baked = clip.clone();
    else { const sb = bonesByName(src.scene), rest = snapshotPose(sb); baked = retargetClipFor({ src, clip, character, bones, span }); applyPose(rest); src.scene.updateMatrixWorld(true); }
    if (m.loop) baked = makeSeamless(baked, m.loop);
    baked.name = m.id; byId[m.id] = baked;
  }
  if (byId.idle && [...need].some((i) => i.startsWith('p_'))) for (const c of bakePoses({ character, bones, base: byId.idle, span })) byId[c.name] = c;
  for (const id of ids) if (byId[id]) out.push(byId[id]);
  return out;
}
export { POSES };
