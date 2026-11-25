// Photo + depth map → a 3D scene: surfaces projected from the camera, torn at depth edges into separate
// objects (each with a backdrop filled in behind it), all in Blender's frame (camera at the origin looking +Y, Z up).

// disp: disparity grid (gw × gh, bigger = nearer). Returns { layers, fill: { mask, color }, fov, stats }
export function reconstruct({ disp, gw, gh, photo, lens = 26, near = 1.5, range = 6, separation = 1, maxObjects = 12, thickness = 0.35 }) {
  const n = gw * gh;
  // robust normalisation of the disparity
  const sorted = Float32Array.from(disp).sort(), lo = sorted[Math.floor(n * 0.01)], hi = sorted[Math.floor(n * 0.995)];
  const dn = new Float32Array(n); for (let i = 0; i < n; i++) dn[i] = Math.min(1, Math.max(0, (disp[i] - lo) / (hi - lo || 1)));
  // disparity → metric-ish depth between `near` and `near·range`
  const far = near * range, z = new Float32Array(n);
  for (let i = 0; i < n; i++) z[i] = 1 / (dn[i] / near + (1 - dn[i]) / far);
  // camera: 35 mm-equivalent lens across the long side
  const aspect = gw / gh, half = 18 / lens, tx = aspect >= 1 ? half : half * aspect, ty = aspect >= 1 ? half / aspect : half;
  const P = (i, zz = z[i]) => { const x = i % gw, y = (i / gw) | 0; const u = (x / (gw - 1)) * 2 - 1, v = 1 - (y / (gh - 1)) * 2; return [u * tx * zz, zz, v * ty * zz]; };

  // depth edges: a sharp step in disparity between neighbouring cells (floors and walls change gradually,
  // object outlines change abruptly even though the model softens them over a few pixels)
  const tD = (0.03 * (240 / Math.max(gw, gh))) / Math.max(0.2, separation);
  const jump = (a, b) => Math.abs(dn[a] - dn[b]) > tD;
  // components: union-find over non-jump links
  const par = Int32Array.from({ length: n }, (_, i) => i), find = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
  const unite = (a, b) => { a = find(a); b = find(b); if (a !== b) par[a] = b; };
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const i = y * gw + x;
    if (x + 1 < gw && !jump(i, i + 1)) unite(i, i + 1);
    if (y + 1 < gh && !jump(i, i + gw)) unite(i, i + gw);
  }
  const comp = new Int32Array(n), stats = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i); comp[i] = r;
    let s = stats.get(r); if (!s) stats.set(r, (s = { id: r, count: 0, zsum: 0, border: 0, x0: gw, x1: 0, y0: gh, y1: 0 }));
    const x = i % gw, y = (i / gw) | 0; s.count++; s.zsum += z[i]; if (x === 0 || y === 0 || x === gw - 1 || y === gh - 1) s.border++;
    s.x0 = Math.min(s.x0, x); s.x1 = Math.max(s.x1, x); s.y0 = Math.min(s.y0, y); s.y1 = Math.max(s.y1, y);
  }
  const comps = [...stats.values()].map((s) => ({ ...s, z: s.zsum / s.count }));
  // background: big, far, touching the frame
  const bg = comps.reduce((a, b) => (score(b) > score(a) ? b : a));
  function score(s) { return s.count * (0.5 + s.z / far) * (s.border > 0 ? 1.5 : 0.6); }
  const minObj = Math.max(30, n * 0.004);
  const objs = comps.filter((s) => s !== bg && s.count >= minObj && s.z < bg.z * 0.98).sort((a, b) => b.count - a.count).slice(0, maxObjects);
  const objOf = new Map(objs.map((s, k) => [s.id, k]));

  // backdrop: depth and colour filled in under the objects (harmonic fill from the surrounding background)
  const F = new Uint8Array(n); for (let i = 0; i < n; i++) if (objOf.has(comp[i])) F[i] = 1;
  // the soft ramp between an object and what's behind it belongs to neither: fill it too
  for (let i = 0; i < n; i++) {
    const x = i % gw;
    for (const j of [x < gw - 1 ? i + 1 : -1, i + gw]) if (j >= 0 && j < n && jump(i, j)) { const near = dn[i] > dn[j] ? i : j; if (F[near] || objOf.has(comp[near])) { F[i] = 1; F[j] = 1; } }
  }
  // grow the fill region by a cell so object edges don't leave slivers on the backdrop
  const F2 = F.slice(); for (let i = 0; i < n; i++) if (F[i]) { const x = i % gw; for (const j of [x > 0 ? i - 1 : -1, x < gw - 1 ? i + 1 : -1, i - gw, i + gw]) if (j >= 0 && j < n) F2[j] = 1; }
  const zb = z.slice(), col = sampleColors(photo, gw, gh);
  for (let i = 0; i < n; i++) if (F2[i]) zb[i] = NaN;
  harmonicFill(zb, gw, gh, F2, bg.z);
  const fillCol = new Float32Array(n * 3); for (let i = 0; i < n * 3; i++) fillCol[i] = F2[(i / 3) | 0] ? NaN : col[i];
  for (let k = 0; k < 3; k++) { const ch = new Float32Array(n); for (let i = 0; i < n; i++) ch[i] = fillCol[i * 3 + k]; harmonicFill(ch, gw, gh, F2, 128); for (let i = 0; i < n; i++) fillCol[i * 3 + k] = ch[i]; }
  // the backdrop must stay behind what it hides
  for (let i = 0; i < n; i++) if (F2[i]) { let zmax = z[i]; zb[i] = Math.max(zb[i], zmax * 1.04); }

  // meshes: a face goes to a layer when its four corners belong to it
  const uvOf = (i) => [(i % gw) / (gw - 1), 1 - ((i / gw) | 0) / (gh - 1)];
  const layers = [];
  const make = (name, kind, keep, depthOf, image) => {
    const idx = new Int32Array(n).fill(-1), pos = [], faces = [], uv = [];
    const vert = (i) => { if (idx[i] < 0) { idx[i] = pos.length / 3; pos.push(...P(i, depthOf(i))); } return idx[i]; };
    for (let y = 0; y + 1 < gh; y++) for (let x = 0; x + 1 < gw; x++) {
      const tl = y * gw + x, tr = tl + 1, bl = tl + gw, br = bl + 1;
      if (!keep(tl, tr, bl, br)) continue;
      const f = [vert(bl), vert(br), vert(tr), vert(tl)]; faces.push(f); for (const c of [bl, br, tr, tl]) uv.push(...uvOf(c));
    }
    if (!faces.length) return;
    const L = { name, kind, pos, faces, uv, image };
    layers.push(L);
    return L;
  };
  // give an object depth: a back copy pushed away from the camera along each ray, plus side walls on the outline
  const extrude = (L, t) => {
    const nv = L.pos.length / 3, nf = L.faces.length;
    for (let v = 0; v < nv; v++) { const p = [L.pos[v * 3], L.pos[v * 3 + 1], L.pos[v * 3 + 2]], l = Math.hypot(...p) || 1; L.pos.push(p[0] + (p[0] / l) * t, p[1] + (p[1] / l) * t, p[2] + (p[2] / l) * t); }
    const uvOfVert = new Float32Array(nv * 2); let c = 0;
    for (const f of L.faces) for (const v of f) { uvOfVert[v * 2] = L.uv[c * 2]; uvOfVert[v * 2 + 1] = L.uv[c * 2 + 1]; c++; }
    const edges = new Map();
    for (let k = 0; k < nf; k++) {
      const f = L.faces[k];
      L.faces.push([f[3] + nv, f[2] + nv, f[1] + nv, f[0] + nv]); for (const v of [f[3], f[2], f[1], f[0]]) L.uv.push(uvOfVert[v * 2], uvOfVert[v * 2 + 1]);
      for (let e = 0; e < 4; e++) { const a = f[e], b = f[(e + 1) % 4], key = a < b ? `${a},${b}` : `${b},${a}`; edges.set(key, edges.has(key) ? null : [a, b]); }
    }
    for (const e of edges.values()) if (e) { const [a, b] = e; L.faces.push([b, a, a + nv, b + nv]); for (const v of [b, a, a, b]) L.uv.push(uvOfVert[v * 2], uvOfVert[v * 2 + 1]); }
  };
  // backdrop: everything except real tears inside the background itself
  make('Backdrop', 'backdrop', () => true, (i) => zb[i], 'fill'); // never torn: no holes from the camera
  objs.forEach((s, k) => {
    const id = s.id;
    const L = make(`Object ${k + 1}`, 'object', (a, b, c, d) => comp[a] === id && comp[b] === id && comp[c] === id && comp[d] === id, (i) => z[i], 'photo');
    if (!L) return;
    L.depth = s.z; L.width = ((s.x1 - s.x0 + 1) / gw) * 2 * tx * s.z;
    if (thickness > 0) extrude(L, Math.min(L.width * thickness, s.z * 0.4));
  });
  const zs = Float32Array.from(z).sort();
  // texture fill only where an object fully hides the backdrop (eroded object mask): elsewhere the backdrop keeps
  // the photo, so the view from the camera stays sharp at object edges
  const hid = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!objOf.has(comp[i])) continue;
    const x = i % gw; let ok = true;
    for (const j of [x > 0 ? i - 1 : -1, x < gw - 1 ? i + 1 : -1, i - gw, i + gw]) if (j < 0 || j >= n || comp[j] !== comp[i]) { ok = false; break; }
    if (ok) hid[i] = 1;
  }
  return { layers, fill: { mask: hid, color: fillCol }, lens, aspect, near, far, objects: objs.length, gw, gh, medianZ: zs[n >> 1], tx, ty };
}

