/* =========================================================================
   Individual bucks and the camera census. Pure functions (no DOM, no
   storage) so they can be unit-tested.

   Camera census follows the Jacobson et al. (1997) method used by TPWD,
   Mississippi State and others: run cameras over bait/feeders for 10–14
   days, identify each buck individually, then
     factor   = unique bucks ÷ buck photo occurrences
     does     = doe occurrences × factor
     fawns    = fawn occurrences × factor
   and multiply by 1.11 (14 days) or 1.18 (10 days) for deer never
   photographed.
   ========================================================================= */
import { sunTimes } from './calc.js';

/* A photo can show more than one named buck: \`buck\` is the first, \`bucks\` all of them. */
export const photoBucks = (p) => [...new Set([p?.buck, ...(p?.bucks || [])].filter(Boolean))];
export const hasBuck = (p, id) => photoBucks(p).includes(id);
/** The photo with exactly these bucks. */
export const withBucks = (p, ids) => { const u = [...new Set(ids.filter(Boolean))]; return { ...p, buck: u[0] || '', bucks: u }; };

/** Deer in one classifier result: { buck, doe, fawn, deer (sex unknown) }. */
export function deerCounts(labels) {
  const out = { buck: 0, doe: 0, fawn: 0, deer: 0 };
  for (const a of labels?.animals || []) {
    if (a.species !== 'white-tailed deer' || a.id_confidence === 'low') continue;
    const n = Math.max(1, Number(a.count) || 1);
    out[['buck', 'doe', 'fawn'].includes(a.sex) ? a.sex : 'deer'] += n;
  }
  return out;
}

/**
 * Deer occurrences in a photo for the census. Your tags win (one of each
 * tagged kind); otherwise the AI's counts; otherwise one per AI tag.
 */
export function photoDeer(p) {
  const mine = String(p?.tags || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
  const fromTags = (tags) => ({ buck: +tags.includes('buck'), doe: +tags.includes('doe'), fawn: +tags.includes('fawn'), deer: +tags.includes('deer') });
  // Counts you set by hand (in the viewer from the census) beat everything.
  if (p?.counts) return { buck: 0, doe: 0, fawn: 0, deer: 0, ...p.counts };
  if (mine.length) return fromTags(mine);
  if (p?.aiCounts) return { buck: 0, doe: 0, fawn: 0, deer: 0, ...p.aiCounts };
  return fromTags(String(p?.aiTags || '').toLowerCase().split(',').map((x) => x.trim()));
}

/** Local Date for a photo's date + 'HH:MM'. */
export const photoTime = (p) => {
  if (!p?.date) return null;
  const [y, m, d] = p.date.split('-').map(Number);
  const [hh, mm] = String(p.time || '12:00').split(':').map(Number);
  return new Date(y, m - 1, d, hh || 0, mm || 0);
};
/** Was the photo taken between sunrise and sunset? */
export function inDaylight(p, lat, lon) {
  const t = photoTime(p);
  if (!t || !p.time) return null;
  const { rise, set } = sunTimes(lat, lon, t.getTime());
  return rise != null && set != null && t.getTime() >= rise && t.getTime() <= set;
}

/**
 * One buck's pattern from his confirmed photos: sightings, first/last seen,
 * cameras, hour of day, and how often he's out in daylight (overall and in
 * the last 7 days — a jump usually means the rut or a cold front).
 */
export function buckPattern(photos, { lat, lon, today }) {
  const ps = [...photos].filter((p) => p.date).sort((a, b) => (`${a.date} ${a.time || ''}` < `${b.date} ${b.time || ''}` ? -1 : 1));
  const hours = Array(24).fill(0);
  const cams = {};
  let day = 0, timed = 0, recentDay = 0, recent = 0;
  const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 7);
  const wk = `${weekAgo.getFullYear()}-${String(weekAgo.getMonth() + 1).padStart(2, '0')}-${String(weekAgo.getDate()).padStart(2, '0')}`;
  for (const p of ps) {
    cams[p.device || ''] = (cams[p.device || ''] || 0) + 1;
    if (p.time) hours[Number(p.time.slice(0, 2))]++;
    const dl = inDaylight(p, lat, lon);
    if (dl != null) { timed++; if (dl) day++; }
    if (p.date >= wk) { recent++; if (dl) recentDay++; }
  }
  const peak = hours.some(Boolean) ? hours.indexOf(Math.max(...hours)) : null;
  return {
    sightings: ps.length, first: ps[0] || null, last: ps[ps.length - 1] || null,
    days: new Set(ps.map((p) => p.date)).size,
    cameras: Object.entries(cams).sort((a, b) => b[1] - a[1]).map(([device, n]) => ({ device, n })),
    hours, peak, daylight: timed ? day / timed : null, daylightCount: day,
    recent, recentDaylight: recentDay,
  };
}

