// Automatic UV unwrap for polygon meshes (quads stay whole).
// Islands:
//   'frontback' (default, for garments): each piece is split into a front and a back half, like a basic
//            sewing pattern (pants → front + back). Longest unbroken runs for stripes and prints.
//   'panels': follow the panels/pieces cut in the source file (e.g. Marvelous pattern pieces);
//            pieces that can't lie flat in one go are split front/back.
//   Anything still not flat after that falls back to splitting by surface direction.
//   'smart':  split by surface direction (like Blender's Smart UV Project, 66° limit).
// Each island is flattened with LSCM (conformal, low stretch) and scaled to one texel density.
// upright: every island is turned so "up" on the model is "up" in the texture (stripes run level).
// alignHeight: islands keep their real height in the layout, so stripes line up across seams.
// level: V is locked to the model's height (U re-solved conformally), so stripes are level bands
//        that meet exactly at every seam; islands that would fold keep the plain flatten.
import { newell } from './quadmesh.js';

const ekey = (a, b) => (a < b ? a * 67108864 + b : b * 67108864 + a);

export function unwrap(m, { mode = 'frontback', upright = true, alignHeight = true, level = true, angle = 66, margin = 0.004 } = {}) {
  const { pos, faces } = m, nF = faces.length;
  const fn = faces.map((f) => newell(pos, f));
  const farea = faces.map((f) => polyArea(pos, f));
  const edges = new Map();
  faces.forEach((f, fi) => { for (let i = 0; i < f.length; i++) { const k = ekey(f[i], f[(i + 1) % f.length]); const e = edges.get(k); if (e) e.push(fi); else edges.set(k, [fi]); } });
  const adj = faces.map(() => []);
  for (const e of edges.values()) if (e.length === 2) { adj[e[0]].push(e[1]); adj[e[1]].push(e[0]); }
  const ctx = { m, fn, farea, adj, angle };

  let L = mode === 'smart' ? segmentSmart(ctx, [...faces.keys()]) : segmentPanels(ctx, mode === 'panels' ? cleanPanels(ctx) : faces.map(() => 0));
  L = mergeTiny(ctx, L);
  // which garment (connected piece) each island belongs to: height alignment only matters within one
  const piece = new Int32Array(nF).fill(-1);
  groupsBy(ctx, [...faces.keys()], () => 0).forEach((g, i) => g.forEach((f) => { piece[f] = i; }));

  const charts = L.map((fs) => Object.assign(flatten(pos, faces, fs, fn), { piece: piece[fs[0]] }));
  let levelled = 0;
  if (upright) for (const c of charts) { orientUp(c, pos); if (level && levelChart(c, pos)) levelled++; }
  pack(charts, margin, { upright, alignHeight, pos });

  const uvs = [], uvVert = [], corner = new Array(nF);
  for (const c of charts) {
    const base = uvVert.length;
    for (let i = 0; i < c.verts.length; i++) { uvVert.push(c.verts[i]); uvs.push(c.u[i], c.v[i]); }
    c.faces.forEach((fi) => { corner[fi] = faces[fi].map((v) => base + c.local.get(v)); });
  }
  return { uvs: Float32Array.from(uvs), uvVert: Int32Array.from(uvVert), corner, islands: charts.length, levelled, mode };
}

/* ---------- segmentation ---------- */

// connected groups of `fs` where neighbours share the same key
function groupsBy(ctx, fs, key) {
  const inSet = new Set(fs), seen = new Set(), out = [];
  for (const f0 of fs) {
    if (seen.has(f0)) continue;
    const q = [f0]; seen.add(f0);
    for (let h = 0; h < q.length; h++) for (const g of ctx.adj[q[h]]) if (inSet.has(g) && !seen.has(g) && key(g) === key(q[h])) { seen.add(g); q.push(g); }
    out.push(q);
  }
  return out;
}

