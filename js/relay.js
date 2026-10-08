/* =========================================================================
   Pulls automatic data from your ranch relay (relay/ — a Cloudflare Worker):
   daily rain and Tactacam Reveal photos with camera battery and signal.
   Runs when the app opens, every 15 minutes while it's open, and whenever
   the phone gets signal back. Nothing here is needed for the app to work.
   ========================================================================= */
import * as db from './db.js';
import * as C from './calc.js';
import { addPhotoFile, photoURL, photoTags, shrinkImage, imageSize } from './photos.js';
import { deerCounts, planBuckSort, sortBatches, planVisitCarry, planTwinMerges, photoBucks, hasBuck, withBucks, cleanBuckName, cleanRack, planReset, BUCK_FIELDS } from './deer.js';

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
    // A new (or corrected) ranch location means new estimates for every day: pull them all again.
    const where = st.location ? `${st.location.lat},${st.location.lon}` : '';
    const moved = where && s.relayRainLoc && s.relayRainLoc !== where;
    const since = s.relayRainSynced && !moved ? C.addDays(s.relayRainSynced, -14) : '1900-01-01';
    const rows = await call(`/rain?since=${since}`);
    const plan = planRainImport(rows, db.all('rain'));
    if (plan.put.length) await db.putMany('rain', plan.put);
    if (plan.del.length) await db.delMany('rain', plan.del);
    out.rain = plan.put.length;
    await db.saveSettings({ relayRainSynced: C.today(), relayRainLoc: where });
  } catch (err) {
    if (err.auth || err instanceof TypeError) {
      out.errors.push(err.auth ? err.message : `Can't reach the relay (${err.message}). Check the address`);
      await db.saveSettings({ relayLastResult: out });
      return out;
    }
    out.errors.push(`Rain: ${err.message}`);
  }

  // --- weather station (every sensor) ---------------------------------------
  if (db.settings().relayInfo?.sources?.ambient) {
    try {
      const after = db.settings().relayWxCursor || '1970-01-01';
      const wx = await call(`/weather?after=${encodeURIComponent(after)}`);
      if (wx.current) await db.saveSettings({ weatherNow: wx.current });
      let cursor = after;
      const days = wx.days.map((d) => { cursor = d.updated > cursor ? d.updated : cursor; return { id: `wx-${d.date}`, date: d.date, f: d.f }; });
      if (days.length) await db.putMany('wxdays', days);
      out.weatherDays = days.length;
      await db.saveSettings({ relayWxCursor: cursor });
    } catch (err) { out.errors.push(`Weather: ${err.message}`); }
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
              ...(p.ai_labels ? { aiCounts: deerCounts(parseJSON(p.ai_labels)) } : {}),
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
        // A redone label (after a reset) brings new deer counts even when the tags look the same.
        if (ph && (ph.aiTags !== (r.tags || '') || ph.aiSummary !== (r.summary || '') || (r.labels && JSON.stringify(deerCounts(r.labels)) !== JSON.stringify(ph.aiCounts || null)))) {
          writes.push({ ...ph, aiTags: r.tags || '', aiSummary: r.summary || '', ...(r.labels ? { aiCounts: deerCounts(r.labels) } : {}) });
        }
      }
      if (writes.length) await db.putMany('photos', writes);
      out.labels = writes.length;
      await db.saveSettings({ relayLabelCursor: cursor });
    } catch (err) { out.errors.push(`Labels: ${err.message}`); }
  }

  // New buck photos: which named buck is it?
  try { out.bucks = await matchPendingBucks(); await cleanAutoBuckNames(); } catch (err) { out.errors.push(`Buck matching: ${err.message}`); }

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

/** Full-resolution original of a camera photo from the relay (null if it's gone or offline). */
export async function relayPhotoBlob(photoId) {
  if (!relayConfigured() || !navigator.onLine || !String(photoId).startsWith('reveal-')) return null;
  try { return await call(`/photo/${encodeURIComponent(String(photoId).slice(7))}`, { as: 'blob' }); } catch { return null; }
}

export async function relayStatus() {
  return call('/status');
}
export async function relayRunNow() {
  return call('/run', { method: 'POST' });
}

