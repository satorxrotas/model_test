// Auto-skinning: fits an un-rigged garment onto a rigged body and transfers skin weights.
import * as THREE from 'three';

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();

/* ---------- garment extraction ---------- */

// Turn any loaded Object3D into world-space, non-indexed geometry parts (one per material).
export function extractParts(root) {
  root.updateMatrixWorld(true);
  const byKey = new Map();
  let n = 0;
  root.traverse((m) => {
    if (!m.isMesh || !m.geometry?.attributes?.position) return;
    let g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    g.applyMatrix4(m.matrixWorld);
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const total = g.attributes.position.count;
    const groups = g.groups.length ? g.groups : [{ start: 0, count: total, materialIndex: 0 }];
    for (const grp of groups) {
      const start = grp.start, count = Math.min(grp.count, total - start);
      if (count < 3) continue;
      const mat = mats[grp.materialIndex ?? 0] || mats[0];
      const key = (mat && mat.name) || `part${n++}`;
      if (!byKey.has(key)) byKey.set(key, { name: key, map: mat?.map || null, color: mat?.map ? '#ffffff' : null, chunks: [] });
      const chunk = {};
      for (const a of ['position', 'normal', 'uv']) {
        const at = g.attributes[a];
        if (!at) continue;
        const arr = new Float32Array(count * at.itemSize);
        for (let i = 0; i < count; i++) for (let c = 0; c < at.itemSize; c++) arr[i * at.itemSize + c] = at.getComponent(start + i, c);
        chunk[a] = arr;
      }
      byKey.get(key).chunks.push(chunk);
    }
  });
  const parts = [];
  for (const p of byKey.values()) {
    const geo = new THREE.BufferGeometry();
    for (const [a, size] of [['position', 3], ['normal', 3], ['uv', 2]]) {
      if (!p.chunks.every((c) => c[a])) continue;
      const len = p.chunks.reduce((s, c) => s + c[a].length, 0);
      const arr = new Float32Array(len); let o = 0;
      for (const c of p.chunks) { arr.set(c[a], o); o += c[a].length; }
      geo.setAttribute(a, new THREE.BufferAttribute(arr, size));
    }
    if (!geo.attributes.normal) geo.computeVertexNormals();
    geo.computeBoundingBox();
    parts.push({ name: p.name, map: p.map, color: p.color, geometry: geo });
  }
  // label by height: highest = Upper, lowest = Lower
  parts.sort((a, b) => b.geometry.boundingBox.max.y - a.geometry.boundingBox.max.y);
  parts.forEach((p, i) => { p.label = parts.length === 2 ? (i === 0 ? 'Upper' : 'Lower') : `Part ${i + 1}`; });
  return parts;
}

/* ---------- spatial grid for nearest-neighbour lookups ---------- */

class Grid {
  constructor(pos, cell) {
    this.pos = pos; this.cell = cell; this.map = new Map();
    for (let i = 0; i < pos.length / 3; i++) {
      const k = this.key(Math.floor(pos[i * 3] / cell), Math.floor(pos[i * 3 + 1] / cell), Math.floor(pos[i * 3 + 2] / cell));
      let b = this.map.get(k); if (!b) this.map.set(k, (b = [])); b.push(i);
    }
  }
  key(x, y, z) { return `${x},${y},${z}`; }
  knn(x, y, z, k, outI, outD) {
    const c = this.cell, cx = Math.floor(x / c), cy = Math.floor(y / c), cz = Math.floor(z / c), P = this.pos;
    let found = 0;
    for (let i = 0; i < k; i++) { outI[i] = -1; outD[i] = Infinity; }
    for (let r = 0; r < 40; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
        const b = this.map.get(this.key(cx + dx, cy + dy, cz + dz)); if (!b) continue;
        for (const j of b) {
          const ex = P[j * 3] - x, ey = P[j * 3 + 1] - y, ez = P[j * 3 + 2] - z, d = ex * ex + ey * ey + ez * ez;
          if (d >= outD[k - 1]) continue;
          let s = k - 1; while (s > 0 && outD[s - 1] > d) { outD[s] = outD[s - 1]; outI[s] = outI[s - 1]; s--; }
          outD[s] = d; outI[s] = j; found++;
        }
      }
      if (found >= k && outD[k - 1] <= (r * c) * (r * c)) break;
    }
  }
}

/* ---------- body helpers ---------- */

