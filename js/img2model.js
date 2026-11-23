import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { zipSync, strToU8 } from 'three/addons/libs/fflate.module.js';
import { bonesByName, snapshotPose, applyPose, sampleBody, fitGarment } from './autoskin.js';
import { exportRiggedGLB } from './exportrig.js';
import { cutout, guessType, measurePants, measureTube, bodyInfo, buildPants, buildSkirt, buildTop, toGeometry, toOBJ, garmentTexture } from './garments.js';
import { putGarment } from './handoff.js';

const $ = (s) => document.querySelector(s);
const status = (m) => { $('#status').textContent = m; };
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const state = { type: 'pants', tolerance: 1, size: 1, length: 1, rise: 1, sleeve: -1, density: 1, showBody: true, wire: false, name: 'garment' };
let character, bodyMesh, bones, restPose, body, srcCanvas, cut, meas, tex, garment, mesh, texture;

/* ---------- 3D view ---------- */
const canvas = $('#stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene(); scene.background = new THREE.Color('#16161a');
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture; scene.environmentIntensity = 0.9;
const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(2, 4, 3); scene.add(sun);
const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 50); camera.position.set(0.9, 1.0, 3.2);
const controls = new OrbitControls(camera, canvas); controls.target.set(0, 0.85, 0); controls.enableDamping = true;
scene.add(new THREE.GridHelper(4, 40, 0x3a3a40, 0x26262b));
const bodyMat = new THREE.MeshStandardMaterial({ color: 0x8c8780, roughness: 0.8, transparent: true, opacity: 0.35, depthWrite: false });
const wireMat = new THREE.LineBasicMaterial({ color: 0x111114, transparent: true, opacity: 0.6 });

function resize() { const p = canvas.parentElement; renderer.setSize(p.clientWidth, p.clientHeight, false); camera.aspect = p.clientWidth / p.clientHeight; camera.updateProjectionMatrix(); }
new ResizeObserver(resize).observe(canvas.parentElement);
(function loop() { controls.update(); renderer.render(scene, camera); requestAnimationFrame(loop); })();

/* ---------- body ---------- */
async function loadBody() {
  status('Loading body…');
  const g = await new GLTFLoader().loadAsync('assets/rigs/Michelle.glb');
  character = g.scene; character.traverse((o) => { if (o.isSkinnedMesh) bodyMesh = o; });
  bones = bonesByName(character); restPose = snapshotPose(bones);
  applyPose(restPose); character.updateMatrixWorld(true);
  body = bodyInfo(bones, sampleBody(bodyMesh).pos);
  bodyMesh.material = bodyMat; bodyMesh.frustumCulled = false;
  scene.add(character);
}

/* ---------- photo ---------- */
async function loadImage(file) {
  status(`Reading ${file.name}…`);
  state.name = file.name.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_') || 'garment';
  const img = await createImageBitmap(file);
  const k = Math.min(1, 1200 / Math.max(img.width, img.height));
  srcCanvas = document.createElement('canvas'); srcCanvas.width = Math.round(img.width * k); srcCanvas.height = Math.round(img.height * k);
  srcCanvas.getContext('2d').drawImage(img, 0, 0, srcCanvas.width, srcCanvas.height);
  $('#name').value = `${state.name}_3d`;
  await processCut(true);
}

async function processCut(guess) {
  status('Cutting the garment out of the background…'); await nextFrame();
  const g = srcCanvas.getContext('2d'), data = g.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
  cut = cutout(data, { tolerance: state.tolerance });
  if (!cut.bbox) { status('Couldn\'t find a garment — try a plainer background or raise Background tolerance.'); drawPhoto(); return; }
  if (guess) setType(guessType(cut), false);
  document.body.classList.add('loaded');
  await build();
}

function measure() {
  meas = state.type === 'pants' ? measurePants(cut) : measureTube(cut, state.type);
}

