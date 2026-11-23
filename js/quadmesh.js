// Quad mode: polygon meshes that stay a clean quad grid while being reduced.
// Reduction collapses whole quad strips (edge loops), narrowest first — the automated version of
// "select every other loop and collapse" — then relaxes the grid and snaps it back onto the original surface.
import * as THREE from 'three';
import { MeshBVH } from '../vendor/three-mesh-bvh/index.module.js';

/* ---------------- building polygon meshes ---------------- */

// Native OBJ polygons (OBJ is the one common format that keeps quads; loaders triangulate them).
export function polyFromOBJ(text) {
  const P = [], faces = [], fmat = [], matNames = [];
  let mat = 0; const matIndex = new Map([['', 0]]); matNames.push('');
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start); if (end < 0) end = text.length;
    const c0 = text.charCodeAt(start), c1 = text.charCodeAt(start + 1);
    if (c0 === 118 && (c1 === 32 || c1 === 9)) { // "v "
      const t = text.slice(start + 2, end).trim().split(/\s+/);
      P.push(+t[0], +t[1], +t[2]);
    } else if (c0 === 102 && (c1 === 32 || c1 === 9)) { // "f "
      const t = text.slice(start + 2, end).trim().split(/\s+/), nv = P.length / 3, f = [];
      for (const s of t) { const i = parseInt(s, 10); if (!Number.isNaN(i)) f.push(i < 0 ? nv + i : i - 1); }
      if (f.length >= 3) { faces.push(f); fmat.push(mat); }
    } else if (text.startsWith('usemtl', start)) {
      const name = text.slice(start + 6, end).trim();
      if (!matIndex.has(name)) { matIndex.set(name, matNames.length); matNames.push(name); }
      mat = matIndex.get(name);
    }
    start = end + 1;
  }
  const m = orientFaces(weldPoly({ pos: new Float64Array(P), faces, fmat, matNames }));
  // a triangulated quad mesh (common for GLB/FBX → OBJ round trips): rebuild the quads
  const tris = m.faces.reduce((s, f) => s + (f.length === 3), 0);
  return tris > m.faces.length * 0.5 ? pairTriangles(m) : m;
}

// From welded triangle parts (any format). pairQuads: rebuild quads from triangulated quad meshes.
export function polyFromParts(parts, { pairQuads = true } = {}) {
  const P = [], faces = [], fmat = [];
  parts.forEach((p, pi) => {
    const base = P.length / 3;
    for (let i = 0; i < p.pos.length; i++) P.push(p.pos[i]);
    for (let t = 0; t < p.index.length; t += 3) { faces.push([p.index[t] + base, p.index[t + 1] + base, p.index[t + 2] + base]); fmat.push(pi); }
  });
  const mesh = orientFaces(weldPoly({ pos: new Float64Array(P), faces, fmat, matNames: parts.map((p) => p.material?.name || '') }));
  return pairQuads ? pairTriangles(mesh) : mesh;
}

// Merge vertices with identical positions; drop degenerate / duplicate faces.
function weldPoly(m) {
  const n = m.pos.length / 3, map = new Map(), rep = new Int32Array(n), out = [];
  for (let i = 0; i < n; i++) {
    const k = `${m.pos[i * 3]},${m.pos[i * 3 + 1]},${m.pos[i * 3 + 2]}`;
    let r = map.get(k); if (r === undefined) { r = out.length / 3; map.set(k, r); out.push(m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2]); }
    rep[i] = r;
  }
  const faces = [], fmat = [], seen = new Set();
  m.faces.forEach((f, fi) => {
    const g = cleanFace(f.map((v) => rep[v])); if (!g) return;
    const key = [...g].sort((a, b) => a - b).join(); if (seen.has(key)) return; seen.add(key);
    faces.push(g); fmat.push(m.fmat[fi]);
  });
  return { pos: new Float64Array(out), faces, fmat, matNames: m.matNames };
}