/** Correction for deer never photographed: 1.18 at 10 days, 1.11 at 14 (interpolated between). */
export function censusCorrection(days) {
  const d = Number(days) || 0;
  if (d >= 14) return 1.11;
  if (d <= 10) return 1.18;
  return Math.round((1.18 - (d - 10) * (0.07 / 4)) * 1000) / 1000;
}

/**
 * Group photos into visits: the same camera, each photo within `gapMin`
 * minutes of the one before. A burst of the same doe standing at the feeder
 * is one visit, counted once at the most of each kind seen in any single
 * photo of the visit. gapMin 0 counts every photo on its own.
 */
export function censusVisits(photos, gapMin = 5) {
  const byId = new Map(photos.map((p) => [p.id, p]));
  const at = (p) => photoTime(p)?.getTime();
  const sorted = [...photos].sort((a, b) => String(a.device || '').localeCompare(String(b.device || '')) || (at(a) ?? 0) - (at(b) ?? 0));
  const visits = [];
  let cur = null;
  for (const p of sorted) {
    const t = p.time ? at(p) : null;
    const join = cur && gapMin > 0 && t != null && cur.last != null && (p.device || '') === cur.device && t - cur.last <= gapMin * 60000;
    if (!join) { cur = { device: p.device || '', ids: [], start: t, last: t, counts: { buck: 0, doe: 0, fawn: 0, deer: 0 }, bucks: new Set() }; visits.push(cur); }
    cur.ids.push(p.id);
    if (t != null) cur.last = t;
    const c = photoDeer(p);
    for (const k of Object.keys(cur.counts)) cur.counts[k] = Math.max(cur.counts[k], c[k] || 0);
    for (const b of photoBucks(p)) cur.bucks.add(b);
  }
  // A visit you checked in census review keeps your counts and bucks, as long
  // as it's still the same set of photos (a different burst gap regroups them).
  for (const v of visits) {
    const recs = v.ids.map((id) => byId.get(id));
    const r = recs[0]?.review;
    if (r && reviewKey(r.ids) === reviewKey(v.ids) && recs.every((p) => p.review && reviewKey(p.review.ids) === reviewKey(v.ids))) {
      v.counts = { buck: 0, doe: 0, fawn: 0, deer: 0, ...r.counts };
      for (const b of r.bucks || []) v.bucks.add(b);
      v.reviewed = true;
    }
    v.key = v.ids[0];
  }
  return visits;
}
const reviewKey = (ids) => [...(ids || [])].sort().join('|');
/** Named bucks seen in a set of photos, from tags on photos and checked visits. */
export function censusBuckIds(photos) {
  const set = new Set();
  for (const p of photos) { for (const b of photoBucks(p)) set.add(b); for (const b of p.review?.bucks || []) set.add(b); }
  return set;
}

/**
 * Camera census from photos in the survey window.
 * photos: records in the window; uniqueBucks: named bucks seen in it.
 * gapMin: photos from one camera closer together than this are one visit.
 * Also returns which photos feed each number, so they can be checked.
 */
