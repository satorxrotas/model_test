import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { extractParts, fitGarment, bonesByName, snapshotPose, applyPose, SHAPES, SHAPE_PRESETS } from './autoskin.js';
import { exportRiggedGLB } from './exportrig.js';
import { POSES, bakePoses } from './poses.js';
import { REF_MOTION } from './refmotion.js';

const $ = (s) => document.querySelector(s);
const status = (msg) => { $('#status').textContent = msg; };

/* ---------------- config ---------------- */

const FORMATS = {
  '9x16': { w: 1080, h: 1920, label: '9:16 · Reels / TikTok / Shorts' },
  '4x5': { w: 1080, h: 1350, label: '4:5 · Feed' },
  '1x1': { w: 1080, h: 1080, label: '1:1 · Square' },
  '16x9': { w: 1920, h: 1080, label: '16:9 · YouTube' },
};

const MOTIONS = [
  ...POSES.map((p) => ({ id: p.id, label: p.label, group: 'Model poses · in place' })),
  { id: 'idle', label: 'Idle', src: 'Xbot', clip: 'idle', group: 'Movement' },
  { id: 'walk', label: 'Walk', src: 'Xbot', clip: 'walk', group: 'Movement' },
  { id: 'run', label: 'Run', src: 'Xbot', clip: 'run', group: 'Movement' },
  { id: 'samba', label: 'Dance', src: 'Michelle', clip: 'SambaDance', group: 'Movement' },
  { id: 'agree', label: 'Nod', src: 'Xbot', clip: 'agree', group: 'Movement' },
  { id: 'shake', label: 'Head shake', src: 'Xbot', clip: 'headShake', group: 'Movement' },
  { id: 'sad', label: 'Held — slouch', src: 'Xbot', clip: 'sad_pose', group: 'Held' },
  { id: 'sneak', label: 'Held — crouch', src: 'Xbot', clip: 'sneak_pose', group: 'Held' },
  { id: 'apose', label: 'Static (fit pose)', group: 'Held' },
];

const CAMERAS = [
  { id: 'reference', label: 'Reference — low & level' },
  { id: 'refpush', label: 'Reference + push-in (as in clip)' },
  { id: 'turntable', label: 'Turntable 360°' },
  { id: 'sway', label: 'Front sway' },
  { id: 'push', label: 'Slow push-in' },
  { id: 'hero', label: 'Low-angle hero' },
  { id: 'detail', label: 'Upper-body detail' },
  { id: 'lower', label: 'Lower-body detail' },
  { id: 'free', label: 'Free (drag to orbit)' },
];

const BACKGROUNDS = ['#d8d4cd', '#efebe4', '#1b1b1d', '#0a0a0a', '#c7cdd4', '#e7d9cf', '#00b140'];

const state = {
  format: '9x16', motion: 'p_ref', camera: 'reference', speed: 1, camSpeed: 1,
  body: 'invisible', bg: BACKGROUNDS[0], floorShadow: true,
  fit: { scale: 1, lift: 0, depth: 0, clearance: 0.006 },
  partColors: {},
  shape: { ...SHAPE_PRESETS.inspo },
};

/* ---------------- renderer / scene ---------------- */

const canvas = $('#stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(state.bg);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;

const camera = new THREE.PerspectiveCamera(28, 9 / 16, 0.05, 100);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.enabled = false;

const key = new THREE.DirectionalLight(0xfff4ea, 2.4);
key.position.set(2.2, 4.2, 3.0);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -1.5; key.shadow.camera.right = 1.5; key.shadow.camera.top = 2.5; key.shadow.camera.bottom = -0.5;
key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02; key.shadow.radius = 4;
scene.add(key);
const rim = new THREE.DirectionalLight(0xdfe8ff, 1.6); rim.position.set(-2.5, 3, -3.5); scene.add(rim);
const fill = new THREE.HemisphereLight(0xffffff, 0x8a8278, 0.6); scene.add(fill);

const floor = new THREE.Mesh(new THREE.CircleGeometry(6, 64), new THREE.ShadowMaterial({ opacity: 0.22 }));
floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);

/* ---------------- fabric material ---------------- */

