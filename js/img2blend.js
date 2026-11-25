// Image to Blend: photo → generated model → .blend written in the browser (see blendfile.js / blendscene.js).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { bonesByName, snapshotPose, applyPose, sampleBody, fitGarment } from './autoskin.js';
import { cutout, guessType, measurePants, measureTube, bodyInfo, buildPants, buildSkirt, buildTop, toGeometry, garmentTexture } from './garments.js';
import { parseDescription, SUGGESTIONS } from './describe.js';
import { FIGURES, loadFigure } from './bodies.js';
import { TEMPLATES, drawTemplate, templateIcon } from './templates.js';
import { inflate, logo, picture, yUpToZUp, cornerUV } from './blendgen.js';
import { BlendScene } from './blendscene.js';
import { addArmature, addAction, setAction, skeletonBones, bakeClip, addPose, addObjectAction } from './blendrig.js';
import { estimateDepth, resampleDepth } from './depth.js';
import { reconstruct, fillTexture } from './scene3d.js';
import { buildMotions, POSES } from './motionlib.js';

const $ = (s) => document.querySelector(s);
const status = (m) => { $('#status').textContent = m; };
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const MODES = {
  object: { hint: 'Product or object photo → a rounded 3D object wearing the photo.', file: 'Product shot on a plain background', empty: 'Product photo on a plain background' },
  logo: { hint: 'Logo or graphic → an extruded, bevelled 3D logo in its own colours.', file: 'Logo / graphic — PNG with transparency is best', empty: 'Logo or graphic (transparent PNG is best)' },
  scene: { hint: 'Any photo → rebuilt as a 3D scene: depth from an AI model, separate objects, backdrop filled in behind them, camera at the photo\'s viewpoint.', file: 'Any photo — rooms, streets, people, products', empty: 'Any photo' },
  garment: { hint: 'Garment photo or template → rigged garment on the Motion Studio body, with motions as Blender actions.', file: 'Garment flat lay or product shot', empty: 'Garment photo — or pick a template' },
};
const MOTION_LIST = [['p_ref', 'Reference sway', true], ['walk', 'Walk', true], ['idle', 'Idle', false], ['run', 'Run', false], ['samba', 'Dance', false], ['p_shift', 'Weight shift', false], ['p_hippop', 'Hip pop', false], ['p_handhip', 'Hand on hip', false], ['p_twist', 'Slow twist', false], ['p_lean', 'Lean back', false]];
const state = {
  mode: 'object', tolerance: 1, name: 'model',
  oheight: 30, othick: 0.35, odetail: 0, back: 'round',
  lwidth: 30, ldepth: 20, lbevel: 1.5, lside: null,
  layout: '3d', sheight: 2, sglow: true, lens: 26, near: 1.5, range: 6, sep: 1, detail: 240, thick: 0.35, cammove: true,
  type: 'pants', gsize: 1, glength: 1, desc: {}, figure: 'women', template: null, templateDesc: {}, color: null,
  engine: 'BLENDER_EEVEE', light: 'studio', bg: '#d8d4cd', floor: true,
};
let srcCanvas, cut, tex, model, mesh, texture, texture2, template, depthRaw = null;
let figs = {}, character, bodyMesh, bodyMeshes = [], bones, restPose, restPoses = {}, body, garment, meas;

/* ---------- 3D preview ---------- */
const canvas = $('#stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene(); scene.background = new THREE.Color('#16161a');
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture; scene.environmentIntensity = 0.9;
const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(2, 4, 3); scene.add(sun);
const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100); camera.position.set(0.9, 1.0, 3.2);
const controls = new OrbitControls(camera, canvas); controls.target.set(0, 0.6, 0); controls.enableDamping = true;
const grid = new THREE.GridHelper(4, 40, 0x3a3a40, 0x26262b); scene.add(grid);
const bodyMat = new THREE.MeshStandardMaterial({ color: 0x8c8780, roughness: 0.8, transparent: true, opacity: 0.35, depthWrite: false });
function resize() { const p = canvas.parentElement; renderer.setSize(p.clientWidth, p.clientHeight, false); camera.aspect = p.clientWidth / p.clientHeight; camera.updateProjectionMatrix(); }
new ResizeObserver(resize).observe(canvas.parentElement);
(function loop() { controls.update(); renderer.render(scene, camera); requestAnimationFrame(loop); })();

