// Exports the fitted garment as a rigged, Blender-ready .glb:
// armature + skinned garment (+ optional body) + optional motion clips.
// Rest pose = the garment's own modelled pose, so nothing shifts on import.
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { sampleBody } from './autoskin.js';

export async function exportRiggedGLB({ character, bodyMesh, garment, skeleton, bindPose, applyPose, includeBody, clips, name }) {
  // 1. put the live rig into the bind (fit) pose and rebuild a clean skeleton:
  //    identity root, metres, no scale — the source rig's root rotation/scale is baked
  //    into the top bone so every DCC tool (Blender included) reads the same rest pose.
  applyPose(bindPose);
  character.updateMatrixWorld(true);
  const root = new THREE.Scene(); // meshes + skeleton become root nodes (spec-clean)
  root.name = name;
  const map = new Map(), rootInfo = new Map();
  const src = skeleton.bones;
  for (const b of src) { const nb = new THREE.Bone(); nb.name = b.name; map.set(b, nb); }
  const pW = new THREE.Vector3(), qW = new THREE.Quaternion(), sW = new THREE.Vector3();
  for (const b of src) {
    const nb = map.get(b);
    nb.quaternion.copy(b.quaternion); nb.scale.copy(b.scale);
    if (b.parent && map.has(b.parent)) {
      nb.position.copy(b.position).multiplyScalar(unitScale(b.parent));
      map.get(b.parent).add(nb);
    } else {
      const P = b.parent ? b.parent.matrixWorld.clone() : new THREE.Matrix4();
      P.decompose(pW, qW, sW);
      rootInfo.set(b.name, { P, q: qW.clone() });
      nb.position.copy(b.position).applyMatrix4(P);
      nb.quaternion.premultiply(qW);
      root.add(nb);
    }
  }
  for (const nb of map.values()) nb.quaternion.normalize();
  root.updateMatrixWorld(true);
  const skel = new THREE.Skeleton(src.map((b) => map.get(b)));

  // convert motion curves into the clean skeleton's space
  const names = new Set(src.map((b) => b.name));
  const scaleOf = Object.fromEntries(src.map((b) => [b.name, b.parent && map.has(b.parent) ? unitScale(b.parent) : 1]));
  const outClips = clips.map((clip) => {
    const tracks = [];
    for (const t of clip.tracks) {
      const [node, prop] = [t.name.slice(0, t.name.lastIndexOf('.')), t.name.slice(t.name.lastIndexOf('.') + 1)];
      if (!names.has(node)) continue;
      const tt = t.clone(), v = tt.values, ri = rootInfo.get(node);
      if (prop === 'quaternion' && ri) {
        const q = new THREE.Quaternion();
        for (let i = 0; i < v.length; i += 4) { q.fromArray(v, i).premultiply(ri.q).toArray(v, i); }
      } else if (prop === 'position') {
        const p = new THREE.Vector3();
        for (let i = 0; i < v.length; i += 3) {
          p.fromArray(v, i);
          if (ri) p.applyMatrix4(ri.P); else p.multiplyScalar(scaleOf[node]);
          p.toArray(v, i);
        }
      }
      tracks.push(tt);
    }
    return new THREE.AnimationClip(clip.name, clip.duration, tracks.map(cleanTrack));
  });

  // 2. garment pieces, bound with the same inverse-bind matrices as in the studio
  garment.children.forEach((m) => {
    const g = m.geometry.clone();
    // plain PBR material, no glTF extensions — imports cleanly in older Blender (3.x) too
    const src = m.material;
    const mat = new THREE.MeshStandardMaterial({ name: m.name, color: src.color.clone(), map: src.map || null, roughness: src.roughness, metalness: 0, side: THREE.DoubleSide });
    const sm = new THREE.SkinnedMesh(g, mat);
    sm.name = m.name;
    if (m.morphTargetInfluences) sm.morphTargetInfluences = m.morphTargetInfluences.slice();   // body-shape keys keep their current values
    root.add(sm);
    sm.updateMatrixWorld(true);
    sm.bind(skel, new THREE.Matrix4());
  });

  // 3. optional body, re-baked into the same fit pose so every mesh shares one bind pose
  if (includeBody) {
    const s = sampleBody(bodyMesh);
    const src = bodyMesh.geometry, g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(s.pos.slice(), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(Float32Array.from(s.nrm), 3));
    if (src.attributes.uv) g.setAttribute('uv', src.attributes.uv.clone());
    g.setAttribute('skinIndex', src.attributes.skinIndex.clone());
    g.setAttribute('skinWeight', src.attributes.skinWeight.clone());
    if (src.index) g.setIndex(src.index.clone());
    const body = new THREE.SkinnedMesh(g, new THREE.MeshStandardMaterial({ name: 'Body', color: '#cfc9c1', roughness: 0.6 }));
    body.name = 'Body';
    root.add(body);
    body.updateMatrixWorld(true);
    body.bind(skel, new THREE.Matrix4());
  }

  // 4. export
  const exporter = new GLTFExporter();
  const glb = await exporter.parseAsync(root, { binary: true, animations: outClips, onlyVisible: false });
  return new Blob([glb], { type: 'model/gltf-binary' });
}

// world-space length of one local unit under `obj` (e.g. 0.01 for a cm rig scaled to metres)
function unitScale(obj) {
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  obj.matrixWorld.decompose(p, q, s);
  return (s.x + s.y + s.z) / 3;
}

// drop keys whose time does not strictly increase; renormalise quaternions
function cleanTrack(t) {
  const n = t.getValueSize(), keep = [];
  for (let i = 0; i < t.times.length; i++) if (!keep.length || t.times[i] > t.times[keep[keep.length - 1]] + 1e-6) keep.push(i);
  const times = new Float32Array(keep.length), vals = new Float32Array(keep.length * n);
  keep.forEach((k, j) => { times[j] = t.times[k]; for (let c = 0; c < n; c++) vals[j * n + c] = t.values[k * n + c]; });
  if (n === 4 && /quaternion$/.test(t.name)) for (let i = 0; i < vals.length; i += 4) {
    const l = Math.hypot(vals[i], vals[i + 1], vals[i + 2], vals[i + 3]) || 1; for (let c = 0; c < 4; c++) vals[i + c] /= l;
  }
  return new t.constructor(t.name, times, vals);
}
