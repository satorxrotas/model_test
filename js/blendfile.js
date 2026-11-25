// Minimal .blend reader/writer. It works on a template file saved by Blender (64-bit, little endian) and uses the
// template's own SDNA (the struct catalogue every .blend carries), so blocks are read and written by field name.
// Blender relinks pointers by their "old address", so new blocks just need unique addresses.

const dec = new TextDecoder('latin1'), enc = new TextEncoder();

export class BlendFile {
  constructor(buffer) {
    const u8 = new Uint8Array(buffer), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (dec.decode(u8.subarray(0, 7)) !== 'BLENDER' || u8[7] !== 45 /* '-' */ || u8[8] !== 118 /* 'v' */) throw new Error('Template must be a 64-bit little-endian .blend');
    this.header = u8.slice(0, 12);
    this.blocks = [];
    let o = 12;
    while (o < u8.length) {
      const code = dec.decode(u8.subarray(o, o + 4)), size = dv.getInt32(o + 4, true), old = dv.getBigUint64(o + 8, true);
      const sdna = dv.getInt32(o + 16, true), cnt = dv.getInt32(o + 20, true);
      this.blocks.push({ code, size, old, sdna, cnt, data: u8.slice(o + 24, o + 24 + size) });
      o += 24 + size;
      if (code === 'ENDB') break;
    }
    this.parseDNA(this.blocks.find((b) => b.code === 'DNA1').data);
    this.used = new Set(this.blocks.map((b) => b.old));
    this.nextAddr = 0x100000000n;
  }

  parseDNA(d) {
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength), al = (x) => (x + 3) & ~3;
    let o = 8;
    const strings = (n) => { const out = []; for (let i = 0; i < n; i++) { let e = o; while (d[e]) e++; out.push(dec.decode(d.subarray(o, e))); o = e + 1; } return out; };
    const names = strings(dv.getInt32((o += 4) - 4, true)); o = al(o) + 4;
    const types = strings(dv.getInt32((o += 4) - 4, true)); o = al(o) + 4;
    const tlen = []; for (let i = 0; i < types.length; i++) tlen.push(dv.getInt16(o + 2 * i, true));
    o = al(o + 2 * types.length) + 4;
    const ns = dv.getInt32(o, true); o += 4;
    this.structs = []; this.structIndex = new Map(); this.tlen = new Map(types.map((t, i) => [t, tlen[i]]));
    for (let s = 0; s < ns; s++) {
      const t = types[dv.getInt16(o, true)], nf = dv.getInt16(o + 2, true); o += 4;
      const fields = new Map(), list = []; let off = 0;
      for (let f = 0; f < nf; f++) {
        const ft = types[dv.getInt16(o, true)], fn = names[dv.getInt16(o + 2, true)]; o += 4;
        const ptr = fn.includes('*'), dims = [...fn.matchAll(/\[(\d+)\]/g)].map((m) => +m[1]), n = dims.reduce((a, b) => a * b, 1);
        const elem = ptr ? 8 : this.tlen.get(ft), key = fn.replace(/[*()]/g, '').replace(/\[.*$/, '');
        const fd = { type: ft, name: fn, key, off, ptr, dims, n, elem, size: elem * n, fnptr: fn.includes('(') };
        fields.set(key, fd); list.push(fd); off += fd.size;
      }
      const st = { name: t, size: this.tlen.get(t), fields, list };
      this.structIndex.set(t, s); this.structs.push(st);
    }
  }

  struct(name) { const i = this.structIndex.get(name); if (i == null) throw new Error(`No struct ${name} in template`); return this.structs[i]; }
  structOf(block) { return this.structs[block.sdna]; }

