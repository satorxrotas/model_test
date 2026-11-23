// Garment templates: flat-lay front views drawn to real proportions (metres) for a women's or men's body,
// with fabric and construction details painted on. They go through the same cut-out → measure → build
// steps as a photo, so descriptions and sliders work on them too.

export const TEMPLATES = {
  pants: { label: 'Pants', type: 'pants', color: { f: '#3d5a80', m: '#2e3d55' }, fabric: 'twill' },
  shorts: { label: 'Shorts', type: 'pants', color: { f: '#6b88a8', m: '#8a7f6a' }, fabric: 'twill' },
  skirt: { label: 'Skirt', type: 'skirt', color: { f: '#1f1f22', m: '#3c4a3a' }, fabric: 'twill' },
  tee: { label: 'T-shirt', type: 'top', color: { f: '#ecebe6', m: '#ecebe6' }, fabric: 'knit', desc: { sleeve: 'short' } },
  longsleeve: { label: 'Long sleeve', type: 'top', color: { f: '#9a9690', m: '#3a3a3e' }, fabric: 'knit', desc: { sleeve: 'long' } },
  hoodie: { label: 'Hoodie', type: 'top', color: { f: '#b9b5ae', m: '#4a4d52' }, fabric: 'fleece', desc: { sleeve: 'long', hood: true } },
};

// flat measurements (half circumference across the front), metres, taken from the body the garment is for.
// Widths the builder sizes from (hips for pants, waist for skirts, chest for tops) match the body exactly, so the
// drawing is 1:1 in metres; style lives in the other widths and lengths.
function specFor(kind, sex, body) {
  const m = sex === 'm', sc = body.scale, crotch = body.crotchY, knee = body.kn.L.y, ankle = body.ft.L.y, ground = body.groundY ?? 0;
  const legFlat = (y) => Math.PI * body.legR(y); // half circumference
  if (kind === 'pants' || kind === 'shorts') {
    const rise = (m ? 0.21 : 0.24) * sc, hip = body.section(crotch + 0.09 * sc).perim / 2;
    const waist = Math.max(hip * 0.74, (body.section(crotch + rise - 0.02).perim / 2) * 1.04);
    const ease = m ? 1.28 : 1.15, thigh = legFlat(crotch - 0.04) * ease, kn = legFlat(knee) * ease * (m ? 1.22 : 1.18);
    if (kind === 'shorts') { const inseam = (crotch - knee) * (m ? 0.5 : 0.34); return { waist, hip, hipY: rise * 0.32, rise, thigh: thigh * 1.08, knee: thigh * 1.1, hem: thigh * 1.12, inseam, spread: 0.01 }; }
    return { waist, hip, hipY: rise * 0.32, rise, thigh, knee: kn, hem: kn * 0.98, inseam: crotch - ground - 0.025, spread: m ? 0.015 : 0.02 };
  }
  if (kind === 'skirt') {
    const waistY = body.hips.y + 0.03 * sc, hipAt = crotch + 0.09 * sc, waist = (body.section(waistY).perim / 2) * 1.02, hip = Math.max(waist * 1.1, (body.section(hipAt).perim / 2) * 1.05);
    const len = waistY - (m ? knee - 0.03 * sc : knee + 0.09 * sc);
    return { waist, hip, hipY: waistY - hipAt, hem: hip * (m ? 1.12 : 1.24), len };
  }
  const shoulderY = body.arm.L.y + 0.035, chestY = body.arm.L.y - 0.12;
  const chest = (body.section(chestY, 0.2).perim / 2) * 1.04, shoulderHalf = Math.abs(body.arm.L.x - body.hips.x) + 0.02;
  const armLen = body.hand.L.distanceTo(body.arm.L), armFlat = Math.PI * body.armR(0), cuffFlat = Math.PI * body.armR(1);
  const hemAt = { tee: m ? crotch + 0.0 * sc : body.hips.y - 0.03 * sc, longsleeve: m ? crotch + 0.0 * sc : body.hips.y - 0.04 * sc, hoodie: m ? crotch + 0.02 * sc : body.hips.y - 0.06 * sc }[kind];
  const shoulder = Math.max(shoulderHalf + (m ? 0.02 : 0.01) + (kind === 'hoodie' ? 0.03 : 0), chest / 2 + 0.01);
  const reachStart = shoulderHalf - 0.05, sleeveOf = (frac) => Math.max(0.05, reachStart + frac * armLen - shoulder);
  const base = { neck: (m ? 0.095 : 0.085) * sc * (kind === 'hoodie' ? 1.15 : 1), neckD: (m ? 0.085 : 0.075) * sc, shoulder, chest, len: shoulderY - hemAt + 0.045, arm: 0.17 * sc, angle: 0.07 };
  const sh = kind === 'hoodie' ? 0.96 : 1;
  if (kind === 'tee') return { ...base, waist: chest * (m ? 1 : 0.97), hemW: chest * (m ? 1 : 1.01), sleeve: sleeveOf(m ? 0.34 : 0.28), open: armFlat * 1.45 };
  if (kind === 'longsleeve') return { ...base, waist: chest * (m ? 1 : 0.97), hemW: chest, sleeve: sleeveOf(1.02), open: armFlat * 1.3, cuff: cuffFlat * 1.3 };
  return { ...base, waist: chest, hemW: chest * sh, sleeve: sleeveOf(1.0), open: armFlat * 1.5, cuff: cuffFlat * 1.35, band: 0.065 * sc };
}

