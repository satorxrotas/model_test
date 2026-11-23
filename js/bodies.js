// The two bodies garments are built on and animated with. Both are Mixamo rigs in a T-pose that share bone names.
export const FIGURES = {
  women: { label: 'Women', file: 'Michelle', sex: 'f' },
  men: { label: 'Men', file: 'Xbot', sex: 'm', surface: 'Beta_Surface' },
};

const cache = {};
// load (once) and return { gltf, scene, bodyMesh, meshes }: bodyMesh is the skin surface used for fitting,
// meshes are every skinned mesh of the figure (Xbot's joint pieces are a separate mesh)
export async function loadFigure(loader, id) {
  const f = FIGURES[id] || FIGURES.women;
  const gltf = await (cache[f.file] ||= loader.loadAsync(`assets/rigs/${f.file}.glb`));
  const scene = gltf.scene, meshes = [];
  scene.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });
  const bodyMesh = meshes.find((m) => m.name === f.surface) || meshes.sort((a, b) => b.geometry.attributes.position.count - a.geometry.attributes.position.count)[0];
  return { gltf, scene, bodyMesh, meshes, figure: f, id: FIGURES[id] ? id : 'women' };
}

/* ---------- moving a pre-fitted garment from one body to the other ---------- */
import * as THREE from 'three';
import { bonesByName, sampleBody } from './autoskin.js';
import { bodyInfo } from './garments.js';

// landmarks of a figure in its rest pose
export function landmarks(fig) {
  fig.scene.updateMatrixWorld(true);
  const B = bonesByName(fig.scene), W = (n) => B[n].getWorldPosition(new THREE.Vector3());
  const all = fig.meshes.map((m) => sampleBody(m).pos), pos = new Float32Array(all.reduce((n, p) => n + p.length, 0));
  all.reduce((o, p) => (pos.set(p, o), o + p.length), 0);
  const b = bodyInfo(B, pos, { sex: fig.figure.sex });
  const chestY = b.arm.L.y - 0.12;
  return {
    b, ys: [0, b.ft.L.y, b.kn.L.y, b.crotchY, b.hips.y, chestY, b.arm.L.y, b.neck.y, W('Head').y],
    hip: b.section(b.crotchY + 0.09 * b.scale), chest: b.section(chestY, 0.2), chestY,
    armX: Math.abs(b.arm.L.x - b.hips.x), armLen: b.hand.L.distanceTo(b.arm.L),
  };
}

const sstep = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
function mapY(y, A, B) {
  const a = A.ys, b = B.ys, n = a.length;
  if (y <= a[0]) return b[0] + (y - a[0]);
  for (let i = 0; i + 1 < n; i++) if (y <= a[i + 1]) return b[i] + ((y - a[i]) * (b[i + 1] - b[i])) / (a[i + 1] - a[i]);
  return b[n - 1] + (y - a[n - 1]) * ((b[n - 1] - b[n - 2]) / (a[n - 1] - a[n - 2]));
}

// re-shape a garment built on body A so it sits the same way on body B (torso by girth, legs and arms by their axes)
export function morphGeometry(geo, A, B) {
  const p = geo.attributes.position, v = new THREE.Vector3();
  const rHip = B.hip.perim / A.hip.perim, rChest = B.chest.perim / A.chest.perim;
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const y2 = mapY(v.y, A, B);
    // torso: scale around the body's centre, girth ratio blended from hips to chest
    const t = sstep((v.y - A.b.hips.y) / Math.max(0.05, A.chestY - A.b.hips.y)), r = rHip + (rChest - rHip) * t;
    const cA = A.hip.cz + (A.chest.cz - A.hip.cz) * t, cB = B.hip.cz + (B.chest.cz - B.hip.cz) * t;
    const torso = [B.b.hips.x + (v.x - A.b.hips.x) * r, y2, cB + (v.z - cA) * r];
    let out = torso;
    // legs: follow each leg's axis, scaled by leg thickness
    if (v.y < A.b.crotchY + 0.06) {
      const side = v.x >= A.b.hips.x ? 'L' : 'R', a = A.b.legAt(side, v.y), b = B.b.legAt(side, y2);
      const rl = B.b.legR(y2) / Math.max(1e-4, A.b.legR(v.y));
      const leg = [b.x + (v.x - a.x) * rl, y2, b.z + (v.z - a.z) * rl], w = sstep((A.b.crotchY + 0.06 - v.y) / 0.08);
      out = out.map((c, k) => c + (leg[k] - c) * w);
    }
    // arms: along the (horizontal) arm, scaled by arm length and thickness
    const dx = Math.abs(v.x - A.b.hips.x);
    if (dx > A.armX - 0.08 && v.y > A.b.arm.L.y - 0.22) {
      const sg = Math.sign(v.x - A.b.hips.x) || 1, side = sg > 0 ? 'L' : 'R', a0 = A.b.arm[side], b0 = B.b.arm[side];
      const along = Math.max(0, dx - A.armX), ra = B.b.armR(0) / A.b.armR(0);
      const arm = [B.b.hips.x + sg * (B.armX + along * (B.armLen / A.armLen)) + (dx < A.armX ? sg * (dx - A.armX) * r : 0), b0.y + (v.y - a0.y) * ra, b0.z + (v.z - a0.z) * ra];
      const w = sstep((dx - (A.armX - 0.08)) / 0.1) * sstep((v.y - (A.b.arm.L.y - 0.22)) / 0.08);
      out = out.map((c, k) => c + (arm[k] - c) * w);
    }
    p.setXYZ(i, out[0], out[1], out[2]);
  }
  p.needsUpdate = true; geo.computeBoundingBox(); geo.computeBoundingSphere(); // normals kept: the shape changes smoothly
}