// Make neighbouring faces wind the same way (fixes flipped panels), then point each piece outward.
function orientFaces(m) {
  const { faces, pos } = m, edges = buildEdges(faces, pos.length / 3), done = new Uint8Array(faces.length);
  const dirOf = (f, i) => faces[f][i] < faces[f][(i + 1) % faces[f].length];
  for (let s0 = 0; s0 < faces.length; s0++) {
    if (done[s0]) continue;
    const comp = [s0]; done[s0] = 1;
    for (let h = 0; h < comp.length; h++) {
      const f = comp[h], fv = faces[f];
      for (let i = 0; i < fv.length; i++) {
        const e = edges.get(ekey(fv[i], fv[(i + 1) % fv.length]));
        if (!e || e.length !== 2) continue;
        const o = e[0].f === f ? e[1] : e[0];
        if (done[o.f]) continue;
        // consistent winding traverses a shared edge in opposite directions
        if (dirOf(f, i) === dirOf(o.f, o.i)) { faces[o.f].reverse(); }
        done[o.f] = 1; comp.push(o.f);
      }
      // reversing changes local edge indices; rebuild the entries for this face lazily
      for (let i = 0; i < faces[f].length; i++) {
        const e = edges.get(ekey(faces[f][i], faces[f][(i + 1) % faces[f].length]));
        for (const x of e) if (x.f === f) x.i = i;
      }
    }
    // outward: normals should on balance point away from the piece's centre
    let cx = 0, cy = 0, cz = 0, n = 0;
    for (const f of comp) for (const v of faces[f]) { cx += pos[v * 3]; cy += pos[v * 3 + 1]; cz += pos[v * 3 + 2]; n++; }
    cx /= n; cy /= n; cz /= n;
    let score = 0;
    for (const f of comp) {
      const fv = faces[f], nn = newell(pos, fv);
      let px = 0, py = 0, pz = 0; for (const v of fv) { px += pos[v * 3]; py += pos[v * 3 + 1]; pz += pos[v * 3 + 2]; }
      score += nn.x * (px / fv.length - cx) + nn.y * (py / fv.length - cy) + nn.z * (pz / fv.length - cz);
    }
    if (score < 0) for (const f of comp) faces[f].reverse();
  }
  return m;
}

function cleanFace(f) {
  const g = [];
  for (let i = 0; i < f.length; i++) if (f[i] !== f[(i + 1) % f.length]) g.push(f[i]);
  if (g.length < 3 || new Set(g).size !== g.length) return null;
  return g;
}

// Pair triangles across their mutual longest edge (the diagonal of a triangulated quad).
function pairTriangles(m) {
  const { pos, faces } = m, nF = faces.length;
  const d2 = (a, b) => (pos[a * 3] - pos[b * 3]) ** 2 + (pos[a * 3 + 1] - pos[b * 3 + 1]) ** 2 + (pos[a * 3 + 2] - pos[b * 3 + 2]) ** 2;
  const edges = buildEdges(faces, pos.length / 3);
  const longest = new Int8Array(nF).fill(-1);
  faces.forEach((f, fi) => {
    if (f.length !== 3) return;
    let best = 0, bl = -1; for (let i = 0; i < 3; i++) { const l = d2(f[i], f[(i + 1) % 3]); if (l > bl) { bl = l; best = i; } }
    longest[fi] = best;
  });
  const used = new Uint8Array(nF), out = [], fmat = [];
  const nrm = faces.map((f) => newell(pos, f));
  faces.forEach((f, fi) => {
    if (used[fi]) return;
    if (f.length === 3 && longest[fi] >= 0) {
      const k = longest[fi], a = f[k], b = f[(k + 1) % 3], c = f[(k + 2) % 3];
      const e = edges.get(ekey(a, b));
      const g = e && e.length === 2 ? (e[0].f === fi ? e[1].f : e[0].f) : -1;
      if (g >= 0 && !used[g] && faces[g].length === 3 && m.fmat[g] === m.fmat[fi]) {
        const fg = faces[g], kg = longest[g];
        const lg = ekey(fg[kg], fg[(kg + 1) % 3]);
        if (lg === ekey(a, b) && nrm[fi].dot(nrm[g]) > 0.86) {
          const d = fg.find((v) => v !== a && v !== b);
          used[fi] = used[g] = 1; out.push([a, d, b, c]); fmat.push(m.fmat[fi]); return;
        }
      }
    }
    used[fi] = 1; out.push(f); fmat.push(m.fmat[fi]);
  });
  return { ...m, faces: out, fmat };
}

/* ---------------- helpers ---------------- */

const ekey = (a, b) => (a < b ? a * 67108864 + b : b * 67108864 + a);

function buildEdges(faces, nV) {
  const edges = new Map();
  faces.forEach((f, fi) => {
    for (let i = 0; i < f.length; i++) {
      const k = ekey(f[i], f[(i + 1) % f.length]);
      let e = edges.get(k); if (!e) edges.set(k, (e = []));
      e.push({ f: fi, i });
    }
  });
  return edges;
}