// Blender-frame mesh data → three.js preview geometry (Z up → Y up)
function previewGeometry(m) {
  const P = [], U = [];
  let c = 0;
  m.faces.forEach((f) => {
    const corner = (k) => c + k;
    for (let k = 1; k + 1 < f.length; k++) for (const j of [0, k, k + 1]) {
      const v = f[j]; P.push(m.pos[v * 3], m.pos[v * 3 + 2], -m.pos[v * 3 + 1]); U.push(m.uv[corner(j) * 2], m.uv[corner(j) * 2 + 1]);
    }
    c += f.length;
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  g.computeVertexNormals(); return g;
}
function frameView(box) {
  const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3()), r = Math.max(s.x, s.y, s.z) * 0.5 + 0.01;
  controls.target.copy(c); camera.position.set(c.x + r * 1.6, c.y + r * 0.8, c.z + r * 4.6); camera.near = r / 50; camera.far = r * 60; camera.updateProjectionMatrix();
  grid.scale.setScalar(Math.max(0.1, r)); grid.position.y = box.min.y;
}

/* ---------- input ---------- */
async function loadImage(file) {
  status(`Reading ${file.name}…`);
  state.template = null; state.templateDesc = {}; renderTemplates(); depthRaw = null;
  state.name = file.name.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_') || 'model';
  const img = await createImageBitmap(file);
  const k = Math.min(1, 1600 / Math.max(img.width, img.height));
  srcCanvas = document.createElement('canvas'); srcCanvas.width = Math.round(img.width * k); srcCanvas.height = Math.round(img.height * k);
  srcCanvas.getContext('2d').drawImage(img, 0, 0, srcCanvas.width, srcCanvas.height);
  $('#name').value = state.name;
  await process();
}

async function process() {
  if (!srcCanvas) return;
  if (state.mode === 'scene') { cut = null; document.body.classList.add('loaded'); drawPhoto(); return build(); }
  status('Cutting it out of the background…'); await nextFrame();
  cut = cutout(srcCanvas.getContext('2d').getImageData(0, 0, srcCanvas.width, srcCanvas.height), { tolerance: state.tolerance, keepAll: state.mode === 'logo' });
  if (!cut.bbox) { status('Couldn\'t find the subject — try a plainer background or raise Background tolerance.'); drawPhoto(); return; }
  tex = garmentTexture(srcCanvas, cut);
  if (state.mode === 'garment') { await ensureBody(); setType(state.desc.type || (state.template ? TEMPLATES[state.template].type : guessType(cut)), false); }
  if (state.mode === 'logo' && !state.lside) $('#lside').value = dominant();
  document.body.classList.add('loaded');
  drawPhoto();
  await build();
}

function drawPhoto() {
  const c = $('#photo'), g = c.getContext('2d');
  c.width = srcCanvas.width; c.height = srcCanvas.height; g.drawImage(srcCanvas, 0, 0);
  if (!cut) return;
  const o = g.getImageData(0, 0, c.width, c.height), d = o.data;
  for (let i = 0; i < cut.mask.length; i++) if (!cut.mask[i]) { d[i * 4] = d[i * 4] * 0.25 + 10; d[i * 4 + 1] = d[i * 4 + 1] * 0.25 + 10; d[i * 4 + 2] = d[i * 4 + 2] * 0.25 + 14; }
  g.putImageData(o, 0, 0);
}

// most common saturated-ish colour inside the cut-out, slightly darkened, for logo sides
function dominant() {
  const d = srcCanvas.getContext('2d').getImageData(0, 0, srcCanvas.width, srcCanvas.height).data, bins = new Map();
  for (let i = 0; i < cut.mask.length; i += 3) if (cut.mask[i]) { const k = ((d[i * 4] >> 4) << 8) | ((d[i * 4 + 1] >> 4) << 4) | (d[i * 4 + 2] >> 4); bins.set(k, (bins.get(k) || 0) + 1); }
  let best = 0, bk = 0; for (const [k, n] of bins) if (n > best) { best = n; bk = k; }
  const r = ((bk >> 8) & 15) * 16 + 8, g = ((bk >> 4) & 15) * 16 + 8, b = (bk & 15) * 16 + 8, h = (v) => Math.round(v * 0.7).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/* ---------- build ---------- */
async function build() {
  if (!srcCanvas) return;
  status('Building…'); await nextFrame();
  try {
    if (mesh) { scene.remove(mesh); mesh.traverse((o) => o.geometry?.dispose()); mesh = null; }
    if (texture) texture.dispose(); if (texture2) { texture2.dispose(); texture2 = null; }
    grid.visible = true; camera.fov = 30;
    let geo, info;
    if (state.mode === 'object') {
      const img = srcCanvas.getContext('2d').getImageData(0, 0, srcCanvas.width, srcCanvas.height);
      model = inflate(cut, img, tex.crop, { height: state.oheight / 100, thickness: state.othick, back: state.back, detail: state.odetail });
      texture = new THREE.CanvasTexture(tex.canvas); geo = previewGeometry(model);
      info = `${model.faces.length.toLocaleString()} quads · ${cm(model.size[0])} × ${cm(model.size[2])} × ${cm(model.size[1])}`;
    } else if (state.mode === 'logo') {
      model = logo(cut, tex.crop, { width: state.lwidth / 100, depth: state.ldepth / 1000 });
      texture = new THREE.CanvasTexture(tex.canvas); geo = previewGeometry(model);
      info = `${model.faces.length.toLocaleString()} faces · ${cm(model.size[0])} × ${cm(model.size[2])} · ${state.ldepth} mm deep`;
    } else if (state.mode === 'scene' && state.layout === '3d') {
      return build3d();
    } else if (state.mode === 'scene') {
      const aspect = srcCanvas.width / srcCanvas.height;
      model = picture(aspect, { height: state.sheight, layout: state.layout });
      texture = new THREE.CanvasTexture(srcCanvas); geo = previewGeometry(model);
      info = `${state.layout === 'flat' ? 'Picture plane' : 'Studio sweep'} · ${(state.sheight * aspect).toFixed(2)} × ${state.sheight.toFixed(2)} m · camera framed to ${srcCanvas.width}×${srcCanvas.height}`;
    } else {
      await ensureBody();
      meas = state.type === 'pants' ? measurePants(cut) : measureTube(cut, state.type);
      const o = { size: state.gsize, lengthScale: state.glength, desc: { ...state.templateDesc, ...state.desc } };
      garment = state.type === 'pants' ? buildPants(body, meas, tex.crop, o) : state.type === 'skirt' ? buildSkirt(body, meas, tex.crop, o) : buildTop(body, meas, tex.crop, o);
      texture = new THREE.CanvasTexture(tex.canvas); geo = toGeometry(garment);
      model = { garment };
      info = `${garment.faces.length.toLocaleString()} quads · rigged to ${FIGURES[state.figure].label.toLowerCase()}'s body`;
    }
    texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 8;
    const mat = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.7, side: THREE.DoubleSide });
    if (state.mode === 'logo') {
      // sides in their own colour (material index 1 in the .blend)
      const side = new THREE.MeshStandardMaterial({ color: $('#lside').value, roughness: 0.5 });
      mesh = new THREE.Group(); const g0 = previewGeometry({ ...model, faces: model.faces.filter((_, i) => !model.faceMat[i]), uv: cornerSubset(model, 0) }), g1 = previewGeometry({ ...model, faces: model.faces.filter((_, i) => model.faceMat[i]), uv: cornerSubset(model, 1) });
      mesh.add(new THREE.Mesh(g0, mat), new THREE.Mesh(g1, side));
    } else mesh = new THREE.Mesh(geo, state.mode === 'scene' && state.sglow ? new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }) : mat);
    scene.add(mesh);
    if (character) character.visible = state.mode === 'garment';
    frameView(new THREE.Box3().setFromObject(state.mode === 'garment' && character ? character : mesh));
    $('#facts').innerHTML = info;
    status(`${state.name}: ready — download the .blend when you're happy.`);
  } catch (e) { console.error(e); status(`Couldn't build it: ${e.message}`); }
}
// photo → depth → 3D scene preview (camera starts at the photo's viewpoint)
async function build3d() {
  if (!depthRaw) depthRaw = await estimateDepth(srcCanvas, status);
  status('Building the 3D scene…'); await nextFrame();
  const aspect = srcCanvas.width / srcCanvas.height, gw = aspect >= 1 ? state.detail : Math.round(state.detail * aspect), gh = aspect >= 1 ? Math.round(state.detail / aspect) : state.detail;
  const rec = reconstruct({ disp: resampleDepth(depthRaw, gw, gh), gw, gh, photo: srcCanvas, lens: state.lens, near: state.near, range: state.range, separation: state.sep, thickness: state.thick });
  const fillCanvas = fillTexture(srcCanvas, rec);
  model = { rec, fillCanvas };
  texture = new THREE.CanvasTexture(srcCanvas); texture2 = new THREE.CanvasTexture(fillCanvas);
  for (const t of [texture, texture2]) { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; }
  const M = (map) => (state.sglow ? new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide }) : new THREE.MeshStandardMaterial({ map, roughness: 0.8, side: THREE.DoubleSide }));
  mesh = new THREE.Group();
  for (const L of rec.layers) mesh.add(new THREE.Mesh(previewGeometry(L), M(L.image === 'fill' ? texture2 : texture)));
  scene.add(mesh); grid.visible = false;
  if (character) character.visible = false;
  // look from the photo's camera (Blender origin, looking +Y → three.js −Z)
  camera.fov = (2 * Math.atan(rec.ty) * 180) / Math.PI; camera.near = 0.02; camera.far = rec.far * 4; camera.updateProjectionMatrix();
  controls.target.set(0, 0, -rec.medianZ); camera.position.set(0, 0, 0.001);
  $('#facts').innerHTML = `<b>${rec.objects} object${rec.objects === 1 ? '' : 's'}</b> + backdrop · depth ${rec.near.toFixed(1)}–${rec.far.toFixed(1)} m · ${state.lens} mm lens · drag to look around`;
  status(`${state.name}: 3D scene ready — orbit to check it, then download the .blend.`);
}