// a piece can be flattened in one go when it is a topological disk: one boundary loop, Euler characteristic 1
function isDisk(ctx, fs) {
  const faces = ctx.m.faces, ec = new Map(), verts = new Set();
  for (const f of fs) { const fv = faces[f]; for (let i = 0; i < fv.length; i++) { verts.add(fv[i]); const k = ekey(fv[i], fv[(i + 1) % fv.length]); ec.set(k, (ec.get(k) || 0) + 1); } }
  let E = 0; const bnd = [];
  for (const [k, n] of ec) { if (n > 2) return false; E++; if (n === 1) bnd.push(k); }
  if (verts.size - E + fs.length !== 1 || !bnd.length) return false;
  const par = new Map(), find = (x) => { while (par.get(x) !== x) { par.set(x, par.get(par.get(x))); x = par.get(x); } return x; };
  for (const k of bnd) for (const v of [Math.floor(k / 67108864), k % 67108864]) if (!par.has(v)) par.set(v, v);
  for (const k of bnd) { const a = find(Math.floor(k / 67108864)), b = find(k % 67108864); if (a !== b) par.set(a, b); }
  const roots = new Set(); for (const v of par.keys()) roots.add(find(v));
  return roots.size === 1;
}

// panel labels near seams can be noisy (nearest-face lookup on a simplified mesh): smooth them and
// fold scraps under 1% of their piece into the neighbouring panel
function cleanPanels(ctx) {
  const { m, adj, farea } = ctx;
  let lab = (m.fpanel || m.faces.map(() => 0)).slice();
  for (let it = 0; it < 4; it++) {
    const nx = lab.slice();
    lab.forEach((l, f) => {
      const votes = new Map([[l, 1.5]]);
      for (const g of adj[f]) votes.set(lab[g], (votes.get(lab[g]) || 0) + 1);
      let best = l, bv = -1; for (const [k, v] of votes) if (v > bv) { bv = v; best = k; }
      nx[f] = best;
    });
    lab = nx;
  }
  const groups = groupsBy(ctx, [...m.faces.keys()], (f) => lab[f]);
  const total = farea.reduce((a, b) => a + b, 0);
  for (const g of groups) {
    const a = g.reduce((s, f) => s + farea[f], 0);
    if (a > total * 0.01) continue;
    const cnt = new Map(); for (const f of g) for (const h of adj[f]) if (lab[h] !== lab[f]) cnt.set(lab[h], (cnt.get(lab[h]) || 0) + 1);
    if (!cnt.size) continue;
    const to = [...cnt.entries()].sort((x, y) => y[1] - x[1])[0][0];
    for (const f of g) lab[f] = to;
  }
  return lab;
}

function segmentPanels(ctx, panel) {
  const out = [], { m } = ctx;
  for (const g of groupsBy(ctx, [...m.faces.keys()], (f) => panel[f])) {
    if (isDisk(ctx, g)) { out.push(g); continue; }
    // not flat in one piece (e.g. a leg tube or a whole welded garment): front / back halves, like a pattern
    for (const h of splitFrontBack(ctx, g)) {
      if (isDisk(ctx, h) || h.length < 4) out.push(h);
      else out.push(...segmentSmart(ctx, h));
    }
  }
  return out;
}

function splitFrontBack(ctx, fs) {
  const { fn, farea, adj } = ctx, inSet = new Set(fs);
  // smooth normals over the surface so wrinkles don't fray the seam
  let nz = new Map(fs.map((f) => [f, fn[f].z * farea[f]]));
  for (let it = 0; it < 12; it++) {
    const nx = new Map();
    for (const f of fs) { let s = nz.get(f); for (const g of adj[f]) if (inSet.has(g)) s += nz.get(g); nx.set(f, s); }
    nz = nx;
  }
  let side = new Map(fs.map((f) => [f, nz.get(f) >= 0 ? 0 : 1]));
  for (let it = 0; it < 6; it++) {
    const nx = new Map();
    for (const f of fs) { let a = side.get(f) ? 1.5 : -1.5; for (const g of adj[f]) if (inSet.has(g)) a += side.get(g) ? 1 : -1; nx.set(f, a > 0 ? 1 : 0); }
    side = nx;
  }
  return groupsBy(ctx, fs, (f) => side.get(f));
}

function segmentSmart(ctx, fs) {
  const { fn, farea, adj, angle } = ctx, cosA = Math.cos((angle * Math.PI) / 180), inSet = new Set(fs), island = new Map(), out = [];
  for (const seed of [...fs].sort((a, b) => farea[b] - farea[a])) {
    if (island.has(seed)) continue;
    const sn = fn[seed], q = [seed]; island.set(seed, out.length);
    for (let h = 0; h < q.length; h++) for (const g of adj[q[h]]) {
      if (!inSet.has(g) || island.has(g) || fn[g].dot(sn) < cosA) continue;
      island.set(g, out.length); q.push(g);
    }
    out.push(q);
  }
  return out;
}