const parseJSON = (x) => { try { return typeof x === 'string' ? JSON.parse(x) : x; } catch { return null; } };

/* ------------------------- which buck is this? ---------------------------- */
const MAX_BUCKS_SENT = 8, REFS_PER_BUCK = 3, MATCH_PER_SYNC = 8;
/** Reference photos for a buck: the ones you starred, else his newest confirmed photos. */
export function buckRefIds(b) {
  if (b.refs?.length) return b.refs.filter((id) => db.get('photos', id)).slice(0, REFS_PER_BUCK);
  return db.all('photos').filter((p) => hasBuck(p, b.id)).sort((x, y) => (`${x.date} ${x.time || ''}` < `${y.date} ${y.time || ''}` ? 1 : -1)).slice(0, REFS_PER_BUCK).map((p) => p.id);
}
async function buckRoster(perBuck = REFS_PER_BUCK) {
  const out = [];
  for (const b of db.all('bucks').filter((x) => (x.status || 'active') === 'active')) {
    const refs = [];
    for (const id of buckRefIds(b).slice(0, perBuck)) { const u = await photoURL(id); if (u) refs.push(await shrinkImage(u, 640)); }
    if (refs.length) out.push({ id: b.id, name: b.name, refs });
    if (out.length >= MAX_BUCKS_SENT) break;
  }
  return out;
}
/** Ask the relay which named buck is in a photo; saves the answer on the photo as buckAI. */
export async function matchBuckPhoto(id, roster = null) {
  const p = db.get('photos', id);
  if (!p) return null;
  const bucks = roster || await buckRoster();
  if (!bucks.length) throw new Error('Name a buck and confirm a photo of him first');
  const image = await photoURL(id);
  if (!image) throw new Error('Photo is missing');
  try {
    const cam = db.get('devices', p.device)?.name;
    const r = await call('/buck-match', { method: 'POST', body: { image, size: await imageSize(image), bucks, note: [cam, p.date, p.time].filter(Boolean).join(' ') } });
    return db.put('photos', { ...db.get('photos', id), buckAI: { ...r.result, model: r.model, at: new Date().toISOString() } });
  } catch (err) {
    if (err instanceof TypeError || err.status === 429) throw err; // offline or capped: try again next sync
    return db.put('photos', { ...db.get('photos', id), buckAI: { match: 'error', reason: err.message, at: new Date().toISOString() } });
  }
}
/* ----------------------------- auto-sort bucks ---------------------------- */
const SORT_BATCH = 10;
/** Buck photos nobody has sorted yet (newest first). */
export function unsortedBuckPhotos({ all = false } = {}) {
  const since = C.addDays(C.today(), -60);
  return db.all('photos').filter((p) => !photoBucks(p).length && (all || !p.buckSortAt) && p.date >= since && photoTags(p).includes('buck'))
    .sort((a, b) => (`${a.date} ${a.time || ''}` < `${b.date} ${b.time || ''}` ? 1 : -1));
}
/**
 * Let the AI sort unidentified buck photos: it groups them by individual buck,
 * files them under bucks you've named, and makes provisional bucks (named for
 * their racks) for the rest. Everything it files is marked auto until you confirm.
 */