function newell(pos, f) {
  const n = new THREE.Vector3();
  for (let i = 0; i < f.length; i++) {
    const a = f[i] * 3, b = f[(i + 1) % f.length] * 3;
    n.x += (pos[a + 1] - pos[b + 1]) * (pos[a + 2] + pos[b + 2]);
    n.y += (pos[a + 2] - pos[b + 2]) * (pos[a] + pos[b]);
    n.z += (pos[a] - pos[b]) * (pos[a + 1] + pos[b + 1]);
  }
  return n.normalize();
}
export { newell };

export function faceStats(m) {
  let q = 0, t = 0; for (const f of m.faces) { if (f.length === 4) q++; else if (f.length === 3) t++; }
  return { faces: m.faces.length, quads: q, tris: t, ngons: m.faces.length - q - t, verts: m.pos.length / 3 };
}

/* ---------------- quad-preserving reduction ---------------- */

export function makeSurface(m) {
  const tris = [];
  for (const f of m.faces) for (let k = 1; k + 1 < f.length; k++) tris.push(f[0], f[k], f[k + 1]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(m.pos), 3));
  g.setIndex(tris);
  return new MeshBVH(g);
}

/**
 * Reduce to about `targetFaces` by collapsing quad strips. Returns a new mesh.
 * surface: MeshBVH of the original, used to snap the relaxed grid back onto the original shape.
 */
