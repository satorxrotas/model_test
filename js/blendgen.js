// Geometry generators for Image to Blend. Everything is built in Blender's frame: metres, Z up, front faces −Y
// (Blender's Front view looks along +Y). Meshes: { pos: flat xyz, faces: [[i..]], uv: flat uv per face corner, faceMat? }.
import earcut from '../vendor/earcut/earcut.js';

/* ---------- helpers ---------- */
function gridMask(cut, maxCells) {
  const b = cut.bbox, bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1, cell = Math.max(bw, bh) / maxCells;
  const GW = Math.max(2, Math.ceil(bw / cell)), GH = Math.max(2, Math.ceil(bh / cell)), m = new Uint8Array(GW * GH);
  // a cell is inside when most of it is inside the cut-out
  for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
    let n = 0, t = 0;
    for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
      const x = Math.min(cut.w - 1, Math.floor(b.x0 + (gx + (sx + 0.5) / 3) * cell)), y = Math.min(cut.h - 1, Math.floor(b.y0 + (gy + (sy + 0.5) / 3) * cell));
      t++; n += cut.mask[y * cut.w + x] ? 1 : 0;
    }
    m[gy * GW + gx] = n * 2 > t ? 1 : 0;
  }
  return { GW, GH, cell, m, x0: b.x0, y0: b.y0 };
}

function luminance(img, x, y) {
  const i = (Math.min(img.height - 1, Math.max(0, Math.round(y))) * img.width + Math.min(img.width - 1, Math.max(0, Math.round(x)))) * 4, d = img.data;
  return (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
}

/* ---------- object from a product photo: an inflated, rounded shape with the photo on both sides ---------- */
// thickness: total depth as a fraction of the object's width; back: 'round' | 'flat'; detail: relief from image brightness
export function inflate(cut, img, crop, { height = 0.3, thickness = 0.35, back = 'round', detail = 0, cells = 120 } = {}) {
  const G = gridMask(cut, cells), { GW, GH, m } = G, PW = GW + 1, PH = GH + 1;
  const inside = (x, y) => x >= 0 && y >= 0 && x < GW && y < GH && m[y * GW + x];
  const used = new Uint8Array(PW * PH), edge = new Uint8Array(PW * PH);
  for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
    const c = [inside(x - 1, y - 1), inside(x, y - 1), inside(x - 1, y), inside(x, y)], k = c.filter(Boolean).length;
    if (k) { used[y * PW + x] = 1; if (k < 4) edge[y * PW + x] = 1; }
  }
  // height: Poisson solve (∇²h = −1, h = 0 on the outline), then sqrt → a rounded "inflated" profile
  const h = new Float32Array(PW * PH);
  for (let it = 0; it < 500; it++) for (let y = 1; y < PH - 1; y++) for (let x = 1; x < PW - 1; x++) {
    const i = y * PW + x; if (!used[i] || edge[i]) continue;
    const v = (h[i - 1] + h[i + 1] + h[i - PW] + h[i + PW] + 1) / 4; h[i] += 1.9 * (v - h[i]);
  }
  let hmax = 0; for (let i = 0; i < h.length; i++) { h[i] = Math.sqrt(Math.max(0, h[i])); hmax = Math.max(hmax, h[i]); }
  // smooth the stair-stepped outline: relax outline points along the outline
  const px = new Float32Array(PW * PH), py = new Float32Array(PW * PH);
  for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) { px[y * PW + x] = x; py[y * PW + x] = y; }
  for (let it = 0; it < 6; it++) {
    const nx = px.slice(), ny = py.slice();
    for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
      const i = y * PW + x; if (!edge[i]) continue;
      let sx = 0, sy = 0, n = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= PW || Y >= PH) continue;
        const j = Y * PW + X; if (!edge[j]) continue;
        // only neighbours joined by a boundary cell edge
        const cA = dx ? [inside(Math.min(x, X), y - 1), inside(Math.min(x, X), y)] : [inside(x - 1, Math.min(y, Y)), inside(x, Math.min(y, Y))];
        if (cA[0] === cA[1]) continue;
        sx += px[j]; sy += py[j]; n++;
      }
      if (n) { nx[i] = px[i] * 0.5 + (sx / n) * 0.5; ny[i] = py[i] * 0.5 + (sy / n) * 0.5; }
    }
    px.set(nx); py.set(ny);
  }
  // world scale: height in metres
  const bh = GH * G.cell, s = height / (GH), widthM = GW * s, depth = thickness * widthM;
  const front = new Int32Array(PW * PH).fill(-1), backI = new Int32Array(PW * PH).fill(-1), pos = [], uvOf = [];
  const toUV = (gx, gy) => { const X = G.x0 + gx * G.cell, Y = G.y0 + gy * G.cell; return [(X - crop.x) / crop.w, 1 - (Y - crop.y) / crop.h]; };
  for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
    const i = y * PW + x; if (!used[i]) continue;
    const X = (px[i] - GW / 2) * s, Z = (GH - py[i]) * s, t = hmax ? h[i] / hmax : 0;
    let rel = 0;
    if (detail && !edge[i]) rel = (luminance(img, G.x0 + px[i] * G.cell, G.y0 + py[i] * G.cell) - 0.5) * detail * depth * 0.25 * Math.min(1, t * 3);
    front[i] = pos.length / 3; pos.push(X, -(t * depth * 0.5 + rel), Z); uvOf.push(toUV(px[i], py[i]));
    if (edge[i]) backI[i] = front[i];
    else { backI[i] = pos.length / 3; pos.push(X, back === 'flat' ? 0 : t * depth * 0.5, Z); uvOf.push(toUV(px[i], py[i])); }
  }
  const faces = [], uv = [];
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    if (!inside(x, y)) continue;
    const tl = y * PW + x, tr = tl + 1, bl = tl + PW, br = bl + 1;
    const f = [front[bl], front[br], front[tr], front[tl]]; faces.push(f); for (const v of f) uv.push(...uvOf[v]);
    const g = [backI[tl], backI[tr], backI[br], backI[bl]]; faces.push(g); for (const v of g) uv.push(...uvOf[v]);
  }
  if (back === 'flat') for (let i = 0; i < PW * PH; i++) if (used[i] && !edge[i]) pos[backI[i] * 3 + 1] = 0;
  return { pos, faces, uv, size: [widthM, depth, height] };
}

