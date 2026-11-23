import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { zipSync, unzipSync, strToU8 } from 'three/addons/libs/fflate.module.js';
import { MeshoptDecoder } from '../vendor/meshoptimizer/meshopt_decoder.module.js';
import { ready, extractParts, simplifyParts, toGeometry, countTris, countVerts, writeOBJ, textureBytes } from './polycore.js';

const $ = (s) => document.querySelector(s);
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const status = (msg) => { $('#status').textContent = msg; };
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

const MODEL_EXT = ['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply'];
const state = { ratio: 0.25, lockBorder: false, prune: false, shading: true, mergeSeams: false, view: 'split', wire: false, spin: false, split: 0.5 };
let parts = null, simplified = null, baseName = 'model', fileMap = new Map();

/* ---------------- viewer ---------------- */

const canvas = $('#stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#16161a');
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.8;
const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(3, 5, 4); scene.add(key);
const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
const grid = new THREE.GridHelper(1, 20, 0x3a3a40, 0x26262b); scene.add(grid);

const origGroup = new THREE.Group(), simpGroup = new THREE.Group();
scene.add(origGroup, simpGroup);
const wireMat = new THREE.MeshBasicMaterial({ color: 0xe8ff5a, wireframe: true, transparent: true, opacity: 0.35, depthTest: true, polygonOffset: true, polygonOffsetFactor: -1 });

function buildGroup(group, list) {
  group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
  group.clear();
  for (const p of list) {
    const g = toGeometry(p);
    const mat = p.material.clone(); mat.side = THREE.DoubleSide; mat.vertexColors = false;
    group.add(new THREE.Mesh(g, mat));
    const w = new THREE.Mesh(g, wireMat); w.userData.wire = true; w.visible = state.wire; group.add(w);
  }
}
function setWire(on) { state.wire = on; scene.traverse((o) => { if (o.userData.wire) o.visible = on; }); }

function frame(obj) {
  const box = new THREE.Box3().setFromObject(obj), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const r = Math.max(size.x, size.y, size.z) || 1;
  controls.target.copy(c);
  camera.near = r / 500; camera.far = r * 50; camera.updateProjectionMatrix();
  camera.position.copy(c).add(new THREE.Vector3(0.35, 0.18, 1).normalize().multiplyScalar(r * 1.9));
  grid.scale.setScalar(r * 2.5); grid.position.set(c.x, box.min.y, c.z);
  $('#size').textContent = `${size.x.toPrecision(3)} × ${size.y.toPrecision(3)} × ${size.z.toPrecision(3)} units`;
}

function resize() {
  const w = canvas.parentElement.clientWidth, h = canvas.parentElement.clientHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas.parentElement);

function render() {
  controls.autoRotate = state.spin; controls.autoRotateSpeed = 1.2;
  controls.update();
  const w = canvas.width, h = canvas.height, dpr = renderer.getPixelRatio();
  const showSplit = state.view === 'split' && parts;
  if (showSplit) {
    const x = Math.round((w / dpr) * state.split);
    renderer.setScissorTest(true);
    origGroup.visible = true; simpGroup.visible = false;
    renderer.setScissor(0, 0, x, h / dpr); renderer.render(scene, camera);
    origGroup.visible = false; simpGroup.visible = true;
    renderer.setScissor(x, 0, w / dpr - x, h / dpr); renderer.render(scene, camera);
    renderer.setScissorTest(false);
  } else {
    origGroup.visible = state.view === 'original'; simpGroup.visible = state.view !== 'original';
    renderer.render(scene, camera);
  }
  $('#divider').hidden = !showSplit;
  $('#divider').style.left = `${state.split * 100}%`;
  requestAnimationFrame(render);
}

// draggable split
{
  const d = $('#divider'); let drag = false;
  d.addEventListener('pointerdown', (e) => { drag = true; d.setPointerCapture(e.pointerId); controls.enabled = false; });
  d.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = canvas.getBoundingClientRect();
    state.split = Math.min(0.95, Math.max(0.05, (e.clientX - r.left) / r.width));
  });
  d.addEventListener('pointerup', () => { drag = false; controls.enabled = true; });
}

/* ---------------- loading ---------------- */

function makeManager() {
  const urls = new Map();
  for (const [name, file] of fileMap) urls.set(name, URL.createObjectURL(file));
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (/^data:/.test(url)) return url;
    const base = decodeURIComponent(url.split(/[?#]/)[0].split(/[\\/]/).pop()).toLowerCase();
    return urls.get(base) || url;
  });
  manager.revoke = () => urls.forEach((u) => URL.revokeObjectURL(u));
  return { manager, urlOf: (name) => urls.get(name.toLowerCase()) };
}

// remember which uploaded file each texture came from, so export can reuse the original bytes
async function tagTextures(root) {
  const byUrl = new Map();
  for (const [name, file] of fileMap) byUrl.set(name, file);
  const jobs = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      for (const t of [m.map, m.normalMap]) {
        if (!t || t.userData.fileName !== undefined) continue;
        const src = t.userData.sourceName || t.name || '';
        const file = byUrl.get(src.toLowerCase());
        t.userData.fileName = file ? src : '';
        if (file) jobs.push(file.arrayBuffer().then((b) => { t.userData.bytes = new Uint8Array(b); }));
      }
    }
  });
  await Promise.all(jobs);
}