const cm = (m) => (m >= 1 ? `${m.toFixed(2)} m` : `${Math.round(m * 100)} cm`);
function cornerSubset(m, mat) { const out = []; let c = 0; m.faces.forEach((f, i) => { if ((m.faceMat[i] ? 1 : 0) === mat) for (let k = 0; k < f.length; k++) out.push(m.uv[(c + k) * 2], m.uv[(c + k) * 2 + 1]); c += f.length; }); return out; }

/* ---------- garment body ---------- */
const loader = new GLTFLoader();
async function ensureBody(id = state.figure) {
  if (character && body && figs[id] && character === figs[id].scene) return;
  status('Loading body…');
  for (const k of Object.keys(FIGURES)) figs[k] ||= await loadFigure(loader, k);
  for (const [k, f] of Object.entries(figs)) { restPoses[k] ||= snapshotPose(bonesByName(f.scene)); }
  const f = figs[id];
  if (character && character !== f.scene) scene.remove(character);
  character = f.scene; bodyMesh = f.bodyMesh; bodyMeshes = f.meshes;
  bones = bonesByName(character); restPose = restPoses[id];
  applyPose(restPose); character.updateMatrixWorld(true);
  const all = bodyMeshes.map((m) => sampleBody(m).pos), pos = new Float32Array(all.reduce((n, p) => n + p.length, 0));
  all.reduce((o, p) => (pos.set(p, o), o + p.length), 0);
  body = bodyInfo(bones, pos, { sex: f.figure.sex });
  for (const m of bodyMeshes) { m.material = bodyMat; m.frustumCulled = false; }
  scene.add(character); character.visible = state.mode === 'garment';
  renderTemplates();
}
async function setFigure(id) {
  state.figure = id;
  document.querySelectorAll('[data-figure]').forEach((b) => b.classList.toggle('on', b.dataset.figure === id));
  await ensureBody(id);
  if (state.template) await useTemplate(state.template); else if (cut) await build();
}
async function useTemplate(kind) {
  await ensureBody();
  state.template = kind; state.templateDesc = { ...(TEMPLATES[kind].desc || {}) };
  srcCanvas = drawTemplate(kind, FIGURES[state.figure].sex, body, state.color || undefined);
  state.name = `${state.figure}_${kind}`; $('#name').value = state.name;
  renderTemplates();
  await process();
}
function renderTemplates() {
  const sex = FIGURES[state.figure].sex, el = $('#templates');
  el.innerHTML = Object.entries(TEMPLATES).map(([k, T]) => `<button data-template="${k}" class="${state.template === k ? 'on' : ''}">${body ? templateIcon(k, sex, body, state.template === k ? '#111' : '#cfcac2') : ''}<span>${T.label}</span></button>`).join('');
  el.querySelectorAll('[data-template]').forEach((b) => (b.onclick = () => useTemplate(b.dataset.template)));
  $('#tcolor').value = state.color || (state.template ? TEMPLATES[state.template].color[sex] : '#3d5a80');
}
function setType(t, go = true) {
  state.type = t; document.querySelectorAll('[data-type]').forEach((b) => b.classList.toggle('on', b.dataset.type === t));
  renderSuggestions(); if (go) build();
}
function applyDescription(go = true) {
  state.desc = parseDescription($('#describe').value);
  $('#understood').innerHTML = state.desc.labels.map((l) => `<span class="chip on">${l}</span>`).join('');
  if (state.desc.type && state.desc.type !== state.type) setType(state.desc.type, false);
  renderSuggestions(); if (go) build();
}
function renderSuggestions() {
  const have = $('#describe').value.toLowerCase(), el = $('#suggest'); el.innerHTML = '';
  for (const w of SUGGESTIONS[state.type] || []) {
    if (have.includes(w)) continue;
    const b = document.createElement('button'); b.className = 'chip'; b.textContent = w; b.style.padding = '3px 9px'; b.style.fontSize = '11px';
    b.onclick = () => { const t = $('#describe'); t.value = t.value.trim() ? `${t.value.trim().replace(/[,.]$/, '')}, ${w}` : w; applyDescription(); };
    el.appendChild(b);
  }
}