export function bonesByName(character) {
  const out = {};
  character.traverse((o) => { if (o.isBone) out[o.name.replace(/^mixamorig[:_]?/, '')] = o; });
  return out;
}

export function snapshotPose(bones) {
  return Object.values(bones).map((b) => [b, b.position.clone(), b.quaternion.clone(), b.scale.clone()]);
}
export function applyPose(snap) { for (const [b, p, q, s] of snap) { b.position.copy(p); b.quaternion.copy(q); b.scale.copy(s); } }

// Posed body vertices + normals in world space.
export function sampleBody(bodyMesh) {
  bodyMesh.updateMatrixWorld(true);
  bodyMesh.skeleton.update();
  const geo = bodyMesh.geometry, n = geo.attributes.position.count;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    bodyMesh.getVertexPosition(i, _v1).applyMatrix4(bodyMesh.matrixWorld);
    pos[i * 3] = _v1.x; pos[i * 3 + 1] = _v1.y; pos[i * 3 + 2] = _v1.z;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (geo.index) g.setIndex(geo.index);
  g.computeVertexNormals();
  return { pos, nrm: g.attributes.normal.array, n, skinIndex: geo.attributes.skinIndex, skinWeight: geo.attributes.skinWeight };
}

// Rotate `bone` so that `endBone` points at `target` (world space).
export function aimBone(bone, endBone, target) {
  bone.parent.updateMatrixWorld(true);
  bone.updateMatrixWorld(true);
  const p = bone.getWorldPosition(_v1), e = endBone.getWorldPosition(_v2);
  const from = e.sub(p).normalize(), to = _v3.copy(target).sub(p).normalize();
  const qW = _q1.setFromUnitVectors(from, to);
  const boneW = bone.getWorldQuaternion(_q2);
  const parentInv = bone.parent.getWorldQuaternion(_q3).invert();
  bone.quaternion.copy(parentInv.multiply(qW.multiply(boneW)));
  bone.updateMatrixWorld(true);
}

function centroid(points) {
  const c = new THREE.Vector3(); if (!points.length) return null;
  for (const p of points) c.add(p); return c.divideScalar(points.length);
}

/* ---------- main fit ---------- */

/**
 * Fits garment parts onto the body and returns SkinnedMeshes bound to the body's bones.
 * opts: { scale, lift, depth, clearance }  (scale is multiplicative, others in metres)
 */
