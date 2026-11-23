// Image to Model: cut a garment out of a photo, measure it, and build a clean quad garment on the
// Motion Studio body (T-pose, metres, +Z = front) with the photo wrapped on as its texture.
import * as THREE from 'three';

/* ======================= 1. cut-out ======================= */

// Background = whatever is connected to the image border and close to the border's colours.
export function cutout(img, { tolerance = 1, bgColor = null } = {}) {
  const { width: w, height: h, data } = img, n = w * h;
  // transparent PNGs: use the alpha channel directly
  let transparent = 0; for (let i = 3; i < data.length; i += 4 * 7) if (data[i] < 200) transparent++;
  if (transparent > n / 7 * 0.05) {
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = data[i * 4 + 3] > 128 ? 1 : 0;
    return finish(mask, w, h);
  }
  // border samples, clustered: the garment often fills much of the frame (tight crops, a waistband at the
  // top, another item at the side), so we can't assume the border is all background
  const b = Math.max(2, Math.round(Math.min(w, h) * 0.02)), samples = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < b || y < b || x >= w - b || y >= h - b) if (((x * 7 + y * 13) & 3) === 0) samples.push(y * w + x);
  // colours as brightness + chroma (YCbCr), chroma weighted 3×: grey floors vs. saturated fabric of
  // similar brightness (e.g. pink on concrete) stay far apart
  const ycc = (r, g, bl) => [0.299 * r + 0.587 * g + 0.114 * bl, 3 * (-0.1687 * r - 0.3313 * g + 0.5 * bl), 3 * (0.5 * r - 0.4187 * g - 0.0813 * bl)];
  const C = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const v = ycc(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]); C[i * 3] = v[0]; C[i * 3 + 1] = v[1]; C[i * 3 + 2] = v[2]; }
  const col = (i) => [C[i * 3], C[i * 3 + 1], C[i * 3 + 2]];
  const d2 = (a, c) => (a[0] - c[0]) ** 2 + (a[1] - c[1]) ** 2 + (a[2] - c[2]) ** 2;
  if (bgColor) bgColor = ycc(...bgColor);
  const pts = samples.map(col);
  let cands;
  if (bgColor) {
    const near = pts.filter((p) => d2(p, bgColor) < 90 * 90);
    cands = [{ c: bgColor, spread: near.length > 20 ? near.map((p) => Math.sqrt(d2(p, bgColor))).sort((x, y) => x - y)[Math.floor(near.length * 0.97)] : 25 }];
  } else {
    const cents = [pts[0].slice()];
    while (cents.length < 4) { let best = pts[0], bd2 = -1; for (const p of pts) { const m2 = Math.min(...cents.map((c) => d2(p, c))); if (m2 > bd2) { bd2 = m2; best = p; } } cents.push(best.slice()); }
    const assign = new Int32Array(pts.length);
    for (let it = 0; it < 10; it++) {
      pts.forEach((p, k) => { let bi = 0, bv = Infinity; cents.forEach((c, ci) => { const v = d2(p, c); if (v < bv) { bv = v; bi = ci; } }); assign[k] = bi; });
      cents.forEach((c, ci) => { let n2 = 0; const sum = [0, 0, 0]; pts.forEach((p, k) => { if (assign[k] === ci) { n2++; sum[0] += p[0]; sum[1] += p[1]; sum[2] += p[2]; } }); if (n2) for (let ch = 0; ch < 3; ch++) c[ch] = sum[ch] / n2; });
    }
    cands = cents.map((c, ci) => {
      const ds = pts.filter((_, k) => assign[k] === ci).map((p) => Math.sqrt(d2(p, c))).sort((x, y) => x - y);
      return { c, share: ds.length / pts.length, spread: ds.length ? ds[Math.floor(ds.length * 0.9)] : 0 };
    }).filter((x) => x.share > 0.08);
  }
  // try each candidate as the background; keep the cut whose garment is most central and touches the frame least
  let best = null;
  for (const cand of cands) {
    const T = (cand.spread * 1.35 + 14) * tolerance, med = cand.c;
    const close = (i) => Math.hypot(C[i * 3] - med[0], C[i * 3 + 1] - med[1], C[i * 3 + 2] - med[2]) <= T;
    const bg = new Uint8Array(n), q = new Int32Array(n); let qh = 0, qt = 0;
    const push = (i) => { if (!bg[i] && close(i)) { bg[i] = 1; q[qt++] = i; } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (qh < qt) { const i = q[qh++], x = i % w, y = (i / w) | 0; if (x > 0) push(i - 1); if (x < w - 1) push(i + 1); if (y > 0) push(i - w); if (y < h - 1) push(i + w); }
    const mask = new Uint8Array(n); for (let i = 0; i < n; i++) mask[i] = bg[i] ? 0 : 1;
    const res = finish(mask, w, h);
    // score: area in a sensible range, centred, little of the frame covered
    let on = 0, cx = 0, cy = 0, edge = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (res.mask[y * w + x]) { on++; cx += x; cy += y; if (x < b || y < b || x >= w - b || y >= h - b) edge++; }
    if (!on) continue;
    const area = on / n, off = Math.hypot(cx / on / w - 0.5, cy / on / h - 0.5), edgeShare = edge / Math.max(1, 2 * (w + h) * b);
    const score = (area > 0.05 && area < 0.92 ? 1 : 0.2) - off * 1.5 - edgeShare * 0.8 + (bgColor ? 10 : 0);
    if (!best || score > best.score) best = { ...res, score, bgColor: med };
  }
  return best || finish(new Uint8Array(n), w, h);
}

function finish(mask, w, h) {
  let m = morph(mask, w, h, 2, false); m = morph(m, w, h, 2, true); // open: drop specks
  m = largest(m, w, h);
  m = morph(m, w, h, 3, true); m = morph(m, w, h, 3, false);       // close: fill nicks
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return { mask: m, w, h, bbox: x1 < 0 ? null : { x0, y0, x1, y1 } };
}