// fold slivers (a few faces / tiny area) into the neighbouring island they touch most
function mergeTiny(ctx, L) {
  const { farea, adj } = ctx, total = farea.reduce((s, a) => s + a, 0), owner = new Map();
  L.forEach((fs, i) => fs.forEach((f) => owner.set(f, i)));
  for (let i = 0; i < L.length; i++) {
    const a = L[i].reduce((s, f) => s + farea[f], 0);
    if (L[i].length > 3 && a > total * 0.0005) continue;
    const cnt = new Map();
    for (const f of L[i]) for (const g of adj[f]) { const o = owner.get(g); if (o !== i) cnt.set(o, (cnt.get(o) || 0) + 1); }
    if (!cnt.size) continue;
    const to = [...cnt.entries()].sort((x, y) => y[1] - x[1])[0][0];
    for (const f of L[i]) owner.set(f, to);
    L[to].push(...L[i]); L[i] = [];
  }
  return L.filter((x) => x.length);
}

// turn the island so the model's up direction (+Y) points along +V
function orientUp(c, pos) {
  let gx = 0, gy = 0;
  for (const [a, b, d] of c.tris) {
    const u1 = c.u[b] - c.u[a], v1 = c.v[b] - c.v[a], u2 = c.u[d] - c.u[a], v2 = c.v[d] - c.v[a];
    const det = u1 * v2 - u2 * v1; if (Math.abs(det) < 1e-18) continue;
    const h0 = pos[c.verts[a] * 3 + 1], h1 = pos[c.verts[b] * 3 + 1] - h0, h2 = pos[c.verts[d] * 3 + 1] - h0;
    const w = Math.abs(det) / 2;
    gx += w * ((h1 * v2 - h2 * v1) / det); gy += w * ((u1 * h2 - u2 * h1) / det);
  }
  if (Math.hypot(gx, gy) < 1e-12) return;
  rotate(c, Math.PI / 2 - Math.atan2(gy, gx));
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

/* ---------- LSCM ---------- */

function flatten(pos, faces, fs, fn) {
  const local = new Map(), verts = [];
  for (const f of fs) for (const v of faces[f]) if (!local.has(v)) { local.set(v, verts.length); verts.push(v); }
  const n = verts.length;
  // island frame from the area-weighted normal
  let nx = 0, ny = 0, nz = 0; for (const f of fs) { nx += fn[f].x; ny += fn[f].y; nz += fn[f].z; }
  const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
  let tx = Math.abs(nx) < 0.9 ? 1 : 0, ty = Math.abs(nx) < 0.9 ? 0 : 1, tz = 0;
  const d = tx * nx + ty * ny + tz * nz; tx -= d * nx; ty -= d * ny; tz -= d * nz;
  const tl = Math.hypot(tx, ty, tz); tx /= tl; ty /= tl; tz /= tl;
  const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
  const x = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) { const p = verts[i] * 3; x[2 * i] = pos[p] * tx + pos[p + 1] * ty + pos[p + 2] * tz; x[2 * i + 1] = pos[p] * bx + pos[p + 1] * by + pos[p + 2] * bz; }
  const proj = Float64Array.from(x);

  // conformal residual per triangle: c1·U1 + c2·U2 + c3·U3 = 0 (complex), weighted by 1/sqrt(area)
  const T = [];
  for (const f of fs) {
    const fv = faces[f];
    for (let k = 1; k + 1 < fv.length; k++) {
      const ids = [fv[0], fv[k], fv[k + 1]], P3 = ids.map((v) => [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]);
      // triangle in its own plane
      const e1 = sub(P3[1], P3[0]), e2 = sub(P3[2], P3[0]), l1 = Math.hypot(...e1);
      if (l1 < 1e-12) continue;
      const ex = e1.map((c) => c / l1), nrm = cross(e1, e2), area = Math.hypot(...nrm) / 2;
      if (area < 1e-14) continue;
      const ey = cross(nrm, ex).map((c) => c / (2 * area));
      const z2 = [l1, 0], z3 = [dot(e2, ex), dot(e2, ey)];
      const a = z3, b = z2; // a = z3 - z1, b = z2 - z1 (z1 = 0)
      const w = 1 / Math.sqrt(area);
      T.push({ i: ids.map((v) => local.get(v)), c: [[(b[0] - a[0]) * w, (b[1] - a[1]) * w], [a[0] * w, a[1] * w], [-b[0] * w, -b[1] * w]] });
    }
  }
  // pins: the two projected extremes along the longest axis
  let i0 = 0, i1 = 0;
  { let mn = Infinity, mx = -Infinity; for (let i = 0; i < n; i++) { if (x[2 * i] < mn) { mn = x[2 * i]; i0 = i; } if (x[2 * i] > mx) { mx = x[2 * i]; i1 = i; } } }
  if (i0 === i1) i1 = (i0 + 1) % n;
  const pinned = new Uint8Array(n); pinned[i0] = pinned[i1] = 1;

  if (n > 2 && T.length) {
    // CG on the normal equations (A^T A) x = 0 with pinned entries fixed, matrix-free
    const Ax = (vec, out) => {
      out.fill(0);
      for (const t of T) {
        let re = 0, im = 0;
        for (let j = 0; j < 3; j++) { const [cr, ci] = t.c[j], xi = vec[2 * t.i[j]], yi = vec[2 * t.i[j] + 1]; re += cr * xi - ci * yi; im += ci * xi + cr * yi; }
        for (let j = 0; j < 3; j++) { const [cr, ci] = t.c[j], o = 2 * t.i[j]; out[o] += cr * re + ci * im; out[o + 1] += -ci * re + cr * im; }
      }
    };
    const r = new Float64Array(2 * n), p = new Float64Array(2 * n), Ap = new Float64Array(2 * n);
    Ax(x, r); for (let i = 0; i < 2 * n; i++) r[i] = pinned[i >> 1] ? 0 : -r[i];
    p.set(r); let rr = dot2(r, r); const rr0 = rr;
    const maxIt = Math.min(700, 60 + 12 * Math.sqrt(n));
    for (let it = 0; it < maxIt && rr > rr0 * 1e-9 && rr > 1e-30; it++) {
      Ax(p, Ap); for (let i = 0; i < 2 * n; i++) if (pinned[i >> 1]) Ap[i] = 0;
      const alpha = rr / (dot2(p, Ap) || 1e-30);
      for (let i = 0; i < 2 * n; i++) { x[i] += alpha * p[i]; r[i] -= alpha * Ap[i]; }
      const rn = dot2(r, r), beta = rn / rr; rr = rn;
      for (let i = 0; i < 2 * n; i++) p[i] = r[i] + beta * p[i];
    }
    // mirror if the solve came out flipped; fall back to the projection if triangles fold over
    let pos2 = 0, neg = 0, areaSum = 0;
    const sgn = (X) => { pos2 = 0; neg = 0; areaSum = 0; for (const t of T) { const [a, b, c] = t.i; const s = (X[2 * b] - X[2 * a]) * (X[2 * c + 1] - X[2 * a + 1]) - (X[2 * c] - X[2 * a]) * (X[2 * b + 1] - X[2 * a + 1]); areaSum += s; if (s > 0) pos2++; else if (s < 0) neg++; } };
    sgn(x);
    if (areaSum < 0) { for (let i = 0; i < n; i++) x[2 * i] = -x[2 * i]; const t = pos2; pos2 = neg; neg = t; }
    if (!Number.isFinite(areaSum) || neg > T.length * 0.01) x.set(proj);
  }
  // 3D area → uniform texel density
  let a3 = 0; for (const f of fs) a3 += polyArea(pos, faces[f]);
  let a2 = 0; for (const t of T) { const [a, b, c] = t.i; a2 += Math.abs((x[2 * b] - x[2 * a]) * (x[2 * c + 1] - x[2 * a + 1]) - (x[2 * c] - x[2 * a]) * (x[2 * b + 1] - x[2 * a + 1])) / 2; }
  const s = a2 > 0 ? Math.sqrt(a3 / a2) : 1;
  const u = new Float64Array(n), v = new Float64Array(n);
  for (let i = 0; i < n; i++) { u[i] = x[2 * i] * s; v[i] = x[2 * i + 1] * s; }
  return { faces: fs, verts, local, u, v, tris: T.map((t) => t.i), T };
}