/* ---------- .blend ---------- */
let templateBytes;
async function canvasBytes(c, type = 'image/png', q) { const blob = await new Promise((r) => c.toBlob(r, type, q)); return new Uint8Array(await blob.arrayBuffer()); }
const hex2rgb = (h) => { const n = parseInt(h.slice(1), 16), s = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return [s(n >> 16), s((n >> 8) & 255), s(n & 255)]; };

async function exportBlend() {
  if (!model) return;
  const btn = $('#download'); btn.disabled = true;
  try {
    status('Writing the .blend…'); await nextFrame();
    templateBytes ||= await (await fetch('assets/blend/template.blend')).arrayBuffer();
    const S = new BlendScene(templateBytes.slice(0)), name = ($('#name').value.trim() || state.name).replace(/[^\w.-]+/g, '_');
    const bg = hex2rgb(state.bg);
    let box; // [min xyz, max xyz] in Blender coordinates
    const bounds = (pos, add = [0, 0, 0]) => { const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], pos[i + k] + add[k]); mx[k] = Math.max(mx[k], pos[i + k] + add[k]); } return [mn, mx]; };
    let aspect = 16 / 9, framing = 1.25;

    if (state.mode === 'object' || state.mode === 'logo') {
      const img = S.image(name, await canvasBytes(tex.canvas), { width: tex.canvas.width, height: tex.canvas.height });
      const front = S.material(name, { image: img, roughness: state.mode === 'logo' ? 0.35 : 0.55 });
      const mats = [front];
      if (state.mode === 'logo') mats.push(S.material(`${name}_sides`, { color: hex2rgb($('#lside').value), roughness: 0.35 }));
      const me = S.mesh(name, { positions: model.pos, faces: model.faces, uvs: model.uv, materials: mats, faceMat: model.faceMat || null, smooth: state.mode === 'object' });
      const mods = state.mode === 'object' ? [{ type: 'subsurf', levels: 1 }] : state.lbevel > 0 ? [{ type: 'bevel', width: state.lbevel / 1000, segments: 3, angle: 0.5236 }] : [];
      if (state.mode === 'logo') autoSmooth(S, me);
      S.object(name, me, { modifiers: mods });
      box = bounds(model.pos); aspect = 16 / 9;
    } else if (state.mode === 'scene' && state.layout === '3d') {
      return finish3d(S, name, bg, btn);
    } else if (state.mode === 'scene') {
      const img = S.image(name, await canvasBytes(srcCanvas, 'image/jpeg', 0.92), { ext: 'jpg', width: srcCanvas.width, height: srcCanvas.height });
      const mat = S.material(name, state.sglow ? { image: img, color: [0, 0, 0], emission: 1, roughness: 1, specular: 0 } : { image: img, roughness: 0.6 });
      if (state.sglow) emissionOnly(S, mat);
      S.object(name, S.mesh(name, { positions: model.pos, faces: model.faces, uvs: model.uv, materials: [mat], smooth: true }));
      box = bounds(model.pos); aspect = srcCanvas.width / srcCanvas.height; framing = 1.0;
    } else {
      box = await garmentBlend(S, name);
      aspect = 9 / 16; framing = 1.1;
    }

    // render size from the aspect: long side 1920
    const W = aspect >= 1 ? 1920 : Math.round(1920 * aspect), H = aspect >= 1 ? Math.round(1920 / aspect) : 1920;
    S.setRender({ width: W, height: H, engine: state.engine, fps: 30 });
    placeCamera(S, box, W / H, framing, state.mode === 'scene');
    lighting(S, box);
    S.setWorld(bg, state.mode === 'scene' ? 1 : 0.6);
    if (state.floor && state.mode !== 'scene') {
      const mx = Math.max(box[1][0] - box[0][0], box[1][2] - box[0][2], 1) * 12;
      const fm = S.material('Floor', { color: bg, roughness: 0.9, specular: 0.2 });
      S.object('Floor', S.mesh('Floor', { positions: [-mx, -mx, 0, mx, -mx, 0, mx, mx, 0, -mx, mx, 0].map((v, i) => (i % 3 === 2 ? box[0][2] : v)), faces: [[0, 1, 2, 3]], uvs: [0, 0, 1, 0, 1, 1, 0, 1], materials: [fm], smooth: false }));
    }
    S.viewportMaterialPreview();
    const bytes = S.bytes();
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/x-blender' })); a.download = `${name}.blend`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    status(`Saved ${name}.blend · ${(bytes.length / 1e6).toFixed(1)} MB — open it in Blender 3.5+ (File › Open).`);
    return bytes;
  } catch (e) { console.error(e); status(`Couldn't write the .blend: ${e.message}`); }
  finally { btn.disabled = false; }
}