function morph(m, w, h, r, dilate) {
  const tmp = new Uint8Array(m.length), out = new Uint8Array(m.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = dilate ? 0 : 1;
    for (let d = -r; d <= r; d++) { const xx = Math.min(w - 1, Math.max(0, x + d)), s = m[y * w + xx]; if (dilate ? s : !s) { v = dilate ? 1 : 0; break; } }
    tmp[y * w + x] = v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = dilate ? 0 : 1;
    for (let d = -r; d <= r; d++) { const yy = Math.min(h - 1, Math.max(0, y + d)), s = tmp[yy * w + x]; if (dilate ? s : !s) { v = dilate ? 1 : 0; break; } }
    out[y * w + x] = v;
  }
  return out;
}

function largest(m, w, h) {
  const lab = new Int32Array(m.length).fill(-1), q = new Int32Array(m.length); let best = -1, bestN = 0, id = 0;
  for (let s = 0; s < m.length; s++) {
    if (!m[s] || lab[s] >= 0) continue;
    let qh = 0, qt = 0; q[qt++] = s; lab[s] = id;
    while (qh < qt) { const i = q[qh++], x = i % w; for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) if (j >= 0 && j < m.length && m[j] && lab[j] < 0) { lab[j] = id; q[qt++] = j; } }
    if (qt > bestN) { bestN = qt; best = id; }
    id++;
  }
  const out = new Uint8Array(m.length); for (let i = 0; i < m.length; i++) out[i] = lab[i] === best ? 1 : 0;
  return out;
}

/* ======================= 2. measuring ======================= */

function runs(cut, y, minLen) {
  const { mask, w } = cut, out = []; let s = -1;
  for (let x = 0; x <= w; x++) {
    const on = x < w && mask[y * w + x];
    if (on && s < 0) s = x; else if (!on && s >= 0) { if (x - s >= minLen) out.push([s, x - 1]); s = -1; }
  }
  return out;
}

const median = (a) => { const v = a.filter(Number.isFinite).sort((x, y) => x - y); return v.length ? v[v.length >> 1] : NaN; };

// guess the garment type from the silhouette
export function guessType(cut) {
  const { bbox: b } = cut, H = b.y1 - b.y0 + 1, W = b.x1 - b.x0 + 1;
  let split = 0; for (let k = 0.55; k <= 0.9; k += 0.05) if (runs(cut, Math.round(b.y0 + H * k), W * 0.06).length >= 2) split++;
  if (split >= 5) return 'pants';
  const topW = median([0.05, 0.1, 0.15].map((k) => { const r = runs(cut, Math.round(b.y0 + H * k), 2); return r.length ? r[r.length - 1][1] - r[0][0] : NaN; }));
  const midW = median([0.5, 0.55, 0.6].map((k) => { const r = runs(cut, Math.round(b.y0 + H * k), 2); return r.length ? r[r.length - 1][1] - r[0][0] : NaN; }));
  return topW > midW * 1.35 ? 'top' : 'skirt';
}