async function loadFiles(list) {
  fileMap = new Map();
  for (const f of list) {
    if (/\.zip$/i.test(f.name)) {
      const files = unzipSync(new Uint8Array(await f.arrayBuffer()));
      for (const [path, bytes] of Object.entries(files)) {
        if (path.endsWith('/') || /(^|\/)__MACOSX\//.test(path)) continue;
        const name = path.split('/').pop();
        fileMap.set(name.toLowerCase(), new File([bytes], name));
      }
    } else fileMap.set(f.name.toLowerCase(), f);
  }
  const main = [...fileMap.values()].find((f) => MODEL_EXT.includes(f.name.split('.').pop().toLowerCase()));
  if (!main) { status('No model found — use .glb, .gltf, .obj, .fbx, .stl or .ply (a .zip of them works too).'); return; }
  const ext = main.name.split('.').pop().toLowerCase();
  baseName = main.name.replace(/\.[^.]+$/, '');
  status(`Loading ${main.name} (${(main.size / 1e6).toFixed(1)} MB)…`);
  document.body.classList.remove('loaded');
  await nextFrame();
  const { manager, urlOf } = makeManager();
  // keep each texture's file name (loaders don't), so the export can reference and reuse it
  const origLoad = THREE.ImageLoader.prototype.load;
  const reverse = new Map([...fileMap.entries()].map(([k, f]) => [urlOf(k), f.name]));
  THREE.TextureLoader.prototype.load = function (url, onLoad, onProgress, onError) {
    const tex = new THREE.Texture();
    const real = this.manager.resolveURL(url);
    tex.userData.sourceName = reverse.get(real) || decodeURIComponent(String(url).split('/').pop());
    const loader = new THREE.ImageLoader(this.manager); loader.setCrossOrigin(this.crossOrigin); loader.setPath(this.path);
    origLoad.call(loader, url, (image) => { tex.image = image; tex.needsUpdate = true; onLoad && onLoad(tex); }, onProgress, onError);
    return tex;
  };
  try {
    let root, flipV = false;
    const url = urlOf(main.name);
    if (ext === 'glb' || ext === 'gltf') {
      const gl = new GLTFLoader(manager);
      gl.setDRACOLoader(new DRACOLoader().setDecoderPath('vendor/three/addons/libs/draco/gltf/'));
      gl.setMeshoptDecoder(MeshoptDecoder);
      const res = await gl.loadAsync(url);
      root = res.scene; flipV = true;
    } else if (ext === 'obj') {
      const text = await main.text();
      const obj = new OBJLoader(manager);
      const lib = (text.match(/^mtllib\s+(.+)$/m) || [])[1]?.trim();
      const mtlFile = lib && fileMap.get(lib.split(/[\\/]/).pop().toLowerCase());
      if (mtlFile) {
        const mats = new MTLLoader(manager).parse(await mtlFile.text(), '');
        mats.preload(); obj.setMaterials(mats);
      }
      root = obj.parse(text);
      if (!mtlFile) root.traverse((o) => { if (o.isMesh) o.material = new THREE.MeshStandardMaterial({ name: o.material?.name || 'default', color: 0xbdbab4, roughness: 0.7 }); });
      await new Promise((r) => { if (manager.itemsLoaded >= manager.itemsTotal) r(); else manager.onLoad = r; setTimeout(r, 8000); });
    } else if (ext === 'fbx') {
      root = new FBXLoader(manager).parse(await main.arrayBuffer(), '');
    } else {
      const geo = ext === 'stl' ? new STLLoader().parse(await main.arrayBuffer()) : new PLYLoader().parse(await main.arrayBuffer());
      if (!geo.attributes.normal) geo.computeVertexNormals();
      root = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: geo.attributes.color ? 0xffffff : 0xbdbab4, vertexColors: !!geo.attributes.color, roughness: 0.6 }));
    }
    await tagTextures(root);
    status('Preparing mesh…'); await nextFrame();
    await ready;
    parts = extractParts(root, { flipV });
    if (!parts.length) throw new Error('That file has no mesh geometry.');
    buildGroup(origGroup, parts);
    frame(origGroup);
    $('#orig-tris').textContent = fmt(countTris(parts));
    $('#orig-verts').textContent = fmt(countVerts(parts));
    $('#name').value = `${baseName}_lowpoly`;
    document.body.classList.add('loaded');
    await run();
  } catch (e) {
    console.error(e); status(`Couldn't load ${main.name}: ${e.message}`);
  } finally {
    THREE.TextureLoader.prototype.load = TextureLoaderLoad;
    setTimeout(() => manager.revoke(), 30000);
  }
}
const TextureLoaderLoad = THREE.TextureLoader.prototype.load;

/* ---------------- simplify ---------------- */