// the reconstructed scene: backdrop + objects, camera at the photo's viewpoint (+ an optional slow move)
async function finish3d(S, name, bg, btn) {
  const { rec, fillCanvas } = model, f = S.f;
  const photo = S.image(`${name}_photo`, await canvasBytes(srcCanvas, 'image/jpeg', 0.92), { ext: 'jpg', width: srcCanvas.width, height: srcCanvas.height });
  const fill = S.image(`${name}_backdrop`, await canvasBytes(fillCanvas, 'image/jpeg', 0.9), { ext: 'jpg', width: fillCanvas.width, height: fillCanvas.height });
  const mk = (n, img) => { const m = S.material(n, state.sglow ? { image: img, color: [0, 0, 0], emission: 1, roughness: 1, specular: 0 } : { image: img, roughness: 0.8, specular: 0.2 }); if (state.sglow) emissionOnly(S, m); return m; };
  const mPhoto = mk(`${name}_photo`, photo), mFill = mk(`${name}_backdrop`, fill);
  let box = null;
  for (const L of rec.layers) {
    const me = S.mesh(L.name, { positions: L.pos, faces: L.faces, uvs: L.uv, materials: [L.image === 'fill' ? mFill : mPhoto], smooth: true });
    S.object(L.name, me);
    const b = boundsOf(L.pos); box = box ? [box[0].map((v, k) => Math.min(v, b[0][k])), box[1].map((v, k) => Math.max(v, b[1][k]))] : b;
  }
  const aspect = srcCanvas.width / srcCanvas.height, W = aspect >= 1 ? 1920 : Math.round(1920 * aspect), H = aspect >= 1 ? Math.round(1920 / aspect) : 1920;
  S.setRender({ width: W, height: H, engine: state.engine, fps: 30, frames: state.cammove ? 150 : 1 });
  S.setCamera({ loc: [0, 0, 0], rot: [Math.PI / 2, 0, 0], lens: state.lens, clipEnd: rec.far * 6 });
  if (state.sglow) f.set(S.scene, 'view_settings.view_transform', 'Standard'); // the photo's own colours
  if (state.cammove) {
    // slow 5 s loop: drift side to side and ease in, always aimed at the middle of the scene
    const N = 150, A = rec.medianZ * 0.07, T = [0, rec.medianZ, 0], cur = { lx: [], ly: [], lz: [], rx: [], rz: [] };
    for (let k = 0; k < N; k++) {
      const t = k / N, p = [A * Math.sin(2 * Math.PI * t), A * 0.8 * (1 - Math.cos(2 * Math.PI * t)) / 2, A * 0.25 * Math.sin(4 * Math.PI * t)];
      const d = [T[0] - p[0], T[1] - p[1], T[2] - p[2]];
      cur.lx.push(p[0]); cur.ly.push(p[1]); cur.lz.push(p[2]);
      cur.rx.push(Math.PI / 2 + Math.atan2(d[2], Math.hypot(d[0], d[1]))); cur.rz.push(Math.atan2(-d[0], d[1]));
    }
    addObjectAction(S, S.camera, 'Camera move', [['location', 0, cur.lx], ['location', 1, cur.ly], ['location', 2, cur.lz], ['rotation_euler', 0, cur.rx], ['rotation_euler', 2, cur.rz]].map(([path, index, v]) => ({ path, index, values: Float32Array.from(v) })), N);
  }
  lighting(S, box);
  S.setWorld(bg, 0.6);
  S.viewportMaterialPreview();
  const bytes = S.bytes();
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/x-blender' })); a.download = `${name}.blend`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  status(`Saved ${name}.blend · ${(bytes.length / 1e6).toFixed(1)} MB — open it in Blender 3.5+ and press Numpad 0 to look through the camera.`);
  btn.disabled = false;
  return bytes;
}