function sampleColors(photo, gw, gh) {
  const c = document.createElement('canvas'); c.width = gw; c.height = gh;
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(photo, 0, 0, gw, gh);
  const d = g.getImageData(0, 0, gw, gh).data, out = new Float32Array(gw * gh * 3);
  for (let i = 0; i < gw * gh; i++) { out[i * 3] = d[i * 4]; out[i * 3 + 1] = d[i * 4 + 1]; out[i * 3 + 2] = d[i * 4 + 2]; }
  return out;
}

// fill NaN cells (where mask) by repeated neighbour averaging, coarse-to-fine seeded
function harmonicFill(a, w, h, mask, fallback) {
  const n = w * h;
  // seed: nearest known value by a BFS from the known cells
  const q = new Int32Array(n); let qh = 0, qt = 0;
  for (let i = 0; i < n; i++) if (!Number.isNaN(a[i])) q[qt++] = i;
  if (!qt) { a.fill(fallback); return; }
  while (qh < qt) {
    const i = q[qh++], x = i % w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) if (j >= 0 && j < n && Number.isNaN(a[j])) { a[j] = a[i]; q[qt++] = j; }
  }
  // relax the filled cells
  const cells = []; for (let i = 0; i < n; i++) if (mask[i]) cells.push(i);
  for (let it = 0; it < 120; it++) for (const i of cells) {
    const x = i % w; let s = 0, c = 0;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) if (j >= 0 && j < n) { s += a[j]; c++; }
    a[i] = s / c;
  }
}