function knitNormalMap() {
  const N = 256, c = document.createElement('canvas'); c.width = c.height = N;
  const ctx = c.getContext('2d'), img = ctx.createImageData(N, N);
  const h = (x, y) => 0.6 * Math.sin((x / N) * Math.PI * 2 * 24) + 0.25 * Math.sin((y / N) * Math.PI * 2 * 48 + Math.sin(x * 0.7)) + 0.15 * Math.sin(x * 1.3 + y * 0.9);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = h(x + 1, y) - h(x - 1, y), dy = h(x, y + 1) - h(x, y - 1);
    const n = new THREE.Vector3(-dx, -dy, 2).normalize(), i = (y * N + x) * 4;
    img.data[i] = (n.x * 0.5 + 0.5) * 255; img.data[i + 1] = (n.y * 0.5 + 0.5) * 255; img.data[i + 2] = (n.z * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(4, 4); t.anisotropy = 8;
  return t;
}
const knit = knitNormalMap();
const DEFAULT_COLORS = ['#2b2d33', '#2b2d33', '#8a6e58', '#4a5a4d'];
function fabricMaterial(part, i) {
  const color = state.partColors[part.label] || part.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length];
  state.partColors[part.label] = color;
  return new THREE.MeshPhysicalMaterial({
    color, map: part.map || null, roughness: 0.82, metalness: 0,
    sheen: 1, sheenRoughness: 0.55, sheenColor: new THREE.Color(color).lerp(new THREE.Color('#ffffff'), 0.35),
    normalMap: knit, normalScale: new THREE.Vector2(0.09, 0.09), side: THREE.DoubleSide,
  });
}

/* ---------------- body + motions ---------------- */

const gltfLoader = new GLTFLoader();
let character, bodyMesh, bones, restPose, bindPose, mixer, actions = {}, current = null, measure;
let garment = null, garmentParts = null, garmentName = '', garmentSkeleton = null;

const bodyMats = {
  mannequin: new THREE.MeshStandardMaterial({ color: '#cfc9c1', roughness: 0.55, metalness: 0 }),
};

async function loadRigs() {
  status('Loading body + motion library…');
  const [mich, xbot] = await Promise.all(['Michelle', 'Xbot'].map((n) => gltfLoader.loadAsync(`assets/rigs/${n}.glb`)));
  character = mich.scene;
  character.traverse((o) => { if (o.isSkinnedMesh) bodyMesh = o; });
  bodyMesh.castShadow = true;
  bodyMesh.frustumCulled = false;
  scene.add(character);
  bones = bonesByName(character);
  restPose = snapshotPose(bones);
  character.updateMatrixWorld(true);
  const W = (n) => bones[n].getWorldPosition(new THREE.Vector3());
  const neck = W('Neck'), hips = W('Hips'), footY = (W('LeftFoot').y + W('RightFoot').y) / 2;
  measure = { neck, hips, footY, span: neck.y - footY, groundY: new THREE.Box3().setFromObject(character, true).min.y };
  floor.position.y = measure.groundY;

  mixer = new THREE.AnimationMixer(character);
  const sources = { Michelle: mich, Xbot: xbot };
  for (const m of MOTIONS) {
    if (!m.src) continue;
    const src = sources[m.src];
    const clip = src.animations.find((a) => a.name === m.clip);
    if (!clip) continue;
    const baked = src === mich ? clip.clone() : retargetClip(src, clip);
    baked.name = m.id;
    actions[m.id] = mixer.clipAction(baked);
  }
  // in-place model poses, built on the idle stance with feet locked by IK
  for (const c of bakePoses({ character, bones, base: actions.idle.getClip(), span: measure.span })) actions[c.name] = mixer.clipAction(c);
  applyPose(restPose);
  character.updateMatrixWorld(true);
}