export function measurePants(cut) {
  const { bbox: b } = cut, H = b.y1 - b.y0 + 1;
  const full = (y) => { const r = runs(cut, y, 2); return r.length ? [r[0][0], r[r.length - 1][1]] : null; };
  // waistband width: median over rows a little below the top edge (skips a frame line / crop edge above it)
  const waistW = median(Array.from({ length: Math.max(4, Math.round(H * 0.05)) }, (_, i) => { const f = full(Math.round(b.y0 + H * 0.025) + i); return f ? f[1] - f[0] : NaN; }));
  // crotch: first row (below the top fifth) where two legs stay apart for a few rows
  let crotch = -1;
  for (let y = Math.round(b.y0 + H * 0.15); y < b.y1 - 5; y++) {
    let ok = true;
    for (let k = 0; k < 4 && ok; k++) ok = runs(cut, y + k, waistW * 0.08).length >= 2;
    if (ok) { crotch = y; break; }
  }
  if (crotch < 0) crotch = Math.round(b.y0 + H * 0.32);
  // follow each leg down
  const legL = new Map(), legR = new Map(); // image-left leg = wearer's right
  let prevL = null, prevR = null, endL = crotch, endR = crotch;
  for (let y = crotch; y <= b.y1; y++) {
    const r = runs(cut, y, Math.max(2, waistW * 0.04)).sort((p, q) => (q[1] - q[0]) - (p[1] - p[0])).slice(0, 2).sort((p, q) => p[0] - q[0]);
    const overlaps = (a, p) => !p || (a[0] <= p[1] + 3 && a[1] >= p[0] - 3);
    if (r.length === 2) {
      if (overlaps(r[0], prevL)) { legL.set(y, r[0]); prevL = r[0]; endL = y; }
      if (overlaps(r[1], prevR)) { legR.set(y, r[1]); prevR = r[1]; endR = y; }
    } else if (r.length === 1) {
      if (prevL && overlaps(r[0], prevL) && !(prevR && overlaps(r[0], prevR))) { legL.set(y, r[0]); prevL = r[0]; endL = y; }
      else if (prevR && overlaps(r[0], prevR)) { legR.set(y, r[0]); prevR = r[0]; endR = y; }
    }
  }
  // ignore things touching the garment (another item in the shot): hips can't be much wider than the waistband,
  // and a leg's outer edge doesn't jump from one row to the next
  const top = full(Math.round(b.y0 + H * 0.05)) || [b.x0, b.x1], wc = (top[0] + top[1]) / 2, half = waistW * 0.66;
  const pelvis = new Map(); for (let y = b.y0; y <= crotch; y++) { const f = full(y); if (f) pelvis.set(y, [Math.max(f[0], wc - half), Math.min(f[1], wc + half)]); }
  for (const [map, outer] of [[legL, 0], [legR, 1]]) {
    const ys = [...map.keys()].sort((a2, b2) => a2 - b2), edge = ys.map((y) => map.get(y)[outer]);
    ys.forEach((y, k) => {
      const win = edge.slice(Math.max(0, k - 12), k + 13).sort((a2, b2) => a2 - b2), med = win[win.length >> 1];
      if (Math.abs(edge[k] - med) > waistW * 0.06) { const r = map.get(y).slice(); r[outer] = med; map.set(y, r); }
    });
  }
  const near = (map, y) => { for (let d = 0; d < 400; d++) { if (map.has(y - d)) return map.get(y - d); if (map.has(y + d)) return map.get(y + d); } return [0, 0]; };
  // legs are the same width: where one is clearly wider at the same point, something else is attached to it
  for (let k = 0; k <= 60; k++) {
    const t = k / 60, yl = Math.round(crotch + t * (endL - crotch)), yr = Math.round(crotch + t * (endR - crotch));
    const a = legL.get(yl), c = legR.get(yr); if (!a || !c) continue;
    const wa = a[1] - a[0], wc2 = c[1] - c[0];
    if (wa > wc2 * 1.2) for (let y = yl - 4; y <= yl + 4; y++) { const r = legL.get(y); if (r) legL.set(y, [Math.max(r[0], r[1] - wc2), r[1]]); }
    if (wc2 > wa * 1.2) for (let y = yr - 4; y <= yr + 4; y++) { const r = legR.get(y); if (r) legR.set(y, [r[0], Math.min(r[1], r[0] + wa)]); }
  }
  // garment cut off by the bottom of the photo → it's longer than we can see
  const cropped = b.y1 >= cut.h - 3;
  // beyond the last visible row, continue the texture by mirroring the last stretch of the photo
  const mirrorRow = (y, end, start) => { if (y <= end) return y; const P = Math.max(4, Math.round((end - start) * 0.12)), k = (y - end) % (2 * P); return k < P ? end - k : end - (2 * P - k); };
  const legWidth = (t) => {
    const yl = Math.round(crotch + t * (endL - crotch)), yr = Math.round(crotch + t * (endR - crotch));
    const a = near(legL, yl), c = near(legR, yr); return ((a[1] - a[0]) + (c[1] - c[0])) / 2;
  };
  const gap = runs(cut, crotch + 2, 1);
  const apex = gap.length >= 2 ? [(gap[0][1] + gap[1][0]) / 2, crotch] : [(b.x0 + b.x1) / 2, crotch];
  return {
    type: 'pants', waistW, top: b.y0, crotch, endL, endR, apex,
    rise: crotch - b.y0, inseam: ((endL - crotch) + (endR - crotch)) / 2, cropped,
    hipW: median(Array.from({ length: 12 }, (_, i) => { const r = pelvis.get(Math.round(b.y0 + (0.35 + i * 0.05) * (crotch - b.y0))); return r ? r[1] - r[0] : NaN; })),
    pelvisWidth: (t) => { const s = near(pelvis, Math.round(b.y0 + t * (crotch - b.y0))); return s[1] - s[0]; },
    legWidth: (t) => legWidth(Math.min(1, t)),
    // image spans for texture mapping
    pelvisSpan: (t) => { const y = Math.round(b.y0 + t * (crotch - b.y0)); return [...near(pelvis, y), y]; },
    // t may go past 1 when the hem continues below the photo; the texture is mirrored there
    legSpan: (side, t) => { const end = side === 'R' ? endL : endR, map = side === 'R' ? legL : legR, y = mirrorRow(Math.round(crotch + t * (end - crotch)), end, crotch); return [...near(map, y), y]; },
  };
}

export function measureTube(cut, type) {
  // skirts (and the torso of tops): width per row
  const { bbox: b } = cut, H = b.y1 - b.y0 + 1, cx = (b.x0 + b.x1) / 2;
  const rows = new Map();
  for (let y = b.y0; y <= b.y1; y++) {
    const r = runs(cut, y, 2); if (!r.length) continue;
    // the run containing (or nearest) the centre column = torso; for skirts that's the whole width
    let best = r[0], bd = Infinity;
    for (const s of r) { const d = s[0] <= cx && s[1] >= cx ? 0 : Math.min(Math.abs(s[0] - cx), Math.abs(s[1] - cx)); if (d < bd) { bd = d; best = s; } }
    rows.set(y, type === 'skirt' ? [r[0][0], r[r.length - 1][1]] : best);
  }
  const near = (y) => { for (let d = 0; d < 400; d++) { if (rows.has(y - d)) return rows.get(y - d); if (rows.has(y + d)) return rows.get(y + d); } return [0, 0]; };
  const width = (t) => { const s = near(Math.round(b.y0 + t * (H - 1))); return s[1] - s[0]; };
  const m = {
    type, top: b.y0, bottom: b.y1, length: H,
    waistW: median([0.01, 0.02, 0.03].map((k) => width(k))),
    width, span: (t) => { const y = Math.round(b.y0 + t * (H - 1)); return [...near(y), y]; },
  };
  if (type === 'top') {
    // torso width = typical width in the lower half (sleeves don't reach there in a flat lay)
    m.torsoW = median([0.55, 0.65, 0.75, 0.85].map((k) => width(k)));
    // torso band: the columns the lower torso occupies; sleeves = mask outside it in the upper half
    const band = [median([0.6, 0.7, 0.8].map((k) => near(Math.round(b.y0 + k * (H - 1)))[0])), median([0.6, 0.7, 0.8].map((k) => near(Math.round(b.y0 + k * (H - 1)))[1]))];
    let reach = 0, thick = [];
    for (let y = b.y0; y < b.y0 + H * 0.7; y++) {
      const r = runs(cut, y, 2); if (!r.length) continue;
      const out = Math.max(band[0] - r[0][0], r[r.length - 1][1] - band[1]); if (out > 0) reach = Math.max(reach, out);
    }
    for (let x = Math.round(band[0] - reach * 0.6); x === Math.round(band[0] - reach * 0.6); x++) {
      let c = 0; for (let y = b.y0; y <= b.y1; y++) if (cut.mask[y * cut.w + Math.max(0, x)]) c++; thick.push(c);
    }
    m.sleeveReach = reach; m.sleeveThick = thick[0] || H * 0.12; m.band = band;
    m.sleeveSpan = (side, t) => {
      // sample a horizontal line through the sleeve: from the torso edge outward
      const xe = side === 'R' ? band[0] - t * reach : band[1] + t * reach, x = Math.round(Math.max(0, Math.min(cut.w - 1, xe)));
      let y0 = -1, y1 = -1; for (let y = b.y0; y < b.y0 + H * 0.8; y++) if (cut.mask[y * cut.w + x]) { if (y0 < 0) y0 = y; y1 = y; }
      if (y0 < 0) { y0 = b.y0; y1 = b.y0 + H * 0.2; }
      return [y0, y1, x];
    };
  }
  return m;
}