// Lock V to the model's height (so every stripe is a level band that meets itself at every seam) and
// re-solve only U with the same conformal energy. Reverts if the island would fold (e.g. flat tops).
function levelChart(c, pos) {
  const n = c.u.length, T = c.T;
  if (!T || T.length < 2) return false;
  const y = new Float64Array(n);
  let y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) { y[i] = pos[c.verts[i] * 3 + 1]; y0 = Math.min(y0, y[i]); y1 = Math.max(y1, y[i]); }
  let area = 0; for (const t of c.tris) area += Math.abs(triArea(c, t));
  if (y1 - y0 < 0.25 * Math.sqrt(area)) return false; // island is mostly horizontal: leave it
  // the conformal scale of LSCM vs. 3D units: coefficients were built in 3D units, U/V are in 3D units too
  const x = Float64Array.from(c.u);
  const apply = (X, Y, out) => {
    out.fill(0);
    for (const t of T) {
      let re = 0, im = 0;
      for (let j = 0; j < 3; j++) { const [cr, ci] = t.c[j], k = t.i[j], yy = Y ? Y[k] : 0; re += cr * X[k] - ci * yy; im += ci * X[k] + cr * yy; }
      for (let j = 0; j < 3; j++) { const [cr, ci] = t.c[j]; out[t.i[j]] += cr * re + ci * im; }
    }
  };
  const r = new Float64Array(n), p = new Float64Array(n), Ap = new Float64Array(n);
  apply(x, y, r); for (let i = 0; i < n; i++) r[i] = -r[i]; r[0] = 0;
  p.set(r); let rr = dot2(r, r); const rr0 = rr;
  const maxIt = Math.min(900, 80 + 12 * Math.sqrt(n));
  for (let it = 0; it < maxIt && rr > rr0 * 1e-10 && rr > 1e-30; it++) {
    apply(p, null, Ap); Ap[0] = 0;
    const alpha = rr / (dot2(p, Ap) || 1e-30);
    for (let i = 0; i < n; i++) { x[i] += alpha * p[i]; r[i] -= alpha * Ap[i]; }
    const rn = dot2(r, r), beta = rn / rr; rr = rn;
    for (let i = 0; i < n; i++) p[i] = r[i] + beta * p[i];
  }
  // fold check: triangles must keep one orientation
  let pos2 = 0, neg = 0;
  for (const [a, b, d] of c.tris) { const s2 = (x[b] - x[a]) * (y[d] - y[a]) - (x[d] - x[a]) * (y[b] - y[a]); if (s2 > 0) pos2++; else if (s2 < 0) neg++; }
  if (neg > pos2) { for (let i = 0; i < n; i++) x[i] = -x[i]; const t = pos2; pos2 = neg; neg = t; }
  if (!Number.isFinite(x[0]) || neg > c.tris.length * 0.01) return false;
  let xm = Infinity; for (let i = 0; i < n; i++) xm = Math.min(xm, x[i]);
  for (let i = 0; i < n; i++) { c.u[i] = x[i] - xm; c.v[i] = y[i] - y0; }
  return true;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot2 = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/* ---------- packing ---------- */