async function build() {
  if (!cut?.bbox || !body) return;
  status('Building the garment…'); await nextFrame();
  try {
    measure();
    tex = garmentTexture(srcCanvas, cut);
    const o = { size: state.size, lengthScale: state.length, riseScale: state.rise, density: state.density, sleeve: state.sleeve >= 0 ? state.sleeve : undefined };
    garment = state.type === 'pants' ? buildPants(body, meas, tex.crop, o) : state.type === 'skirt' ? buildSkirt(body, meas, tex.crop, o) : buildTop(body, meas, tex.crop, o);
    if (texture) texture.dispose();
    texture = new THREE.CanvasTexture(tex.canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 8;
    if (mesh) { scene.remove(mesh); mesh.traverse((o) => o.geometry?.dispose()); }
    mesh = new THREE.Group();
    const geo = toGeometry(garment);
    mesh.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: texture, roughness: 0.85, side: THREE.DoubleSide })));
    const w = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 1), wireMat); w.visible = state.wire; w.userData.wire = true; mesh.add(w);
    scene.add(mesh);
    drawPhoto();
    const cm = (v) => `${Math.round(v * 100)} cm`;
    const info = garment.info, quads = garment.faces.length;
    $('#facts').innerHTML = state.type === 'pants'
      ? `<b>${quads.toLocaleString()} quads</b> · waist at ${cm(info.waistY)} · inseam ${cm(body.crotchY - info.hemY)}${meas.cropped ? ' · hems were cut off in the photo, so the legs run to the floor (adjust with Length)' : ''}`
      : `<b>${quads.toLocaleString()} quads</b> · ${state.type === 'skirt' ? `length ${cm(info.waistY - info.hemY)}` : `hem at ${cm(info.hemY)}`}`;
    status(`${state.name}: ${state.type} built — ${quads.toLocaleString()} quads, rigged to the Motion Studio body.`);
  } catch (e) { console.error(e); status(`Couldn't build it: ${e.message}`); }
}

// photo with the cut-out and the measurement guides
function drawPhoto() {
  const c = $('#photo'), g = c.getContext('2d');
  c.width = srcCanvas.width; c.height = srcCanvas.height;
  g.drawImage(srcCanvas, 0, 0);
  if (!cut) return;
  const o = g.getImageData(0, 0, c.width, c.height), d = o.data;
  for (let i = 0; i < cut.mask.length; i++) if (!cut.mask[i]) { d[i * 4] = d[i * 4] * 0.25 + 10; d[i * 4 + 1] = d[i * 4 + 1] * 0.25 + 10; d[i * 4 + 2] = d[i * 4 + 2] * 0.25 + 14; }
  g.putImageData(o, 0, 0);
  if (!meas || !cut.bbox) return;
  const b = cut.bbox, line = (y, label) => { g.strokeStyle = '#e8ff5a'; g.lineWidth = Math.max(2, c.width / 400); g.setLineDash([10, 6]); g.beginPath(); g.moveTo(b.x0 - 10, y); g.lineTo(b.x1 + 10, y); g.stroke(); g.setLineDash([]); g.fillStyle = '#e8ff5a'; g.font = `${Math.round(c.width / 38)}px Inter Tight, sans-serif`; g.fillText(label, b.x1 + 14, y + 6); };
  if (meas.type === 'pants') { line(meas.top, 'waist'); line(meas.crotch, 'crotch'); line((meas.endL + meas.endR) / 2, 'hem'); }
  else { line(meas.top, meas.type === 'top' ? 'shoulder' : 'waist'); line(meas.bottom, 'hem'); }
}

/* ---------- outputs ---------- */
async function texturePNG() { const blob = await new Promise((r) => tex.canvas.toBlob(r, 'image/png')); return new Uint8Array(await blob.arrayBuffer()); }
const fileName = () => ($('#name').value.trim() || `${state.name}_3d`).replace(/[^\w.-]+/g, '_');
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 20000); }

async function exportOBJ() {
  if (!garment) return;
  const n = fileName(), { obj, mtl } = toOBJ(garment, n);
  const zip = zipSync({ [`${n}.obj`]: strToU8(obj), [`${n}.mtl`]: strToU8(mtl), [`${n}_texture.png`]: [await texturePNG(), { level: 0 }] });
  download(new Blob([zip], { type: 'application/zip' }), `${n}.zip`);
  status(`Saved ${n}.zip — quad mesh in the body's T-pose with UVs and texture. Blender: File › Import › Wavefront (.obj).`);
}