/* ======================= 3. body ======================= */

// Landmarks + cross-sections of the Motion Studio body in its rest (T) pose.
// Legs use standard female proportions (the body mesh wears wide trousers, so its legs can't be measured).
export function bodyInfo(bones, bodyPos) {
  const W = (n) => bones[n].getWorldPosition(new THREE.Vector3());
  const hips = W('Hips'), ul = { L: W('LeftUpLeg'), R: W('RightUpLeg') }, kn = { L: W('LeftLeg'), R: W('RightLeg') }, ft = { L: W('LeftFoot'), R: W('RightFoot') };
  const arm = { L: W('LeftArm'), R: W('RightArm') }, fore = { L: W('LeftForeArm'), R: W('RightForeArm') }, hand = { L: W('LeftHand'), R: W('RightHand') };
  const neck = W('Neck'), legLen = ul.L.y - ft.L.y, height = W('Head').y + 0.11;
  const crotchY = ul.L.y - 0.09 * legLen;
  // torso cross-section at a height: centre, half-extents and perimeter (convex hull of a thin slice)
  const section = (y, maxAbsX = 0.26) => {
    const pts = [];
    for (let i = 0; i < bodyPos.length; i += 3) if (Math.abs(bodyPos[i + 1] - y) < 0.012 && Math.abs(bodyPos[i] - hips.x) < maxAbsX) pts.push([bodyPos[i], bodyPos[i + 2]]);
    if (pts.length < 6) return { cx: hips.x, cz: hips.z, a: 0.14, b: 0.1, perim: 0.8 };
    const H = hull2(pts); let per = 0, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let k = 0; k < H.length; k++) { const p = H[k], q = H[(k + 1) % H.length]; per += Math.hypot(p[0] - q[0], p[1] - q[1]); x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
    return { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, a: (x1 - x0) / 2, b: (z1 - z0) / 2, perim: per };
  };
  // leg axis (hip joint → knee → ankle, then straight down) and anatomical radius by height
  const legAt = (side, y) => {
    const a = ul[side], k = kn[side], f = ft[side];
    if (y >= k.y) { const t = (a.y - y) / (a.y - k.y); return a.clone().lerp(k, Math.max(0, t)); }
    if (y >= f.y) { const t = (k.y - y) / (k.y - f.y); return k.clone().lerp(f, t); }
    return new THREE.Vector3(f.x, y, f.z);
  };
  const scale = height / 1.66;
  const legR = (y) => { // circumference profile of a female leg, crotch → ankle
    const t = Math.max(0, Math.min(1, (crotchY - y) / (crotchY - ft.L.y)));
    const C = [[0, 0.56], [0.25, 0.48], [0.5, 0.37], [0.7, 0.35], [0.88, 0.25], [1, 0.22]];
    let c = C[C.length - 1][1]; for (let i = 0; i + 1 < C.length; i++) if (t <= C[i + 1][0]) { c = C[i][1] + (C[i + 1][1] - C[i][1]) * (t - C[i][0]) / (C[i + 1][0] - C[i][0]); break; }
    return (c * scale) / (2 * Math.PI);
  };
  const armR = (t) => (0.24 - 0.09 * t) * scale / (2 * Math.PI); // upper arm → wrist
  return { hips, ul, kn, ft, arm, fore, hand, neck, crotchY, legLen, height, groundY: 0, section, legAt, legR, armR, scale };
}

function hull2(pts) {
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]), lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

const ellipsePerim = (a, b) => Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));

/* ======================= 4. building ======================= */

class Builder {
  constructor() { this.P = []; this.UV = []; this.F = []; }
  v(p, uv) { this.P.push(p.x, p.y, p.z); this.UV.push(uv[0], uv[1]); return this.P.length / 3 - 1; }
  tube(rings, closed = true) { // rings: arrays of vertex ids, equal length
    for (let i = 0; i + 1 < rings.length; i++) {
      const a = rings[i], b = rings[i + 1], n = a.length;
      for (let j = 0; j < (closed ? n : n - 1); j++) { const k = (j + 1) % n; this.F.push([a[j], a[k], b[k], b[j]]); }
    }
  }
}

// make every piece's faces point outward (from its own centre line)
function orientOutward(B, groups) {
  for (const { faces, axis } of groups) {
    let s = 0;
    for (const fi of faces) {
      const f = B.F[fi], P = (i) => new THREE.Vector3(B.P[f[i] * 3], B.P[f[i] * 3 + 1], B.P[f[i] * 3 + 2]);
      const n = new THREE.Vector3().crossVectors(P(1).sub(P(0)), P(2).sub(P(0)));
      const c = P(0).add(P(2)).multiplyScalar(0.5);
      s += n.dot(c.sub(axis(c.y)));
    }
    if (s < 0) for (const fi of faces) B.F[fi].reverse();
  }
}

// image pixel → texture UV (texture = the garment's bounding box crop, v up)
const uvOf = (crop) => (x, y) => [(x - crop.x) / crop.w, 1 - (y - crop.y) / crop.h];