function hull(px, py) {
  const idx = [...px.keys()].sort((a, b) => px[a] - px[b] || py[a] - py[b]);
  const crossZ = (o, a, b) => (px[a] - px[o]) * (py[b] - py[o]) - (py[a] - py[o]) * (px[b] - px[o]);
  const lower = [], upper = [];
  for (const i of idx) { while (lower.length >= 2 && crossZ(lower[lower.length - 2], lower[lower.length - 1], i) <= 0) lower.pop(); lower.push(i); }
  for (let k = idx.length - 1; k >= 0; k--) { const i = idx[k]; while (upper.length >= 2 && crossZ(upper[upper.length - 2], upper[upper.length - 1], i) <= 0) upper.pop(); upper.push(i); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function pack(charts, margin, opts = {}) {
  for (const c of charts) { c.area = 0; for (const t of c.tris) c.area += Math.abs(triArea(c, t)); }
  if (opts.upright && opts.alignHeight) {
    const blocks = heightBlocks(charts, opts.pos);
    pack(blocks, margin, { upright: true });
    for (const b of blocks) for (const [c, off] of b.members) for (let i = 0; i < c.u.length; i++) { c.u[i] = b.u[off + i]; c.v[i] = b.v[off + i]; }
    return;
  }
  // rotate each chart to its minimum-area bounding box (only when islands may turn)
  for (const c of charts) {
    if (opts.upright) break;
    const H = hull(c.u, c.v);
    let best = { area: Infinity, ang: 0 };
    for (let k = 0; k < H.length; k++) {
      const a = H[k], b = H[(k + 1) % H.length], ang = Math.atan2(c.v[b] - c.v[a], c.u[b] - c.u[a]);
      const cs = Math.cos(-ang), sn = Math.sin(-ang);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const i of H) { const x = c.u[i] * cs - c.v[i] * sn, y = c.u[i] * sn + c.v[i] * cs; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      const area = (x1 - x0) * (y1 - y0); if (area < best.area) best = { area, ang };
    }
    rotate(c, -best.ang);
    c.area = 0;
    for (const t of c.tris) c.area += Math.abs(triArea(c, t));
  }
  // raster packing: islands are placed by their real shape (not their boxes), biggest first,
  // at the lowest, then left-most free spot, trying both 0° and 90°; density is raised until it no longer fits
  const R = 256, total = charts.reduce((s, c) => s + c.area, 0);
  const order = [...charts].sort((a, b) => b.area - a.area);
  let result = null;
  for (let fill = 0.62; fill > 0.05 && !result; fill *= 0.92) {
    const scale = Math.sqrt((fill * R * R) / total), pad = Math.max(1, margin * R);
    const grid = new Uint8Array(R * R), placed = [];
    let ok = true;
    for (const c of order) {
      let best = null;
      for (const rot of opts.upright ? [0] : [0, 1]) {
        const cells = rasterize(c, scale, pad, rot);
        if (cells.w > R || cells.h > R) continue;
        const spot = findSpot(grid, R, cells, best ? best.y * R + best.x : Infinity);
        if (spot && (!best || spot.y * R + spot.x < best.y * R + best.x)) best = { ...spot, rot, cells };
      }
      if (!best) { ok = false; break; }
      for (const [x, y] of best.cells.list) grid[(best.y + y) * R + best.x + x] = 1;
      placed.push([c, best]);
    }
    if (ok) result = { placed, scale, pad };
  }
  // map to 0..1, then stretch the whole layout so it fills the square
  let mx = 0, my = 0;
  for (const [c, p] of result.placed) {
    for (let i = 0; i < c.u.length; i++) {
      let x = c.u[i] * result.scale, y = c.v[i] * result.scale;
      if (p.rot) { const t = x; x = p.cells.hgt - y; y = t; }
      c.u[i] = p.x + p.cells.ox + x; c.v[i] = p.y + p.cells.oy + y;
      mx = Math.max(mx, c.u[i]); my = Math.max(my, c.v[i]);
    }
  }
  const S = Math.max(mx, my) + result.pad * 0.5, m = margin;
  for (const [c] of result.placed) for (let i = 0; i < c.u.length; i++) { c.u[i] = m + (c.u[i] / S) * (1 - 2 * m); c.v[i] = m + (c.v[i] / S) * (1 - 2 * m); }
}

// Per garment: keep every island at its real height (stripes meet across seams), slide islands sideways
// until they don't overlap, and return the garment as one rigid block for the packer.
function heightBlocks(charts, pos) {
  const byPiece = new Map();
  for (const c of charts) { if (!byPiece.has(c.piece)) byPiece.set(c.piece, []); byPiece.get(c.piece).push(c); }
  const blocks = [];
  for (const group of byPiece.values()) {
    for (const c of group) { let o = 0; for (let i = 0; i < c.u.length; i++) o += pos[c.verts[i] * 3 + 1] - c.v[i]; c.off = o / c.u.length; }
    const lo = Math.min(...group.map((c) => c.off)), hi = Math.max(...group.map((c) => c.off + Math.max(...c.v)));
    const R = 192, scale = (R * 0.98) / Math.max(1e-9, hi - lo), pad = 1.5, W = R * 8, grid = new Uint8Array(R * W);
    const place = [];
    for (const c of [...group].sort((a, b) => b.area - a.area)) {
      const cells = rasterize(c, scale, pad, 0), y = Math.max(0, Math.min(R - cells.h, Math.round((c.off - lo) * scale)));
      let x = 0;
      for (; x + cells.w <= W; x++) { let free = true; for (const [cx, cy] of cells.list) if (grid[(y + cy) * W + x + cx]) { free = false; break; } if (free) break; }
      for (const [cx, cy] of cells.list) if (x + cx < W) grid[(y + cy) * W + x + cx] = 1;
      place.push([c, x, y]);
    }
    // merge into one block in world units
    const b = { u: [], v: [], tris: [], members: [] };
    for (const [c, x, y] of place) {
      const off = b.u.length;
      for (let i = 0; i < c.u.length; i++) { b.u.push(c.u[i] + (x + pad) / scale); b.v.push(c.v[i] + (y + pad) / scale); }
      for (const [p, q, r] of c.tris) b.tris.push([p + off, q + off, r + off]);
      b.members.push([c, off]);
    }
    b.u = Float64Array.from(b.u); b.v = Float64Array.from(b.v);
    let x0 = Infinity, y0 = Infinity; for (let i = 0; i < b.u.length; i++) { x0 = Math.min(x0, b.u[i]); y0 = Math.min(y0, b.v[i]); }
    for (let i = 0; i < b.u.length; i++) { b.u[i] -= x0; b.v[i] -= y0; }
    blocks.push(b);
  }
  return blocks;
}

function rotate(c, ang) {
  const cs = Math.cos(ang), sn = Math.sin(ang);
  let x0 = Infinity, y0 = Infinity;
  for (let i = 0; i < c.u.length; i++) { const x = c.u[i] * cs - c.v[i] * sn, y = c.u[i] * sn + c.v[i] * cs; c.u[i] = x; c.v[i] = y; x0 = Math.min(x0, x); y0 = Math.min(y0, y); }
  for (let i = 0; i < c.u.length; i++) { c.u[i] -= x0; c.v[i] -= y0; }
}
const triArea = (c, [a, b, d]) => ((c.u[b] - c.u[a]) * (c.v[d] - c.v[a]) - (c.u[d] - c.u[a]) * (c.v[b] - c.v[a])) / 2;

// cells covered by the chart (dilated by the margin). rot=1 → rotated 90°.
function rasterize(c, scale, pad, rot) {
  let w0 = 0, h0 = 0;
  for (let i = 0; i < c.u.length; i++) { w0 = Math.max(w0, c.u[i] * scale); h0 = Math.max(h0, c.v[i] * scale); }
  const X = (i) => (rot ? h0 - c.v[i] * scale : c.u[i] * scale), Y = (i) => (rot ? c.u[i] * scale : c.v[i] * scale);
  const ox = pad, oy = pad, w = Math.ceil((rot ? h0 : w0) + 2 * pad), h = Math.ceil((rot ? w0 : h0) + 2 * pad);
  const occ = new Uint8Array(w * h), r = pad + 0.71;
  for (const [a, b, d] of c.tris) {
    const ax = X(a) + ox, ay = Y(a) + oy, bx = X(b) + ox, by = Y(b) + oy, dx = X(d) + ox, dy = Y(d) + oy;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, dx) - r)), x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx, dx) + r));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, dy) - r)), y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by, dy) + r));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (occ[y * w + x]) continue;
      if (distTri(x + 0.5, y + 0.5, ax, ay, bx, by, dx, dy) <= r) occ[y * w + x] = 1;
    }
  }
  const list = [], rows = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (occ[y * w + x]) list.push([x, y]);
  return { list, w, h, ox, oy, hgt: h0 };
}