const lerp = (a, b, t) => a + (b - a) * t;
function shade(hex, k) { // k > 0 lighter, < 0 darker
  const n = parseInt(hex.slice(1), 16), c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(k > 0 ? v + (255 - v) * k : v * (1 + k)));
  return `rgb(${c.join(',')})`;
}
const lum = (hex) => { const n = parseInt(hex.slice(1), 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; };

/* ---------- silhouettes: arrays of [x, y] in metres, x from the centre, y down from the top ---------- */

function pantsOutline(S) {
  const half = S.hip / 2, w0 = half + 0.015, xc0 = w0 / 2 + 0.004, N = 24, L = [], R = [];
  const width = (v) => { const u = v / Math.max(0.001, S.inseam); return u < 0.1 ? lerp(w0, S.thigh, u / 0.1) : u < 0.5 ? lerp(S.thigh, S.knee, (u - 0.1) / 0.4) : lerp(S.knee, S.hem, (u - 0.5) / 0.5); };
  for (let i = 0; i <= N; i++) {
    const v = (S.inseam * i) / N, w = width(v), inner = 0.004 + 0.018 * Math.min(1, Math.sqrt(v / 0.06)) + S.spread * (v / 0.8);
    L.push([inner, S.rise + v, inner + w]);
  }
  const pts = [[-S.waist / 2, 0]];
  // side seam: waist → hip (curved) → outer leg
  for (let i = 1; i <= 6; i++) { const t = i / 6; pts.push([-lerp(S.waist / 2, half, Math.sin((t * Math.PI) / 2)), S.hipY * t]); }
  pts.push([-lerp(half, L[0][2], 0.5), lerp(S.hipY, S.rise, 0.5)]);
  for (const p of L) pts.push([-p[2], p[1]]);
  for (let i = L.length - 1; i >= 0; i--) pts.push([-Math.max(0.003, L[i][0]), L[i][1]]);
  for (const p of L) pts.push([Math.max(0.003, p[0]), p[1]]);
  for (let i = L.length - 1; i >= 0; i--) pts.push([L[i][2], L[i][1]]);
  pts.push([lerp(half, L[0][2], 0.5), lerp(S.hipY, S.rise, 0.5)]);
  for (let i = 6; i >= 1; i--) { const t = i / 6; pts.push([lerp(S.waist / 2, half, Math.sin((t * Math.PI) / 2)), S.hipY * t]); }
  pts.push([S.waist / 2, 0]);
  return { pts, legs: L };
}

function skirtOutline(S) {
  const pts = [[-S.waist / 2, 0]];
  for (let i = 1; i <= 8; i++) { const t = i / 8; pts.push([-lerp(S.waist / 2, S.hip / 2, Math.sin((t * Math.PI) / 2)), S.hipY * t]); }
  for (let i = 1; i <= 8; i++) { const t = i / 8; pts.push([-lerp(S.hip / 2, S.hem / 2, t), lerp(S.hipY, S.len, t) + 0.012 * t * t]); }
  for (let i = 8; i >= 0; i--) { const x = (S.hem / 2) * (i / 8 * 2 - 1); pts.push([x, S.len + 0.012 * (1 - 0.6 * (1 - Math.abs(x) / (S.hem / 2)))]); }
  const r = pts.slice(1, pts.length - 9).map(([x, y]) => [-x, y]).reverse();
  return { pts: [...pts, ...r] };
}

function topOutline(S) {
  const sh = [S.shoulder, 0.045], dir = [Math.cos(S.angle), Math.sin(S.angle)], perp = [-dir[1], dir[0]];
  const cuff = S.cuff ?? S.open, end = [sh[0] + dir[0] * S.sleeve, sh[1] + dir[1] * S.sleeve];
  const endB = [end[0] + perp[0] * cuff, end[1] + perp[1] * cuff];
  const pit = [S.chest / 2, sh[1] + S.arm];
  const side = [];
  for (let i = 1; i <= 8; i++) { const t = i / 8, y = lerp(pit[1], S.len, t), w = t < 0.5 ? lerp(S.chest, S.waist, t / 0.5) : lerp(S.waist, S.hemW, (t - 0.5) / 0.5); side.push([w / 2, y]); }
  const right = [[S.neck, 0], sh, end, endB, pit, ...side];
  const neck = []; for (let i = 0; i <= 10; i++) { const a = Math.PI * (i / 10); neck.push([S.neck * Math.cos(a), S.neckD * Math.sin(a) * 0.9]); }
  const left = right.map(([x, y]) => [-x, y]).reverse();
  return { pts: [...left.slice(0, -1), ...neck.reverse(), ...right.slice(1)].concat([]), sh, end, endB, pit, dir, perp };
}

/* ---------- drawing ---------- */

export function drawTemplate(kind, sex = 'f', body, color, P = 900) {
  const T = TEMPLATES[kind], S = specFor(kind, sex, body);
  color = color || T.color[sex === 'm' ? 'm' : 'f'];
  const shape = T.type === 'pants' ? pantsOutline(S) : T.type === 'skirt' ? skirtOutline(S) : topOutline(S);
  // fit the outline in the canvas
  let x0 = Infinity, x1 = -Infinity, y1 = -Infinity, y0 = Infinity;
  for (const [x, y] of shape.pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const pad = 0.05, W = Math.ceil((x1 - x0 + 2 * pad) * P), H = Math.ceil((y1 - y0 + 2 * pad) * P);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), X = (x) => (x - x0 + pad) * P, Y = (y) => (y - y0 + pad) * P;
  const path = new Path2D(); shape.pts.forEach(([x, y], i) => (i ? path.lineTo(X(x), Y(y)) : path.moveTo(X(x), Y(y)))); path.closePath();
  g.save(); g.clip(path);
  g.fillStyle = color; g.fillRect(0, 0, W, H);
  fabric(g, W, H, T.fabric, color, P);
  // soft shading toward the edges reads as volume in the flat lay
  const dark = lum(color) > 0.6 ? 0.1 : 0.18;
  g.lineJoin = 'round'; g.strokeStyle = `rgba(0,0,0,${dark})`; g.lineWidth = 0.02 * P; g.filter = `blur(${Math.round(0.012 * P)}px)`; g.stroke(path); g.filter = 'none';
  const ctx = { g, X, Y, P, S, color, shape, sex, stitch: T.fabric === 'twill' && kind !== 'skirt' ? '#c8894a' : shade(color, lum(color) > 0.55 ? -0.25 : 0.22) };
  ({ pants: detailPants, shorts: detailPants, skirt: detailSkirt, tee: detailTop, longsleeve: detailTop, hoodie: detailHoodie })[kind](ctx, kind);
  g.restore();
  return c;
}

// small preview silhouette for the picker
export function templateIcon(kind, sex, body, color = '#d9d6cf') {
  const T = TEMPLATES[kind], S = specFor(kind, sex, body);
  const shape = T.type === 'pants' ? pantsOutline(S) : T.type === 'skirt' ? skirtOutline(S) : topOutline(S);
  let x0 = Infinity, x1 = -Infinity, y1 = -Infinity, y0 = Infinity;
  for (const [x, y] of shape.pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const k = 52 / Math.max(x1 - x0, y1 - y0), ox = (60 - (x1 - x0) * k) / 2, oy = (60 - (y1 - y0) * k) / 2;
  const d = shape.pts.map(([x, y], i) => `${i ? 'L' : 'M'}${(ox + (x - x0) * k).toFixed(1)} ${(oy + (y - y0) * k).toFixed(1)}`).join('') + 'Z';
  return `<svg viewBox="0 0 60 60" width="40" height="40" aria-hidden="true"><path d="${d}" fill="${color}"/></svg>`;
}

function fabric(g, W, H, kind, color, P) {
  const img = g.getImageData(0, 0, W, H), d = img.data;
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const amp = kind === 'fleece' ? 10 : kind === 'knit' ? 7 : 9, pitch = Math.max(2, Math.round(0.004 * P));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    let n = (rnd() - 0.5) * amp;
    if (kind === 'twill') n += ((x + y) % (pitch * 2) < pitch ? 1 : -1) * 4; // diagonal twill
    else if (kind === 'knit') n += (x % pitch < pitch / 2 ? 1.5 : -1.5);
    d[i] = Math.max(0, Math.min(255, d[i] + n)); d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n)); d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  g.putImageData(img, 0, 0);
}