export function fitGarment({ character, bodyMesh, bones, restPose, parts, opts }) {
  applyPose(restPose);
  character.updateMatrixWorld(true);

  const W = (name) => bones[name].getWorldPosition(new THREE.Vector3());
  const neck = W('Neck'), hips = W('Hips');
  const footY = (W('LeftFoot').y + W('RightFoot').y) / 2;
  const span = neck.y - footY;

  // Combined raw bounds
  const raw = new THREE.Box3(); for (const p of parts) raw.union(p.geometry.boundingBox);
  const rawH = raw.max.y - raw.min.y;
  const all = []; // flat list of [partIndex, vertexIndex]
  const P = (p, i) => _v1.fromBufferAttribute(parts[p].geometry.attributes.position, i);

  // Detect legs: two separated clusters near the bottom of the garment
  const lowL = [], lowR = [];
  const midX = (raw.min.x + raw.max.x) / 2;
  parts.forEach((part, pi) => {
    const pos = part.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      all.push(pi, i);
      const v = P(pi, i);
      if (v.y < raw.min.y + rawH * 0.05) (v.x > midX ? lowL : lowR).push(v.clone());
    }
  });
  const legGap = lowL.length && lowR.length ? Math.min(...lowL.map((v) => v.x)) - Math.max(...lowR.map((v) => v.x)) : -1;
  const hasLegs = legGap > rawH * 0.02;

  // Scale + vertical placement
  let s, ty;
  if (hasLegs) {
    // garment spans collar -> ankle: map onto neck -> foot
    const topY = neck.y + span * 0.035, botY = footY - span * 0.012;
    s = (topY - botY) / rawH;
    s *= opts.scale;
    ty = botY - raw.min.y * s;
  } else {
    // unknown coverage: guess units, assume modelled on a ~1.70 m avatar with feet at y=0
    const units = [1, 0.01, 0.001, 0.0254];
    const u = units.find((k) => raw.max.y * k > 0.25 && raw.max.y * k < 2.3) ?? 1;
    const groundY = footY - span * 0.06;
    s = u * ((neck.y - groundY) / 1.45) * opts.scale;
    ty = groundY;
  }

  // Horizontal alignment using the torso band
  const bandLo = footY + span * 0.5, bandHi = neck.y - span * 0.12, bandX = span * 0.14;
  const body0 = sampleBody(bodyMesh);
  const bb = new THREE.Box3(), gb = new THREE.Box3();
  for (let i = 0; i < body0.n; i++) {
    const x = body0.pos[i * 3], y = body0.pos[i * 3 + 1], z = body0.pos[i * 3 + 2];
    if (y > bandLo && y < bandHi && Math.abs(x - hips.x) < bandX) bb.expandByPoint(_v2.set(x, y, z));
  }
  const gxc = (raw.min.x + raw.max.x) / 2;
  for (let k = 0; k < all.length; k += 2) {
    const v = P(all[k], all[k + 1]); const y = v.y * s + ty, x = (v.x - gxc) * s;
    if (y > bandLo && y < bandHi && Math.abs(x) < bandX) gb.expandByPoint(_v2.set(x, 0, v.z * s));
  }
  const tx = hips.x - gxc * s;
  let tz = 0;
  if (!bb.isEmpty() && !gb.isEmpty()) tz = (bb.min.z + bb.max.z) / 2 - (gb.min.z + gb.max.z) / 2;
  tz += opts.depth; ty += opts.lift;

  const M = new THREE.Matrix4().makeTranslation(tx, ty, tz).multiply(new THREE.Matrix4().makeScale(s, s, s));
  const fitted = parts.map((p) => { const g = p.geometry.clone(); g.applyMatrix4(M); g.computeBoundingBox(); return g; });
  const fb = new THREE.Box3(); fitted.forEach((g) => fb.union(g.boundingBox));
  const fH = fb.max.y - fb.min.y;

  // Aim limbs at sleeve cuffs / pant hems so the bind pose matches the garment
  const shoulderW = Math.abs(W('LeftArm').x - W('RightArm').x);
  const cuffL = [], cuffR = [], hemL = [], hemR = [];
  const maxX = Math.max(Math.abs(fb.max.x - hips.x), Math.abs(fb.min.x - hips.x));
  fitted.forEach((g) => {
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const v = _v1.fromBufferAttribute(pos, i), dx = v.x - hips.x;
      if (Math.abs(dx) > maxX * 0.9 && Math.abs(dx) > shoulderW * 0.9)(dx > 0 ? cuffL : cuffR).push(v.clone());
      if (hasLegs && v.y < fb.min.y + fH * 0.04) (dx > 0 ? hemL : hemR).push(v.clone());
    }
  });
  const cL = centroid(cuffL), cR = centroid(cuffR), hL = centroid(hemL), hR = centroid(hemR);
  if (cL && cR) { aimBone(bones.LeftArm, bones.LeftHand, cL); aimBone(bones.RightArm, bones.RightHand, cR); }
  if (hL && hR) {
    aimBone(bones.LeftUpLeg, bones.LeftFoot, hL.clone().setY(hL.y + fH * 0.02));
    aimBone(bones.RightUpLeg, bones.RightFoot, hR.clone().setY(hR.y + fH * 0.02));
  }
  character.updateMatrixWorld(true);
  const bindPose = snapshotPose(bones);

  // ---- weight transfer ----
  const body = sampleBody(bodyMesh);
  const grid = new Grid(body.pos, span * 0.04);
  const NB = bodyMesh.skeleton.bones.length;
  const K = 6, idx = new Int32Array(K), dst = new Float64Array(K);
  const q = span * 1e-5;
  const clearance = opts.clearance;

  // weld coincident vertices (across UV seams and parts) so weights never crack
  const weld = new Map(), wpos = [], refs = [];
  fitted.forEach((g, gi) => {
    const pos = g.attributes.position; const r = new Int32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const key = `${Math.round(x / q)},${Math.round(y / q)},${Math.round(z / q)}`;
      let id = weld.get(key); if (id === undefined) { id = wpos.length / 3; weld.set(key, id); wpos.push(x, y, z); }
      r[i] = id;
    }
    refs.push(r);
  });
  const nW = wpos.length / 3;
  let Wt = new Float32Array(nW * NB);
  const offset = new Float32Array(nW * 3);

  for (let w = 0; w < nW; w++) {
    const x = wpos[w * 3], y = wpos[w * 3 + 1], z = wpos[w * 3 + 2];
    grid.knn(x, y, z, K, idx, dst);
    let tot = 0;
    for (let k = 0; k < K; k++) {
      const j = idx[k]; if (j < 0) continue;
      const iw = 1 / (dst[k] + (span * 0.004) ** 2);
      for (let c = 0; c < 4; c++) {
        const wt = body.skinWeight.getComponent(j, c); if (!wt) continue;
        Wt[w * NB + body.skinIndex.getComponent(j, c)] += wt * iw; tot += wt * iw;
      }
    }
    if (tot > 0) for (let b = 0; b < NB; b++) Wt[w * NB + b] /= tot;
    // push out anything sitting inside (or too close to) the body
    const j0 = idx[0];
    if (j0 >= 0) {
      const nx = body.nrm[j0 * 3], ny = body.nrm[j0 * 3 + 1], nz = body.nrm[j0 * 3 + 2];
      const ex = x - body.pos[j0 * 3], ey = y - body.pos[j0 * 3 + 1], ez = z - body.pos[j0 * 3 + 2];
      const d = ex * nx + ey * ny + ez * nz;
      if (d < clearance && Math.sqrt(dst[0]) < span * 0.08) {
        const push = clearance - d;
        offset[w * 3] = nx * push; offset[w * 3 + 1] = ny * push; offset[w * 3 + 2] = nz * push;
      }
    }
  }

  // neighbour graph from triangles, then smooth weights + offsets
  const nbr = Array.from({ length: nW }, () => new Set());
  refs.forEach((r) => {
    for (let t = 0; t + 2 < r.length; t += 3) {
      const a = r[t], b = r[t + 1], c = r[t + 2];
      nbr[a].add(b).add(c); nbr[b].add(a).add(c); nbr[c].add(a).add(b);
    }
  });
  const smooth = (arr, stride, iters, keep) => {
    for (let it = 0; it < iters; it++) {
      const out = new Float32Array(arr.length);
      for (let v = 0; v < nW; v++) {
        const ns = nbr[v]; const o = v * stride;
        if (!ns.size) { for (let c = 0; c < stride; c++) out[o + c] = arr[o + c]; continue; }
        for (const u of ns) for (let c = 0; c < stride; c++) out[o + c] += arr[u * stride + c];
        for (let c = 0; c < stride; c++) out[o + c] = keep * arr[o + c] + (1 - keep) * out[o + c] / ns.size;
      }
      arr = out;
    }
    return arr;
  };
  Wt = smooth(Wt, NB, 3, 0.5);
  const off = smooth(offset, 3, 4, 0.4);

  // top-4 influences per welded vertex
  const sIdx = new Uint16Array(nW * 4), sW = new Float32Array(nW * 4);
  for (let v = 0; v < nW; v++) {
    const top = [];
    for (let b = 0; b < NB; b++) {
      const wt = Wt[v * NB + b]; if (wt <= 1e-4) continue;
      top.push([b, wt]);
    }
    top.sort((a, b) => b[1] - a[1]);
    let tot = 0; for (let c = 0; c < 4 && c < top.length; c++) tot += top[c][1];
    for (let c = 0; c < 4; c++) {
      if (c < top.length && tot > 0) { sIdx[v * 4 + c] = top[c][0]; sW[v * 4 + c] = top[c][1] / tot; }
    }
    if (!top.length) { sIdx[v * 4] = 0; sW[v * 4] = 1; }
  }

  // build skinned meshes
  const skeleton = new THREE.Skeleton(bodyMesh.skeleton.bones); // inverses captured in the fitted A-pose
  const geometries = fitted.map((g, gi) => {
    const r = refs[gi], n = r.length, pos = g.attributes.position;
    const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const w = r[i];
      pos.setXYZ(i, pos.getX(i) + off[w * 3], pos.getY(i) + off[w * 3 + 1], pos.getZ(i) + off[w * 3 + 2]);
      for (let c = 0; c < 4; c++) { si[i * 4 + c] = sIdx[w * 4 + c]; sw[i * 4 + c] = sW[w * 4 + c]; }
    }
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    g.computeBoundingSphere();
    return g;
  });

  return { geometries, skeleton, bindPose, info: { hasLegs, scale: s, sleeves: !!(cL && cR), vertices: nW } };
}