export function buildPants(body, m, crop, o = {}) {
  const size = o.size ?? 1, M = 2 * Math.round((o.density ?? 1) * 8), K = 4, ease = 0.006;
  const N = Math.round((o.density ?? 1) * 34), PR = Math.max(4, Math.round((o.density ?? 1) * 8));
  const uv = uvOf(crop), B = new Builder();
  // scale (m per image px) from the waist; iterate because the waist height depends on the scale
  // scale (m per photo px) from the hips: flat-lay hip width = half the hip circumference.
  // (Waistbands are often elastic and read narrow, which would shrink everything.)
  const hipY = body.crotchY + 0.09 * body.scale;
  const s = (body.section(hipY).perim / 2 / (m.hipW || m.waistW)) * size;
  const D = o.desc || {}, fit = FIT[D.fit] || FIT.none;
  // rise: the description wins over the photo
  const rise = D.rise ? RISE[D.rise] * body.scale : m.rise * s;
  const waistY = body.crotchY + rise * (o.riseScale ?? 1);
  // hem: description length, else the photo (down to the floor if the photo cuts the legs off)
  const floorHem = body.groundY + 0.015, photoHem = body.crotchY - m.inseam * s;
  const target = D.length && pantsHem(body, D.length);
  const inseam = target != null ? body.crotchY - target : m.cropped ? Math.max(m.inseam * s, body.crotchY - floorHem) : m.inseam * s;
  const hemY = Math.max(floorHem, body.crotchY - inseam * (o.lengthScale ?? 1));
  const tMax = (body.crotchY - hemY) / Math.max(1e-6, body.crotchY - photoHem); // > 1 where the leg continues past the photo

  // pelvis rings: ellipses around the hips, perimeter from the photo (flat width = half the circumference)
  const pelvis = [];
  for (let i = 0; i < PR; i++) {
    const t = i / (PR - 1), y = waistY + (body.crotchY - waistY) * t, sec = body.section(y);
    const want = Math.max(2 * m.pelvisWidth(t) * s * fit.hips, sec.perim * (1 + ease * 3));
    const k = want / ellipsePerim(sec.a, sec.b);
    const span = m.pelvisSpan(t), ring = [];
    for (let j = 0; j < 2 * M; j++) {
      const phi = (2 * Math.PI * j) / (2 * M);
      const p = new THREE.Vector3(sec.cx + sec.a * k * Math.sin(phi), y, sec.cz + sec.b * k * Math.cos(phi));
      // texture: front half runs wearer's right side → left side across the photo; back half mirrors it
      const jj = j / M; // 0 front, 0.5 left, 1 back, 1.5 right
      const sF = jj >= 1.5 ? jj - 1.5 : jj + 0.5; // front: right side (1.5) → front (0) → left (0.5)
      const sB = 1.5 - jj;                          // back: right side (1.5) → back (1) → left (0.5)
      const sx = jj <= 0.5 || jj >= 1.5 ? sF : sB;
      ring.push(B.v(p, uv(span[0] + sx * (span[1] - span[0]), span[2])));
    }
    pelvis.push(ring);
  }
  const pelvisFaces0 = B.F.length; B.tube(pelvis); const pelvisFaces = range(pelvisFaces0, B.F.length);
  // crotch: points from back centre to front centre, dipping slightly, shared by both legs
  const bot = pelvis[PR - 1], F = vec(B, bot[0]), Bk = vec(B, bot[M]), crotch = [];
  for (let i = 1; i < K; i++) { const p = Bk.clone().lerp(F, i / K); p.y -= 0.025 * Math.sin((Math.PI * i) / K); crotch.push(B.v(p, uv(m.apex[0], m.apex[1]))); }
  const legFaces = { L: [], R: [] };
  for (const side of ['L', 'R']) {
    const loop = side === 'L' ? [...bot.slice(0, M + 1), ...crotch] : [...bot.slice(M), bot[0], ...[...crotch].reverse()];
    const n = loop.length, c0 = body.legAt(side, body.crotchY);
    const ang = loop.map((id) => { const p = vec(B, id); return Math.atan2(p.z - c0.z, p.x - c0.x); });
    for (let j = 1; j < n; j++) { while (ang[j] - ang[j - 1] > Math.PI) ang[j] -= 2 * Math.PI; while (ang[j] - ang[j - 1] < -Math.PI) ang[j] += 2 * Math.PI; }
    const dir = Math.sign(ang[n - 1] - ang[0]) || 1;
    // how far the hip loop sits from the leg centre: the top of the leg eases from there to the thigh
    let rTop = 0; for (const id of loop) { const p = vec(B, id); rTop += Math.hypot(p.x - c0.x, p.z - c0.z); } rTop /= n;
    const rings = [loop];
    for (let i = 1; i <= N; i++) {
      const t = i / N, y = body.crotchY + (hemY - body.crotchY) * t, c = body.legAt(side, y), tp = t * tMax;
      const rFloor = body.legR(y) * 1.04 + 0.004;
      // leg shape from the description (flare, bootcut, wide, straight, skinny, joggers), else from the photo
      const rShape = D.leg ? legShape(body, D.leg, y, rFloor) : (2 * m.legWidth(tp) * s) / (2 * Math.PI);
      const rProfile = Math.max(rShape * fit.legs, rFloor);
      const e = Math.min(1, t / 0.2), ease2 = e * e * (3 - 2 * e); // smoothstep over the top fifth of the leg
      const r = Math.max(rProfile, rTop + (rProfile - rTop) * ease2);
      const w = Math.min(1, i / 8), span = m.legSpan(side, tp), ring = [];
      for (let j = 0; j < n; j++) {
        const a = ang[j] * (1 - w) + (ang[0] + (dir * 2 * Math.PI * j) / n) * w;
        const circ = new THREE.Vector3(c.x + r * Math.cos(a), y, c.z + r * Math.sin(a));
        const p = w < 1 ? vec(B, loop[j]).setY(y).lerp(circ, w) : circ;
        // texture: s = 0 at the outer seam, 1 at the inner seam, same on front and back
        const outerA = side === 'L' ? 0 : Math.PI, d = Math.abs(normAng(Math.atan2(p.z - c.z, p.x - c.x) - outerA)) / Math.PI;
        const x = side === 'L' ? span[1] - d * (span[1] - span[0]) : span[0] + d * (span[1] - span[0]);
        ring.push(B.v(p, uv(x, span[2])));
      }
      rings.push(ring);
    }
    const f0 = B.F.length; B.tube(rings); legFaces[side] = range(f0, B.F.length);
  }
  orientOutward(B, [
    { faces: pelvisFaces, axis: (y) => { const s2 = body.section(y); return new THREE.Vector3(s2.cx, y, s2.cz); } },
    { faces: legFaces.L, axis: (y) => body.legAt('L', y) }, { faces: legFaces.R, axis: (y) => body.legAt('R', y) },
  ]);
  return finishMesh(B, { waistY, hemY, scale: s });
}