const line = (ctx, pts, { w = 0.003, dash = true, color, alpha = 0.9 } = {}) => {
  const { g, X, Y, P } = ctx; g.save(); g.globalAlpha = alpha; g.strokeStyle = color || ctx.stitch; g.lineWidth = Math.max(1, w * P);
  g.setLineDash(dash ? [0.008 * P, 0.005 * P] : []); g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y)))); g.stroke(); g.restore();
};
const fold = (ctx, pts, w = 0.004) => line(ctx, pts, { w, dash: false, color: 'rgba(0,0,0,0.28)', alpha: 1 });
const offsetPoly = (pts, dy) => pts.map(([x, y]) => [x, y + dy]);

function detailPants(ctx, kind) {
  const { S, shape, g, X, Y, P } = ctx, band = 0.045;
  // waistband
  fold(ctx, [[-S.waist / 2 - 0.01, band], [S.waist / 2 + 0.01, band]]);
  line(ctx, [[-S.waist / 2, 0.008], [S.waist / 2, 0.008]]); line(ctx, [[-S.waist / 2 - 0.005, band - 0.008], [S.waist / 2 + 0.005, band - 0.008]]);
  // belt loops
  for (const x of [-0.6, -0.25, 0.25, 0.6]) { g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(X((x * S.waist) / 2 - 0.006), Y(-0.002), 0.012 * P, (band + 0.01) * P); line(ctx, [[(x * S.waist) / 2 - 0.004, 0], [(x * S.waist) / 2 - 0.004, band + 0.006]], { w: 0.002 }); }
  // button + fly
  g.fillStyle = shade('#b08a50', -0.1); g.beginPath(); g.arc(X(0), Y(band / 2), 0.009 * P, 0, 7); g.fill();
  const fly = S.rise * 0.62; line(ctx, [[0.035, band], [0.035, fly - 0.03], [0.02, fly], [0, fly + 0.01]]); fold(ctx, [[0, band], [0, fly + 0.01]], 0.003);
  // front pockets
  for (const s of [-1, 1]) {
    const px = (S.waist / 2) * s, pts = []; for (let i = 0; i <= 10; i++) { const t = i / 10; pts.push([lerp(px * 0.62, px + s * 0.012, Math.sin((t * Math.PI) / 2)), band + t * 0.075]); }
    fold(ctx, pts, 0.003); line(ctx, offsetPoly(pts, 0.008), { w: 0.002 });
  }
  // inseam/outseam stitching and hems
  for (const s of [-1, 1]) {
    const L = shape.legs; line(ctx, L.map((p) => [s * (p[2] - 0.006), p[1]]), { w: 0.002, alpha: 0.5 });
    const last = L[L.length - 1], hy = last[1] - (kind === 'shorts' ? 0.025 : 0.02);
    line(ctx, [[s * (last[0] + 0.004), hy], [s * (last[2] - 0.004), hy]]);
    if (kind === 'shorts') fold(ctx, [[s * last[0], hy - 0.012], [s * last[2], hy - 0.012]], 0.003);
    // a couple of soft creases at the knee / crotch
    if (kind === 'pants') for (const v of [0.48, 0.52]) { const p = L[Math.round(v * (L.length - 1))]; g.save(); g.globalAlpha = 0.5; fold(ctx, [[s * (p[0] + 0.03), p[1]], [s * (p[2] - 0.04), p[1] + 0.012]], 0.002); g.restore(); }
  }
}