// full-resolution backdrop texture: the photo with the hidden areas painted from the filled colours (soft edges)
export function fillTexture(photo, rec) {
  const { gw, gh, fill } = rec, W = photo.width, H = photo.height;
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'); g.drawImage(photo, 0, 0);
  const small = document.createElement('canvas'); small.width = gw; small.height = gh; const sg = small.getContext('2d'), sd = sg.createImageData(gw, gh);
  const mk = document.createElement('canvas'); mk.width = gw; mk.height = gh; const mg = mk.getContext('2d'), md = mg.createImageData(gw, gh);
  for (let i = 0; i < gw * gh; i++) {
    sd.data[i * 4] = fill.color[i * 3]; sd.data[i * 4 + 1] = fill.color[i * 3 + 1]; sd.data[i * 4 + 2] = fill.color[i * 3 + 2]; sd.data[i * 4 + 3] = 255;
    md.data[i * 4 + 3] = fill.mask[i] ? 255 : 0;
  }
  sg.putImageData(sd, 0, 0); mg.putImageData(md, 0, 0);
  // masked fill on top of the photo
  const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H; const tg = tmp.getContext('2d');
  tg.imageSmoothingQuality = 'high'; tg.filter = `blur(${Math.max(1, Math.round(W / gw))}px)`; tg.drawImage(small, 0, 0, W, H); tg.filter = 'none';
  tg.globalCompositeOperation = 'destination-in'; tg.filter = `blur(${Math.max(1, Math.round(W / gw / 2))}px)`; tg.drawImage(mk, 0, 0, W, H); tg.filter = 'none';
  g.drawImage(tmp, 0, 0);
  return c;
}