// World-space delta retargeting between two humanoid rigs that share bone names.
// target_world(t) = source_world(t) * inv(source_rest_world) * target_rest_world
function retargetClip(src, clip, fps = 30) {
  const srcRoot = src.scene;
  const srcBones = bonesByName(srcRoot);
  // measure the source rest pose in T-pose when the rig ships one
  const tpose = src.animations.find((a) => /t-?pose/i.test(a.name));
  if (tpose) { const tm = new THREE.AnimationMixer(srcRoot); tm.clipAction(tpose).play(); tm.setTime(0); tm.stopAllAction(); tm.uncacheRoot(srcRoot); }
  srcRoot.updateMatrixWorld(true);
  character.updateMatrixWorld(true);
  const order = [];
  character.traverse((o) => { if (o.isBone) { const n = o.name.replace(/^mixamorig[:_]?/, ''); if (srcBones[n]) order.push([n, o]); } });
  const restS = {}, restT = {};
  for (const [n, tb] of order) { restS[n] = srcBones[n].getWorldQuaternion(new THREE.Quaternion()); restT[n] = tb.getWorldQuaternion(new THREE.Quaternion()); }
  const W = (bs, n) => bs[n].getWorldPosition(new THREE.Vector3());
  const srcSpan = W(srcBones, 'Neck').y - (W(srcBones, 'LeftFoot').y + W(srcBones, 'RightFoot').y) / 2;
  const ratio = measure.span / srcSpan;
  const hipsRestS = W(srcBones, 'Hips'), hipsRestT = W(bones, 'Hips');
  const hipsParentInv = bones.Hips.parent.matrixWorld.clone().invert();

  const smix = new THREE.AnimationMixer(srcRoot);
  smix.clipAction(clip).play();
  const frames = Math.max(2, Math.floor(clip.duration * fps + 1e-6) + 1);
  const times = new Float32Array(frames);
  const qv = Object.fromEntries(order.map(([n]) => [n, new Float32Array(frames * 4)]));
  const pv = new Float32Array(frames * 3);
  const worldT = {}, q = new THREE.Quaternion(), pq = new THREE.Quaternion(), v = new THREE.Vector3();
  for (let f = 0; f < frames; f++) {
    const t = Math.min(clip.duration, f / fps); times[f] = t;
    smix.setTime(t); srcRoot.updateMatrixWorld(true);
    for (const [n, tb] of order) {
      const ws = srcBones[n].getWorldQuaternion(q);
      const wt = (worldT[n] ||= new THREE.Quaternion()).copy(ws).multiply(restS[n].clone().invert()).multiply(restT[n]);
      const parentName = tb.parent.isBone ? tb.parent.name.replace(/^mixamorig[:_]?/, '') : null;
      const parentW = parentName && worldT[parentName] ? worldT[parentName] : tb.parent.getWorldQuaternion(pq);
      const local = parentW.clone().invert().multiply(wt);
      local.toArray(qv[n], f * 4);
    }
    v.copy(W(srcBones, 'Hips')).sub(hipsRestS).multiplyScalar(ratio).add(hipsRestT).applyMatrix4(hipsParentInv);
    v.toArray(pv, f * 3);
  }
  smix.stopAllAction(); smix.uncacheRoot(srcRoot);
  const tracks = order.map(([n, tb]) => new THREE.QuaternionKeyframeTrack(`${tb.name}.quaternion`, times, qv[n]));
  tracks.push(new THREE.VectorKeyframeTrack(`${bones.Hips.name}.position`, times, pv));
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

function setMotion(id, fade = 0.45) {
  state.motion = id;
  const next = actions[id] || null;
  if (current && current !== next) current.fadeOut(fade);
  if (next) { next.reset().setEffectiveWeight(1).fadeIn(current ? fade : 0).play(); }
  else if (bindPose) { mixer.stopAllAction(); applyPose(bindPose); }
  current = next;
}

function setBodyMode(mode) {
  const changed = state.body !== mode;
  state.body = mode;
  if (changed && garment) rebuildGarment();
  bodyMesh.visible = mode !== 'invisible';
  bodyMesh.material = bodyMats.mannequin;
  bodyMesh.castShadow = mode === 'mannequin';
}

/* ---------------- garment ---------------- */

async function loadGarmentFromObject(obj, name) {
  garmentParts = extractParts(obj);
  garmentName = name;
  if (!garmentParts.length) throw new Error('No mesh geometry found in that file.');
  rebuildGarment();
  buildPartColorUI();
}

function rebuildGarment() {
  if (!garmentParts) return;
  status('Fitting garment + transferring weights…');
  const was = state.motion;
  mixer.stopAllAction(); current = null;
  if (garment) { scene.remove(garment); garment.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); }); }
  const t0 = performance.now();
  // push-out only matters when the body is visible; otherwise keep the garment's exact shape
  const opts = { ...state.fit, clearance: state.body === 'mannequin' ? state.fit.clearance : -1 };
  const res = fitGarment({ character, bodyMesh, bones, restPose, parts: garmentParts, opts });
  bindPose = res.bindPose;
  garmentSkeleton = res.skeleton;
  garment = new THREE.Group(); garment.name = 'garment';
  res.geometries.forEach((g, i) => {
    const m = new THREE.SkinnedMesh(g, fabricMaterial(garmentParts[i], i));
    m.name = garmentParts[i].label;
    m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
    garment.add(m);
    m.updateMatrixWorld(true);
    m.bind(res.skeleton, new THREE.Matrix4());
  });
  applyShape();
  scene.add(garment);
  setMotion(was, 0);
  const ms = Math.round(performance.now() - t0);
  status(`${garmentName} · ${res.info.vertices.toLocaleString()} verts · fitted in ${ms} ms${res.info.sleeves ? '' : ' · no sleeves detected'}${res.info.hasLegs ? '' : ' · no legs detected'}`);
  window.__fitInfo = res.info;
}

