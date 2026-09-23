/* =========================================================================
   Storage. Everything lives on this device in IndexedDB so the app works with
   no signal. Records are small and kept in memory after load; photos go in a
   separate store and are read on demand.
   ========================================================================= */
const DB_NAME = 'mason-ranch';
const VERSION = 1;
let idb = null;
const cache = new Map(); // collection -> Map(id -> record)
const listeners = new Set();

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const tx = (store, mode, fn) => new Promise((resolve, reject) => {
  const t = idb.transaction(store, mode);
  const out = fn(t.objectStore(store));
  t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
  t.onerror = () => reject(t.error);
  t.onabort = () => reject(t.error);
});

export async function init() {
  idb = await open();
  const rows = await tx('records', 'readonly', (s) => s.getAll());
  for (const r of rows) bucket(r.col).set(r.id, r);
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
}
const bucket = (col) => { if (!cache.has(col)) cache.set(col, new Map()); return cache.get(col); };
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const all = (col) => [...bucket(col).values()];
export const get = (col, id) => bucket(col).get(id) || null;
export const onChange = (fn) => listeners.add(fn);
const emit = (col) => listeners.forEach((fn) => fn(col));

export async function put(col, rec) {
  const r = { ...rec, col, id: rec.id || uid(), updated: new Date().toISOString() };
  await tx('records', 'readwrite', (s) => s.put(r));
  bucket(col).set(r.id, r);
  emit(col);
  return r;
}
export async function putMany(col, recs) {
  const now = new Date().toISOString();
  const rows = recs.map((rec) => ({ ...rec, col, id: rec.id || uid(), updated: now }));
  await tx('records', 'readwrite', (s) => rows.forEach((r) => s.put(r)));
  rows.forEach((r) => bucket(col).set(r.id, r));
  emit(col);
  return rows;
}
export async function del(col, id) {
  await tx('records', 'readwrite', (s) => s.delete(id));
  bucket(col).delete(id);
  emit(col);
}
export async function delMany(col, ids) {
  await tx('records', 'readwrite', (s) => ids.forEach((id) => s.delete(id)));
  ids.forEach((id) => bucket(col).delete(id));
  emit(col);
}

/* Settings are a single record. */
export const settings = () => get('settings', 'main') || { id: 'main' };
export const saveSettings = (patch) => put('settings', { ...settings(), ...patch, id: 'main' });

/* Photos: metadata is an ordinary 'photos' record; pixels live in 'blobs'. */
export const putBlob = (id, data) => tx('blobs', 'readwrite', (s) => s.put({ id, data }));
export const getBlob = (id) => tx('blobs', 'readonly', (s) => s.get(id)).then((r) => r?.data || null);
export const delBlob = (id) => tx('blobs', 'readwrite', (s) => s.delete(id));

/* Full backup — the one file to copy off this phone. */
export async function exportAll() {
  const records = [];
  for (const m of cache.values()) records.push(...m.values());
  const blobs = await tx('blobs', 'readonly', (s) => s.getAll());
  return { app: 'mason-ranch', version: 1, exported: new Date().toISOString(), records, blobs };
}
export async function importAll(data, { replace = false } = {}) {
  if (!data || data.app !== 'mason-ranch' || !Array.isArray(data.records)) throw new Error('Not a Mason Ranch backup file.');
  if (replace) {
    await tx('records', 'readwrite', (s) => s.clear());
    await tx('blobs', 'readwrite', (s) => s.clear());
    cache.clear();
  }
  // Merge: the newer copy of a record wins.
  const keep = data.records.filter((r) => {
    const cur = get(r.col, r.id);
    return !cur || !cur.updated || (r.updated || '') >= cur.updated;
  });
  await tx('records', 'readwrite', (s) => keep.forEach((r) => s.put(r)));
  keep.forEach((r) => bucket(r.col).set(r.id, r));
  await tx('blobs', 'readwrite', (s) => (data.blobs || []).forEach((b) => s.put(b)));
  emit('*');
  return { records: keep.length, blobs: (data.blobs || []).length };
}