// flat caps + smooth bevels: Blender 3.x auto smooth (4.1+ converts it to "Smooth by Angle")
function autoSmooth(S, me) { const f = S.f; f.set(me, 'flag', f.get(me, 'flag') | 32).set(me, 'smoothresh', 0.5236); }
// shadeless picture: texture into Emission, base colour black
function emissionOnly(S, mat) {
  const f = S.f, tree = f.byAddr(f.get(mat, 'nodetree')), bsdf = f.listItems(tree, 'nodes').find((n) => f.get(n, 'idname') === 'ShaderNodeBsdfPrincipled');
  const base = f.listItems(bsdf, 'inputs').find((s) => f.get(s, 'identifier') === 'Base Color');
  // unlink base colour (texture stays wired into Emission)
  const links = f.listItems(tree, 'links'), keep = links.filter((l) => f.get(l, 'tosock') !== base.old);
  f.set(base, 'link', 0n); f.linkList(tree, 'links', keep);
  for (const l of links) if (!keep.includes(l)) f.blocks.splice(f.blocks.indexOf(l), 1);
}

function placeCamera(S, box, aspect, framing, flat) {
  const c = [0, 1, 2].map((k) => (box[0][k] + box[1][k]) / 2), w = box[1][0] - box[0][0], h = box[1][2] - box[0][2], d = box[1][1] - box[0][1];
  const lens = flat ? 50 : 50, half = 18 / lens;
  const tx = aspect >= 1 ? half : half * aspect, ty = aspect >= 1 ? half / aspect : half;
  let dist = Math.max((w / 2) * framing / tx, (h / 2) * framing / ty) + d / 2;
  const pitch = flat ? 0 : 0.12, loc = [c[0], c[1] - dist * Math.cos(pitch), c[2] + dist * Math.sin(pitch)];
  S.setCamera({ loc, rot: [Math.PI / 2 - pitch, 0, 0], lens, clipEnd: Math.max(100, dist * 10) });
}

function lighting(S, box) {
  const c = [0, 1, 2].map((k) => (box[0][k] + box[1][k]) / 2), size = Math.max(box[1][0] - box[0][0], box[1][2] - box[0][2], 0.1), r = size * 1.6 + 0.5;
  const P = { studio: [1, 0.45, 0.5], soft: [0.8, 0.8, 0.25], dramatic: [1.4, 0.12, 1.1] }[state.light];
  const aim = (from) => { const d = [c[0] - from[0], c[1] - from[1], c[2] - from[2]], l = Math.hypot(...d); return [Math.acos(-d[2] / l), 0, Math.atan2(d[0], -d[1]) + Math.PI]; };
  const at = (az, el) => [c[0] + r * Math.sin(az) * Math.cos(el), c[1] - r * Math.cos(az) * Math.cos(el), c[2] + r * Math.sin(el)];
  const e = (k) => k * 55 * r * r;
  const key = at(-0.7, 0.6); S.setLight({ loc: key, rot: aim(key), type: 'area', energy: e(P[0]), size: size * 1.2 });
  const fill = at(0.9, 0.25); S.addLight('Fill', { loc: fill, rot: aim(fill), type: 'area', energy: e(P[1]), size: size * 1.5 });
  const rim = at(Math.PI * 0.85, 1.2); // high behind: lights the shoulders, stays out of frame S.addLight('Rim', { loc: rim, rot: aim(rim), type: 'area', energy: e(P[2]), size: size * 0.8 });
}