async function loadGarmentFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  status(`Loading ${file.name}…`);
  try {
    let obj;
    if (ext === 'obj') obj = new OBJLoader().parse(await file.text());
    else if (ext === 'glb' || ext === 'gltf') obj = (await gltfLoader.parseAsync(await file.arrayBuffer(), '')).scene;
    else if (ext === 'fbx') obj = new FBXLoader().parse(await file.arrayBuffer(), '');
    else throw new Error('Use an .obj, .glb/.gltf or .fbx file.');
    state.partColors = {};
    await loadGarmentFromObject(obj, file.name);
  } catch (e) { console.error(e); status(`Couldn't load ${file.name}: ${e.message}`); }
}

/* ---------------- rigged export ---------------- */

async function exportRig() {
  if (!garment) return;
  const btn = $('#exportrig'); btn.disabled = true;
  status('Building rigged .glb…');
  const which = $('#exportanims').value;
  const motions = MOTIONS.filter((m) => actions[m.id] && (which === 'all' || (which === 'current' && m.id === state.motion)));
  const clips = motions.map((m) => { const c = actions[m.id].getClip().clone(); c.name = m.label.replace(/\s*—\s*/g, ' ').replace(/[^\w ]+/g, '').trim(); return c; });
  const base = (garmentName || 'garment').replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '-');
  const was = state.motion;
  try {
    mixer.stopAllAction(); current = null;
    const blob = await exportRiggedGLB({ character, bodyMesh, garment, skeleton: garmentSkeleton, bindPose, applyPose, includeBody: $('#exportbody').checked, clips, name: base });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `${base}_rigged.glb`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    status(`Saved ${base}_rigged.glb · ${(blob.size / 1e6).toFixed(1)} MB · ${clips.length} motion${clips.length === 1 ? '' : 's'} — Blender: File › Import › glTF 2.0`);
  } catch (e) { console.error(e); status(`Export failed: ${e.message}`); }
  finally { setMotion(was, 0); btn.disabled = false; }
}
window.__exportRig = exportRig;


/* ---------------- body shape ---------------- */

function applyShape() {
  if (!garment) return;
  garment.children.forEach((m) => {
    if (!m.morphTargetInfluences) return;
    SHAPES.forEach((sh, i) => { m.morphTargetInfluences[i] = state.shape[sh.id] || 0; });
  });
}
function buildShapeUI() {
  const box = $('#shape'); box.innerHTML = '';
  for (const sh of SHAPES) {
    const row = document.createElement('label'); row.className = 'row'; row.title = sh.hint;
    row.innerHTML = `<span>${sh.label}</span><input type="range" min="-0.6" max="1.5" step="0.05" data-shape="${sh.id}"><span class="val"></span>`;
    const el = row.querySelector('input'), out = row.querySelector('.val');
    const show = () => { const v = +el.value; out.textContent = `${v > 0 ? '+' : ''}${Math.round(v * 100)}`; };
    el.value = state.shape[sh.id] || 0; show();
    el.oninput = () => { state.shape[sh.id] = +el.value; show(); applyShape(); };
    box.appendChild(row);
  }
}
function setShapePreset(name) {
  state.shape = { ...SHAPE_PRESETS[name] };
  document.querySelectorAll('#shape input').forEach((el) => { el.value = state.shape[el.dataset.shape] || 0; el.oninput(); });
}