export function cameraCensus({ photos, uniqueBucks, days, acres, gapMin = 0 }) {
  const occ = { buck: 0, doe: 0, fawn: 0, deer: 0 };
  const photosFor = { buck: [], doe: [], fawn: [], deer: [], unidentified: [] };
  const visitOf = {};
  let unidentified = 0;
  const visits = censusVisits(photos, gapMin);
  for (const v of visits) {
    for (const k of Object.keys(occ)) { occ[k] += v.counts[k]; if (v.counts[k]) photosFor[k].push(...v.ids); }
    // A visit with more bucks counted than named (none named, or 2 counted and 1 named).
    if (v.counts.buck > v.bucks.size) { unidentified++; photosFor.unidentified.push(...v.ids); }
    for (const id of v.ids) visitOf[id] = v;
  }
  const corr = censusCorrection(days);
  const factor = occ.buck > 0 && uniqueBucks > 0 ? uniqueBucks / occ.buck : null;
  const est = factor ? {
    bucks: uniqueBucks * corr, does: occ.doe * factor * corr, fawns: occ.fawn * factor * corr,
  } : null;
  if (est) est.total = est.bucks + est.does + est.fawns;
  return {
    photos: photos.length, visits: visits.length, occ, uniqueBucks, unidentified, factor, correction: corr, est, photosFor, visitOf,
    doesPerBuck: occ.buck ? occ.doe / occ.buck : null,
    fawnsPerDoe: occ.doe ? occ.fawn / occ.doe : null,
    acresPerDeer: est?.total && acres ? acres / est.total : null,
  };
}

/**
 * Turn an auto-sort result into actions. photoIds[i] is new photo i+1.
 *  - a named buck at high confidence: file it under him (marked auto, for you to confirm)
 *  - a named buck at medium: a suggestion only
 *  - a new group: a provisional buck holding its high/medium photos
 *  - low confidence or "unsure": left alone
 */
export function planBuckSort(result, photoIds, existingIds) {
  const known = new Set(existingIds);
  const out = { assign: [], suggest: [], newBucks: [], rack: {}, spots: {}, tracked: {} };
  const groups = new Map();
  const seen = {}; // photo id → entries already taken, so one deer listed twice counts once
  for (const p of result?.photos || []) {
    const id = photoIds[p.photo - 1];
    if (!id) continue;
    // Each buck in the photo (older replies had one group per photo).
    const entries = sameDeerOnce(Array.isArray(p.bucks) ? p.bucks : [{ group: p.group, rack: p.rack, confidence: p.confidence }], (seen[id] ||= []));
    const racks = entries.map((b) => b.rack).filter(Boolean);
    if (racks.length) out.rack[id] = racks.join(' + ');
    for (const b of entries) {
      // No rack in this shot: only a buck followed from another shot of the visit counts.
      if (p.antlers_visible === false && !b.tracked) continue;
      if (b.tracked) (out.tracked[id] ||= []).push(b.group);
      // Where each buck is in the frame, so a photo with two bucks says which is which.
      if (b.group && b.group !== 'unsure' && (b.where || b.box)) (out.spots[id] ||= {})[b.group] = { where: String(b.where || '').trim(), box: normBox(b.box), ...(b.box_v ? { bv: b.box_v } : {}) };
      if (b.group === 'unsure' || b.confidence === 'low') continue;
      if (known.has(b.group)) (b.confidence === 'high' ? out.assign : out.suggest).push({ id, buck: b.group, confidence: b.confidence });
      else if (/^new\d+$/.test(b.group)) groups.set(b.group, [...new Set([...(groups.get(b.group) || []), id])]);
    }
  }
  for (const [group, ids] of groups) {
    const meta = (result.new_bucks || []).find((b) => b.group === group) || {};
    const best = photoIds[(meta.best_photo || 0) - 1];
    out.newBucks.push({ group, name: String(meta.name || '').trim() || `Buck ${out.newBucks.length + 1}`, rack: meta.rack || out.rack[ids[0]] || '', refId: ids.includes(best) ? best : ids[0], photoIds: ids });
  }
  return out;
}