export function buildSkirt(body, m, crop, o = {}) {
  const size = o.size ?? 1, M = 2 * Math.round((o.density ?? 1) * 10), R = Math.round((o.density ?? 1) * 22), uv = uvOf(crop), B = new Builder();
  const D = o.desc || {}, fit = FIT[D.fit] || FIT.none;
  const waistY = body.hips.y + ({ low: -0.03, mid: 0.03, high: 0.09 }[D.rise] ?? 0.03) * body.scale * (o.riseScale ?? 1);
  const s = (body.section(waistY).perim / 2 / m.waistW) * size;
  const target = D.length && skirtHem(body, D.length);
  const len = (target != null ? waistY - target : m.length * s) * (o.lengthScale ?? 1), rings = [];
  let hipPerim = 0;
  for (let i = 0; i < R; i++) {
    const t = i / (R - 1), y = Math.max(body.groundY + 0.01, waistY - len * t);
    let sec = body.section(Math.max(y, body.crotchY + 0.02));
    if (y < body.crotchY) { // must clear both legs
      const L = body.legAt('L', y), Rr = body.legAt('R', y), r = body.legR(y) * 1.05;
      sec = { cx: (L.x + Rr.x) / 2, cz: (L.z + Rr.z) / 2, a: Math.max(sec.a, (L.x - Rr.x) / 2 + r), b: Math.max(sec.b * 0.9, r), perim: 0 };
      sec.perim = ellipsePerim(sec.a, sec.b);
    }
    if (y > body.crotchY) hipPerim = Math.max(hipPerim, sec.perim);
    // silhouette from the description (pencil / A-line / full), else from the photo
    const shaped = D.skirt ? Math.max(hipPerim, sec.perim) * 1.03 * ({ pencil: 1, aline: 1 + 0.8 * t, full: 1 + 1.4 * t * (2 - t) }[D.skirt]) : 2 * m.width(t) * s;
    const want = Math.max(shaped * fit.hips, sec.perim * 1.02), k = want / ellipsePerim(sec.a, sec.b), span = m.span(t), ring = [];
    for (let j = 0; j < 2 * M; j++) {
      const phi = (2 * Math.PI * j) / (2 * M), jj = j / M;
      const sx = jj <= 0.5 || jj >= 1.5 ? (jj >= 1.5 ? jj - 1.5 : jj + 0.5) : 1.5 - jj;
      ring.push(B.v(new THREE.Vector3(sec.cx + sec.a * k * Math.sin(phi), y, sec.cz + sec.b * k * Math.cos(phi)), uv(span[0] + sx * (span[1] - span[0]), span[2])));
    }
    rings.push(ring);
  }
  B.tube(rings);
  orientOutward(B, [{ faces: range(0, B.F.length), axis: (y) => new THREE.Vector3(body.hips.x, y, body.hips.z) }]);
  return finishMesh(B, { waistY, hemY: waistY - len, scale: s });
}