/* ---------------- camera moves ---------------- */

let camT = 0;
const tmp = new THREE.Vector3();
function fullBodyDistance(heightMeters) {
  const vfov = THREE.MathUtils.degToRad(camera.fov);
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
  return Math.max(heightMeters / (2 * Math.tan(vfov / 2)), (heightMeters * 0.62) / (2 * Math.tan(hfov / 2)));
}
function updateCamera(dt) {
  if (state.camera === 'free') { controls.update(); return; }
  camT += dt * state.camSpeed;
  const { neck, hips, footY, span } = measure;
  const center = tmp.set(hips.x, footY + span * 0.62, hips.z);
  const full = fullBodyDistance(span * 1.42);
  if (camera.view && camera.view.enabled && state.camera !== 'refpush') camera.clearViewOffset();
  if (!state.camera.startsWith('ref') && camera.fov !== 28) { camera.fov = 28; camera.updateProjectionMatrix(); }
  let ang = 0, dist = full, y = center.y, look = center.clone();
  const ease = (x) => 0.5 - 0.5 * Math.cos(Math.PI * x);
  switch (state.camera) {
    case 'refpush':
    case 'reference': {
      // matches the reference clip: camera at mid-thigh, level (no tilt), long lens, garment fills ~70% of the frame
      const top = neck.y + span * 0.06, bottom = measure.groundY;
      const visH = (top - bottom) * 1.27, fov = 22;
      camera.fov = fov; camera.updateProjectionMatrix();
      const h = (top + bottom) / 2 - visH * 0.016, d = visH / (2 * Math.tan(THREE.MathUtils.degToRad(fov / 2)));
      camera.position.set(center.x, h, hips.z + d);
      camera.lookAt(center.x, h, hips.z);
      if (state.camera === 'refpush') {
        // digital push-in measured from the clip (~6.7% over 3.9 s, easing out), centred at chest height; holds after
        const n = REF_MOTION.zoomCurve.length, x = Math.min(camT / REF_MOTION.zoomCurveSeconds, 1) * (n - 1);
        const i = Math.floor(x), f = x - i, c = REF_MOTION.zoomCurve[i] * (1 - f) + REF_MOTION.zoomCurve[Math.min(i + 1, n - 1)] * f;
        const z = 1 + REF_MOTION.zoomPerSecond * REF_MOTION.zoomCurveSeconds * c;
        const F = FORMATS[state.format], W = F.w, H = F.h, px = W * 0.5, py = H * 0.264;
        camera.setViewOffset(W, H, px - px / z, py - py / z, W / z, H / z);
      } else if (camera.view && camera.view.enabled) camera.clearViewOffset();
      return;
    }
    case 'turntable': ang = camT * 0.45; break;
    case 'sway': ang = Math.sin(camT * 0.35) * 0.75; y += Math.sin(camT * 0.21) * span * 0.04; break;
    case 'push': { const p = ease(Math.min(1, (camT % 16) / 8) - Math.max(0, (camT % 16) - 8) / 8); dist = THREE.MathUtils.lerp(full * 1.05, full * 0.55, p); ang = 0.25 - p * 0.2; look.y = THREE.MathUtils.lerp(center.y, neck.y - span * 0.18, p); y = look.y; break; }
    case 'hero': ang = 0.45 + Math.sin(camT * 0.25) * 0.25; dist = full * 0.92; y = footY + span * 0.18; look.y = center.y + span * 0.08; break;
    case 'detail': ang = Math.sin(camT * 0.4) * 0.9; dist = full * 0.5; look.y = neck.y - span * 0.22; y = look.y + span * 0.04; break;
    case 'lower': ang = Math.sin(camT * 0.4) * 0.9; dist = full * 0.55; look.y = footY + span * 0.32; y = look.y + span * 0.02; break;
  }
  camera.position.set(center.x + Math.sin(ang) * dist, y, center.z + Math.cos(ang) * dist);
  camera.lookAt(look);
}

/* ---------------- sizing ---------------- */