function findSpot(grid, R, cells, limit) {
  for (let y = 0; y + cells.h <= R; y++) {
    if (y * R >= limit) return null;
    for (let x = 0; x + cells.w <= R; x++) {
      let free = true;
      for (const [cx, cy] of cells.list) if (grid[(y + cy) * R + x + cx]) { free = false; break; }
      if (free) return { x, y };
    }
  }
  return null;
}

function distTri(px, py, ax, ay, bx, by, cx, cy) {
  const s1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax), s2 = (cx - bx) * (py - by) - (cy - by) * (px - bx), s3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
  if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) return 0;
  return Math.min(segD(px, py, ax, ay, bx, by), segD(px, py, bx, by, cx, cy), segD(px, py, cx, cy, ax, ay));
}
function segD(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy, t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/* ---------- metrics (for the UI) ---------- */

// Share of the 0..1 square covered by islands.
export function coverage(m, uv) {
  let a = 0;
  m.faces.forEach((f, fi) => {
    const c = uv.corner[fi];
    for (let k = 1; k + 1 < f.length; k++) {
      const p = c[0] * 2, q = c[k] * 2, r = c[k + 1] * 2, U = uv.uvs;
      a += Math.abs((U[q] - U[p]) * (U[r + 1] - U[p + 1]) - (U[r] - U[p]) * (U[q + 1] - U[p + 1])) / 2;
    }
  });
  return a;
}
