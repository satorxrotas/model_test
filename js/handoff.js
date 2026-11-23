// Pass a generated garment from Image to Model to Motion Studio (same site, IndexedDB).
const DB = 'gms-handoff', STORE = 'garment';
const open = () => new Promise((res, rej) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
export async function putGarment(item) {
  const db = await open();
  await new Promise((res, rej) => { const t = db.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(item, 'latest'); t.oncomplete = res; t.onerror = () => rej(t.error); });
}
export async function getGarment() {
  try {
    const db = await open();
    return await new Promise((res) => { const r = db.transaction(STORE).objectStore(STORE).get('latest'); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); });
  } catch { return null; }
}