/** How much two 0–1 [x, y, w, h] boxes overlap (intersection over union). */
export function boxOverlap(a, b) {
  if (!a || !b) return 0;
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const i = w * h;
  return i / (a[2] * a[3] + b[2] * b[3] - i);
}
/**
 * The AI sometimes lists one deer twice in a photo (two groups, same box), or
 * repeats a photo. Keep the first entry for each deer: a repeat of a group, or
 * a box mostly on top of one already taken, is dropped.
 */
function sameDeerOnce(entries, taken) {
  const out = [];
  for (const b of entries) {
    const box = normBox(b.box);
    const dup = b.group !== 'unsure' && taken.some((t) => t.group === b.group || (box && boxOverlap(box, t.box) >= 0.6));
    if (dup) continue;
    taken.push({ group: b.group, box });
    out.push(b);
  }
  return out;
}

/**
 * Bucks the AI made twice from the same deer: two unconfirmed bucks tagged on
 * one photo that shows only one buck, in the same spot (or no spot for one).
 * Returns [{ from, into }] merges; the buck with more photos (then the older)
 * is kept. Pairs you marked "not the same" are left alone.
 */
export function planTwinMerges(bucks, photos) {
  const by = new Map(bucks.map((b) => [b.id, b]));
  const parent = new Map();
  const root = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x; };
  const count = new Map();
  for (const p of photos) for (const id of photoBucks(p)) count.set(id, (count.get(id) || 0) + 1);
  const rank = (b) => [count.get(b.id) || 0, -(Date.parse(b.created) || 0)];
  const better = (a, b) => { const [x, y] = [rank(a), rank(b)]; return x[0] !== y[0] ? x[0] > y[0] : x[1] >= y[1]; };
  for (const p of photos) {
    const ids = photoBucks(p).filter((id) => by.get(id)?.auto);
    if (ids.length < 2 || Math.max(photoDeer(p).buck, p.aiCounts?.buck || 0) > 1) continue;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const [a, b] = [by.get(ids[i]), by.get(ids[j])];
      if ((a.notSame || []).includes(b.id) || (b.notSame || []).includes(a.id)) continue;
      const sa = p.buckSpots?.[a.id], sb = p.buckSpots?.[b.id];
      const apart = sa && sb && ((sa.box && sb.box && boxOverlap(sa.box, sb.box) < 0.3) || (!(sa.box && sb.box) && sa.where && sb.where && sa.where !== sb.where));
      if (apart) continue;
      for (const x of [a.id, b.id]) if (!parent.has(x)) parent.set(x, x);
      const [ra, rb] = [root(a.id), root(b.id)];
      if (ra !== rb) { if (better(by.get(ra), by.get(rb))) parent.set(rb, ra); else parent.set(ra, rb); }
    }
  }
  return [...parent.keys()].filter((x) => root(x) !== x).map((x) => ({ from: x, into: root(x) }));
}

/** Shots this close together on one camera are one visit for auto-sort. */
export const SORT_GAP_MIN = 5;
/**
 * Unsorted buck photos → batches for the AI, a whole visit at a time so it can
 * follow each deer from shot to shot: newest visit first, each visit's shots
 * in the order taken. A batch holds up to `max` photos; a visit bigger than
 * that goes alone, split into pieces of at most `hard`.
 * Returns [{ ids, visits }] with visits[i] the visit number (1-based, per batch) of ids[i].
 */
export function sortBatches(photos, { max = 10, hard = 12, gapMin = SORT_GAP_MIN } = {}) {
  const at = (id, vs) => photoTime(vs.get(id))?.getTime() ?? 0;
  const byId = new Map(photos.map((p) => [p.id, p]));
  const visits = censusVisits(photos, gapMin).map((v) => v.ids)
    .sort((a, b) => at(b[b.length - 1], byId) - at(a[a.length - 1], byId));
  const out = [];
  let cur = null;
  for (const ids of visits) {
    for (let i = 0; i < ids.length; i += hard) {
      const piece = ids.slice(i, i + hard);
      if (!cur || cur.ids.length + piece.length > max) { cur = { ids: [], visits: [], n: 0 }; out.push(cur); }
      cur.n++;
      for (const id of piece) { cur.ids.push(id); cur.visits.push(cur.n); }
    }
  }
  return out.map(({ ids, visits: v }) => ({ ids, visits: v }));
}