/* ---------- logo / graphic: outline → extruded solid with a planar-mapped front ---------- */
export function logo(cut, crop, { width = 0.3, depth = 0.02, maxDim = 700, simplify = 0.7 } = {}) {
  const b = cut.bbox, k = Math.min(1, maxDim / Math.max(b.x1 - b.x0 + 1, b.y1 - b.y0 + 1));
  const W = Math.ceil((b.x1 - b.x0 + 1) * k) + 4, H = Math.ceil((b.y1 - b.y0 + 1) * k) + 4;
  // soft mask (box filtered) so the 0.5 contour is sub-pixel smooth
  const f = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let n = 0, t = 0;
    for (let sy = -1; sy <= 1; sy++) for (let sx = -1; sx <= 1; sx++) {
      const X = Math.floor(b.x0 + (x - 2 + sx * 0.33 + 0.5) / k), Y = Math.floor(b.y0 + (y - 2 + sy * 0.33 + 0.5) / k);
      t++; if (X >= 0 && Y >= 0 && X < cut.w && Y < cut.h && cut.mask[Y * cut.w + X]) n++;
    }
    f[y * W + x] = n / t;
  }
  const rings = marchingSquares(f, W, H, 0.5).map((r) => dp(r, simplify)).filter((r) => r.length >= 3 && Math.abs(area(r)) > 4);
  // nest rings: even depth = outline, odd = hole of the smallest ring containing it
  const info = rings.map((r, i) => ({ r, i, a: Math.abs(area(r)), parent: -1, depth: 0 }));
  for (const A of info) {
    let best = null;
    for (const B of info) if (B !== A && B.a > A.a && inPoly(A.r[0], B.r) && (!best || B.a < best.a)) best = B;
    A.parent = best ? best.i : -1;
  }
  for (const A of info) { let d = 0, p = A.parent; while (p >= 0) { d++; p = info[p].parent; } A.depth = d; }
  const s = width / ((b.x1 - b.x0 + 1) * k), Hm = (b.y1 - b.y0 + 1) * k * s;
  const toX = (x) => (x - 2 - ((b.x1 - b.x0 + 1) * k) / 2) * s, toZ = (y) => Hm - (y - 2) * s;
  const toUV = (x, y) => { const X = b.x0 + (x - 2) / k, Y = b.y0 + (y - 2) / k; return [(X - crop.x) / crop.w, 1 - (Y - crop.y) / crop.h]; };
  const pos = [], faces = [], uv = [], faceMat = [];
  for (const O of info.filter((x) => x.depth % 2 === 0)) {
    // outline counter-clockwise and holes clockwise as seen from the front (image y runs down, Blender Z up)
    const outer = orient(O.r, false), holes = info.filter((x) => x.parent === O.i).map((x) => orient(x.r, true));
    const all = [outer, ...holes], flat = [], holeIdx = [];
    for (const r of all) { if (r !== outer) holeIdx.push(flat.length / 2); for (const p of r) flat.push(p[0], p[1]); }
    const tris = earcut(flat, holeIdx, 2), n = flat.length / 2, base = pos.length / 3;
    for (let i = 0; i < n; i++) pos.push(toX(flat[i * 2]), -depth / 2, toZ(flat[i * 2 + 1]));
    for (let i = 0; i < n; i++) pos.push(toX(flat[i * 2]), depth / 2, toZ(flat[i * 2 + 1]));
    // front (seen from −Y) and back caps; image y runs down, so flip winding for the front
    for (let t = 0; t < tris.length; t += 3) {
      let a = tris[t], c = tris[t + 1], d = tris[t + 2];
      // front faces must turn counter-clockwise seen from −Y, i.e. clockwise in image coordinates
      const ar = (flat[c * 2] - flat[a * 2]) * (flat[d * 2 + 1] - flat[a * 2 + 1]) - (flat[d * 2] - flat[a * 2]) * (flat[c * 2 + 1] - flat[a * 2 + 1]);
      if (ar > 0) [c, d] = [d, c];
      faces.push([base + a, base + c, base + d]); faceMat.push(0); for (const v of [a, c, d]) uv.push(...toUV(flat[v * 2], flat[v * 2 + 1]));
      faces.push([base + n + a, base + n + d, base + n + c]); faceMat.push(0); for (const v of [a, d, c]) uv.push(...toUV(flat[v * 2], flat[v * 2 + 1]));
    }
    // side walls along every ring
    let off = 0;
    for (const r of all) {
      for (let j = 0; j < r.length; j++) {
        const a = off + j, c = off + ((j + 1) % r.length);
        faces.push([base + a, base + n + a, base + n + c, base + c]); faceMat.push(1);
        const u0 = j / r.length, u1 = (j + 1) / r.length; uv.push(u0, 0, u0, 1, u1, 1, u1, 0);
      }
      off += r.length;
    }
  }
  return { pos, faces, uv, faceMat, size: [width, depth, Hm] };
}