export function buildTop(body, m, crop, o = {}) {
  const size = o.size ?? 1, d = o.density ?? 1, M = 2 * Math.round(d * 10), uv = uvOf(crop), B = new Builder();
  const chestY = body.arm.L.y - 0.12, shoulderY = body.arm.L.y + 0.035, neckY = body.neck.y + 0.01;
  const s = (body.section(chestY, 0.2).perim / 2 / m.torsoW) * size * 1.04;
  const D = o.desc || {}, fit = FIT[D.fit] || FIT.none;
  const topHem = { crop: body.hips.y + 0.03 * body.scale, long: body.crotchY - 0.06 * body.scale }[D.topLen];
  const photoLen = m.length * s, descLen = topHem != null ? shoulderY - topHem : photoLen;
  const hemY = Math.max(body.crotchY - 0.12, shoulderY - (D.topLen === 'long' ? Math.max(photoLen, descLen) : descLen) * (o.lengthScale ?? 1));
  const NR = Math.max(6, Math.round(d * 16)), rings = [];
  const shoulderHalf = Math.abs(body.arm.L.x - body.hips.x) + 0.02;
  // torso: hem → armpit (photo widths), armpit → shoulder (flattening toward the shoulder line), then the neck opening
  const levels = [];
  for (let i = 0; i < NR; i++) levels.push({ y: hemY + (chestY - hemY) * (i / (NR - 1)), kind: 'torso' });
  for (let i = 1; i <= 3; i++) levels.push({ y: chestY + (shoulderY - chestY) * (i / 3), kind: 'shoulder', t: i / 3 });
  levels.push({ y: neckY, kind: 'neck' });
  const chest = body.section(chestY, 0.2);
  for (const L of levels) {
    let cx = chest.cx, cz = chest.cz, a, b;
    if (L.kind === 'torso') {
      const sec = body.section(L.y, 0.2), tImg = 1 - (L.y - hemY) / Math.max(1e-6, shoulderY - hemY);
      const want = Math.max(2 * m.width(Math.min(0.98, Math.max(0.3, tImg))) * s * fit.hips, sec.perim * 1.04);
      const k = want / ellipsePerim(sec.a, sec.b); a = sec.a * k; b = sec.b * k; cx = sec.cx; cz = sec.cz;
    } else if (L.kind === 'shoulder') { a = chest.a * 1.08 + (shoulderHalf - chest.a * 1.08) * L.t; b = chest.b * 1.1 * (1 - 0.45 * L.t); }
    else { a = 0.065 * body.scale; b = 0.06 * body.scale; }
    const tImg = Math.min(1, Math.max(0, 1 - (L.y - hemY) / Math.max(1e-6, neckY - hemY))), span = m.span(tImg), ring = [];
    for (let j = 0; j < 2 * M; j++) {
      const phi = (2 * Math.PI * j) / (2 * M), jj = j / M;
      const sx = jj <= 0.5 || jj >= 1.5 ? (jj >= 1.5 ? jj - 1.5 : jj + 0.5) : 1.5 - jj;
      const x = m.band[0] + sx * (m.band[1] - m.band[0]);
      ring.push(B.v(new THREE.Vector3(cx + a * Math.sin(phi), L.y, cz + b * Math.cos(phi)), uv(x, span[2])));
    }
    rings.push(ring);
  }
  B.tube(rings);
  const torsoFaces = range(0, B.F.length);
  // sleeves: tubes along the (horizontal, T-pose) arms, starting inside the shoulder
  const groups = [{ faces: torsoFaces, axis: (y) => new THREE.Vector3(chest.cx, y, chest.cz) }];
  // sleeve length as a share of the arm: the photo's sleeve reach past the torso, in metres, over shoulder → wrist
  const armLen = body.hand.L.distanceTo(body.arm.L);
  const reach = o.sleeve ?? (D.sleeve ? SLEEVE[D.sleeve] : Math.min(1, (m.sleeveReach * s) / armLen + 0.08));
  if (reach > 0.05) for (const side of ['L', 'R']) {
    const a0 = body.arm[side], hand = body.hand[side], dirX = Math.sign(a0.x - body.hips.x);
    const start = new THREE.Vector3(body.hips.x + dirX * (shoulderHalf - 0.05), a0.y, a0.z), end = start.clone().lerp(hand, reach);
    const S = Math.max(4, Math.round(d * 14 * reach)), n = Math.round(d * 12), rings2 = [];
    const thick = (m.sleeveThick || m.torsoW * 0.35) * s; // flat-lay sleeve height = half circumference
    for (let i = 0; i <= S; i++) {
      const t = i / S, c = start.clone().lerp(end, t), along = (c.x - body.arm[side].x) / (hand.x - body.arm[side].x);
      const r = Math.max(thick * (1 - 0.25 * t) / Math.PI * fit.legs, body.armR(Math.max(0, along)) * 1.08 + 0.004), ring = [];
      const sp = m.sleeveSpan(side, t);
      for (let j = 0; j < n; j++) {
        const a = (2 * Math.PI * j) / n, p = new THREE.Vector3(c.x, c.y + r * Math.cos(a), c.z + r * Math.sin(a));
        const sxx = Math.abs(normAng(a)) / Math.PI; // 0 top seam → 1 underarm, same front and back
        ring.push(B.v(p, uv(sp[2], sp[0] + sxx * (sp[1] - sp[0]))));
      }
      rings2.push(ring);
    }
    const f0 = B.F.length; B.tube(rings2);
    groups.push({ faces: range(f0, B.F.length), axis: (y) => null, sleeve: { start, end } });
  }
  // sleeves point outward from their own axis (x), torso from its centre
  for (const g of groups) if (g.sleeve) g.axis = null;
  orientOutward(B, groups.filter((g) => !g.sleeve));
  for (const g of groups.filter((x) => x.sleeve)) {
    let sgn = 0; for (const fi of g.faces) { const f = B.F[fi]; const P = (i) => vec(B, f[i]); const nrm = new THREE.Vector3().crossVectors(P(1).sub(P(0)), P(2).sub(P(0))); const c = P(0).add(P(2)).multiplyScalar(0.5); sgn += nrm.y * (c.y - g.sleeve.start.y) + nrm.z * (c.z - g.sleeve.start.z); }
    if (sgn < 0) for (const fi of g.faces) B.F[fi].reverse();
  }
  return finishMesh(B, { hemY, scale: s });
}

/* ---------- description presets ---------- */

const FIT = { none: { hips: 1, legs: 1 }, tight: { hips: 1, legs: 0.97 }, fitted: { hips: 1, legs: 1 }, relaxed: { hips: 1.06, legs: 1.18 }, baggy: { hips: 1.12, legs: 1.38 } };
const RISE = { low: 0.13, mid: 0.18, high: 0.25 }; // crotch → waistband, metres on a 1.66 m body
const SLEEVE = { none: 0, cap: 0.1, short: 0.28, elbow: 0.5, threequarter: 0.72, long: 1 };