// garment: armature from the body's skeleton, garment (+ body) skinned with vertex groups, motions as actions
async function garmentBlend(S, name) {
  status('Rigging…'); await nextFrame();
  applyPose(restPose); character.updateMatrixWorld(true);
  const skel = bodyMesh.skeleton, rename = (n) => `mixamorig:${n.replace(/^mixamorig[:_]?/, '')}`;
  const spec = skeletonBones(skel, rename), arm = addArmature(S, 'Armature', spec);
  const armOb = S.object('Armature', arm.data, { type: 25 });
  S.f.set(armOb, 'dtx', 8); // show in front
  addPose(S, armOb, spec, arm);
  const boneIndex = new Map(skel.bones.map((b, i) => [b.name, i]));
  const groupsFrom = (skinIndex, skinWeight, boneList) => {
    const weights = []; const n = skinIndex.count;
    for (let v = 0; v < n; v++) {
      const w = [];
      for (let k = 0; k < 4; k++) { const x = skinWeight.getComponent(v, k); if (x > 1e-4) { const bi = boneIndex.get(boneList[skinIndex.getComponent(v, k)].name); if (bi != null) w.push([bi, x]); } }
      weights.push(w);
    }
    return { names: spec.map((b) => b.name), weights };
  };
  // garment
  const geo = toGeometry(garment);
  const res = fitGarment({ character, bodyMesh, bones, restPose, parts: [{ geometry: geo, label: name }], opts: { scale: 1, lift: 0, depth: 0, clearance: -1, prefit: true } });
  const gg = res.geometries[0];
  if (gg.attributes.position.count !== garment.pos.length / 3) throw new Error('weight transfer changed the vertex count');
  const img = S.image(name, await canvasBytes(tex.canvas), { width: tex.canvas.width, height: tex.canvas.height });
  const gm = S.material(name, { image: img, roughness: 0.8, specular: 0.3 });
  const gpos = yUpToZUp(garment.pos);
  const gme = S.mesh(name, { positions: gpos, faces: garment.faces, uvs: cornerUV(garment.faces, garment.uv), materials: [gm], groups: groupsFrom(gg.attributes.skinIndex, gg.attributes.skinWeight, res.skeleton.bones) });
  S.object(name, gme, { parent: armOb, modifiers: [{ type: 'armature', object: armOb }] });
  let box = boundsOf(gpos);
  // body
  if ($('#gbody').checked) {
    const mann = S.material('Mannequin', { color: [0.62, 0.58, 0.54], roughness: 0.55 }), joints = S.material('Joints', { color: [0.06, 0.06, 0.07], roughness: 0.5 });
    for (const m of bodyMeshes) {
      const p = yUpToZUp(sampleBody(m).pos), g = m.geometry, idx = g.index.array, faces = [];
      for (let i = 0; i < idx.length; i += 3) faces.push([idx[i], idx[i + 1], idx[i + 2]]);
      const uv = g.attributes.uv ? cornerUV(faces, g.attributes.uv.array) : null;
      const me = S.mesh(m === bodyMesh ? 'Body' : `Body_${m.name}`, { positions: p, faces, uvs: uv, materials: [m === bodyMesh ? mann : joints], groups: groupsFrom(g.attributes.skinIndex, g.attributes.skinWeight, m.skeleton.bones) });
      S.object(m === bodyMesh ? 'Body' : `Body_${m.name}`, me, { parent: armOb, modifiers: [{ type: 'armature', object: armOb }] });
      const bb = boundsOf(p); box = [box[0].map((v, k) => Math.min(v, bb[0][k])), box[1].map((v, k) => Math.max(v, bb[1][k]))];
    }
  }
  // motions
  const ids = [...document.querySelectorAll('#motions input:checked')].map((i) => i.value);
  if (ids.length) {
    status(`Baking ${ids.length} motion${ids.length > 1 ? 's' : ''}…`); await nextFrame();
    const span = (() => { const W = (n) => bones[n].getWorldPosition(new THREE.Vector3()); return W('Neck').y - (W('LeftFoot').y + W('RightFoot').y) / 2; })();
    const clips = buildMotions({ figs, own: state.figure, character, bones, span, ids });
    const mixer = new THREE.AnimationMixer(character);
    let first = null, firstFrames = 0;
    for (const clip of clips) {
      const b = bakeClip({ mixer, clip, root: character, skeleton: skel, spec, arm, fps: 30, restPose, applyPose });
      const label = MOTION_LIST.find((m) => m[0] === clip.name)?.[1] || clip.name;
      const ac = addAction(S, label, b.channels, b.frames);
      if (!first) { first = ac; firstFrames = b.frames; }
    }
    mixer.uncacheRoot(character);
    applyPose(restPose); character.updateMatrixWorld(true);
    if (first) { setAction(S, armOb, first); S.setRender({ frames: firstFrames, fps: 30 }); }
  }
  return box;
}
function boundsOf(pos) { const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], pos[i + k]); mx[k] = Math.max(mx[k], pos[i + k]); } return [mn, mx]; }

