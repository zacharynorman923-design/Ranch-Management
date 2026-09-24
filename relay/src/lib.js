/* Pure helpers for the relay — no network, no database — so they can be
   unit-tested in Node (see test/relay.test.js). */

/** 'YYYY-MM-DD' for an instant in a given IANA time zone. */
export function localDate(ms, tz = 'America/Chicago') {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

export const addDaysISO = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 86400000).toISOString().slice(0, 10);
};

/**
 * Ambient Weather's `dailyrainin` is a running total that resets at local
 * midnight, so a day's rain is the largest value seen on that local date.
 * records: [{ dateutc: ms, dailyrainin }]  →  { 'YYYY-MM-DD': inches }
 */
export function ambientDailyTotals(records, tz) {
  const out = {};
  for (const r of records || []) {
    const v = Number(r.dailyrainin);
    if (!Number.isFinite(v) || r.dateutc == null) continue;
    const d = localDate(Number(r.dateutc), tz);
    out[d] = Math.max(out[d] ?? 0, v);
  }
  return out;
}

/** Open-Meteo daily JSON → [{ date, inches }], dropping days it has no value for. */
export function openMeteoDaily(json) {
  const t = json?.daily?.time || [];
  const p = json?.daily?.precipitation_sum || [];
  return t.map((date, i) => ({ date, inches: p[i] })).filter((r) => r.inches != null && Number.isFinite(Number(r.inches)))
    .map((r) => ({ date: r.date, inches: Math.round(Number(r.inches) * 100) / 100 }));
}

/**
 * Normalize one Tactacam Reveal photo record. Field names follow the Reveal
 * web app's API; anything missing comes back null rather than throwing.
 */
export function revealPhotoMeta(p, cameraNames = {}) {
  const id = String(p.photoId ?? p.id ?? p.filename ?? '').trim() || null;
  const cameraId = p.cameraId ?? p.camera?.cameraId ?? null;
  const takenMs = Date.parse(p.photoDateUtc ?? p.photoDate ?? p.createdAt ?? '');
  const w = p.weatherRecord || p.weatherData || {};
  const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    id,
    cameraId,
    camera: cameraNames[cameraId] || p.cameraName || null,
    taken: Number.isFinite(takenMs) ? new Date(takenMs).toISOString() : null,
    url: p.photoUrl || p.hdPhotoUrl || p.url || null,
    lat: num(p.gpsLocation?.lat),
    lon: num(p.gpsLocation?.lon),
    temp: num(w.temperature),
    moon: w.moonPhase ?? null,
    battery: num(p.metadata?.batteryLevel),
    signal: num(p.metadata?.signal),
  };
}

export const cameraName = (c) => c.cameraName || c.cameraLocation || c.name || `Camera ${String(c.cameraId || '').slice(-4)}`;

/** Split bytes into ≤ size pieces (D1 rows top out around 2 MB). */
export function chunk(bytes, size = 900_000) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const out = [];
  for (let i = 0; i < u.length; i += size) out.push(u.subarray(i, i + size));
  return out;
}

/** Constant-time string compare for the bearer token. */
export function safeEqual(a, b) {
  a = String(a ?? ''); b = String(b ?? '');
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0 && a.length > 0;
}