function detailSkirt(ctx) {
  const { S, g, X, Y, P } = ctx, band = 0.04;
  fold(ctx, [[-S.waist / 2 - 0.01, band], [S.waist / 2 + 0.01, band]]);
  line(ctx, [[-S.waist / 2, band - 0.008], [S.waist / 2, band - 0.008]]);
  line(ctx, [[-S.hem / 2, S.len - 0.02], [S.hem / 2, S.len - 0.02]]);
  // soft vertical folds
  g.save(); g.globalAlpha = 0.35; for (const x of [-0.3, 0.05, 0.35]) fold(ctx, [[x * S.hip / 2, S.hipY + 0.05], [x * S.hem / 2 * 1.1, S.len]], 0.006); g.restore();
  g.fillStyle = 'rgba(0,0,0,0.18)'; g.beginPath(); g.arc(X(S.waist / 2 - 0.03), Y(band / 2), 0.006 * P, 0, 7); g.fill();
}

function detailTop(ctx, kind) {
  const { S, shape, g, X, Y, P } = ctx;
  // neck rib
  const neck = []; for (let i = 0; i <= 20; i++) { const a = Math.PI * (i / 20); neck.push([S.neck * Math.cos(a), S.neckD * Math.sin(a) * 0.9]); }
  g.save(); g.lineWidth = 0.022 * P; g.strokeStyle = shade(ctx.color, lum(ctx.color) > 0.55 ? -0.06 : 0.06); g.beginPath(); neck.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y)))); g.stroke(); g.restore();
  line(ctx, neck.map(([x, y]) => [x * 1.13, y * 1.13 + 0.012]), { w: 0.002 });
  // shoulder seams
  for (const s of [-1, 1]) fold(ctx, [[s * S.neck, 0], [s * shape.sh[0], shape.sh[1]]], 0.003);
  // sleeve hems / cuffs
  const { end, endB, dir } = shape, cuffLen = kind === 'tee' ? 0.022 : 0.06;
  for (const s of [-1, 1]) {
    const a = [end[0] - dir[0] * cuffLen, end[1] - dir[1] * cuffLen], b = [endB[0] - dir[0] * cuffLen, endB[1] - dir[1] * cuffLen];
    if (kind === 'tee') line(ctx, [[s * a[0], a[1]], [s * b[0], b[1]]]);
    else { fold(ctx, [[s * a[0], a[1]], [s * b[0], b[1]]], 0.003); for (let k = 1; k < 10; k++) { const t = k / 10; g.save(); g.globalAlpha = 0.4; fold(ctx, [[s * lerp(a[0], end[0], 0), lerp(a[1], b[1], t) - 0 ], [s * (end[0] + (endB[0] - end[0]) * t), end[1] + (endB[1] - end[1]) * t]], 0.0015); g.restore(); } }
  }
  // armhole seams
  for (const s of [-1, 1]) fold(ctx, [[s * shape.sh[0], shape.sh[1]], [s * (shape.pit[0] + 0.005), shape.pit[1]]], 0.0025);
  // hem
  line(ctx, [[-S.hemW / 2, S.len - 0.022], [S.hemW / 2, S.len - 0.022]]);
}