/* ---------- UI ---------- */
function setMode(m) {
  state.mode = m; document.body.dataset.mode = m;
  document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  $('#mode-hint').textContent = MODES[m].hint; $('#file-hint').textContent = MODES[m].file; $('#empty-hint').textContent = MODES[m].empty;
  if (character) character.visible = m === 'garment';
  if (m === 'garment') ensureBody().then(() => { if (template) {} });
  if (srcCanvas) process();
}
document.querySelectorAll('.modes [data-mode]').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
const fmt = { oheight: (v) => `${v} cm`, othick: (v) => `${Math.round(v * 100)}%`, odetail: (v) => (v ? `${Math.round(v * 100)}%` : 'off'), lwidth: (v) => `${v} cm`, ldepth: (v) => `${v} mm`, lbevel: (v) => (v ? `${v} mm` : 'off'), sheight: (v) => `${v.toFixed(1)} m`, gsize: (v) => `${Math.round(v * 100)}%`, glength: (v) => `${Math.round(v * 100)}%`, lens: (v) => `${v} mm`, near: (v) => `${v.toFixed(1)} m`, range: (v) => `${v.toFixed(1)}×`, sep: (v) => `${v.toFixed(2)}×`, detail: (v) => `${v}`, thick: (v) => (v ? `${Math.round(v * 100)}%` : 'flat'), tolerance: (v) => `${v.toFixed(2)}×` };
let deb;
for (const k of Object.keys(fmt)) {
  const el = $(`#${k}`); el.value = state[k]; $(`#${k}-v`).textContent = fmt[k](state[k]);
  el.oninput = () => { state[k] = +el.value; $(`#${k}-v`).textContent = fmt[k](state[k]); clearTimeout(deb); deb = setTimeout(() => (k === 'tolerance' ? process() : build()), 200); };
}
document.querySelectorAll('[data-back]').forEach((b) => (b.onclick = () => { state.back = b.dataset.back; document.querySelectorAll('[data-back]').forEach((x) => x.classList.toggle('on', x === b)); build(); }));
document.querySelectorAll('[data-layout]').forEach((b) => (b.onclick = () => { state.layout = b.dataset.layout; document.body.dataset.layout = state.layout; document.querySelectorAll('[data-layout]').forEach((x) => x.classList.toggle('on', x === b)); build(); }));
document.body.dataset.layout = state.layout;
document.querySelectorAll('[data-engine]').forEach((b) => (b.onclick = () => { state.engine = b.dataset.engine; document.querySelectorAll('[data-engine]').forEach((x) => x.classList.toggle('on', x === b)); }));
document.querySelectorAll('[data-light]').forEach((b) => (b.onclick = () => { state.light = b.dataset.light; document.querySelectorAll('[data-light]').forEach((x) => x.classList.toggle('on', x === b)); }));
document.querySelectorAll('[data-type]').forEach((b) => (b.onclick = () => setType(b.dataset.type)));
document.querySelectorAll('[data-bg]').forEach((b) => { b.style.setProperty('--c', b.dataset.bg); b.onclick = () => { state.bg = b.dataset.bg; $('#bg').value = b.dataset.bg; }; });
$('#bg').oninput = (e) => { state.bg = e.target.value; };
$('#sglow').onchange = (e) => { state.sglow = e.target.checked; build(); };
$('#cammove').onchange = (e) => { state.cammove = e.target.checked; };
$('#floor').onchange = (e) => { state.floor = e.target.checked; };
$('#lside').oninput = (e) => { state.lside = e.target.value; build(); };
$('#lside-auto').onclick = () => { state.lside = null; if (cut) { $('#lside').value = dominant(); build(); } };
$('#motions').innerHTML = MOTION_LIST.map(([id, label, on]) => `<label class="check"><input type="checkbox" value="${id}" ${on ? 'checked' : ''}><span>${label}</span></label>`).join('');
document.querySelectorAll('[data-figure]').forEach((b) => (b.onclick = () => setFigure(b.dataset.figure)));
let colDeb;
$('#tcolor').oninput = (e) => { state.color = e.target.value; clearTimeout(colDeb); if (state.template) colDeb = setTimeout(() => useTemplate(state.template), 250); };
document.querySelectorAll('[data-color]').forEach((b) => { b.style.setProperty('--c', b.dataset.color); b.onclick = () => { $('#tcolor').value = b.dataset.color; $('#tcolor').oninput({ target: { value: b.dataset.color } }); }; });
let descDeb; $('#describe').addEventListener('input', () => { clearTimeout(descDeb); descDeb = setTimeout(() => applyDescription(), 450); });
$('#file').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadImage(f); };
window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drag'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('drag'); });
window.addEventListener('drop', (e) => { e.preventDefault(); document.body.classList.remove('drag'); const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/')); if (f) loadImage(f); });
$('#download').onclick = exportBlend;

resize(); setMode('object'); renderTemplates(); renderSuggestions();
status('Pick what to make, then drop an image.');
window.__blend = { loadImage, setMode, setFigure, useTemplate, setType, exportBlend, build, state, describe: (t) => { $('#describe').value = t; applyDescription(); }, get model() { return model; } };