let sorting = null;
export function sortPendingBucks(opts = {}) {
  if (!db.settings().relayInfo?.sources?.buckSort) return Promise.resolve(null);
  // One sort at a time: two at once would each send the same unsorted photos
  // and each make its own new buck from them, so one picture ends up as two
  // bucks. A second call (the 15-minute sync, a button, another tab) waits for
  // the running one and gets its result; another tab skips its turn.
  sorting ||= (navigator.locks ? navigator.locks.request('ranch-buck-sort', { ifAvailable: true }, (lock) => (lock ? runSort(opts) : null)) : runSort(opts)).finally(() => { sorting = null; });
  return sorting;
}
async function runSort({ batches = 2, all = false } = {}) {
  const out = { sorted: 0, filed: 0, suggested: 0, newBucks: 0 };
  for (let k = 0; k < batches; k++) {
    // A whole visit at a time (same camera, minutes apart), in the order taken,
    // so the AI can follow each deer from shot to shot.
    const [batch] = sortBatches(unsortedBuckPhotos({ all: all && k === 0 }), { max: SORT_BATCH });
    if (!batch) break;
    const roster = await buckRoster(2); // rebuilt each batch, so a buck found in batch 1 can collect more in batch 2
    const photos = [], ids = [], notes = [], sizes = [], visits = [];
    for (const [i, id] of batch.ids.entries()) {
      const p = db.get('photos', id), u = await photoURL(id);
      if (!u) { await db.put('photos', { ...p, buckSortAt: new Date().toISOString() }); continue; } // no image: don't block the queue
      const small = await shrinkImage(u, 900);
      photos.push(small); ids.push(id); sizes.push(await imageSize(small)); visits.push(batch.visits[i]);
      notes.push([db.get('devices', p.device)?.name, p.date, p.time].filter(Boolean).join(' '));
    }
    if (!photos.length) continue;
    let r;
    try { r = await call('/buck-sort', { method: 'POST', body: { photos, bucks: roster, notes, sizes, visits } }); } catch (err) { if (err.status === 429 || err instanceof TypeError) break; throw err; }
    const plan = planBuckSort(r.result, ids, roster.map((b) => b.id));
    const now = new Date().toISOString();
    const names = new Set(db.all('bucks').map((b) => String(b.name).toLowerCase()));
    const newId = {};
    for (const nb of plan.newBucks) {
      // Names and notes describe the deer, never the photo ("Night 8" → "8").
      const base = cleanBuckName(nb.name);
      let name = base, n = 2;
      while (names.has(name.toLowerCase())) name = `${base} ${n++}`;
      names.add(name.toLowerCase());
      const b = await db.put('bucks', { name, status: 'active', auto: true, marks: cleanRack(nb.rack), refs: [nb.refId], created: now });
      newId[nb.group] = b.id;
      out.newBucks++;
    }
    const writes = ids.map((id) => {
      const p = db.get('photos', id);
      const w = { ...p, buckSortAt: now, ...(plan.rack[id] ? { buckRack: cleanRack(plan.rack[id]) } : {}) };
      // Every buck the AI found in this photo: named ones and new groups.
      const found = [...plan.assign.filter((x) => x.id === id).map((x) => x.buck), ...plan.newBucks.filter((x) => x.photoIds.includes(id)).map((x) => newId[x.group])];
      const sgt = plan.suggest.find((x) => x.id === id);
      if (found.length) {
        Object.assign(w, withBucks(w, [...photoBucks(w), ...found])); w.buckAuto = true; out.filed++;
        if (plan.tracked[id]?.length === found.length) w.buckVia = 'visit'; // known only from his other shots in the visit
      }
      else if (sgt) { const sp = plan.spots[id]?.[sgt.buck]; w.buckAI = { match: sgt.buck, confidence: sgt.confidence, reason: `Auto-sort: ${plan.rack[id] || 'similar rack'}`, rack: plan.rack[id] || '', where: sp?.where || '', box: sp?.box || null, bv: sp?.bv || 0, at: now }; out.suggested++; }
      // Where each buck is in this photo (keeps places you set yourself).
      const spots = plan.spots[id] || {};
      for (const [group, spot] of Object.entries(spots)) {
        const bid = newId[group] || group;
        if (!db.get('bucks', bid) && !newId[group]) continue;
        if (w.buckSpots?.[bid]?.by === 'you') continue;
        w.buckSpots = { ...(w.buckSpots || {}), [bid]: { ...spot, where: cleanRack(spot.where), by: 'ai' } };
      }
      return w;
    });
    await db.putMany('photos', writes);
    out.sorted += ids.length;
    // Shots the AI couldn't place, in a visit that's all one buck: they're him too.
    const days = new Set(writes.flatMap((p) => [p.date, C.addDays(p.date, -1), C.addDays(p.date, 1)]));
    const devs = new Set(writes.map((p) => p.device));
    const near = db.all('photos').filter((p) => days.has(p.date) && devs.has(p.device) && (photoBucks(p).length || photoTags(p).includes('buck')));
    const carry = planVisitCarry(near, ids);
    if (carry.length) {
      await db.putMany('photos', carry.map((c) => ({ ...withBucks(db.get('photos', c.id), [c.buck]), buckAuto: true, buckVia: 'visit' })));
      out.filed += carry.length;
    }
  }
  out.merged = await mergeTwinBucks();
  await db.saveSettings({ buckSortLast: { ...out, at: new Date().toISOString() } });
  return out;
}