function pantsHem(body, len) {
  const ankle = body.ft.L.y, knee = body.kn.L.y;
  return { microshorts: body.crotchY - 0.035 * body.scale, shorts: body.crotchY - 0.12 * body.scale, knee: knee - 0.02, calf: (knee + ankle) / 2,
    ankle: ankle + 0.05 * body.scale, full: body.groundY + 0.03, floor: body.groundY + 0.012 }[len] ?? null;
}
function skirtHem(body, len) {
  const ankle = body.ft.L.y, knee = body.kn.L.y;
  return { micro: body.crotchY - 0.02, mini: body.crotchY - 0.1 * body.scale, shorts: body.crotchY - 0.1 * body.scale, knee: knee, calf: (knee + ankle) / 2 - 0.02,
    midi: (knee + ankle) / 2 - 0.02, ankle: ankle + 0.04, maxi: body.groundY + 0.04, full: body.groundY + 0.04, floor: body.groundY + 0.015 }[len] ?? null;
}
// leg radius for a named cut, from the anatomical leg (rFloor = leg + ease at this height)
function legShape(body, cut, y, rFloor) {
  const knee = body.kn.L.y, u = (body.crotchY - y) / (body.crotchY - body.ft.L.y); // 0 crotch → 1 ankle
  const rAt = (yy) => body.legR(yy) * 1.04 + 0.004, sm = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
  const rKnee = rAt(knee), rThigh = rAt(body.crotchY), rMid = rAt(body.crotchY - 0.25 * (body.crotchY - body.ft.L.y));
  switch (cut) {
    case 'skinny': return rFloor;
    case 'straight': return Math.max(rFloor, rMid);
    case 'bootcut': return Math.max(rFloor, rKnee * (1 + 0.4 * sm((u - 0.5) / 0.5)));
    case 'flare': return Math.max(rFloor, rKnee * (1 + 1.15 * sm((u - 0.42) / 0.6)));
    case 'wide': return Math.max(rFloor, rThigh * 1.12);
    case 'tapered': return u > 0.93 ? rAt(body.ft.L.y) * 1.02 : Math.max(rFloor * 1.12, rFloor + (rAt(body.ft.L.y) - rFloor) * sm((u - 0.6) / 0.33));
    default: return rFloor;
  }
}

const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);
const vec = (B, i) => new THREE.Vector3(B.P[i * 3], B.P[i * 3 + 1], B.P[i * 3 + 2]);
const normAng = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

function finishMesh(B, info) {
  return { pos: Float64Array.from(B.P), uv: Float32Array.from(B.UV), faces: B.F, info };
}

/* ======================= 5. outputs ======================= */

// three.js geometry (triangulated quads) for preview / skinning
export function toGeometry(g) {
  const idx = []; for (const f of g.faces) for (let k = 1; k + 1 < f.length; k++) idx.push(f[0], f[k], f[k + 1]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(Float32Array.from(g.pos), 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.uv, 2));
  geo.setIndex(idx); geo.computeVertexNormals(); geo.computeBoundingBox(); geo.computeBoundingSphere();
  return geo;
}

export function toOBJ(g, name) {
  const f6 = (x) => x.toFixed(6), L = [`# Image to Model · ${g.faces.length} quads`, `mtllib ${name}.mtl`, `o ${name}`];
  const n = g.pos.length / 3;
  for (let i = 0; i < n; i++) L.push(`v ${f6(g.pos[i * 3])} ${f6(g.pos[i * 3 + 1])} ${f6(g.pos[i * 3 + 2])}`);
  for (let i = 0; i < n; i++) L.push(`vt ${f6(g.uv[i * 2])} ${f6(g.uv[i * 2 + 1])}`);
  L.push(`usemtl ${name}`, 's 1');
  for (const f of g.faces) L.push('f ' + f.map((v) => `${v + 1}/${v + 1}`).join(' '));
  const mtl = [`newmtl ${name}`, 'Ka 0 0 0', 'Kd 1 1 1', 'Ks 0.05 0.05 0.05', 'Ns 20', 'd 1', 'illum 2', `map_Kd ${name}_texture.png`, ''].join('\n');
  return { obj: L.join('\n') + '\n', mtl };
}

// crop the photo to the garment and paint the background with nearby garment colours (no halos at the edges)
export function garmentTexture(srcCanvas, cut, pad = 0.02) {
  const b = cut.bbox, W = cut.w, H = cut.h, p = Math.round(Math.max(b.x1 - b.x0, b.y1 - b.y0) * pad);
  const crop = { x: Math.max(0, b.x0 - p), y: Math.max(0, b.y0 - p) };
  crop.w = Math.min(W, b.x1 + p + 1) - crop.x; crop.h = Math.min(H, b.y1 + p + 1) - crop.y;
  const c = document.createElement('canvas'); c.width = crop.w; c.height = crop.h;
  const g = c.getContext('2d'); g.drawImage(srcCanvas, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
  const img = g.getImageData(0, 0, crop.w, crop.h), d = img.data, known = new Uint8Array(crop.w * crop.h);
  for (let y = 0; y < crop.h; y++) for (let x = 0; x < crop.w; x++) known[y * crop.w + x] = cut.mask[(y + crop.y) * W + x + crop.x];
  // shrink the known area by a pixel (edge pixels are mixed with the background), then grow colours outward
  const k2 = known.slice(); for (let y = 1; y < crop.h - 1; y++) for (let x = 1; x < crop.w - 1; x++) { const i = y * crop.w + x; if (known[i] && (!known[i - 1] || !known[i + 1] || !known[i - crop.w] || !known[i + crop.w])) k2[i] = 0; }
  let cur = k2;
  for (let pass = 0; pass < 64; pass++) {
    const nx = cur.slice(); let changed = 0;
    for (let y = 0; y < crop.h; y++) for (let x = 0; x < crop.w; x++) {
      const i = y * crop.w + x; if (cur[i]) continue;
      let r = 0, gg = 0, bb = 0, c2 = 0;
      for (const j of [x > 0 ? i - 1 : -1, x < crop.w - 1 ? i + 1 : -1, y > 0 ? i - crop.w : -1, y < crop.h - 1 ? i + crop.w : -1]) if (j >= 0 && cur[j]) { r += d[j * 4]; gg += d[j * 4 + 1]; bb += d[j * 4 + 2]; c2++; }
      if (c2) { d[i * 4] = r / c2; d[i * 4 + 1] = gg / c2; d[i * 4 + 2] = bb / c2; d[i * 4 + 3] = 255; nx[i] = 1; changed++; }
    }
    cur = nx; if (!changed) break;
  }
  g.putImageData(img, 0, 0);
  return { canvas: c, crop };
}