function applyFormat() {
  const f = FORMATS[state.format];
  renderer.setSize(f.w, f.h, false);
  camera.aspect = f.w / f.h; camera.updateProjectionMatrix();
  fitCanvas();
}
function fitCanvas() {
  const f = FORMATS[state.format], wrap = $('#viewport');
  const k = Math.min(wrap.clientWidth / f.w, wrap.clientHeight / f.h);
  canvas.style.width = `${Math.floor(f.w * k)}px`; canvas.style.height = `${Math.floor(f.h * k)}px`;
}
window.addEventListener('resize', fitCanvas);

/* ---------------- recording ---------------- */

let recorder = null, recStart = 0, recLimit = 0;
function pickMime() {
  const opts = ['video/mp4;codecs=avc1.640034', 'video/mp4;codecs=avc1.4d0034', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return opts.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}
function startRecording() {
  if (!window.MediaRecorder) { status('This browser cannot record video — try Chrome.'); return; }
  const mime = pickMime();
  // restart the loop so every take begins cleanly
  camT = 0; if (current) current.time = 0;
  const stream = canvas.captureStream(60);
  const chunks = [];
  recorder = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 24_000_000 });
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    const type = recorder.mimeType || mime || 'video/webm';
    const blob = new Blob(chunks, { type });
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const f = FORMATS[state.format];
    const name = `${(garmentName || 'garment').replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '-')}_${state.motion}_${state.camera}_${f.w}x${f.h}.${ext}`;
    const url = URL.createObjectURL(blob);
    const a = $('#download'); a.href = url; a.download = name; a.textContent = `Download ${ext.toUpperCase()} · ${(blob.size / 1e6).toFixed(1)} MB`; a.hidden = false;
    a.click();
    status(`Saved ${name}${ext === 'webm' ? ' — WebM: most platforms accept it; convert to MP4 if one refuses.' : ''}`);
    recorder = null; $('#rec').classList.remove('on'); $('#rec span').textContent = 'Record';
    document.body.classList.remove('recording');
  };
  recorder.start(250);
  recStart = performance.now(); recLimit = Number($('#duration').value) * 1000;
  $('#rec').classList.add('on'); $('#download').hidden = true; document.body.classList.add('recording');
}
function stopRecording() { if (recorder && recorder.state !== 'inactive') recorder.stop(); }

/* ---------------- loop ---------------- */

const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 1 / 20);
  if (mixer) mixer.update(dt * state.speed);
  if (measure) updateCamera(dt);
  renderer.render(scene, camera);
  if (recorder) {
    const el = performance.now() - recStart;
    $('#rec span').textContent = `Stop · ${(el / 1000).toFixed(1)}s`;
    if (recLimit && el >= recLimit) stopRecording();
  }
  requestAnimationFrame(frame);
}

/* ---------------- UI ---------------- */