/** Move every photo, suggestion and census check from one buck to another, then delete it. */
export async function mergeBucks(fromId, intoId) {
  const b = db.get('bucks', fromId), into = db.get('bucks', intoId);
  if (!b || !into || b.id === into.id) return;
  await db.putMany('photos', db.all('photos').filter((p) => hasBuck(p, b.id) || p.buckAI?.match === b.id || p.review?.bucks?.includes(b.id) || p.buckSpots?.[b.id]).map((p) => {
    const spots = p.buckSpots ? { ...p.buckSpots } : null;
    if (spots?.[b.id]) { if (!spots[into.id] || (spots[b.id].by === 'you' && spots[into.id].by !== 'you')) spots[into.id] = spots[b.id]; delete spots[b.id]; }
    return {
      ...p,
      ...(hasBuck(p, b.id) ? withBucks(p, photoBucks(p).map((x) => (x === b.id ? into.id : x))) : {}),
      ...(p.buckAI?.match === b.id ? { buckAI: { ...p.buckAI, match: into.id } } : {}),
      ...(p.review?.bucks?.includes(b.id) ? { review: { ...p.review, bucks: [...new Set(p.review.bucks.map((x) => (x === b.id ? into.id : x)))] } } : {}),
      ...(spots ? { buckSpots: spots } : {}),
    };
  }));
  // "Tall 10" merged into "Tall 10 2" keeps the plain name.
  const name = String(into.name).replace(/\s+\d+$/, '') === b.name ? b.name : into.name;
  await db.put('bucks', { ...db.get('bucks', into.id), name, refs: [...new Set([...(into.refs || []), ...(b.refs || [])])].slice(0, 3), notSame: [...new Set([...(into.notSame || []), ...(b.notSame || [])])].filter((x) => x !== into.id && x !== b.id) });
  await db.del('bucks', b.id);
}

/** Merge bucks the AI made twice from the same deer (see planTwinMerges). Returns how many went. */
export async function mergeTwinBucks() {
  const plan = planTwinMerges(db.all('bucks'), db.all('photos'));
  for (const m of plan) await mergeBucks(m.from, m.into);
  return plan.length;
}

/** Fix names the AI gave earlier from the photo's conditions ("Foggy Tall 10" → "Tall 10"). */
export async function cleanAutoBuckNames() {
  const bucks = db.all('bucks');
  const taken = new Set(bucks.map((b) => String(b.name).toLowerCase()));
  const writes = [];
  for (const b of bucks.filter((x) => x.auto)) {
    const clean = cleanBuckName(b.name), marks = cleanRack(b.marks);
    if (clean === b.name && marks === (b.marks || '')) continue;
    taken.delete(String(b.name).toLowerCase());
    // Same name as another buck once the photo words are gone: probably the same deer.
    const twin = bucks.find((x) => x.id !== b.id && String(x.name).toLowerCase() === clean.toLowerCase());
    let name = clean, n = 2;
    while (taken.has(name.toLowerCase())) name = `${clean} ${n++}`;
    taken.add(name.toLowerCase());
    writes.push({ ...b, name, marks, ...(twin ? { dupOf: twin.id } : {}) });
  }
  if (writes.length) await db.putMany('bucks', writes);
  return writes.length;
}

/**
 * Ask the AI whether any of these bucks are really the same buck (e.g. one
 * the auto-sort split into a night and a day version). Saves the answer in
 * settings.buckDupes for the Buck tracker to show.
 */
