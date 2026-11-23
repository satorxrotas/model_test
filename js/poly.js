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
import { ready, extractParts, simplifyParts, toGeometry, countTris, countVerts, writeOBJ, writePolyOBJ, textureBytes } from './polycore.js';
import { polyFromOBJ, polyFromParts, makeSurface, reduceQuads, faceStats, gridScore, polyToGeometry, polyWire, panelsFrom } from './quadmesh.js';
import { unwrap, coverage } from './uvunwrap.js';

const $ = (s) => document.querySelector(s);
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const status = (msg) => { $('#status').textContent = msg; };
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const ms = (t) => (t < 1000 ? `${Math.round(t)} ms` : `${(t / 1000).toFixed(1)} s`);

const MODEL_EXT = ['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply'];
const state = { ratio: 0.25, topo: 'quads', autoUV: true, islands: 'frontback', upright: true, level: true, look: 'material', regularize: true, lockBorder: false, prune: false, shading: true, mergeSeams: false, view: 'split', wire: false, spin: false, split: 0.5 };
let parts = null, simplified = null, baseName = 'model', fileMap = new Map();
let base = null, surface = null, baseStats = null; // quad source mesh + BVH of the original surface
let result = null; // { mesh, uv, materials } when the polygon path is used (quad mode or auto UV)

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
const wireMat = new THREE.MeshBasicMaterial({ color: 0xe8ff5a, wireframe: true, transparent: true, opacity: 0.35, polygonOffset: true, polygonOffsetFactor: -1 });
const lineMat = new THREE.LineBasicMaterial({ color: 0x15151a, transparent: true, opacity: 0.85 });
const greyMat = new THREE.MeshStandardMaterial({ color: 0xbdbab4, roughness: 0.7, side: THREE.DoubleSide });

// UV checker: numbered squares make stretch and texel density easy to judge
const checker = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 1024;
  const g = c.getContext('2d'), n = 32, s = 1024 / n;
  const hues = [0, 30, 55, 140, 190, 220, 270, 320];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    g.fillStyle = (x + y) % 2 ? '#2d2d33' : '#e9e6df'; g.fillRect(x * s, y * s, s, s);
    if ((x + y) % 2 === 0) { g.fillStyle = `hsl(${hues[(x >> 1) % 8]} 70% 55%)`; g.fillRect(x * s + s * 0.38, y * s + s * 0.38, s * 0.24, s * 0.24); }
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
})();
const checkerMat = new THREE.MeshStandardMaterial({ map: checker, roughness: 0.8, side: THREE.DoubleSide });
// stripe preview: horizontal bands show at a glance whether stripes run level and meet at seams
const stripes = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 1024;
  const g = c.getContext('2d');
  for (let y = 0; y < 1024; y += 32) { g.fillStyle = '#ec78aa'; g.fillRect(0, y, 1024, 16); g.fillStyle = '#141416'; g.fillRect(0, y + 16, 1024, 16); g.fillStyle = '#f2f2f2'; g.fillRect(0, y + 14, 1024, 2); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
})();
const stripeMat = new THREE.MeshStandardMaterial({ map: stripes, roughness: 0.85, side: THREE.DoubleSide });

function disposeGroup(group) { group.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); group.clear(); }

function addWire(group, geom) { const w = new THREE.LineSegments(geom, lineMat); w.userData.wire = true; w.visible = state.wire; group.add(w); }

// triangle parts (original model, or triangle-mode result without auto UV)
function buildTriGroup(group, list, polyForWire) {
  disposeGroup(group);
  for (const p of list) {
    const mat = p.material.clone(); mat.side = THREE.DoubleSide; mat.vertexColors = false;
    const g = toGeometry(p);
    group.add(new THREE.Mesh(g, mat));
    if (!polyForWire) { const w = new THREE.Mesh(g, wireMat); w.userData.wire = true; w.visible = state.wire; group.add(w); }
  }
  if (polyForWire) addWire(group, polyWire(polyForWire)); // show the real quads, not render triangles
}