/**
 * Carry a buck to the rest of his visit: when every filed shot in a visit is
 * the same one buck and no shot shows more than one, the shots the AI just
 * looked at but couldn't place (head down, turned away) are him too.
 * photos: buck photos around the batch; ids: the ones just sorted.
 * Returns [{ id, buck, shots }] — shots is how many of his shots in the visit back it.
 */
export function planVisitCarry(photos, ids, gapMin = SORT_GAP_MIN) {
  const fresh = new Set(ids);
  const byId = new Map(photos.map((p) => [p.id, p]));
  const out = [];
  for (const v of censusVisits(photos, gapMin)) {
    if (v.ids.length < 2) continue;
    const ps = v.ids.map((id) => byId.get(id));
    const filed = new Set(ps.flatMap((p) => photoBucks(p)));
    if (filed.size !== 1 || ps.some((p) => Math.max(photoDeer(p).buck, p.aiCounts?.buck || 0) > 1 || photoBucks(p).length > 1)) continue;
    const [buck] = filed;
    const shots = ps.filter((p) => hasBuck(p, buck)).length;
    for (const p of ps) {
      if (!fresh.has(p.id) || photoBucks(p).length) continue;
      const m = p.buckAI?.match; // you said no, or the AI thinks it's a different buck: leave it
      if (m && !['unsure', 'error', 'new', buck].includes(m)) continue;
      out.push({ id: p.id, buck, shots });
    }
  }
  return out;
}

/* Lighting, weather and camera words describe the photo, not the deer. */
const CONDITION_WORDS = /\b(night(time)?|nocturnal|ir|infra-?red|b&w|black[- ]and[- ]white|fog(gy)?|mist(y)?|haz(e|y)|rain(y)?|wet|blur(ry|red)?|grainy|day(light|time)?|morning|evening|dusk|dawn|sunrise|sunset|feeder|cam(era)?)\b/gi;
/** "Night Kicker 9" → "Kicker 9". Falls back to "Buck" if nothing's left. */
export function cleanBuckName(name) {
  const out = String(name || '').replace(/\([^)]*\)/g, (m) => (CONDITION_WORDS.test(m) ? '' : m)).replace(CONDITION_WORDS, ' ')
    .replace(/\s*[-–,/]\s*$/g, '').replace(/^\s*[-–,/]\s*/g, '').replace(/\s{2,}/g, ' ').trim();
  CONDITION_WORDS.lastIndex = 0;
  if (/^\d{1,2}$/.test(out)) return `${out} Point`; // "Night 9" → "9 Point", not just "9"
  return out || 'Buck';
}
/** "tall 10, long G2s, foggy morning" → "tall 10, long G2s": drops comma parts that are about the photo. */
export function cleanRack(text) {
  return String(text || '').split(/\s*[,;]\s*/).filter((part) => { const hit = CONDITION_WORDS.test(part); CONDITION_WORDS.lastIndex = 0; return part && !hit; }).join(', ');
}

/**
 * Duplicate pairs from the AI, ready to show: drops pairs you said were
 * different and pairs with a buck that's gone, and keeps the buck you
 * confirmed (or the one with more photos) as the one to merge into.
 */
export function planDedupe(duplicates, bucks, photoCount = () => 0) {
  const by = new Map(bucks.map((b) => [b.id, b]));
  const seen = new Set();
  const out = [];
  for (const d of duplicates || []) {
    let keep = by.get(d.keep), merge = by.get(d.merge);
    if (!keep || !merge || keep.id === merge.id) continue;
    if ((keep.notSame || []).includes(merge.id) || (merge.notSame || []).includes(keep.id)) continue;
    const k = [keep.id, merge.id].sort().join('|');
    if (seen.has(k)) continue;
    seen.add(k);
    const rank = (b) => (b.auto ? 0 : 1000) + photoCount(b.id);
    if (rank(merge) > rank(keep)) [keep, merge] = [merge, keep];
    out.push({ keep: keep.id, merge: merge.id, confidence: d.confidence, reason: d.reason });
  }
  const order = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => order[a.confidence] - order[b.confidence]);
}

