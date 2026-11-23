// Poly Simplify core: mesh extraction, welding, quadric simplification (meshoptimizer) and OBJ/MTL writing.
import * as THREE from 'three';
import { MeshoptSimplifier } from '../vendor/meshoptimizer/meshopt_simplifier.module.js';

export const ready = MeshoptSimplifier.ready;

/* ---------- extraction ---------- */

// Every mesh × material group becomes one "part": welded, indexed, world-space geometry.
// flipV marks glTF-sourced UVs (origin top-left) so the OBJ writer can convert them.
export function extractParts(root, { flipV = false } = {}) {
  root.updateMatrixWorld(true);
  const parts = [];
  const nMat = new THREE.Matrix3();
  root.traverse((m) => {
    if (!m.isMesh || !m.geometry?.attributes?.position) return;
    const g = m.geometry, pos = g.attributes.position, nrm = g.attributes.normal, uv = g.attributes.uv;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const count = g.index ? g.index.count : pos.count;
    const groups = g.groups.length ? g.groups : [{ start: 0, count, materialIndex: 0 }];
    nMat.getNormalMatrix(m.matrixWorld);
    const flipWinding = m.matrixWorld.determinant() < 0;
    const v = new THREE.Vector3();
    for (const grp of groups) {
      const start = grp.start, n = Math.min(grp.count, count - start) - (Math.min(grp.count, count - start) % 3);
      if (n < 3) continue;
      const P = new Float32Array(n * 3), N = nrm ? new Float32Array(n * 3) : null, U = uv ? new Float32Array(n * 2) : null;
      for (let i = 0; i < n; i++) {
        // reverse triangle order if the transform mirrors the mesh, so faces keep facing outward
        const ii = flipWinding ? (i - (i % 3)) + (2 - (i % 3)) : i;
        const src = g.index ? g.index.getX(start + ii) : start + ii;
        v.fromBufferAttribute(pos, src).applyMatrix4(m.matrixWorld); v.toArray(P, i * 3);
        if (N) { v.fromBufferAttribute(nrm, src).applyMatrix3(nMat).normalize(); v.toArray(N, i * 3); }
        if (U) { U[i * 2] = uv.getX(src); U[i * 2 + 1] = uv.getY(src); }
      }
      const w = weld(P, N, U);
      const mat = mats[grp.materialIndex ?? 0] || mats[0] || new THREE.MeshStandardMaterial();
      parts.push({ name: m.name || `mesh${parts.length + 1}`, material: mat, flipV, ...w });
    }
  });
  return parts;
}

// Merge bit-identical vertices (position + normal + uv). Exact matches only, so UV seams and hard edges survive.
function weld(P, N, U) {
  const n = P.length / 3;
  const pb = new Uint32Array(P.buffer), ub = U ? new Uint32Array(U.buffer) : null;
  let size = 1; while (size < n * 2) size <<= 1;
  const table = new Int32Array(size).fill(-1), mask = size - 1;
  const remap = new Uint32Array(n), first = new Uint32Array(n);
  let unique = 0;
  // same position + UV, and normals within ~25° (merges faceted normals that loaders generate for files
  // without normals, but keeps real hard edges split)
  const same = (a, b) => {
    for (let c = 0; c < 3; c++) if (pb[a * 3 + c] !== pb[b * 3 + c]) return false;
    if (ub) for (let c = 0; c < 2; c++) if (ub[a * 2 + c] !== ub[b * 2 + c]) return false;
    if (N && N[a * 3] * N[b * 3] + N[a * 3 + 1] * N[b * 3 + 1] + N[a * 3 + 2] * N[b * 3 + 2] < 0.9) return false;
    return true;
  };
  for (let i = 0; i < n; i++) {
    let h = 2166136261;
    for (let c = 0; c < 3; c++) h = Math.imul(h ^ pb[i * 3 + c], 16777619);
    if (ub) for (let c = 0; c < 2; c++) h = Math.imul(h ^ ub[i * 2 + c], 16777619);
    let slot = (h >>> 0) & mask;
    for (;;) {
      const e = table[slot];
      if (e < 0) { table[slot] = unique; first[unique] = i; remap[i] = unique++; break; }
      if (same(first[e], i)) { remap[i] = e; break; }
      slot = (slot + 1) & mask;
    }
  }
  const pos = new Float32Array(unique * 3), nrm = N ? new Float32Array(unique * 3) : null, uv = U ? new Float32Array(unique * 2) : null;
  for (let u = 0; u < unique; u++) {
    const s = first[u];
    pos[u * 3] = P[s * 3]; pos[u * 3 + 1] = P[s * 3 + 1]; pos[u * 3 + 2] = P[s * 3 + 2];
    if (uv) { uv[u * 2] = U[s * 2]; uv[u * 2 + 1] = U[s * 2 + 1]; }
  }
  if (nrm) {
    for (let i = 0; i < n; i++) { const u = remap[i]; nrm[u * 3] += N[i * 3]; nrm[u * 3 + 1] += N[i * 3 + 1]; nrm[u * 3 + 2] += N[i * 3 + 2]; }
    for (let u = 0; u < unique; u++) { const l = Math.hypot(nrm[u * 3], nrm[u * 3 + 1], nrm[u * 3 + 2]) || 1; nrm[u * 3] /= l; nrm[u * 3 + 1] /= l; nrm[u * 3 + 2] /= l; }
  }
  // drop triangles that welding made degenerate
  const idx = new Uint32Array(n); let k = 0;
  for (let t = 0; t < n; t += 3) {
    const a = remap[t], b = remap[t + 1], c = remap[t + 2];
    if (a === b || b === c || a === c) continue;
    idx[k++] = a; idx[k++] = b; idx[k++] = c;
  }
  return { pos, nrm, uv, index: idx.slice(0, k) };
}