// rings (arrays of [x, y]) where the field crosses level; cells split at their midpoints for saddles
function marchingSquares(f, W, H, lv) {
  const segs = new Map(), key = (x, y, e) => `${x},${y},${e}`; // edge ids: 0 top, 1 right, 2 bottom, 3 left of cell (x,y)
  const v = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : f[y * W + x]);
  const pt = (x, y, e) => {
    const [ax, ay, bx, by] = [[x, y, x + 1, y], [x + 1, y, x + 1, y + 1], [x, y + 1, x + 1, y + 1], [x, y, x, y + 1]][e];
    const va = v(ax, ay), vb = v(bx, by), t = (lv - va) / (vb - va || 1e-9);
    return [ax + (bx - ax) * t, ay + (by - ay) * t];
  };
  // canonical edge id shared by neighbouring cells
  const eid = (x, y, e) => (e === 0 ? `h${x},${y}` : e === 2 ? `h${x},${y + 1}` : e === 3 ? `v${x},${y}` : `v${x + 1},${y}`);
  const next = new Map(), pos = new Map();
  for (let y = -1; y < H; y++) for (let x = -1; x < W; x++) {
    const tl = v(x, y) > lv, tr = v(x + 1, y) > lv, br = v(x + 1, y + 1) > lv, bl = v(x, y + 1) > lv;
    const c = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
    if (c === 0 || c === 15) continue;
    // segments oriented with the inside on the left (consistent direction → closed rings)
    const S = {
      1: [[3, 2]], 2: [[2, 1]], 3: [[3, 1]], 4: [[1, 0]], 5: [[3, 0], [1, 2]], 6: [[2, 0]], 7: [[3, 0]],
      8: [[0, 3]], 9: [[0, 2]], 10: [[0, 1], [2, 3]], 11: [[0, 1]], 12: [[1, 3]], 13: [[1, 2]], 14: [[2, 3]],
    }[c];
    const mid = (v(x, y) + v(x + 1, y) + v(x + 1, y + 1) + v(x, y + 1)) / 4 > lv;
    const segsHere = c === 5 && mid ? [[3, 2], [1, 0]] : c === 10 && mid ? [[0, 3], [2, 1]] : S;
    for (const [a, b2] of segsHere) {
      const A = eid(x, y, a), B = eid(x, y, b2);
      next.set(A, B); if (!pos.has(A)) pos.set(A, pt(x, y, a)); if (!pos.has(B)) pos.set(B, pt(x, y, b2));
    }
  }
  const rings = [], seen = new Set();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const r = []; let k = start;
    while (k && !seen.has(k)) { seen.add(k); r.push(pos.get(k)); k = next.get(k); }
    if (r.length >= 3) rings.push(r);
  }
  return rings;
}
function area(r) { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }
function orient(r, ccw) { return (area(r) > 0) === ccw ? r : r.slice().reverse(); }
function inPoly(p, r) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i], b = r[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}
// Douglas–Peucker on a closed ring
function dp(r, tol) {
  if (r.length < 8) return r;
  // split at the point farthest from the first
  let far = 0, fd = -1; for (let i = 1; i < r.length; i++) { const d = (r[i][0] - r[0][0]) ** 2 + (r[i][1] - r[0][1]) ** 2; if (d > fd) { fd = d; far = i; } }
  const run = (pts) => {
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const st = [[0, pts.length - 1]];
    while (st.length) {
      const [a, b] = st.pop(); let md = -1, mi = -1;
      const [ax, ay] = pts[a], [bx, by] = pts[b], L = Math.hypot(bx - ax, by - ay) || 1e-9;
      for (let i = a + 1; i < b; i++) { const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / L; if (d > md) { md = d; mi = i; } }
      if (md > tol) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  };
  const A = run(r.slice(0, far + 1)), B = run([...r.slice(far), r[0]]);
  return [...A.slice(0, -1), ...B.slice(0, -1)];
}

/* ---------- photo as a scene: a picture plane, or a studio sweep (wall curving onto the floor) ---------- */
export function picture(aspect, { height = 2, layout = 'flat', sweep = 0.3, cols = 24, rows = 40 } = {}) {
  const W = height * aspect, pos = [], faces = [], uv = [];
  if (layout === 'flat') {
    pos.push(-W / 2, 0, 0, W / 2, 0, 0, W / 2, 0, height, -W / 2, 0, height);
    faces.push([0, 1, 2, 3]); uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    return { pos, faces, uv, size: [W, 0, height] };
  }
  // studio sweep: the bottom `sweep` of the image bends through a quarter circle and runs out as floor toward the camera
  const Lb = height * sweep, R = Lb * 0.5, arc = (Math.PI / 2) * R, flat = Lb - arc;
  for (let j = 0; j <= rows; j++) {
    const t = j / rows, d = t * height; // distance along the picture from the bottom edge
    let y, z;
    if (d < flat) { y = -(flat - d) - R; z = 0; } // floor toward the camera
    else if (d < flat + arc) { const a = (d - flat) / R; y = -(R - R * Math.sin(a)); z = R - R * Math.cos(a); } // quarter circle
    else { y = 0; z = R + (d - flat - arc); }
    for (let i = 0; i <= cols; i++) { pos.push(-W / 2 + (W * i) / cols, y, z); }
  }
  const vid = (i, j) => j * (cols + 1) + i;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    faces.push([vid(i, j), vid(i + 1, j), vid(i + 1, j + 1), vid(i, j + 1)]);
    uv.push(i / cols, j / rows, (i + 1) / cols, j / rows, (i + 1) / cols, (j + 1) / rows, i / cols, (j + 1) / rows);
  }
  return { pos, faces, uv, size: [W, flat + R, height - flat - arc + R] };
}

/* ---------- three.js Y-up garment/body data → Blender Z-up ---------- */
export function yUpToZUp(pos) { const out = new Float32Array(pos.length); for (let i = 0; i < pos.length; i += 3) { out[i] = pos[i]; out[i + 1] = -pos[i + 2]; out[i + 2] = pos[i + 1]; } return out; }
export function cornerUV(faces, uvPerVertex) { const out = []; for (const f of faces) for (const v of f) out.push(uvPerVertex[v * 2], uvPerVertex[v * 2 + 1]); return out; }