function fillSelect(sel, items, value) {
  const groups = [...new Set(items.map((i) => i.group || ''))];
  sel.innerHTML = groups.map((g) => {
    const opts = items.filter((i) => (i.group || '') === g).map((i) => `<option value="${i.id}">${i.label}</option>`).join('');
    return g ? `<optgroup label="${g}">${opts}</optgroup>` : opts;
  }).join('');
  sel.value = value;
}
function buildPartColorUI() {
  const box = $('#parts'); box.innerHTML = '';
  garmentParts.forEach((p) => {
    const row = document.createElement('label'); row.className = 'row';
    row.innerHTML = `<span>${p.label}</span><input type="color" value="${state.partColors[p.label]}">`;
    row.querySelector('input').addEventListener('input', (e) => {
      state.partColors[p.label] = e.target.value;
      const m = garment.getObjectByName(p.label);
      if (m) { m.material.color.set(e.target.value); m.material.sheenColor.set(e.target.value).lerp(new THREE.Color('#fff'), 0.35); }
    });
    box.appendChild(row);
  });
}
function bindUI() {
  fillSelect($('#motion'), MOTIONS, state.motion);
  fillSelect($('#camera'), CAMERAS, state.camera);
  $('#format').innerHTML = Object.entries(FORMATS).map(([k, f]) => `<option value="${k}">${f.label}</option>`).join('');
  $('#format').value = state.format;
  $('#motion').onchange = (e) => setMotion(e.target.value);
  $('#camera').onchange = (e) => { state.camera = e.target.value; camT = 0; controls.enabled = state.camera === 'free'; if (controls.enabled) controls.target.set(measure.hips.x, measure.footY + measure.span * 0.62, measure.hips.z); };
  $('#format').onchange = (e) => { state.format = e.target.value; applyFormat(); };
  $('#body').value = state.body; $('#body').onchange = (e) => setBodyMode(e.target.value);
  $('#speed').oninput = (e) => { state.speed = +e.target.value; $('#speedv').textContent = `${state.speed.toFixed(2)}×`; };
  $('#camspeed').oninput = (e) => { state.camSpeed = +e.target.value; $('#camspeedv').textContent = `${state.camSpeed.toFixed(2)}×`; };
  $('#shadow').onchange = (e) => { floor.visible = e.target.checked; };

  const sw = $('#swatches');
  sw.innerHTML = BACKGROUNDS.map((c) => `<button class="sw" style="--c:${c}" data-c="${c}" aria-label="Background ${c}"></button>`).join('') + `<input type="color" id="bgcustom" value="${state.bg}" aria-label="Custom background">`;
  const setBg = (c) => { state.bg = c; scene.background.set(c); sw.querySelectorAll('.sw').forEach((b) => b.classList.toggle('on', b.dataset.c === c)); };
  sw.querySelectorAll('.sw').forEach((b) => (b.onclick = () => setBg(b.dataset.c)));
  $('#bgcustom').oninput = (e) => setBg(e.target.value);
  setBg(state.bg);

  const fitInputs = [['scale', 'x', 2], ['lift', 'cm', 100], ['depth', 'cm', 100], ['clearance', 'mm', 1000]];
  for (const [k, unit, mul] of fitInputs) {
    const el = $(`#fit-${k}`), out = $(`#fit-${k}v`);
    const show = () => { out.textContent = unit === 'x' ? `${(+el.value).toFixed(3)}×` : `${(+el.value * mul).toFixed(unit === 'mm' ? 0 : 1)} ${unit}`; };
    el.value = state.fit[k]; show();
    el.oninput = show;
    el.onchange = () => { state.fit[k] = +el.value; rebuildGarment(); };
  }
  $('#refit').onclick = () => {
    state.fit = { scale: 1, lift: 0, depth: 0, clearance: 0.006 };
    for (const [k] of fitInputs) { $(`#fit-${k}`).value = state.fit[k]; $(`#fit-${k}`).oninput(); }
    rebuildGarment();
  };

  $('#file').onchange = (e) => e.target.files[0] && loadGarmentFile(e.target.files[0]);
  window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drag'); });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('drag'); });
  window.addEventListener('drop', (e) => { e.preventDefault(); document.body.classList.remove('drag'); const f = e.dataTransfer.files[0]; if (f) loadGarmentFile(f); });

  $('#rec').onclick = () => (recorder ? stopRecording() : startRecording());
  $('#exportrig').onclick = exportRig;
  buildShapeUI();
  $('#shape-inspo').onclick = () => setShapePreset('inspo');
  $('#shape-reset').onclick = () => setShapePreset('neutral');
  $('#togglepanel').onclick = () => document.body.classList.toggle('panel-hidden');
  window.addEventListener('keydown', (e) => { if (e.key === 'r' && !e.target.closest('input,select')) $('#rec').click(); });
}

/* ---------------- boot ---------------- */

(async function boot() {
  bindUI();
  applyFormat();
  requestAnimationFrame(frame);
  try {
    await loadRigs();
    setBodyMode(state.body);
    status('Loading garment…');
    const text = await (await fetch('assets/garments/ladies-tracksuit.obj')).text();
    await loadGarmentFromObject(new OBJLoader().parse(text), 'ladies-tracksuit.obj');
    document.body.classList.add('ready');
  } catch (e) { console.error(e); status(`Error: ${e.message}`); }
})();

// test hooks
window.__studio = { get camera() { return camera; }, get garment() { return garment; }, fitWith: (o) => fitGarment({ character, bodyMesh, bones, restPose, parts: garmentParts, opts: { ...state.fit, ...o } }), setMotion, setBodyMode, state, rebuildGarment, get mixer() { return mixer; }, setCamera: (id) => { $('#camera').value = id; $('#camera').onchange({ target: { value: id } }); }, setFormat: (f) => { state.format = f; applyFormat(); }, step: (t) => { mixer.update(t); updateCamera(t); renderer.render(scene, camera); }, get camT() { return camT; }, set camT(v) { camT = v; } };