export function reduceQuads(src, targetFaces, { surface, relax = 6, onPass } = {}) {
  let pos = Float64Array.from(src.pos), faces = src.faces.map((f) => f.slice()), fmat = src.fmat.slice();
  // target edge length for an even grid: total area / target faces = h²
  let area = 0; for (const f of faces) area += polyArea(pos, f);
  let h = Math.sqrt(area / Math.max(1, targetFaces)), stalls = 0;
  for (let pass = 0; pass < 80 && faces.length > targetFaces; pass++) {
    const nV = pos.length / 3;
    const edges = buildEdges(faces, nV);
    const border = new Uint8Array(nV);
    for (const [k, e] of edges) if (e.length === 1) { border[Math.floor(k / 67108864)] = 1; border[k % 67108864] = 1; }
    const nbrs = Array.from({ length: nV }, () => []);
    for (const k of edges.keys()) { const a = Math.floor(k / 67108864), b = k % 67108864; nbrs[a].push(b); nbrs[b].push(a); }
    const len = (a, b) => Math.hypot(pos[a * 3] - pos[b * 3], pos[a * 3 + 1] - pos[b * 3 + 1], pos[a * 3 + 2] - pos[b * 3 + 2]);

    // 1. trace every strip: a chain of quads entered and left through opposite edges
    const seen = new Uint8Array(faces.length * 2), strips = [];
    for (let f0 = 0; f0 < faces.length; f0++) {
      if (faces[f0].length !== 4) continue;
      for (let dir = 0; dir < 2; dir++) {
        if (seen[f0 * 2 + dir]) continue;
        const quads = [f0], cross = [], inStrip = new Map([[f0, dir]]);
        let ok = true, closed = false;
        seen[f0 * 2 + dir] = 1;
        const walk = (startLocal, forward) => {
          let f = f0, li = startLocal; const out = [];
          for (;;) {
            const fa = faces[f], a = fa[li], b = fa[(li + 1) % 4];
            out.push([a, b]);
            const e = edges.get(ekey(a, b));
            if (!e || e.length !== 2) break;
            const nx = e[0].f === f ? e[1] : e[0];
            if (nx.f === f0) { closed = true; break; }
            if (faces[nx.f].length !== 4) break;
            const d = nx.i % 2;
            if (inStrip.has(nx.f)) { ok = false; break; }
            inStrip.set(nx.f, d); seen[nx.f * 2 + d] = 1;
            if (forward) quads.push(nx.f); else quads.unshift(nx.f);
            f = nx.f; li = (nx.i + 2) % 4;
          }
          return out;
        };
        const fwd = walk((dir + 2) % 4, true);
        const back = closed ? [] : walk(dir, false);
        if (!ok) continue;
        cross.push(...back.reverse(), ...fwd);
        strips.push({ quads, cross });
      }
    }

    // 2. score + validate: narrowest first; reject collapses that would pinch or fold the surface
    const cand = [];
    for (const s of strips) {
      const verts = new Set(); let w = 0, bad = false;
      for (const [a, b] of s.cross) {
        if (verts.has(a) || verts.has(b)) { bad = true; break; }
        verts.add(a); verts.add(b);
        const e = edges.get(ekey(a, b));
        if (e && e.length === 2 && border[a] && border[b]) { bad = true; break; } // would pinch across a piece
        // link condition: u and v may only share neighbours through triangles on this edge
        const nb = new Set(nbrs[a]);
        const allowed = new Set();
        if (e) for (const { f } of e) if (faces[f].length === 3) for (const v of faces[f]) allowed.add(v);
        for (const c of nbrs[b]) if (nb.has(c) && !allowed.has(c)) { bad = true; break; }
        if (bad) break;
        w += len(a, b);
      }
      // only strips clearly narrower than the target spacing, so every region and direction evens out
      if (!bad && w / s.cross.length < 0.7 * h) cand.push({ ...s, w: w / s.cross.length });
    }
    cand.sort((x, y) => x.w - y.w);

    // 3. pick non-touching strips until the target is reached
    const touched = new Uint8Array(nV), parent = Int32Array.from({ length: nV }, (_, i) => i);
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    let remaining = faces.length, picked = 0;
    for (const s of cand) {
      if (remaining <= targetFaces) break;
      let clash = false;
      for (const f of s.quads) for (const v of faces[f]) if (touched[v]) { clash = true; break; }
      if (!clash) for (const [a, b] of s.cross) if (touched[a] || touched[b]) { clash = true; break; }
      if (clash) continue;
      for (const f of s.quads) for (const v of faces[f]) touched[v] = 1;
      for (const [a, b] of s.cross) { touched[a] = touched[b] = 1; parent[find(a)] = find(b); }
      remaining -= s.quads.length; picked++;
    }
    if (!picked) {
      // nothing narrow enough left but still above the target: allow slightly coarser spacing
      if (++stalls > 12) break;
      h *= 1.08; continue;
    }

    // 4. merge: border vertices win so hems / openings keep their outline
    const acc = new Float64Array(nV * 4);
    for (let v = 0; v < nV; v++) {
      const r = find(v), wgt = border[v] ? 1000 : 1;
      acc[r * 4] += pos[v * 3] * wgt; acc[r * 4 + 1] += pos[v * 3 + 1] * wgt; acc[r * 4 + 2] += pos[v * 3 + 2] * wgt; acc[r * 4 + 3] += wgt;
    }
    const remap = new Int32Array(nV).fill(-1), np = [];
    for (let v = 0; v < nV; v++) { const r = find(v); if (remap[r] < 0) { remap[r] = np.length / 3; np.push(acc[r * 4] / acc[r * 4 + 3], acc[r * 4 + 1] / acc[r * 4 + 3], acc[r * 4 + 2] / acc[r * 4 + 3]); } }
    const nf = [], nm = [], dup = new Set();
    faces.forEach((f, fi) => {
      const g = cleanFace(f.map((v) => remap[find(v)])); if (!g) return;
      const key = [...g].sort((a, b) => a - b).join(); if (dup.has(key)) return; dup.add(key);
      nf.push(g); nm.push(fmat[fi]);
    });
    pos = Float64Array.from(np); faces = nf; fmat = nm;
    onPass && onPass(pass, faces.length);
  }
  const out = dropUnused({ pos, faces, fmat, matNames: src.matNames });
  if (surface && relax) relaxOnto(out, surface, relax);
  return out;
}

function polyArea(pos, f) {
  let ax = 0, ay = 0, az = 0;
  for (let k = 1; k + 1 < f.length; k++) {
    const a = f[0] * 3, b = f[k] * 3, c = f[k + 1] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    ax += uy * vz - uz * vy; ay += uz * vx - ux * vz; az += ux * vy - uy * vx;
  }
  return Math.hypot(ax, ay, az) / 2;
}

function dropUnused(m) {
  const n = m.pos.length / 3, map = new Int32Array(n).fill(-1), p = [];
  for (const f of m.faces) for (const v of f) if (map[v] < 0) { map[v] = p.length / 3; p.push(m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2]); }
  return { ...m, pos: Float64Array.from(p), faces: m.faces.map((f) => f.map((v) => map[v])) };
}