let running = false, queued = false;
async function run() {
  if (!parts) return;
  if (running) { queued = true; return; }
  running = true;
  const total = countTris(parts);
  status(`Simplifying ${fmt(total)} triangles…`); await nextFrame();
  const t0 = performance.now();
  simplified = simplifyParts(parts, state.ratio, state);
  const ms = performance.now() - t0;
  buildGroup(simpGroup, simplified);
  const tris = countTris(simplified), verts = countVerts(simplified);
  $('#low-tris').textContent = fmt(tris);
  $('#low-verts').textContent = fmt(verts);
  $('#reduction').textContent = `${(100 * (1 - tris / total)).toFixed(1)}%`;
  $('#lbl-orig').textContent = `Original · ${fmt(total)} tris`;
  $('#lbl-low').textContent = `Low poly · ${fmt(tris)} tris`;
  const short = tris > Math.ceil(total * state.ratio) * 1.15 + 12;
  const why = state.lockBorder ? 'protected open edges' : 'UV seams / hard edges';
  status(`${baseName} · ${fmt(total)} → ${fmt(tris)} triangles in ${ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s'}${short ? ` · stopped early to keep ${why}${state.mergeSeams ? '' : ' — try “Allow collapsing across UV seams”'}` : ''}`);
  running = false;
  if (queued) { queued = false; run(); }
}

/* ---------------- export ---------------- */

async function exportOBJ(withMaterials) {
  if (!simplified) return;
  const name = ($('#name').value.trim() || `${baseName}_lowpoly`).replace(/[^\w.-]+/g, '_');
  status('Writing OBJ…'); await nextFrame();
  const { obj, mtl, textures } = writeOBJ(simplified, name);
  let blob, file;
  if (withMaterials) {
    const files = { [`${name}.obj`]: strToU8(obj), [`${name}.mtl`]: strToU8(mtl) };
    for (const { texture, path } of textures) files[path] = [await textureBytes(texture, path), { level: 0 }];
    blob = new Blob([zipSync(files, { level: 6 })], { type: 'application/zip' }); file = `${name}.zip`;
  } else {
    blob = new Blob([obj], { type: 'text/plain' }); file = `${name}.obj`;
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 20000);
  status(`Saved ${file} · ${(blob.size / 1e6).toFixed(1)} MB${withMaterials ? ` · ${textures.length} texture${textures.length === 1 ? '' : 's'}` : ''} — Blender: File › Import › Wavefront (.obj)`);
}

/* ---------------- UI ---------------- */

// slider position 0..1000 → keep 0.5%..100% on a log scale, so low counts are easy to dial in
const toRatio = (v) => 0.005 * Math.pow(200, v / 1000);
const toSlider = (r) => Math.round((1000 * Math.log(r / 0.005)) / Math.log(200));
function showRatio() {
  const pct = state.ratio * 100;
  $('#ratio-v').textContent = `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
  if (parts) $('#target').value = Math.round(countTris(parts) * state.ratio);
  document.querySelectorAll('[data-pct]').forEach((b) => b.classList.toggle('on', Math.abs(+b.dataset.pct / 100 - state.ratio) < 1e-4));
}
function setRatio(r, go = true) {
  state.ratio = Math.min(1, Math.max(0.0005, r));
  $('#ratio').value = toSlider(Math.max(0.005, state.ratio));
  showRatio();
  if (go) run();
}

let debounce;
$('#ratio').addEventListener('input', (e) => {
  state.ratio = toRatio(+e.target.value); showRatio();
  clearTimeout(debounce);
  debounce = setTimeout(run, parts && countTris(parts) > 600000 ? 350 : 60);
});
$('#target').addEventListener('change', (e) => parts && setRatio(+e.target.value / countTris(parts)));
document.querySelectorAll('[data-pct]').forEach((b) => (b.onclick = () => setRatio(+b.dataset.pct / 100)));
for (const id of ['lockBorder', 'prune', 'shading', 'mergeSeams']) $(`#${id}`).onchange = (e) => { state[id] = e.target.checked; run(); };
document.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => {
  state.view = b.dataset.view;
  document.body.classList.toggle('split', state.view === 'split');
  document.querySelectorAll('[data-view]').forEach((x) => x.classList.toggle('on', x === b));
}));
$('#wire').onchange = (e) => setWire(e.target.checked);
$('#spin').onchange = (e) => { state.spin = e.target.checked; };
$('#export-zip').onclick = () => exportOBJ(true);
$('#export-obj').onclick = () => exportOBJ(false);
$('#file').onchange = (e) => { const f = [...e.target.files]; e.target.value = ''; if (f.length) loadFiles(f); };
window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drag'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('drag'); });
window.addEventListener('drop', (e) => { e.preventDefault(); document.body.classList.remove('drag'); if (e.dataTransfer.files.length) loadFiles([...e.dataTransfer.files]); });

setRatio(state.ratio, false);
resize();
requestAnimationFrame(render);
status('Drop a high-poly model to start.');

// test hooks
window.__poly = { loadFiles, setRatio, exportOBJ, get parts() { return parts; }, get simplified() { return simplified; }, state, writeOBJ };