  /* ---------- addresses + blocks ---------- */
  addr() { let a; do { a = this.nextAddr; this.nextAddr += 0x40n; } while (this.used.has(a)); this.used.add(a); return a; }
  alloc(structName, cnt = 1, code = 'DATA') {
    const st = this.struct(structName);
    return { code, size: st.size * cnt, old: this.addr(), sdna: this.structIndex.get(structName), cnt, data: new Uint8Array(st.size * cnt) };
  }
  raw(bytes) { const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes); return { code: 'DATA', size: u.length, old: this.addr(), sdna: 0, cnt: 1, data: u.slice() }; }
  ptrArray(ptrs) { // Material **mat style arrays (written as raw pointer lists)
    const b = { code: 'DATA', size: 8 * ptrs.length, old: this.addr(), sdna: this.structIndex.get('Link'), cnt: 1, data: new Uint8Array(8 * ptrs.length) };
    const dv = new DataView(b.data.buffer); ptrs.forEach((p, i) => dv.setBigUint64(8 * i, toAddr(p), true)); return b;
  }

  isID(b) { return b.code.length === 4 && b.code[2] === '\0' && b.code !== 'DATA' && /^[A-Z]{2}$/.test(b.code.slice(0, 2)); }
  ids(code2) { return this.blocks.filter((b) => this.isID(b) && b.code.startsWith(code2)); }
  idName(b) { return this.get(b, 'id.name'); }
  find(fullName) { return this.blocks.find((b) => this.isID(b) && this.idName(b) === fullName); }
  group(b) { // an ID block and the DATA blocks that follow it
    const i = this.blocks.indexOf(b), out = [b];
    for (let j = i + 1; j < this.blocks.length && this.blocks[j].code === 'DATA'; j++) out.push(this.blocks[j]);
    return out;
  }
  remove(b) { const g = this.group(b), i = this.blocks.indexOf(b); this.blocks.splice(i, g.length); }
  // add an ID block and its data before DNA1 (or right after another block)
  add(blocks, after = null) {
    const i = after ? this.blocks.indexOf(after) + 1 : this.blocks.findIndex((b) => b.code === 'DNA1');
    this.blocks.splice(i, 0, ...blocks);
  }
  addData(owner, blocks) { const g = this.group(owner), i = this.blocks.indexOf(g[g.length - 1]) + 1; this.blocks.splice(i, 0, ...blocks); }
  byAddr(a) { a = toAddr(a); return this.blocks.find((b) => b.old === a); }

  /* ---------- field access ---------- */
  locate(structName, path) {
    let st = this.struct(structName), off = 0, fd;
    const parts = path.split('.');
    for (let k = 0; k < parts.length; k++) {
      fd = st.fields.get(parts[k]);
      if (!fd) throw new Error(`${st.name} has no field ${parts[k]}`);
      off += fd.off;
      if (k < parts.length - 1) st = this.struct(fd.type);
    }
    return { fd, off };
  }
  has(structName, path) { try { this.locate(structName, path); return true; } catch { return false; } }
  get(block, path, index = 0, structName) {
    const sn = structName || this.structOf(block).name, { fd, off } = this.locate(sn, path), base = index * this.struct(sn).size + off;
    return readField(block.data, base, fd);
  }
  set(block, path, value, index = 0, structName) {
    const sn = structName || this.structOf(block).name, { fd, off } = this.locate(sn, path), base = index * this.struct(sn).size + off;
    writeField(block.data, base, fd, value);
    return this;
  }
  // zero every pointer in a block (keeps plain values); used when copying a struct out of context
  clearPointers(block, keep = []) {
    const walk = (sn, base) => {
      for (const fd of this.struct(sn).list) {
        if (fd.ptr) { if (!keep.includes(fd.key) || base) block.data.fill(0, base + fd.off, base + fd.off + fd.size); }
        else if (this.structIndex.has(fd.type) && fd.type !== sn) for (let i = 0; i < fd.n; i++) walk(fd.type, base + fd.off + i * fd.elem);
      }
    };
    for (let i = 0; i < block.cnt; i++) walk(this.structOf(block).name, i * this.structOf(block).size);
  }
  // remap every pointer field of the given blocks through map (old -> new)
  remap(blocks, map) {
    for (const b of blocks) {
      const dv = new DataView(b.data.buffer, b.data.byteOffset, b.data.byteLength);
      const st = this.structOf(b);
      if (b.sdna === this.structIndex.get('Link') && st.name === 'Link') { // raw pointer arrays
        for (let o = 0; o + 8 <= b.size; o += 8) { const v = dv.getBigUint64(o, true); if (map.has(v)) dv.setBigUint64(o, map.get(v), true); }
        continue;
      }
      const walk = (sn, base) => {
        for (const fd of this.struct(sn).list) {
          if (fd.ptr) { for (let i = 0; i < fd.n; i++) { const o = base + fd.off + 8 * i, v = dv.getBigUint64(o, true); if (map.has(v)) dv.setBigUint64(o, map.get(v), true); } }
          else if (this.structIndex.has(fd.type)) for (let i = 0; i < fd.n; i++) walk(fd.type, base + fd.off + i * fd.elem);
        }
      };
      if (b.data.length >= st.size) for (let i = 0; i < b.cnt; i++) walk(st.name, i * st.size);
    }
  }
  // deep copy of an ID and its data with fresh addresses; returns the new ID block (not yet added)
  cloneGroup(idBlock) {
    const g = this.group(idBlock), map = new Map(), out = g.map((b) => { const nb = { ...b, data: b.data.slice(), old: this.addr() }; map.set(b.old, nb.old); return nb; });
    this.remap(out, map);
    return { blocks: out, id: out[0], map };
  }
  // ListBase helpers: link a chain of blocks (each starting with next/prev pointers) into owner.path
  linkList(owner, path, items, index = 0) {
    items.forEach((it, i) => { setPtr(it.data, 0, items[i + 1]?.old ?? 0n); setPtr(it.data, 8, items[i - 1]?.old ?? 0n); });
    this.set(owner, `${path}.first`, items[0]?.old ?? 0n, index);
    this.set(owner, `${path}.last`, items[items.length - 1]?.old ?? 0n, index);
  }
  listItems(owner, path, index = 0) {
    const out = []; let a = this.get(owner, `${path}.first`, index);
    while (a) { const b = this.byAddr(a); if (!b) break; out.push(b); a = getPtr(b.data, 0); }
    return out;
  }

  write() {
    let total = 12; for (const b of this.blocks) total += 24 + b.data.length;
    const out = new Uint8Array(total), dv = new DataView(out.buffer); out.set(this.header, 0);
    let o = 12;
    for (const b of this.blocks) {
      out.set(enc.encode(b.code.padEnd(4, '\0')).subarray(0, 4), o);
      dv.setInt32(o + 4, b.data.length, true); dv.setBigUint64(o + 8, b.old, true); dv.setInt32(o + 16, b.sdna, true); dv.setInt32(o + 20, b.cnt, true);
      out.set(b.data, o + 24); o += 24 + b.data.length;
    }
    return out;
  }
}

