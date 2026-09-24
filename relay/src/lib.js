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

/* ------------------------------ classifier ------------------------------- */
export const SPECIES = [
  'white-tailed deer', 'axis deer', 'fallow deer', 'other exotic deer', 'feral hog', 'wild turkey',
  'coyote', 'bobcat', 'mountain lion', 'gray fox', 'raccoon', 'skunk', 'armadillo', 'opossum',
  'rabbit', 'dove', 'quail', 'other bird', 'cattle', 'goat', 'sheep', 'horse', 'dog', 'cat',
  'person', 'vehicle', 'other',
];

/** JSON schema the model must answer in (structured outputs). */
export const LABEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['empty', 'animals', 'summary', 'confidence'],
  properties: {
    empty: { type: 'boolean', description: 'True when no animal, person or vehicle is visible (e.g. wind-blown grass).' },
    animals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['species', 'count', 'sex', 'antler_points'],
        properties: {
          species: { type: 'string', enum: SPECIES },
          count: { type: 'integer', description: 'Individuals of this species/sex visible.' },
          sex: { type: 'string', enum: ['buck', 'doe', 'fawn', 'male', 'female', 'young', 'unknown'], description: 'For deer use buck/doe/fawn; otherwise male/female/young/unknown.' },
          antler_points: { type: 'integer', description: 'Best estimate of total antler points for a buck when clearly visible, else 0.' },
        },
      },
    },
    summary: { type: 'string', description: 'One short line a rancher would write in a log, e.g. "2 does and a fawn at the feeder".' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
};

const PREDATORS = new Set(['coyote', 'bobcat', 'mountain lion', 'gray fox']);
const EXOTICS = new Set(['axis deer', 'fallow deer', 'other exotic deer']);
/** Short tags for the app's photo log from a classifier result. */
export function tagsFromLabels(l) {
  if (!l || l.empty || !Array.isArray(l.animals) || !l.animals.length) return ['empty'];
  const t = new Set();
  for (const a of l.animals) {
    const s = a.species;
    if (s === 'white-tailed deer') t.add(['buck', 'doe', 'fawn'].includes(a.sex) ? a.sex : 'deer');
    else if (s === 'feral hog') t.add('hog');
    else if (s === 'wild turkey') t.add('turkey');
    else if (PREDATORS.has(s)) { t.add(s === 'mountain lion' ? 'lion' : s.replace('gray ', '')); t.add('predator'); }
    else if (EXOTICS.has(s)) t.add('exotic');
    else if (s === 'person' || s === 'vehicle') t.add(s);
    else if (['dove', 'quail', 'other bird'].includes(s)) t.add(s === 'other bird' ? 'bird' : s);
    else t.add(s);
  }
  return [...t];
}

/** bytes → base64 without blowing the call stack on large images. */
export function toBase64(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