export async function checkBuckDuplicates(ids) {
  const list = ids.map((id) => db.get('bucks', id)).filter(Boolean).slice(0, 12);
  const bucks = [];
  for (const b of list) {
    const refs = [];
    for (const id of buckRefIds(b).slice(0, 3)) { const u = await photoURL(id); if (u) refs.push(await shrinkImage(u, 640)); }
    if (refs.length) bucks.push({ id: b.id, name: b.name, refs, photos: db.all('photos').filter((p) => hasBuck(p, b.id)).length, confirmed: !b.auto });
  }
  if (bucks.length < 2) throw new Error('Need at least two bucks with photos to compare');
  const r = await call('/buck-dedupe', { method: 'POST', body: { bucks } });
  const result = { at: new Date().toISOString(), checked: bucks.map((b) => b.id), duplicates: r.result.duplicates || [] };
  await db.saveSettings({ buckDupes: result });
  return result;
}

/* ------------------------------- start over -------------------------------- */
/**
 * Clear the AI's buck work (and optionally your confirmed bucks and census
 * checks) so the improved AI can sort everything again. Saves a snapshot of
 * every buck and every photo's buck fields first, for undoBuckReset().
 */
export async function resetBuckAI(opts = {}) {
  const bucks = db.all('bucks'), photos = db.all('photos');
  const plan = planReset(bucks, photos, opts);
  const st = db.settings();
  const pick = (p) => Object.fromEntries(BUCK_FIELDS.filter((k) => k in p).map((k) => [k, p[k]]));
  await db.saveSettings({
    buckResetUndo: {
      at: new Date().toISOString(), opts,
      bucks, photos: photos.filter((p) => BUCK_FIELDS.some((k) => k in p)).map((p) => ({ id: p.id, ...pick(p) })),
      settings: { buckDupes: st.buckDupes || null, buckSortLast: st.buckSortLast || null },
    },
    buckDupes: null, buckSortLast: null,
  });
  if (plan.patches.length) await db.putMany('photos', plan.patches.map(({ id, patch }) => ({ ...db.get('photos', id), ...patch })));
  for (const id of plan.removeBucks) await db.del('bucks', id);
  return { removedBucks: plan.removeBucks.length, keptBucks: plan.keepBucks.length, photos: plan.patches.length };
}
/** Put everything back the way it was before the last reset (bucks the re-sort made are removed). */
export async function undoBuckReset() {
  const snap = db.settings().buckResetUndo;
  if (!snap) return null;
  const had = new Set(snap.bucks.map((b) => b.id));
  for (const b of db.all('bucks')) if (!had.has(b.id)) await db.del('bucks', b.id);
  await db.putMany('bucks', snap.bucks);
  const saved = new Map(snap.photos.map((p) => [p.id, p]));
  const writes = db.all('photos').filter((p) => saved.has(p.id) || BUCK_FIELDS.some((k) => p[k] != null && p[k] !== '' && p[k] !== false)).map((p) => {
    const base = { ...p };
    for (const k of BUCK_FIELDS) delete base[k];
    const { id, ...fields } = saved.get(p.id) || {};
    return { ...base, ...fields };
  });
  if (writes.length) await db.putMany('photos', writes);
  await db.saveSettings({ ...snap.settings, buckResetUndo: null });
  return { bucks: snap.bucks.length, photos: writes.length };
}
/** Have the relay label photos in a date range again with the current AI rules. */
export async function relabelPhotos(since, until) {
  return call('/relabel', { method: 'POST', body: { since, until } });
}

async function matchPendingBucks() {
  if (db.settings().relayInfo?.sources?.buckSort) return sortPendingBucks();
  if (!db.settings().relayInfo?.sources?.buckMatch) return 0;
  const since = C.addDays(C.today(), -30);
  const todo = db.all('photos').filter((p) => !photoBucks(p).length && !p.buckAI && p.date >= since && photoTags(p).includes('buck'))
    .sort((a, b) => (`${a.date} ${a.time || ''}` < `${b.date} ${b.time || ''}` ? 1 : -1)).slice(0, MATCH_PER_SYNC);
  if (!todo.length) return 0;
  const roster = await buckRoster();
  if (!roster.length) return 0;
  let n = 0;
  for (const p of todo) {
    try { await matchBuckPhoto(p.id, roster); n++; } catch (err) { if (err.status === 429) break; throw err; }
  }
  return n;
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