// polygon result (quad mode or auto UV): one mesh per material, per-corner UVs, polygon wire
function buildPolyGroup(group, r) {
  disposeGroup(group);
  const { mesh, uv, materials } = r;
  const byMat = new Map();
  mesh.faces.forEach((f, fi) => { const k = mesh.fmat[fi]; if (!byMat.has(k)) byMat.set(k, []); byMat.get(k).push(fi); });
  for (const [k, fis] of byMat) {
    const sub = { pos: mesh.pos, faces: fis.map((fi) => mesh.faces[fi]) };
    const g = polyToGeometry(sub, uv ? { ...uv, corner: fis.map((fi) => uv.corner[fi]) } : null);
    let mat;
    if (state.look === 'checker' && uv) mat = checkerMat;
    else if (state.look === 'stripes' && uv) mat = stripeMat;
    else { mat = (materials[k] || greyMat).clone(); mat.side = THREE.DoubleSide; mat.vertexColors = false; if (uv || state.topo === 'quads') { mat.map = null; mat.normalMap = null; } mat.needsUpdate = true; }
    group.add(new THREE.Mesh(g, mat));
  }
  addWire(group, polyWire(mesh));
}

function setWire(on) { state.wire = on; scene.traverse((o) => { if (o.userData.wire) o.visible = on; }); }