function detailHoodie(ctx) {
  const { S, shape, g, X, Y, P } = ctx;
  detailTop(ctx, 'hoodie');
  // ribbed hem band
  fold(ctx, [[-S.hemW / 2, S.len - S.band], [S.hemW / 2, S.len - S.band]], 0.004);
  g.save(); g.globalAlpha = 0.35; for (let x = -S.hemW / 2; x < S.hemW / 2; x += 0.008) fold(ctx, [[x, S.len - S.band + 0.004], [x, S.len]], 0.0015); g.restore();
  // kangaroo pocket
  const top = S.len - S.band - 0.2, bot = S.len - S.band - 0.005, wt = S.chest * 0.36, wb = S.chest * 0.62;
  const pocket = [[-wt / 2, top], [wt / 2, top], [wb / 2, bot], [-wb / 2, bot], [-wt / 2, top]];
  g.save(); g.fillStyle = 'rgba(0,0,0,0.05)'; g.beginPath(); pocket.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y)))); g.fill(); g.restore();
  fold(ctx, pocket, 0.0035); line(ctx, offsetPoly(pocket.slice(0, 2), 0.01), { w: 0.002 });
  for (const s of [-1, 1]) { const o = []; for (let i = 0; i <= 10; i++) { const t = i / 10; o.push([s * (wt / 2 + (wb / 2 - wt / 2) * t - 0.03 * Math.sin(t * Math.PI)), top + t * (bot - top) * 0.75]); } fold(ctx, o, 0.004); }
  // drawstrings with eyelets
  for (const s of [-1, 1]) {
    const x = s * S.neck * 0.45, y0 = S.neckD * 0.75;
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.beginPath(); g.arc(X(x), Y(y0), 0.006 * P, 0, 7); g.fill();
    g.save(); g.strokeStyle = shade(ctx.color, lum(ctx.color) > 0.55 ? -0.12 : 0.35); g.lineWidth = 0.008 * P; g.lineCap = 'round';
    g.beginPath(); g.moveTo(X(x), Y(y0)); g.quadraticCurveTo(X(x + s * 0.01), Y(y0 + 0.1), X(x - s * 0.004), Y(y0 + 0.2)); g.stroke(); g.restore();
    g.fillStyle = shade(ctx.color, lum(ctx.color) > 0.55 ? -0.4 : 0.6); g.fillRect(X(x - s * 0.004) - 0.005 * P, Y(y0 + 0.2), 0.01 * P, 0.03 * P);
  }
  // hood seam around the neck
  const nk = []; for (let i = 0; i <= 20; i++) { const a = Math.PI * (i / 20); nk.push([S.neck * 1.05 * Math.cos(a), S.neckD * 1.02 * Math.sin(a)]); }
  fold(ctx, nk, 0.004);
}