/* ---------- simplification ---------- */

/**
 * ratio: fraction of triangles to keep. opts: { lockBorder, prune, shading }
 * Returns per-part { pos, nrm, uv, index, error } with unused vertices removed.
 */
export function simplifyParts(parts, ratio, opts = {}) {
  const flags = [];
  if (opts.lockBorder) flags.push('LockBorder');
  if (opts.prune) flags.push('Prune');
  if (opts.regularize !== false) flags.push('Regularize'); // even triangles, far fewer slivers
  // Permissive: collapses may cross UV seams / hard edges; UVs are passed as attributes so
  // texture distortion is still penalised.
  if (opts.mergeSeams) flags.push('Permissive');
  return parts.map((p) => {
    const tris = p.index.length / 3;
    if (ratio >= 0.999 || tris < 4) return { ...p, error: 0 };
    const target = Math.max(3, Math.floor(tris * ratio) * 3);
    const useN = opts.shading !== false && p.nrm, useUV = !!p.uv;
    let out, err;
    if (useN || useUV) {
      const n = p.pos.length / 3, stride = (useN ? 3 : 0) + (useUV ? 2 : 0), attr = new Float32Array(n * stride);
      for (let v = 0; v < n; v++) {
        let o = v * stride;
        if (useN) { attr[o++] = p.nrm[v * 3]; attr[o++] = p.nrm[v * 3 + 1]; attr[o++] = p.nrm[v * 3 + 2]; }
        if (useUV) { attr[o++] = p.uv[v * 2]; attr[o++] = p.uv[v * 2 + 1]; }
      }
      const weights = [...(useN ? [0.5, 0.5, 0.5] : []), ...(useUV ? [1, 1] : [])];
      [out, err] = MeshoptSimplifier.simplifyWithAttributes(p.index, p.pos, 3, attr, stride, weights, null, target, 1, flags);
    } else {
      [out, err] = MeshoptSimplifier.simplify(p.index, p.pos, 3, target, 1, flags);
    }
    return { ...compact(p, out), error: err };
  });
}

function compact(p, index) {
  const n = p.pos.length / 3, map = new Int32Array(n).fill(-1);
  let u = 0;
  for (let i = 0; i < index.length; i++) if (map[index[i]] < 0) map[index[i]] = u++;
  const pos = new Float32Array(u * 3), nrm = p.nrm ? new Float32Array(u * 3) : null, uv = p.uv ? new Float32Array(u * 2) : null;
  for (let v = 0; v < n; v++) {
    const d = map[v]; if (d < 0) continue;
    pos.set(p.pos.subarray(v * 3, v * 3 + 3), d * 3);
    if (nrm) nrm.set(p.nrm.subarray(v * 3, v * 3 + 3), d * 3);
    if (uv) uv.set(p.uv.subarray(v * 2, v * 2 + 2), d * 2);
  }
  const idx = new Uint32Array(index.length);
  for (let i = 0; i < index.length; i++) idx[i] = map[index[i]];
  return { name: p.name, material: p.material, flipV: p.flipV, pos, nrm, uv, index: idx };
}

export function toGeometry(p) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p.pos, 3));
  if (p.nrm) g.setAttribute('normal', new THREE.BufferAttribute(p.nrm, 3));
  if (p.uv) g.setAttribute('uv', new THREE.BufferAttribute(p.uv, 2));
  g.setIndex(new THREE.BufferAttribute(p.index, 1));
  if (!p.nrm) g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