// Even out the grid (tangential smoothing) and snap back onto the original surface.
function relaxOnto(m, surface, iters) {
  const nV = m.pos.length / 3, edges = buildEdges(m.faces, nV);
  const nb = Array.from({ length: nV }, () => []), bnb = Array.from({ length: nV }, () => []);
  for (const [k, e] of edges) {
    const a = Math.floor(k / 67108864), b = k % 67108864;
    nb[a].push(b); nb[b].push(a);
    if (e.length === 1) { bnb[a].push(b); bnb[b].push(a); }
  }
  const P = m.pos, tmp = new Float64Array(P.length), v = new THREE.Vector3(), hit = {};
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < nV; i++) {
      const list = bnb[i].length ? (bnb[i].length === 2 ? bnb[i] : null) : nb[i];
      if (!list || !list.length) { tmp.set(P.subarray(i * 3, i * 3 + 3), i * 3); continue; }
      let x = 0, y = 0, z = 0; for (const j of list) { x += P[j * 3]; y += P[j * 3 + 1]; z += P[j * 3 + 2]; }
      const k = bnb[i].length ? 0.3 : 0.5;
      tmp[i * 3] = P[i * 3] + k * (x / list.length - P[i * 3]);
      tmp[i * 3 + 1] = P[i * 3 + 1] + k * (y / list.length - P[i * 3 + 1]);
      tmp[i * 3 + 2] = P[i * 3 + 2] + k * (z / list.length - P[i * 3 + 2]);
    }
    for (let i = 0; i < nV; i++) {
      v.set(tmp[i * 3], tmp[i * 3 + 1], tmp[i * 3 + 2]);
      const r = surface.closestPointToPoint(v, hit);
      if (r) { P[i * 3] = r.point.x; P[i * 3 + 1] = r.point.y; P[i * 3 + 2] = r.point.z; }
      else { P[i * 3] = tmp[i * 3]; P[i * 3 + 1] = tmp[i * 3 + 1]; P[i * 3 + 2] = tmp[i * 3 + 2]; }
    }
  }
}

/* ---------------- display ---------------- */

export function vertexNormals(m) {
  const n = new Float32Array(m.pos.length);
  for (const f of m.faces) {
    const fn = newell(m.pos, f);
    // area weight
    let ax = 0, ay = 0, az = 0;
    for (let k = 1; k + 1 < f.length; k++) {
      const a = f[0] * 3, b = f[k] * 3, c = f[k + 1] * 3;
      const ux = m.pos[b] - m.pos[a], uy = m.pos[b + 1] - m.pos[a + 1], uz = m.pos[b + 2] - m.pos[a + 2];
      const vx = m.pos[c] - m.pos[a], vy = m.pos[c + 1] - m.pos[a + 1], vz = m.pos[c + 2] - m.pos[a + 2];
      ax += uy * vz - uz * vy; ay += uz * vx - ux * vz; az += ux * vy - uy * vx;
    }
    const area = Math.hypot(ax, ay, az) / 2;
    for (const v of f) { n[v * 3] += fn.x * area; n[v * 3 + 1] += fn.y * area; n[v * 3 + 2] += fn.z * area; }
  }
  for (let i = 0; i < n.length; i += 3) { const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1; n[i] /= l; n[i + 1] /= l; n[i + 2] /= l; }
  return n;
}

// Triangulated geometry for rendering (optionally with per-corner UVs) + polygon-edge wireframe.
export function polyToGeometry(m, uv) {
  const vn = vertexNormals(m), P = [], N = [], T = [], idx = [];
  if (uv) {
    const nU = uv.uvs.length / 2;
    for (let u = 0; u < nU; u++) { const v = uv.uvVert[u]; P.push(m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2]); N.push(vn[v * 3], vn[v * 3 + 1], vn[v * 3 + 2]); T.push(uv.uvs[u * 2], uv.uvs[u * 2 + 1]); }
    m.faces.forEach((f, fi) => { const c = uv.corner[fi]; for (let k = 1; k + 1 < f.length; k++) idx.push(c[0], c[k], c[k + 1]); });
  } else {
    for (let i = 0; i < m.pos.length; i++) P.push(m.pos[i]);
    for (let i = 0; i < vn.length; i++) N.push(vn[i]);
    for (const f of m.faces) for (let k = 1; k + 1 < f.length; k++) idx.push(f[0], f[k], f[k + 1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  if (uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(T, 2));
  g.setIndex(idx); g.computeBoundingSphere();
  return g;
}

export function polyWire(m) {
  const seen = new Set(), L = [];
  for (const f of m.faces) for (let i = 0; i < f.length; i++) {
    const a = f[i], b = f[(i + 1) % f.length], k = ekey(a, b); if (seen.has(k)) continue; seen.add(k);
    L.push(m.pos[a * 3], m.pos[a * 3 + 1], m.pos[a * 3 + 2], m.pos[b * 3], m.pos[b * 3 + 1], m.pos[b * 3 + 2]);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(L, 3));
  return g;
}