/* ---------- value codecs ---------- */
export const toAddr = (p) => (p == null ? 0n : typeof p === 'bigint' ? p : typeof p === 'object' ? p.old : BigInt(p));
const getPtr = (u8, o) => new DataView(u8.buffer, u8.byteOffset).getBigUint64(o, true);
const setPtr = (u8, o, v) => new DataView(u8.buffer, u8.byteOffset).setBigUint64(o, toAddr(v), true);
const SCALAR = {
  char: ['Int8', 1], uchar: ['Uint8', 1], int8_t: ['Int8', 1], uint8_t: ['Uint8', 1], short: ['Int16', 2], ushort: ['Uint16', 2], int16_t: ['Int16', 2], uint16_t: ['Uint16', 2],
  int: ['Int32', 4], uint: ['Uint32', 4], int32_t: ['Int32', 4], uint32_t: ['Uint32', 4], float: ['Float32', 4], double: ['Float64', 8],
  int64_t: ['BigInt64', 8], uint64_t: ['BigUint64', 8], long: ['Int32', 4], ulong: ['Uint32', 4],
};
function readField(u8, base, fd) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (fd.ptr) { const v = []; for (let i = 0; i < fd.n; i++) v.push(dv.getBigUint64(base + 8 * i, true)); return fd.n === 1 && !fd.dims.length ? v[0] : v; }
  if ((fd.type === 'char' || fd.type === 'uchar') && fd.dims.length) { let e = base; while (e < base + fd.size && u8[e]) e++; return dec.decode(u8.subarray(base, e)); }
  const sc = SCALAR[fd.type]; if (!sc) return u8.slice(base, base + fd.size);
  const v = []; for (let i = 0; i < fd.n; i++) v.push(dv[`get${sc[0]}`](base + i * sc[1], true));
  return fd.dims.length ? v : v[0];
}
function writeField(u8, base, fd, value) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (fd.ptr) { const vs = Array.isArray(value) ? value : [value]; vs.forEach((v, i) => dv.setBigUint64(base + 8 * i, toAddr(v), true)); return; }
  if ((fd.type === 'char' || fd.type === 'uchar') && fd.dims.length && typeof value === 'string') {
    const b = enc.encode(value); u8.fill(0, base, base + fd.size); u8.set(b.subarray(0, fd.size - 1), base); return;
  }
  if (value instanceof Uint8Array) { u8.set(value.subarray(0, fd.size), base); return; }
  const sc = SCALAR[fd.type]; if (!sc) throw new Error(`Can't write ${fd.type} ${fd.name}`);
  const vs = Array.isArray(value) || ArrayBuffer.isView(value) ? [...value] : [value];
  vs.slice(0, fd.n).forEach((v, i) => dv[`set${sc[0]}`](base + i * sc[1], sc[0].startsWith('Big') ? BigInt(v) : v, true));
}