async function exportRig() {
  if (!garment) return;
  status('Rigging…'); await nextFrame();
  const n = fileName(), geo = toGeometry(garment);
  const res = fitGarment({ character, bodyMesh, bones, restPose, parts: [{ geometry: geo, label: n }], opts: { scale: 1, lift: 0, depth: 0, clearance: -1, prefit: true } });
  const group = new THREE.Group();
  const sm = new THREE.SkinnedMesh(res.geometries[0], new THREE.MeshStandardMaterial({ name: n, map: texture, roughness: 0.85 }));
  sm.name = n; group.add(sm); sm.updateMatrixWorld(true); sm.bind(res.skeleton, new THREE.Matrix4());
  const blob = await exportRiggedGLB({ character, bodyMesh, garment: group, skeleton: res.skeleton, bindPose: res.bindPose, applyPose, includeBody: $('#withbody').checked, clips: [], name: n });
  applyPose(restPose); character.updateMatrixWorld(true);
  download(blob, `${n}_rigged.glb`);
  status(`Saved ${n}_rigged.glb · ${(blob.size / 1e6).toFixed(1)} MB — armature + skinned garment (texture embedded). Blender: File › Import › glTF 2.0.`);
}

async function sendToStudio() {
  if (!garment) return;
  const n = fileName(), { obj } = toOBJ(garment, n);
  await putGarment({ name: n, obj, texture: new Blob([await texturePNG()], { type: 'image/png' }), created: Date.now() });
  location.href = 'index.html?garment=handoff';
}

/* ---------- UI ---------- */
function setType(t, go = true) {
  state.type = t;
  document.querySelectorAll('[data-type]').forEach((b) => b.classList.toggle('on', b.dataset.type === t));
  document.body.dataset.type = t;
  if (go) build();
}
document.querySelectorAll('[data-type]').forEach((b) => (b.onclick = () => setType(b.dataset.type)));
let deb;
for (const [id, key, fmt] of [['size', 'size', (v) => `${Math.round(v * 100)}%`], ['length', 'length', (v) => `${Math.round(v * 100)}%`], ['rise', 'rise', (v) => `${Math.round(v * 100)}%`], ['sleeve', 'sleeve', (v) => (v < 0 ? 'auto' : `${Math.round(v * 100)}%`)], ['density', 'density', (v) => `${v.toFixed(2)}×`], ['tolerance', 'tolerance', (v) => `${v.toFixed(2)}×`]]) {
  const el = $(`#${id}`), out = $(`#${id}-v`);
  el.value = state[key]; out.textContent = fmt(state[key]);
  el.oninput = () => { state[key] = +el.value; out.textContent = fmt(state[key]); clearTimeout(deb); deb = setTimeout(() => (key === 'tolerance' ? processCut(false) : build()), 220); };
}
$('#showbody').onchange = (e) => { if (character) character.visible = e.target.checked; };
$('#wire').onchange = (e) => { state.wire = e.target.checked; mesh?.traverse((o) => { if (o.userData.wire) o.visible = state.wire; }); };
$('#file').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadImage(f); };
window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drag'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('drag'); });
window.addEventListener('drop', (e) => { e.preventDefault(); document.body.classList.remove('drag'); const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/')); if (f) loadImage(f); });
$('#export-obj').onclick = exportOBJ;
$('#export-glb').onclick = exportRig;
$('#send').onclick = sendToStudio;

resize();
loadBody().then(() => status('Drop a photo of a garment — a flat lay or product shot on a plain background works best.')).catch((e) => status(`Couldn't load the body: ${e.message}`));
setType(state.type, false);

window.__img = { loadImage, setType, build, exportOBJ, exportRig, state, get garment() { return garment; }, get meas() { return meas; }, get cut() { return cut; }, get body() { return body; } };