export const countTris = (parts) => parts.reduce((s, p) => s + p.index.length / 3, 0);
export const countVerts = (parts) => parts.reduce((s, p) => s + p.pos.length / 3, 0);

/* ---------- OBJ + MTL ---------- */

const safe = (s, fallback) => (String(s || '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || fallback);
const f6 = (x) => { const s = x.toFixed(6); return s === '-0.000000' ? '0.000000' : s; };

/**
 * Writes OBJ (+ MTL + texture files). Y-up, same units as the source, which is what
 * Blender's OBJ importer (3.x and 4.x, default axes) expects.
 * Returns { obj: string, mtl: string, textures: [{ path, texture }] }.
 */
export function writeOBJ(parts, baseName) {
  const matNames = new Map(), usedNames = new Set(), textures = new Map();
  const texKey = new Map(); // same file or image → one texture file
  const texPath = (tex, suffix) => {
    if (!tex?.image) return null;
    const key = (tex.userData?.fileName || '').toLowerCase() || tex.image;
    if (texKey.has(key)) return textures.get(texKey.get(key));
    texKey.set(key, tex);
    if (!textures.has(tex)) {
      const src = tex.userData?.fileName || tex.name || `${suffix}${textures.size + 1}`;
      let name = safe(src.replace(/\.[^.]+$/, ''), `tex${textures.size + 1}`);
      const ext = tex.userData?.fileName && /\.(jpe?g|png)$/i.test(tex.userData.fileName) ? tex.userData.fileName.split('.').pop().toLowerCase() : 'png';
      let path = `textures/${name}.${ext}`, k = 2;
      while ([...textures.values()].includes(path)) path = `textures/${name}_${k++}.${ext}`;
      textures.set(tex, path);
    }
    return textures.get(tex);
  };
  const mtl = [`# Poly Simplify · ${new Date().toISOString().slice(0, 10)}`, ''];
  for (const p of parts) {
    const m = p.material;
    if (matNames.has(m)) continue;
    let name = safe(m.name, `material${matNames.size + 1}`), k = 2;
    while (usedNames.has(name)) name = `${safe(m.name, 'material')}_${k++}`;
    usedNames.add(name); matNames.set(m, name);
    const c = (m.color || new THREE.Color(1, 1, 1)).clone().convertLinearToSRGB();
    const kd = texPath(m.map, 'basecolor'), kn = texPath(m.normalMap, 'normal');
    const rough = m.roughness ?? (m.shininess != null ? 1 - Math.min(1, Math.sqrt(m.shininess / 1000)) : 0.8);
    mtl.push(`newmtl ${name}`, `Ka 0.000000 0.000000 0.000000`, `Kd ${f6(c.r)} ${f6(c.g)} ${f6(c.b)}`,
      `Ks ${f6(0.5 * (1 - rough))} ${f6(0.5 * (1 - rough))} ${f6(0.5 * (1 - rough))}`, `Ns ${f6(Math.max(1, (1 - rough) ** 2 * 900))}`,
      `d ${f6(m.opacity ?? 1)}`, `illum 2`);
    if (kd) mtl.push(`map_Kd ${kd}`);
    if (kn) mtl.push(`map_Bump -bm 1.000000 ${kn}`);
    mtl.push('');
  }
  const out = [`# Poly Simplify · ${countTris(parts).toLocaleString('en-US')} triangles`, `mtllib ${baseName}.mtl`];
  let vo = 1, to = 1, no = 1;
  const objNames = new Set();
  for (const p of parts) {
    let name = safe(p.name, 'object'), k = 2;
    while (objNames.has(name)) name = `${safe(p.name, 'object')}_${k++}`;
    objNames.add(name);
    out.push(`o ${name}`);
    const nv = p.pos.length / 3, lines = new Array(nv);
    for (let i = 0; i < nv; i++) lines[i] = `v ${f6(p.pos[i * 3])} ${f6(p.pos[i * 3 + 1])} ${f6(p.pos[i * 3 + 2])}`;
    out.push(lines.join('\n'));
    if (p.uv) {
      for (let i = 0; i < nv; i++) { const v = p.uv[i * 2 + 1]; lines[i] = `vt ${f6(p.uv[i * 2])} ${f6(p.flipV ? 1 - v : v)}`; }
      out.push(lines.join('\n'));
    }
    if (p.nrm) {
      for (let i = 0; i < nv; i++) lines[i] = `vn ${f6(p.nrm[i * 3])} ${f6(p.nrm[i * 3 + 1])} ${f6(p.nrm[i * 3 + 2])}`;
      out.push(lines.join('\n'));
    }
    out.push(`usemtl ${matNames.get(p.material)}`, 's 1');
    const ix = p.index, nf = ix.length / 3, fl = new Array(nf);
    const ref = (i) => {
      const a = ix[i];
      if (p.uv && p.nrm) return `${a + vo}/${a + to}/${a + no}`;
      if (p.uv) return `${a + vo}/${a + to}`;
      if (p.nrm) return `${a + vo}//${a + no}`;
      return `${a + vo}`;
    };
    for (let t = 0; t < nf; t++) fl[t] = `f ${ref(t * 3)} ${ref(t * 3 + 1)} ${ref(t * 3 + 2)}`;
    out.push(fl.join('\n'));
    vo += nv; if (p.uv) to += nv; if (p.nrm) no += nv;
  }
  return { obj: out.join('\n') + '\n', mtl: mtl.join('\n'), textures: [...textures.entries()].map(([texture, path]) => ({ texture, path })) };
}

// Texture -> file bytes: reuse the uploaded file when we have it, otherwise re-encode from the image.
export async function textureBytes(tex, path) {
  if (tex.userData?.bytes && path.endsWith(tex.userData.fileName.split('.').pop().toLowerCase())) return tex.userData.bytes;
  const img = tex.image, w = img.width || img.videoWidth, h = img.height || img.videoHeight;
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(img, 0, 0, w, h);
  const type = path.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const blob = await new Promise((r) => canvas.toBlob(r, type, 0.92));
  return new Uint8Array(await blob.arrayBuffer());
}

/* ---------- OBJ for polygon (quad) meshes ---------- */

/**
 * m: { pos, faces, fmat, matNames }, uv: result of unwrap() or null, materials: three materials by fmat index.
 * Faces are written as-is (quads stay quads). UVs are per corner. Colours only (new UVs don't match old textures).
 */
export function writePolyOBJ(m, uv, materials, baseName) {
  const used = [...new Set(m.fmat)].sort((a, b) => a - b), names = new Map(), taken = new Set();
  for (const i of used) {
    let n = safe(m.matNames?.[i] || materials?.[i]?.name, `material${i + 1}`), k = 2;
    while (taken.has(n)) n = `${safe(m.matNames?.[i], 'material')}_${k++}`;
    taken.add(n); names.set(i, n);
  }
  const mtl = [`# Poly Simplify · ${new Date().toISOString().slice(0, 10)}`, ''];
  for (const i of used) {
    const mat = materials?.[i], c = (mat?.color || new THREE.Color(0.74, 0.73, 0.7)).clone().convertLinearToSRGB();
    mtl.push(`newmtl ${names.get(i)}`, 'Ka 0.000000 0.000000 0.000000', `Kd ${f6(c.r)} ${f6(c.g)} ${f6(c.b)}`, 'Ks 0.100000 0.100000 0.100000', 'Ns 50.000000', `d ${f6(mat?.opacity ?? 1)}`, 'illum 2', '');
  }
  const nV = m.pos.length / 3, out = [`# Poly Simplify · ${m.faces.length.toLocaleString('en-US')} faces`, `mtllib ${baseName}.mtl`, `o ${safe(baseName, 'mesh')}`];
  const lines = new Array(nV);
  for (let i = 0; i < nV; i++) lines[i] = `v ${f6(m.pos[i * 3])} ${f6(m.pos[i * 3 + 1])} ${f6(m.pos[i * 3 + 2])}`;
  out.push(lines.join('\n'));
  if (uv) {
    const nU = uv.uvs.length / 2, vt = new Array(nU);
    for (let i = 0; i < nU; i++) vt[i] = `vt ${f6(uv.uvs[i * 2])} ${f6(uv.uvs[i * 2 + 1])}`;
    out.push(vt.join('\n'));
  }
  out.push('s 1');
  // group faces by material so each usemtl appears once
  for (const mi of used) {
    out.push(`usemtl ${names.get(mi)}`);
    const fl = [];
    m.faces.forEach((f, fi) => {
      if (m.fmat[fi] !== mi) return;
      fl.push('f ' + f.map((v, k) => (uv ? `${v + 1}/${uv.corner[fi][k] + 1}` : `${v + 1}`)).join(' '));
    });
    out.push(fl.join('\n'));
  }
  return { obj: out.join('\n') + '\n', mtl: mtl.join('\n') };
}