function frame(obj) {
  const box = new THREE.Box3().setFromObject(obj), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const r = Math.max(size.x, size.y, size.z) || 1;
  controls.target.copy(c);
  camera.near = r / 500; camera.far = r * 50; camera.updateProjectionMatrix();
  camera.position.copy(c).add(new THREE.Vector3(0.35, 0.18, 1).normalize().multiplyScalar(r * 1.9));
  grid.scale.setScalar(r * 2.5); grid.position.set(c.x, box.min.y, c.z);
  const n3 = (v) => Number(v.toPrecision(3)).toLocaleString('en-US');
  $('#size').textContent = `${n3(size.x)} × ${n3(size.y)} × ${n3(size.z)} units`;
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
    const b = decodeURIComponent(url.split(/[?#]/)[0].split(/[\\/]/).pop()).toLowerCase();
    return urls.get(b) || url;
  });
  manager.revoke = () => urls.forEach((u) => URL.revokeObjectURL(u));
  return { manager, urlOf: (name) => urls.get(name.toLowerCase()) };
}

// remember which uploaded file each texture came from, so export can reuse the original bytes
async function tagTextures(root) {
  const jobs = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      for (const t of [m.map, m.normalMap]) {
        if (!t || t.userData.fileName !== undefined) continue;
        const src = t.userData.sourceName || t.name || '';
        const file = fileMap.get(src.toLowerCase());
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
  base = surface = result = null;
  await nextFrame();
  const { manager, urlOf } = makeManager();
  // keep each texture's file name (loaders don't), so the export can reference and reuse it
  const origLoad = THREE.ImageLoader.prototype.load;
  const reverse = new Map([...fileMap.entries()].map(([k, f]) => [urlOf(k), f.name]));
  THREE.TextureLoader.prototype.load = function (url, onLoad, onProgress, onError) {
    const tex = new THREE.Texture();
    tex.userData.sourceName = reverse.get(this.manager.resolveURL(url)) || decodeURIComponent(String(url).split('/').pop());
    const loader = new THREE.ImageLoader(this.manager); loader.setCrossOrigin(this.crossOrigin); loader.setPath(this.path);
    origLoad.call(loader, url, (image) => { tex.image = image; tex.needsUpdate = true; onLoad && onLoad(tex); }, onProgress, onError);
    return tex;
  };
  try {
    let root, flipV = false, objText = null;
    const url = urlOf(main.name);
    if (ext === 'glb' || ext === 'gltf') {
      const gl = new GLTFLoader(manager);
      gl.setDRACOLoader(new DRACOLoader().setDecoderPath('vendor/three/addons/libs/draco/gltf/'));
      gl.setMeshoptDecoder(MeshoptDecoder);
      const res = await gl.loadAsync(url);
      root = res.scene; flipV = true;
    } else if (ext === 'obj') {
      objText = await main.text();
      const obj = new OBJLoader(manager);
      const lib = (objText.match(/^mtllib\s+(.+)$/m) || [])[1]?.trim();
      const mtlFile = lib && fileMap.get(lib.split(/[\\/]/).pop().toLowerCase());
      if (mtlFile) {
        const mats = new MTLLoader(manager).parse(await mtlFile.text(), '');
        mats.preload(); obj.setMaterials(mats);
      }
      root = obj.parse(objText);
      if (!mtlFile) root.traverse((o) => { if (o.isMesh) o.material = new THREE.MeshStandardMaterial({ name: [].concat(o.material)[0]?.name || 'default', color: 0xbdbab4, roughness: 0.7 }); });
      await new Promise((r) => { if (manager.itemsLoaded >= manager.itemsTotal) r(); else manager.onLoad = r; setTimeout(r, 8000); });
    } else if (ext === 'fbx') {
      root = new FBXLoader(manager).parse(await main.arrayBuffer(), '');
    } else {
      const geo = ext === 'stl' ? new STLLoader().parse(await main.arrayBuffer()) : new PLYLoader().parse(await main.arrayBuffer());
      if (!geo.attributes.normal) geo.computeVertexNormals();
      root = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xbdbab4, roughness: 0.6 }));
    }
    await tagTextures(root);
    status('Preparing mesh…'); await nextFrame();
    await ready;
    parts = extractParts(root, { flipV });
    if (!parts.length) throw new Error('That file has no mesh geometry.');
    // polygon version of the source: native OBJ faces, or quads rebuilt from triangles
    base = objText ? polyFromOBJ(objText) : polyFromParts(parts, { pairQuads: true });
    baseStats = faceStats(base);
    const quadShare = baseStats.quads / Math.max(1, baseStats.faces), grid = gridScore(base);
    const isGrid = quadShare >= 0.7 && grid >= 0.6;
    setTopo(isGrid ? 'quads' : 'tris', false);
    const textured = parts.some((p) => p.material?.map);
    state.autoUV = !textured; $('#autoUV').checked = state.autoUV; document.body.classList.toggle('autouv', state.autoUV);
for (const id of ['upright', 'level', 'regularize']) $(`#${id}`).checked = state[id];
    $('#detected').textContent = `${isGrid ? `Clean quad grid (${Math.round(quadShare * 100)}% quads)` : quadShare >= 0.7 ? `Quads, but no regular grid (${Math.round(grid * 100)}% grid)` : `Triangle mesh (${Math.round(quadShare * 100)}% quads)`} → ${isGrid ? 'Quads' : 'Triangles'} mode.${textured ? ' Auto UV is off because this model has textures; turning it on replaces its UVs.' : ''}`;
    buildOrig();
    frame(origGroup);
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

function buildOrig() {
  if (!parts) return;
  buildTriGroup(origGroup, parts, state.topo === 'quads' ? base : null);
  const quad = state.topo === 'quads';
  $('#orig-faces').textContent = fmt(quad ? baseStats.faces : countTris(parts));
  $('#orig-verts').textContent = fmt(quad ? baseStats.verts : countVerts(parts));
  $('#orig-quads').textContent = quad ? `${Math.round((100 * baseStats.quads) / Math.max(1, baseStats.faces))}%` : '—';
}

/* ---------------- process ---------------- */

const sourceFaces = () => (state.topo === 'quads' ? baseStats.faces : countTris(parts));
const materialsFor = (names) => names.map((n, i) => parts.find((p) => (p.material?.name || '') === n)?.material || parts[i]?.material || null);

let running = false, queued = false;
async function run() {
  if (!parts) return;
  if (running) { queued = true; return; }
  running = true;
  try {
    const total = sourceFaces(), target = Math.max(4, Math.round(total * state.ratio));
    let t0 = performance.now(), tReduce, tUV = 0, faces, verts, quadPct = '—';
    if (state.topo === 'quads') {
      status(`Reducing ${fmt(total)} faces to a ${fmt(target)}-face quad grid…`); await nextFrame();
      if (!surface) surface = makeSurface(base);
      const mesh = state.ratio >= 0.999 ? base : reduceQuads(base, target, { surface });
      tReduce = performance.now() - t0;
      let uv = null;
      if (state.autoUV) { status('Unwrapping UVs…'); await nextFrame(); t0 = performance.now(); uv = unwrap(mesh, uvOpts()); tUV = performance.now() - t0; }
      result = { mesh, uv, materials: materialsFor(mesh.matNames || []) };
      simplified = null;
      buildPolyGroup(simpGroup, result);
      const st = faceStats(mesh); faces = st.faces; verts = st.verts; quadPct = `${((100 * st.quads) / Math.max(1, st.faces)).toFixed(1)}%`;
    } else {
      status(`Simplifying ${fmt(total)} triangles…`); await nextFrame();
      simplified = simplifyParts(parts, state.ratio, state);
      tReduce = performance.now() - t0;
      faces = countTris(simplified); verts = countVerts(simplified);
      if (state.autoUV) {
        status('Unwrapping UVs…'); await nextFrame(); t0 = performance.now();
        const mesh = polyFromParts(simplified, { pairQuads: false });
        if (state.islands === 'panels') { if (!surface) surface = makeSurface(base); panelsFrom(mesh, base, surface); }
        result = { mesh, uv: unwrap(mesh, uvOpts()), materials: simplified.map((p) => p.material) };
        tUV = performance.now() - t0;
        buildPolyGroup(simpGroup, result);
      } else { result = null; buildTriGroup(simpGroup, simplified); }
    }
    $('#low-faces').textContent = fmt(faces);
    $('#low-verts').textContent = fmt(verts);
    $('#low-quads').textContent = quadPct;
    $('#reduction').textContent = `${(100 * (1 - faces / total)).toFixed(1)}%`;
    const unit = state.topo === 'quads' ? 'faces' : 'tris';
    $('#lbl-orig').textContent = `Original · ${fmt(total)} ${unit}`;
    $('#lbl-low').textContent = `Low poly · ${fmt(faces)} ${unit}`;
    drawUV();
    let msg = `${baseName} · ${fmt(total)} → ${fmt(faces)} ${state.topo === 'quads' ? `faces (${quadPct} quads)` : 'triangles'} in ${ms(tReduce)}`;
    if (result?.uv) msg += ` · UVs: ${result.uv.islands} island${result.uv.islands === 1 ? '' : 's'}${state.level && state.upright ? `, ${result.uv.levelled} level` : ''}, ${Math.round(coverage(result.mesh, result.uv) * 100)}% of the square, ${ms(tUV)}`;
    if (state.topo === 'tris' && faces > Math.ceil(total * state.ratio) * 1.15 + 12) msg += ` · stopped early to keep ${state.lockBorder ? 'protected open edges' : 'UV seams / hard edges'}${state.mergeSeams ? '' : ' — try “Allow collapsing across UV seams”'}`;
    status(msg);
  } catch (e) {
    console.error(e); status(`Something went wrong: ${e.message}`);
  }
  running = false;
  if (queued) { queued = false; run(); }
}

const uvOpts = () => ({ mode: state.islands, upright: state.upright, alignHeight: state.upright && state.level, level: state.upright && state.level });

/* ---------------- UV layout ---------------- */

function paintUV(cnv, size, bg, fill, line, lw) {
  const g = cnv.getContext('2d'); cnv.width = cnv.height = size;
  g.fillStyle = bg; g.fillRect(0, 0, size, size);
  if (!result?.uv) return false;
  const { mesh, uv } = result, U = uv.uvs;
  g.beginPath();
  mesh.faces.forEach((f, fi) => {
    const c = uv.corner[fi];
    g.moveTo(U[c[0] * 2] * size, (1 - U[c[0] * 2 + 1]) * size);
    for (let k = 1; k < f.length; k++) g.lineTo(U[c[k] * 2] * size, (1 - U[c[k] * 2 + 1]) * size);
    g.closePath();
  });
  if (fill) { g.fillStyle = fill; g.fill(); }
  g.strokeStyle = line; g.lineWidth = lw; g.stroke();
  return true;
}
function drawUV() {
  const ok = paintUV($('#uvmap'), 480, '#111114', 'rgba(232,255,90,.16)', 'rgba(232,255,90,.75)', 0.6);
  $('#uvbox').hidden = !ok;
  if (ok) $('#uvinfo').textContent = `${result.uv.islands} islands · ${Math.round(coverage(result.mesh, result.uv) * 100)}% of the square used`;
}
async function uvLayoutPNG() {
  const c = document.createElement('canvas');
  if (!paintUV(c, 2048, '#ffffff', null, '#000000', 1.2)) return null;
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

/* ---------------- export ---------------- */

async function exportOBJ(withMaterials) {
  if (!simplified && !result) return;
  const name = ($('#name').value.trim() || `${baseName}_lowpoly`).replace(/[^\w.-]+/g, '_');
  status('Writing OBJ…'); await nextFrame();
  let obj, files = {}, note = '';
  if (result) {
    const w = writePolyOBJ(result.mesh, result.uv, result.materials, name);
    obj = w.obj;
    files[`${name}.mtl`] = strToU8(w.mtl);
    if (result.uv) { const png = await uvLayoutPNG(); if (png) { files[`${name}_uv_layout.png`] = [png, { level: 0 }]; note = ' · UV layout included'; } }
  } else {
    const w = writeOBJ(simplified, name);
    obj = w.obj;
    files[`${name}.mtl`] = strToU8(w.mtl);
    for (const { texture, path } of w.textures) files[path] = [await textureBytes(texture, path), { level: 0 }];
    if (w.textures.length) note = ` · ${w.textures.length} texture${w.textures.length === 1 ? '' : 's'}`;
  }
  let blob, file;
  if (withMaterials) {
    files[`${name}.obj`] = strToU8(obj);
    blob = new Blob([zipSync(files, { level: 6 })], { type: 'application/zip' }); file = `${name}.zip`;
  } else { blob = new Blob([obj], { type: 'text/plain' }); file = `${name}.obj`; note = ''; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 20000);
  status(`Saved ${file} · ${(blob.size / 1e6).toFixed(1)} MB${note} — Blender: File › Import › Wavefront (.obj)`);
}

/* ---------------- UI ---------------- */

// slider position 0..1000 → keep 0.5%..100% on a log scale, so low counts are easy to dial in
const toRatio = (v) => 0.005 * Math.pow(200, v / 1000);
const toSlider = (r) => Math.round((1000 * Math.log(r / 0.005)) / Math.log(200));
function showRatio() {
  const pct = state.ratio * 100;
  $('#ratio-v').textContent = `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
  if (parts && baseStats) $('#target').value = Math.round(sourceFaces() * state.ratio);
  document.querySelectorAll('[data-pct]').forEach((b) => b.classList.toggle('on', Math.abs(+b.dataset.pct / 100 - state.ratio) < 1e-4));
}
function setRatio(r, go = true) {
  state.ratio = Math.min(1, Math.max(0.0005, r));
  $('#ratio').value = toSlider(Math.max(0.005, state.ratio));
  showRatio();
  if (go) run();
}
function setTopo(t, go = true) {
  state.topo = t;
  document.body.classList.toggle('quadmode', t === 'quads');
  document.querySelectorAll('[data-topo]').forEach((b) => b.classList.toggle('on', b.dataset.topo === t));
  $('#unit').textContent = t === 'quads' ? 'faces' : 'triangles';
  showRatio();
  if (go) { buildOrig(); run(); }
}

let debounce;
$('#ratio').addEventListener('input', (e) => {
  state.ratio = toRatio(+e.target.value); showRatio();
  clearTimeout(debounce);
  const heavy = state.topo === 'quads' || state.autoUV || (parts && countTris(parts) > 600000);
  debounce = setTimeout(run, heavy ? 450 : 60);
});
$('#target').addEventListener('change', (e) => parts && setRatio(+e.target.value / sourceFaces()));
document.querySelectorAll('[data-pct]').forEach((b) => (b.onclick = () => setRatio(+b.dataset.pct / 100)));
document.querySelectorAll('[data-topo]').forEach((b) => (b.onclick = () => setTopo(b.dataset.topo)));
for (const id of ['lockBorder', 'prune', 'shading', 'mergeSeams', 'autoUV', 'upright', 'level', 'regularize']) $(`#${id}`).onchange = (e) => { state[id] = e.target.checked; document.body.classList.toggle('autouv', state.autoUV); run(); };
document.querySelectorAll('[data-islands]').forEach((b) => (b.onclick = () => {
  state.islands = b.dataset.islands;
  document.querySelectorAll('[data-islands]').forEach((x) => x.classList.toggle('on', x === b));
  run();
}));
document.querySelectorAll('[data-look]').forEach((b) => (b.onclick = () => {
  state.look = b.dataset.look;
  document.querySelectorAll('[data-look]').forEach((x) => x.classList.toggle('on', x === b));
  if (result) buildPolyGroup(simpGroup, result);
}));
document.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => {
  state.view = b.dataset.view;
  document.body.classList.toggle('split', state.view === 'split');
  document.querySelectorAll('[data-view]').forEach((x) => x.classList.toggle('on', x === b));
}));
$('#wire').onchange = (e) => setWire(e.target.checked);
$('#spin').onchange = (e) => { state.spin = e.target.checked; };
$('#export-zip').onclick = () => exportOBJ(true);
$('#export-obj').onclick = () => exportOBJ(false);
$('#uv-png').onclick = async () => {
  const png = await uvLayoutPNG(); if (!png) return;
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
  a.download = `${($('#name').value.trim() || baseName).replace(/[^\w.-]+/g, '_')}_uv_layout.png`; a.click();
};
$('#file').onchange = (e) => { const f = [...e.target.files]; e.target.value = ''; if (f.length) loadFiles(f); };
window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drag'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('drag'); });
window.addEventListener('drop', (e) => { e.preventDefault(); document.body.classList.remove('drag'); if (e.dataTransfer.files.length) loadFiles([...e.dataTransfer.files]); });

$('#autoUV').checked = state.autoUV; document.body.classList.toggle('autouv', state.autoUV);
for (const id of ['upright', 'level', 'regularize']) $(`#${id}`).checked = state[id];
setTopo(state.topo, false);
setRatio(state.ratio, false);
resize();
requestAnimationFrame(render);
status('Drop a high-poly model to start.');

// test hooks
window.__poly = { loadFiles, setRatio, setTopo, exportOBJ, get parts() { return parts; }, get result() { return result; }, get simplified() { return simplified; }, state };