/* ------------------------- which buck is where ---------------------------
   p.buckSpots = { [buckId]: { where: 'left', box: [x, y, w, h] (0–1), by: 'ai' | 'you' } } */
/** The AI's [x, y, w, h] in 0–1000 → 0–1, or null if it isn't a usable box. */
export function normBox(box) {
  if (!Array.isArray(box) || box.length !== 4 || !box.every((v) => Number.isFinite(Number(v)))) return null;
  let [x, y, w, h] = box.map(Number);
  const scale = Math.max(x + w, y + h) > 1.5 ? 1000 : 1;
  [x, y, w, h] = [x, y, w, h].map((v) => v / scale);
  x = Math.max(0, Math.min(1, x)); y = Math.max(0, Math.min(1, y));
  w = Math.min(1 - x, w); h = Math.min(1 - y, h);
  return w > 0.02 && h > 0.02 ? [x, y, w, h].map((v) => Math.round(v * 1000) / 1000) : null;
}
/** Short place word for a buck in a photo ("left"), from the saved spot or the box. */
export function buckWhere(p, id) {
  const s = p?.buckSpots?.[id];
  if (s?.where) return s.where;
  if (s?.box) { const cx = s.box[0] + s.box[2] / 2; return cx < 0.38 ? 'left' : cx > 0.62 ? 'right' : 'middle'; }
  return '';
}
/** "Big 8 (left) + Tall 10 (right)" — places only when there's more than one buck. */
export function bucksLabel(p, nameOf) {
  const ids = photoBucks(p);
  return ids.map((id) => { const w = ids.length > 1 ? buckWhere(p, id) : ''; return `${nameOf(id)}${w ? ` (${w})` : ''}`; }).join(' + ');
}

/* ------------------------------- start over -------------------------------- */
/** Photo fields the buck tracker and census write (what a reset clears and an undo restores). */
export const BUCK_FIELDS = ['buck', 'bucks', 'buckAuto', 'buckSortAt', 'buckAI', 'buckRack', 'buckSpots', 'buckVia', 'review', 'counts'];

/**
 * What a "start over" removes.
 *   default:          the AI's work (its unconfirmed bucks, auto-filed photos,
 *                     suggestions, rack notes, places and sort marks)
 *   confirmed: true   also bucks you confirmed or named, and your own tags of them
 *   reviews: true     also your census visit checks and hand counts
 * Returns the buck ids to delete and a patch per photo that changes.
 */
export function planReset(bucks, photos, { confirmed = false, reviews = false } = {}) {
  const removeBucks = bucks.filter((b) => confirmed || b.auto).map((b) => b.id);
  const gone = new Set(removeBucks);
  const patches = [];
  for (const p of photos) {
    const patch = {};
    // AI-filed photos lose all their bucks; your own tags stay unless the buck goes.
    const keep = p.buckAuto ? [] : photoBucks(p).filter((id) => !gone.has(id));
    if (keep.length !== photoBucks(p).length) Object.assign(patch, { buck: keep[0] || '', bucks: keep });
    if (p.buckAuto) patch.buckAuto = false;
    for (const k of ['buckSortAt', 'buckAI', 'buckRack', 'buckVia']) if (p[k] != null && p[k] !== '') patch[k] = null;
    if (p.buckSpots) {
      const spots = Object.fromEntries(Object.entries(p.buckSpots).filter(([id, s]) => s.by === 'you' && keep.includes(id)));
      if (Object.keys(spots).length !== Object.keys(p.buckSpots).length) patch.buckSpots = Object.keys(spots).length ? spots : null;
    }
    if (reviews && p.review) patch.review = null;
    if (reviews && p.counts) patch.counts = null;
    if (Object.keys(patch).length) patches.push({ id: p.id, patch });
  }
  return { removeBucks, keepBucks: bucks.filter((b) => !gone.has(b.id)).map((b) => b.id), patches };
}
