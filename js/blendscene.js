// Build a Blender scene into the factory-startup template (Blender 3.0 format, opens in 3.x, 4.x and 5.x):
// meshes (legacy MVert/MEdge/MPoly/MLoop layers, which every version converts on load), packed images,
// Principled materials with an Image Texture node, objects with modifiers / vertex groups, camera, light, world.
import { BlendFile, toAddr } from './blendfile.js';

const ID = (code, name) => code + name;
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export class BlendScene {
  static async fromURL(url) { return new BlendScene(await (await fetch(url)).arrayBuffer()); }

  constructor(buffer) {
    const f = (this.f = new BlendFile(buffer));
    // keep the ID blocks we clone from, drop the default cube from the scene
    this.tpl = { object: f.find('OBCube'), mesh: f.find('MECube'), material: f.find('MAMaterial'), image: f.find('IMViewer Node') || f.ids('IM')[0] };
    this.collection = f.find('GRCollection');
    this.camera = f.find('OBCamera'); this.light = f.find('OBLight');
    this.scene = f.ids('SC')[0];
    this.objects = [this.camera, this.light];
    this.names = new Set(f.blocks.filter((b) => f.isID(b)).map((b) => f.idName(b)));
  }

  unique(code, name) {
    let n = name.slice(0, 60), i = 1;
    while (this.names.has(ID(code, n))) n = `${name.slice(0, 55)}.${String(i++).padStart(3, '0')}`;
    this.names.add(ID(code, n)); return ID(code, n);
  }

  /* ---------- images ---------- */
  image(name, bytes, { ext = 'png', colorspace = 'sRGB', width = 1024, height = 1024 } = {}) {
    // copy of the template's plain image (keeps its tile + stereo records), turned into a packed file image
    const f = this.f, { blocks, id: im } = f.cloneGroup(this.tpl.image);
    const keep = new Set(['tiles', 'stereo3d_format']);
    for (const fd of f.struct('Image').list) if (fd.ptr && !keep.has(fd.key) && !['id'].includes(fd.key)) f.set(im, fd.key, fd.n > 1 ? new Array(fd.n).fill(0n) : 0n);
    for (const k of ['anims', 'renderslots', 'views', 'packedfiles']) f.set(im, `${k}.first`, 0n).set(im, `${k}.last`, 0n);
    const kept = blocks.filter((b, i) => i === 0 || ['ImageTile', 'Stereo3dFormat'].includes(f.structOf(b).name));
    const full = this.unique('IM', name);
    f.set(im, 'id.name', full).set(im, 'id.us', 1).set(im, 'id.flag', 0);
    f.set(im, 'name', `//textures/${full.slice(2)}.${ext}`).set(im, 'source', 1).set(im, 'type', 0).set(im, 'flag', 0);
    f.set(im, 'gen_x', width).set(im, 'gen_y', height).set(im, 'alpha_mode', 0).set(im, 'colorspace_settings.name', colorspace);
    const data = f.raw(bytes), pf = f.alloc('PackedFile'), ipf = f.alloc('ImagePackedFile');
    f.set(pf, 'size', data.size).set(pf, 'seek', 0).set(pf, 'data', data);
    f.set(ipf, 'packedfile', pf).set(ipf, 'filepath', `//textures/${full.slice(2)}.${ext}`);
    f.linkList(im, 'packedfiles', [ipf]);
    if (f.has('Image', 'packedfile')) f.set(im, 'packedfile', pf);
    f.add([...kept, ipf, pf, data]);
    return im;
  }

  /* ---------- materials ---------- */
  material(name, { color = [0.8, 0.8, 0.8], image = null, roughness = 0.5, metallic = 0, specular = 0.5, emission = 0, alpha = 1, backface = true } = {}) {
    const f = this.f, { blocks, id } = f.cloneGroup(this.tpl.material);
    f.set(id, 'id.name', this.unique('MA', name)).set(id, 'id.us', 0);
    f.set(id, 'r', color[0]).set(id, 'g', color[1]).set(id, 'b', color[2]).set(id, 'roughness', roughness).set(id, 'metallic', metallic);
    // drop the template's preview image (stale thumbnail)
    const prev = blocks.find((b) => f.structOf(b).name === 'PreviewImage'); if (prev) { f.set(id, 'preview', 0n); blocks.splice(blocks.indexOf(prev), 1); const px = blocks.findIndex((b) => b.size === 4096 && f.structOf(b).name === 'Link'); if (px >= 0) blocks.splice(px, 1); }
    f.add(blocks);
    const tree = f.byAddr(f.get(id, 'nodetree')), nodes = f.listItems(tree, 'nodes', 0);
    const bsdf = nodes.find((n) => f.get(n, 'idname') === 'ShaderNodeBsdfPrincipled');
    const input = (node, ident) => f.listItems(node, 'inputs').find((s) => f.get(s, 'identifier') === ident);
    const value = (sock, v) => { const dv = f.byAddr(f.get(sock, 'default_value')); f.set(dv, 'value', v); };
    f.set(f.byAddr(f.get(input(bsdf, 'Base Color'), 'default_value')), 'value', [...color, 1]);
    value(input(bsdf, 'Roughness'), roughness); value(input(bsdf, 'Metallic'), metallic); value(input(bsdf, 'Specular'), specular);
    if (emission) { f.set(f.byAddr(f.get(input(bsdf, 'Emission'), 'default_value')), 'value', [...color, 1]); value(input(bsdf, 'Emission Strength'), emission); }
    if (image) this.textureNode(tree, bsdf, image, input(bsdf, 'Base Color'), emission ? input(bsdf, 'Emission') : null);
    if (alpha < 1) value(input(bsdf, 'Alpha'), alpha);
    if (!backface) f.set(id, 'blend_flag', f.get(id, 'blend_flag') | 4);
    return id;
  }

  // Image Texture node wired into a socket (or two)
  textureNode(tree, bsdf, image, ...targets) {
    const f = this.f, node = f.alloc('bNode'), store = f.alloc('NodeTexImage');
    for (const [k, v] of [['idname', 'ShaderNodeTexImage'], ['name', 'Image Texture'], ['type', 143], ['flag', f.get(bsdf, 'flag')], ['width', 240], ['locx', f.get(bsdf, 'locx') - 340], ['locy', f.get(bsdf, 'locy') - 40], ['color', [0.608, 0.608, 0.608]]]) f.set(node, k, v);
    f.set(node, 'id', image).set(node, 'storage', store);
    f.set(store, 'base.tex_mapping.size', [1, 1, 1]).set(store, 'base.tex_mapping.mat', identity()).set(store, 'base.tex_mapping.max', [1, 1, 1]).set(store, 'base.tex_mapping.flag', 4).set(store, 'base.tex_mapping.projx', 1).set(store, 'base.tex_mapping.projy', 2).set(store, 'base.tex_mapping.projz', 3);
    f.set(store, 'base.color_mapping.bright', 1).set(store, 'base.color_mapping.contrast', 1).set(store, 'base.color_mapping.saturation', 1).set(store, 'base.color_mapping.blend_color', [0.8, 0.8, 0.8]);
    f.set(store, 'iuser.frames', 100).set(store, 'iuser.sfra', 1);
    // sockets, cloned from the BSDF's own sockets so every field is sane
    const inputs = f.listItems(bsdf, 'inputs');
    const sock = (fromIdent, ident, inOut) => {
      const src = inputs.find((s) => f.get(s, 'identifier') === fromIdent), s = { ...src, data: src.data.slice(), old: f.addr() };
      const dv0 = f.byAddr(f.get(src, 'default_value')), dv = { ...dv0, data: dv0.data.slice(), old: f.addr() };
      f.set(s, 'default_value', dv).set(s, 'link', 0n).set(s, 'identifier', ident).set(s, 'name', ident).set(s, 'in_out', inOut);
      return [s, dv];
    };
    const [vec, vecDv] = sock('Normal', 'Vector', 1), [col, colDv] = sock('Base Color', 'Color', 2), [alp, alpDv] = sock('IOR', 'Alpha', 2);
    f.set(vec, 'flag', f.get(vec, 'flag') | (1 << 6)); // value hidden: uses UVs
    f.linkList(node, 'inputs', [vec]); f.linkList(node, 'outputs', [col, alp]);
    const nodes = f.listItems(tree, 'nodes'); f.linkList(tree, 'nodes', [...nodes, node]);
    const links = f.listItems(tree, 'links'), tmplLink = links[0], made = [];
    for (const to of targets.filter(Boolean)) {
      const l = f.alloc('bNodeLink');
      f.set(l, 'fromnode', node).set(l, 'tonode', bsdf).set(l, 'fromsock', col).set(l, 'tosock', to).set(l, 'flag', tmplLink ? f.get(tmplLink, 'flag') : 2);
      f.set(to, 'link', l); made.push(l);
    }
    f.linkList(tree, 'links', [...links, ...made]);
    f.addData(tree, [node, store, vec, vecDv, col, colDv, alp, alpDv, ...made]);
    f.set(image, 'id.us', f.get(image, 'id.us') + 0);
  }

  /* ---------- meshes ---------- */
  // positions: flat xyz (Blender Z-up); faces: arrays of vertex indices; uvs: flat uv per face corner (in face order)
  mesh(name, { positions, faces, uvs = null, smooth = true, materials = [], faceMat = null, groups = null }) {
    const f = this.f, me = { ...this.tpl.mesh, data: this.tpl.mesh.data.slice(), old: f.addr() };
    f.clearPointers(me);
    f.set(me, 'id.name', this.unique('ME', name)).set(me, 'id.us', 1);
    const nv = positions.length / 3, np = faces.length, nl = faces.reduce((n, p) => n + p.length, 0);
    // edges from faces
    const edgeKey = new Map(), edges = [];
    const loopE = new Int32Array(nl); let li = 0;
    for (const p of faces) for (let k = 0; k < p.length; k++) {
      const a = p[k], b = p[(k + 1) % p.length], key = a < b ? a * nv + b : b * nv + a;
      let e = edgeKey.get(key); if (e == null) { e = edges.length; edges.push([a, b]); edgeKey.set(key, e); }
      loopE[li++] = e;
    }
    // vertex normals (legacy short normals; Blender recomputes, but keep them sane)
    const vn = new Float32Array(nv * 3);
    for (const p of faces) {
      for (let k = 0; k < p.length; k++) {
        const a = p[k], b = p[(k + 1) % p.length], c = p[(k + 2) % p.length];
        const ux = positions[b * 3] - positions[a * 3], uy = positions[b * 3 + 1] - positions[a * 3 + 1], uz = positions[b * 3 + 2] - positions[a * 3 + 2];
        const wx = positions[c * 3] - positions[b * 3], wy = positions[c * 3 + 1] - positions[b * 3 + 1], wz = positions[c * 3 + 2] - positions[b * 3 + 2];
        vn[b * 3] += uy * wz - uz * wy; vn[b * 3 + 1] += uz * wx - ux * wz; vn[b * 3 + 2] += ux * wy - uy * wx;
      }
    }
    const mv = f.alloc('MVert', nv), md = new DataView(mv.data.buffer), vs = f.struct('MVert').size;
    for (let i = 0; i < nv; i++) {
      for (let k = 0; k < 3; k++) md.setFloat32(i * vs + 4 * k, positions[i * 3 + k], true);
      const l = Math.hypot(vn[i * 3], vn[i * 3 + 1], vn[i * 3 + 2]) || 1;
      if (f.has('MVert', 'no')) for (let k = 0; k < 3; k++) md.setInt16(i * vs + 12 + 2 * k, Math.round((vn[i * 3 + k] / l) * 32767), true);
    }
    const ed = f.alloc('MEdge', edges.length), es = f.struct('MEdge').size, edv = new DataView(ed.data.buffer);
    edges.forEach(([a, b], i) => { edv.setInt32(i * es, a, true); edv.setInt32(i * es + 4, b, true); edv.setInt16(i * es + 10, 35, true); });
    const mp = f.alloc('MPoly', np), ps = f.struct('MPoly').size, pdv = new DataView(mp.data.buffer);
    const ml = f.alloc('MLoop', nl), ls = f.struct('MLoop').size, ldv = new DataView(ml.data.buffer);
    let start = 0;
    faces.forEach((p, i) => {
      pdv.setInt32(i * ps, start, true); pdv.setInt32(i * ps + 4, p.length, true); pdv.setInt16(i * ps + 8, faceMat ? faceMat[i] : 0, true); mp.data[i * ps + 10] = smooth ? 1 : 0;
      for (let k = 0; k < p.length; k++) { ldv.setUint32((start + k) * ls, p[k], true); ldv.setUint32((start + k) * ls + 4, loopE[start + k], true); }
      start += p.length;
    });
    // custom data layers
    const layer = (blocks, type, data, nm = '') => { const l = f.alloc('CustomDataLayer'); f.set(l, 'type', type).set(l, 'data', data).set(l, 'name', nm); blocks.push(l); return l; };
    const cd = (path, entries) => {
      const L = f.alloc('CustomDataLayer', entries.length), sz = f.struct('CustomDataLayer').size, tm = new Array(f.locate('CustomData', 'typemap').fd.n).fill(-1);
      let total = 0;
      entries.forEach(([type, data, nm, elem], i) => { f.set(L, 'type', type, i).set(L, 'data', data, i).set(L, 'name', nm || '', i); if (tm[type] < 0) tm[type] = i; total += elem; });
      f.set(me, `${path}.layers`, L).set(me, `${path}.totlayer`, entries.length).set(me, `${path}.maxlayer`, entries.length).set(me, `${path}.typemap`, tm).set(me, `${path}.totsize`, total);
      return L;
    };
    const out = [me];
    const vEntries = [[0, mv, '', vs]];
    let dvert = null, wblocks = [];
    if (groups) {
      dvert = f.alloc('MDeformVert', nv); const dvs = f.struct('MDeformVert').size;
      for (let i = 0; i < nv; i++) {
        const ws = groups.weights[i] || []; if (!ws.length) continue;
        const w = f.alloc('MDeformWeight', ws.length);
        ws.forEach(([g, x], k) => { f.set(w, 'def_nr', g, k).set(w, 'weight', x, k); });
        f.set(dvert, 'dw', w, i).set(dvert, 'totweight', ws.length, i); wblocks.push(w);
      }
      vEntries.push([2, dvert, '', dvs]);
    }
    const vL = cd('vdata', vEntries), eL = cd('edata', [[3, ed, '', es]]), pL = cd('pdata', [[25, mp, '', ps]]);
    const lEntries = [[26, ml, '', ls]]; let uvb = null;
    if (uvs) {
      uvb = f.alloc('MLoopUV', nl); const us = f.struct('MLoopUV').size, udv = new DataView(uvb.data.buffer);
      for (let i = 0; i < nl; i++) { udv.setFloat32(i * us, uvs[i * 2], true); udv.setFloat32(i * us + 4, uvs[i * 2 + 1], true); }
      lEntries.unshift([16, uvb, 'UVMap', us]);
    }
    const lL = cd('ldata', lEntries);
    f.set(me, 'totvert', nv).set(me, 'totedge', edges.length).set(me, 'totpoly', np).set(me, 'totloop', nl).set(me, 'totface', 0).set(me, 'act_face', -1);
    f.set(me, 'mvert', mv).set(me, 'medge', ed).set(me, 'mpoly', mp).set(me, 'mloop', ml);
    if (uvb) f.set(me, 'mloopuv', uvb);
    if (dvert) f.set(me, 'dvert', dvert);
    out.push(vL, mv); if (dvert) out.push(dvert, ...wblocks);
    out.push(eL, ed, lL); if (uvb) out.push(uvb); out.push(ml, pL, mp);
    if (materials.length) { const arr = f.ptrArray(materials); f.set(me, 'mat', arr).set(me, 'totcol', materials.length); out.splice(1, 0, arr); materials.forEach((m) => f.set(m, 'id.us', f.get(m, 'id.us') + 1)); }
    else f.set(me, 'totcol', 0);
    if (groups && f.has('Mesh', 'vertex_group_names')) {
      const dg = groups.names.map((n) => { const g = f.alloc('bDeformGroup'); f.set(g, 'name', n); return g; });
      f.linkList(me, 'vertex_group_names', dg); out.push(...dg);
      if (f.has('Mesh', 'vertex_group_active_index')) f.set(me, 'vertex_group_active_index', 1);
    }
    f.add(out);
    me.groupNames = groups?.names;
    return me;
  }

  /* ---------- objects ---------- */
  object(name, data, { type = 1, loc = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1], parent = null, modifiers = [], link = true, materials = null } = {}) {
    const f = this.f, ob = { ...this.tpl.object, data: this.tpl.object.data.slice(), old: f.addr() };
    f.clearPointers(ob);
    f.set(ob, 'id.name', this.unique('OB', name)).set(ob, 'id.us', 1).set(ob, 'type', type).set(ob, 'data', data ?? 0n);
    f.set(ob, 'loc', loc).set(ob, 'rot', rot).set(ob, 'size', scale).set(ob, 'rotmode', 1);
    f.set(ob, 'obmat', matrix(loc, rot, scale)).set(ob, 'parentinv', identity()).set(ob, 'constinv', identity());
    if (parent) f.set(ob, 'parent', parent).set(ob, 'partype', 0);
    const out = [ob];
    const nmat = materials ? materials.length : 0;
    if (data && type === 1) {
      const tot = f.get(data, 'totcol');
      if (tot) { const mat = f.ptrArray(new Array(tot).fill(0n)), bits = f.raw(new Uint8Array(tot)); f.set(ob, 'mat', mat).set(ob, 'matbits', bits).set(ob, 'totcol', tot).set(ob, 'actcol', 1); out.push(mat, bits); }
      else f.set(ob, 'totcol', 0);
    } else f.set(ob, 'totcol', nmat);
    if (data) f.set(ob, 'empty_drawtype', 1).set(ob, 'dt', 5);
    const mods = modifiers.map((m) => this.modifier(m)).flat();
    if (mods.length) { f.linkList(ob, 'modifiers', mods.filter((b) => b.isMod)); out.push(...mods); }
    f.add(out);
    if (link) this.objects.push(ob);
    return ob;
  }

  modifier(m) {
    const f = this.f, S = { armature: ['ArmatureModifierData', 8, 'Armature'], bevel: ['BevelModifierData', 24, 'Bevel'], subsurf: ['SubsurfModifierData', 1, 'Subdivision'], solidify: ['SolidifyModifierData', 33, 'Solidify'] }[m.type];
    const b = f.alloc(S[0]); b.isMod = true;
    f.set(b, 'modifier.type', S[1]).set(b, 'modifier.name', m.name || S[2]).set(b, 'modifier.mode', 1 | 2 | 8 | 16).set(b, 'modifier.ui_expand_flag', 1);
    if (f.has(S[0], 'modifier.flag')) f.set(b, 'modifier.flag', 0);
    if (m.type === 'armature') f.set(b, 'object', m.object).set(b, 'deformflag', 1); // vertex groups
    if (m.type === 'bevel') {
      f.set(b, 'value', m.width ?? 0.01).set(b, 'res', m.segments ?? 3).set(b, 'flags', 0).set(b, 'val_flags', 0).set(b, 'lim_flags', 2 /* angle */).set(b, 'bevel_angle', m.angle ?? 0.5236)
        .set(b, 'profile', 0.5).set(b, 'affect_type', 1 /* edges */).set(b, 'mat', -1).set(b, 'spread', 0.1).set(b, 'vmesh_method', 0).set(b, 'miter_inner', 0).set(b, 'miter_outer', 0);
      if (f.has('BevelModifierData', 'harden_normals')) f.set(b, 'face_str_mode', 0);
    }
    if (m.type === 'subsurf') f.set(b, 'levels', m.levels ?? 1).set(b, 'renderLevels', m.levels ?? 2).set(b, 'quality', 3).set(b, 'flags', 2 /* use creases */).set(b, 'uv_smooth', 1).set(b, 'boundary_smooth', 1);
    if (m.type === 'solidify') f.set(b, 'offset', -1).set(b, 'offset_fac', -1).set(b, 'crease_inner', 0).set(b, 'flag', 0).set(b, 'mat_ofs', 0).set(b, 'nonmanifold_thickness_mode', 1).set(b, 'nonmanifold_boundary_mode', 0).set(b, 'merge_tolerance', 0.0001).set(b, 'bevel_convex', 0).set(b, 'offset', m.thickness ?? 0.01);
    return [b];
  }

  /* ---------- camera / light / world / render ---------- */
  setCamera({ loc, rot, lens = 50, clipEnd = 100 }) {
    const f = this.f, ob = this.camera, ca = f.byAddr(f.get(ob, 'data'));
    f.set(ob, 'loc', loc).set(ob, 'rot', rot).set(ob, 'obmat', matrix(loc, rot, [1, 1, 1]));
    f.set(ca, 'lens', lens); if (f.has('Camera', 'clip_end')) f.set(ca, 'clip_end', clipEnd); else if (f.has('Camera', 'clipend')) f.set(ca, 'clipend', clipEnd);
  }
  setLight({ loc, rot = [0, 0, 0], type = 'area', energy = 600, size = 3, color = [1, 1, 1] }) {
    const f = this.f, ob = this.light, la = f.byAddr(f.get(ob, 'data'));
    f.set(ob, 'loc', loc).set(ob, 'rot', rot).set(ob, 'obmat', matrix(loc, rot, [1, 1, 1]));
    f.set(la, 'type', { point: 0, sun: 1, spot: 2, area: 4 }[type]).set(la, 'energy', energy).set(la, 'r', color[0]).set(la, 'g', color[1]).set(la, 'b', color[2]);
    f.set(la, 'area_size', size); if (f.has('Lamp', 'area_sizey')) f.set(la, 'area_sizey', size);
    if (type === 'sun' && f.has('Lamp', 'sun_angle')) f.set(la, 'sun_angle', 0.1);
  }
  // an extra light: a copy of the scene light's object + data
  addLight(name, opts) {
    const f = this.f, src = f.byAddr(f.get(this.light, 'data')), la = { ...src, data: src.data.slice(), old: f.addr() };
    f.clearPointers(la); f.set(la, 'id.name', this.unique('LA', name)).set(la, 'id.us', 1);
    // keep the light's embedded curve-falloff data out (zeroed pointer is fine)
    f.add([la]);
    const ob = this.object(name, la, { type: 10, loc: opts.loc, rot: opts.rot });
    const keep = this.light; this.light = ob; this.setLight(opts); this.light = keep;
    return ob;
  }
  setWorld(color, strength = 1) {
    const f = this.f, wo = f.find('WOWorld');
    f.set(wo, 'horr', color[0]).set(wo, 'horg', color[1]).set(wo, 'horb', color[2]);
    const tree = f.byAddr(f.get(wo, 'nodetree')); if (!tree) return;
    for (const n of f.listItems(tree, 'nodes')) if (f.get(n, 'idname') === 'ShaderNodeBackground') {
      for (const s of f.listItems(n, 'inputs')) {
        const dv = f.byAddr(f.get(s, 'default_value')); if (!dv) continue;
        if (f.get(s, 'identifier') === 'Color') f.set(dv, 'value', [...color, 1]);
        if (f.get(s, 'identifier') === 'Strength') f.set(dv, 'value', strength);
      }
    }
  }
  setRender({ width, height, frames, fps, engine }) {
    const f = this.f, sc = this.scene;
    if (width) f.set(sc, 'r.xsch', width).set(sc, 'r.ysch', height).set(sc, 'r.size', 100);
    if (frames) f.set(sc, 'r.sfra', 1).set(sc, 'r.efra', frames);
    if (fps) f.set(sc, 'r.frs_sec', fps).set(sc, 'r.frs_sec_base', 1);
    if (engine) f.set(sc, 'r.engine', engine);
  }
  // 3D viewports open in Material Preview so textures show straight away
  viewportMaterialPreview() {
    const f = this.f, sid = f.structIndex.get('View3D');
    for (const b of f.blocks) if (b.sdna === sid && b.code === 'DATA') { try { f.set(b, 'shading.type', 4); } catch { /* older layout */ } }
  }

  /* ---------- output ---------- */
  bytes() {
    const f = this.f;
    // rebuild the collection's object list (camera, light and everything we added; the cube is gone)
    const old = f.listItems(this.collection, 'gobject');
    for (const b of old) f.blocks.splice(f.blocks.indexOf(b), 1);
    const items = this.objects.map((ob) => { const c = f.alloc('CollectionObject'); f.set(c, 'ob', ob); return c; });
    f.linkList(this.collection, 'gobject', items); f.addData(this.collection, items);
    for (const b of [this.tpl.object, this.tpl.mesh]) if (f.blocks.includes(b)) f.remove(b);
    // the template material has no users left; keep it only if something uses it
    for (const br of f.ids('BR')) f.remove(br);
    for (const pl of f.ids('PL')) f.remove(pl);
    return f.write();
  }
}

// Blender XYZ euler (radians) + location + scale -> column-major 4x4 (as stored in obmat)
export function matrix(loc, rot, scale) {
  const [x, y, z] = rot, cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
  // R = Rz * Ry * Rx
  const r = [
    [cy * cz, sx * sy * cz - cx * sz, cx * sy * cz + sx * sz],
    [cy * sz, sx * sy * sz + cx * cz, cx * sy * sz - sx * cz],
    [-sy, sx * cy, cx * cy],
  ];
  return [r[0][0] * scale[0], r[1][0] * scale[0], r[2][0] * scale[0], 0, r[0][1] * scale[1], r[1][1] * scale[1], r[2][1] * scale[1], 0, r[0][2] * scale[2], r[1][2] * scale[2], r[2][2] * scale[2], 0, loc[0], loc[1], loc[2], 1];
}
export { toAddr };
