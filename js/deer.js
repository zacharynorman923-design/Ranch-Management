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
    if (p.buck) cur.bucks.add(p.buck);
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
  for (const p of photos) { if (p.buck) set.add(p.buck); for (const b of p.review?.bucks || []) set.add(b); }
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
    // A visit with a buck in it but no photo tied to a named buck.
    if (v.counts.buck && !v.bucks.size) { unidentified++; photosFor.unidentified.push(...v.ids); }
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
  const out = { assign: [], suggest: [], newBucks: [], rack: {} };
  const groups = new Map();
  for (const p of result?.photos || []) {
    const id = photoIds[p.photo - 1];
    if (!id) continue;
    if (p.rack) out.rack[id] = p.rack;
    if (p.group === 'unsure' || p.confidence === 'low' || p.antlers_visible === false) continue;
    if (known.has(p.group)) (p.confidence === 'high' ? out.assign : out.suggest).push({ id, buck: p.group, confidence: p.confidence });
    else if (/^new\d+$/.test(p.group)) groups.set(p.group, [...(groups.get(p.group) || []), id]);
  }
  for (const [group, ids] of groups) {
    const meta = (result.new_bucks || []).find((b) => b.group === group) || {};
    const best = photoIds[(meta.best_photo || 0) - 1];
    out.newBucks.push({ group, name: String(meta.name || '').trim() || `Buck ${out.newBucks.length + 1}`, rack: meta.rack || out.rack[ids[0]] || '', refId: ids.includes(best) ? best : ids[0], photoIds: ids });
  }
  return out;
}
