/* =========================================================================
   Pulls automatic data from your ranch relay (relay/ — a Cloudflare Worker):
   daily rain and Tactacam Reveal photos with camera battery and signal.
   Runs when the app opens, every 15 minutes while it's open, and whenever
   the phone gets signal back. Nothing here is needed for the app to work.
   ========================================================================= */
import * as db from './db.js';
import * as C from './calc.js';
import { addPhotoFile } from './photos.js';

export const AUTO_GAUGE = 'Rain gauge (auto)';
export const AUTO_EST = 'Weather-model estimate (auto)';
const MAX_PHOTOS_PER_SYNC = 200;
let running = null;

export const relayConfigured = () => { const s = db.settings(); return !!(s.relayUrl && s.relayToken); };

async function call(path, { as = 'json', method = 'GET', body } = {}) {
  const s = db.settings();
  const base = String(s.relayUrl).trim().replace(/\/+$/, '');
  const headers = { Authorization: `Bearer ${String(s.relayToken).trim()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) };
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) throw Object.assign(new Error('Relay rejected the token. Check it matches RELAY_TOKEN'), { auth: true });
  if (!r.ok) {
    const msg = await r.json().then((j) => j.error).catch(() => '');
    throw Object.assign(new Error(msg || `Relay ${path.split('?')[0]} HTTP ${r.status}`), { status: r.status });
  }
  return as === 'blob' ? r.blob() : r.json();
}

/**
 * Turn relay rain rows into rain-log writes. One automatic record per day
 * (gauge if it reported, else the model estimate). A day you logged by hand
 * wins — its automatic record is removed so rain is never counted twice.
 */
export function planRainImport(rows, existing) {
  const manual = new Set(existing.filter((r) => !r.auto && r.date).map((r) => r.date));
  const autos = new Map(existing.filter((r) => r.auto).map((r) => [r.date, r]));
  const put = [], del = [];
  for (const row of rows) {
    const gauge = row.gauge != null && Number.isFinite(Number(row.gauge));
    const inches = gauge ? Number(row.gauge) : row.est != null ? Number(row.est) : null;
    const cur = autos.get(row.date);
    if (manual.has(row.date)) { if (cur) del.push(cur.id); continue; }
    if (inches == null || !Number.isFinite(inches)) continue;
    const rec = { id: `auto-rain-${row.date}`, date: row.date, inches: Math.round(inches * 100) / 100, gauge: gauge ? AUTO_GAUGE : AUTO_EST, auto: true };
    if (cur && cur.inches === rec.inches && cur.gauge === rec.gauge) continue;
    put.push({ ...(cur || {}), ...rec });
  }
  // Hand-logged days whose auto record predates them.
  for (const [date, r] of autos) if (manual.has(date) && !del.includes(r.id)) del.push(r.id);
  return { put, del };
}

/** Local 'YYYY-MM-DD' and 'HH:MM' for an ISO instant. */
const localParts = (iso) => {
  const d = new Date(iso);
  return { date: C.ymd(d), time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` };
};

export function syncRelay(opts = {}) {
  if (!relayConfigured() || !navigator.onLine) return Promise.resolve(null);
  running ||= doSync(opts).finally(() => { running = null; });
  return running;
}

async function doSync() {
  const s = db.settings();
  const out = { rain: 0, photos: 0, cameras: 0, errors: [] };

  // --- rain ---------------------------------------------------------------
  try {
    const st = await call('/status'); // fail fast (once) on a wrong address or token
    await db.saveSettings({ relayInfo: { sources: st.sources || {}, location: st.location || null } });
    const since = s.relayRainSynced ? C.addDays(s.relayRainSynced, -14) : '1900-01-01';
    const rows = await call(`/rain?since=${since}`);
    const plan = planRainImport(rows, db.all('rain'));
    if (plan.put.length) await db.putMany('rain', plan.put);
    if (plan.del.length) await db.delMany('rain', plan.del);
    out.rain = plan.put.length;
    await db.saveSettings({ relayRainSynced: C.today() });
  } catch (err) {
    if (err.auth || err instanceof TypeError) {
      out.errors.push(err.auth ? err.message : `Can't reach the relay (${err.message}). Check the address`);
      await db.saveSettings({ relayLastResult: out });
      return out;
    }
    out.errors.push(`Rain: ${err.message}`);
  }

  // --- cameras (battery, signal, location) ---------------------------------
  const deviceFor = new Map();
  try {
    const cams = await call('/cameras');
    const devs = db.all('devices');
    const writes = [];
    for (const c of cams) {
      let d = devs.find((x) => x.revealId === c.id);
      const patch = {
        batteryPct: c.battery ?? '', signal: c.signal ?? '', lastPhoto: c.last_photo || '',
        ...(c.lat != null && !d?.loc?.lat ? { loc: { lat: c.lat, lon: c.lon } } : {}),
      };
      d = d ? { ...d, ...patch } : { id: db.uid(), name: c.name || 'Reveal camera', type: 'camera', revealId: c.id, batteryDays: '', ...patch };
      writes.push(d);
      deviceFor.set(c.id, d);
    }
    if (writes.length) await db.putMany('devices', writes);
    out.cameras = writes.length;
  } catch (err) { out.errors.push(`Cameras: ${err.message}`); }

  // --- photos --------------------------------------------------------------
  if (s.relayPhotos !== false) {
    try {
      let cursor = Number(db.settings().relayPhotoCursor) || 0;
      while (out.photos < MAX_PHOTOS_PER_SYNC) {
        const list = await call(`/photos?after=${cursor}&limit=25`);
        if (!list.length) break;
        for (const p of list) {
          const id = `reveal-${p.id}`;
          if (!db.get('photos', id)) {
            const blob = await call(`/photo/${encodeURIComponent(p.id)}`, { as: 'blob' });
            const dev = deviceFor.get(p.camera_id) || db.all('devices').find((x) => x.revealId === p.camera_id);
            const { date, time } = localParts(p.taken);
            await addPhotoFile(new File([blob], `${p.id}.jpg`, { type: 'image/jpeg', lastModified: Date.parse(p.taken) || 0 }), {
              id, date, time, source: 'reveal', noGps: true, maxEdge: 1280,
              caption: `${p.camera || dev?.name || 'Camera'} · ${time}`,
              device: dev?.id || '',
              loc: p.lat != null ? { lat: p.lat, lon: p.lon } : dev?.loc || null,
              temp: p.temp ?? '', moon: p.moon || '',
              aiTags: p.ai_tags || '', aiSummary: p.ai_summary || '',
            });
            out.photos++;
          }
          cursor = Math.max(cursor, Number(p.seq) || 0);
        }
        await db.saveSettings({ relayPhotoCursor: cursor });
      }
    } catch (err) { out.errors.push(`Photos: ${err.message}`); }
  }

  // AI labels that finished after their photo was already on this phone.
  if (s.relayPhotos !== false) {
    try {
      const since = db.settings().relayLabelCursor || '1970-01-01';
      const rows = await call(`/labels?since=${encodeURIComponent(since)}`);
      const writes = [];
      let cursor = since;
      for (const r of rows) {
        cursor = r.updated > cursor ? r.updated : cursor;
        const ph = db.get('photos', `reveal-${r.id}`);
        if (ph && (ph.aiTags !== (r.tags || '') || ph.aiSummary !== (r.summary || ''))) writes.push({ ...ph, aiTags: r.tags || '', aiSummary: r.summary || '' });
      }
      if (writes.length) await db.putMany('photos', writes);
      out.labels = writes.length;
      await db.saveSettings({ relayLabelCursor: cursor });
    } catch (err) { out.errors.push(`Labels: ${err.message}`); }
  }

  // Brush photos taken without signal.
  try { out.scans = await analyzePendingScans(); } catch (err) { out.errors.push(`Brush photos: ${err.message}`); }

  await prunePhotos();
  await db.saveSettings({ relayLastSync: new Date().toISOString(), relayLastResult: out });
  return out;
}

/**
 * Camera photos pile up fast. Untagged ones older than the keep window are
 * deleted from this phone; anything you tagged or flagged for the packet stays.
 */
export async function prunePhotos() {
  const keep = Number(db.settings().camPhotoKeepDays ?? 30);
  if (!(keep > 0)) return 0;
  const cutoff = C.addDays(C.today(), -keep);
  const { deletePhoto } = await import('./photos.js');
  // Frames the classifier called empty (wind, grass) go after 3 days.
  const emptyCutoff = C.addDays(C.today(), -3);
  const old = db.all('photos').filter((p) => p.source === 'reveal' && p.date && !String(p.tags || '').trim() && !p.packet
    && (p.date < cutoff || (p.aiTags === 'empty' && p.date < emptyCutoff)));
  for (const p of old) await deletePhoto(p.id);
  return old.length;
}

export async function relayStatus() {
  return call('/status');
}
export async function relayRunNow() {
  return call('/run', { method: 'POST' });
}

/* ---------------------- brush density from a photo ---------------------- */
/**
 * Send one brush scan's photo to the relay, which asks Claude to count cedar,
 * mesquite and prickly pear. The result is saved on the scan record. Without
 * signal the scan stays 'pending' and goes out on the next sync.
 */
export async function analyzeScan(id) {
  const scan = db.get('brushscans', id);
  if (!scan) return null;
  const { photoURL } = await import('./photos.js');
  const image = await photoURL(scan.photo);
  if (!image) return db.put('brushscans', { ...scan, status: 'error', error: 'Photo is missing' });
  try {
    const out = await call('/brush-scan', { method: 'POST', body: { image, view: scan.view, note: [scan.area, scan.notes].filter(Boolean).join('. ') } });
    return db.put('brushscans', { ...scan, status: 'done', result: out.result, model: out.model, error: '' });
  } catch (err) {
    // No signal: leave it queued. A daily cap: try again on a later sync.
    if (err instanceof TypeError || err.status === 429) return db.put('brushscans', { ...scan, status: 'pending', error: err.message });
    return db.put('brushscans', { ...scan, status: 'error', error: err.message });
  }
}
async function analyzePendingScans() {
  let n = 0;
  for (const s of db.all('brushscans').filter((x) => x.status === 'pending').slice(0, 5)) {
    const r = await analyzeScan(s.id);
    if (r?.status === 'done') n++;
  }
  return n;
}
