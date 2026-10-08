/* Buck tracker: named bucks, AI matches to confirm, each buck's pattern
   (when, where, daylight), and the camera census built from them. */
import * as db from '../db.js';
import * as C from '../calc.js';
import * as D from '../deer.js';
import { esc, n0, n1, n2, stat, pill, listPanel, dateLabel, openForm, toast } from '../ui.js';
import { photoURL, photoTags } from '../photos.js';
import { buckRefIds, mergeBucks, sortPendingBucks, unsortedBuckPhotos, checkBuckDuplicates, cleanAutoBuckNames, resetBuckAI, undoBuckReset, relabelPhotos } from '../relay.js';
import { openViewer } from '../viewer.js';
import { ranchPlace } from '../place.js';
import { censusNow, reviewCounts, openCensusReview } from '../censusreview.js';
import { openBuckCompare } from '../buckcompare.js';

const byTime = (a, b) => (`${a.date} ${a.time || ''}` < `${b.date} ${b.time || ''}` ? 1 : -1);
const camName = (id) => db.get('devices', id)?.name || 'Other camera';
const hourLabel = (h) => `${h % 12 || 12} ${h < 12 ? 'am' : 'pm'}`;
const when = (p) => `${dateLabel(p.date)}${p.time ? ` ${p.time}` : ''}`;
const thumb = (id, cls = 'buck-thumb', view = '') => (id ? `<img class="${cls}" data-pid="${esc(id)}" ${view ? `data-view="${esc(view)}"` : ''} alt="">` : `<div class="${cls} empty-thumb">🦌</div>`);

function patternFor(b) {
  const pl = ranchPlace();
  return D.buckPattern(db.all('photos').filter((p) => D.hasBuck(p, b.id)), { lat: pl.lat, lon: pl.lon, today: new Date() });
}

const ui = { filter: 'all', dupesBusy: false };
const photosOf = (id) => db.all('photos').filter((p) => D.hasBuck(p, id));
const isPast = (b) => ['harvested', 'gone'].includes(b.status || 'active');
const plural = (n, w, ws = `${w}s`) => `${n} ${n === 1 ? w : ws}`;
const FILTERS = [
  ['all', 'All', (b) => !isPast(b)],
  ['check', '🤖 To check', (b) => !isPast(b) && (b.auto || photosOf(b.id).some((p) => p.buckAuto))],
  ['confirmed', 'Confirmed', (b) => !isPast(b) && !b.auto],
  ['past', 'Harvested / gone', isPast],
];

/** Remember that two bucks are different, so they aren't suggested as duplicates again. */
async function markNotSame(aId, bId) {
  const a = db.get('bucks', aId), b = db.get('bucks', bId);
  if (!a || !b) return;
  await db.putMany('bucks', [{ ...a, notSame: [...new Set([...(a.notSame || []), b.id])] }, { ...b, notSame: [...new Set([...(b.notSame || []), a.id])] }]);
}

/** Top of the page: what needs doing, as tappable counts and one row of buttons. */
function summaryPanel() {
  const st = db.settings();
  const can = !!st.relayInfo?.sources?.buckSort;
  const unsorted = unsortedBuckPhotos();
  const autoPhotos = db.all('photos').filter((p) => D.photoBucks(p).length && p.buckAuto).sort(byTime);
  const since = C.addDays(C.today(), -60);
  const unidentified = db.all('photos').filter((p) => p.date >= since && !D.photoBucks(p).length && photoTags(p).includes('buck')).sort(byTime);
  const active = db.all('bucks').filter((b) => !isPast(b));
  const last = st.buckSortLast;
  const tile = (n, label, attrs, tone = '') => `<button type="button" class="bt-stat ${tone}" ${attrs} ${n ? '' : 'disabled'}><b>${n}</b><span>${label}</span></button>`;
  return `<section class="panel bt-top">
    <div class="bt-stats">
      ${tile(active.length, plural(active.length, 'buck').replace(/^\d+ /, ''), 'data-jump="bucks"')}
      ${tile(autoPhotos.length, 'to check', `data-view="${esc(autoPhotos.map((p) => p.id).join(','))}"`, autoPhotos.length ? 'warn' : '')}
      ${tile(unidentified.length, 'unidentified', `data-view="${esc(unidentified.map((p) => p.id).join(','))}"`)}
      ${tile(unsorted.length, 'to sort', can ? 'data-sort-now' : '', unsorted.length ? 'warn' : '')}
    </div>
    <div class="bt-actions">
      ${can && unsorted.length ? `<button class="btn primary" data-sort-now>🤖 Sort ${plural(unsorted.length, 'photo')}</button>` : ''}
      ${autoPhotos.length ? `<button class="btn ${can && unsorted.length ? '' : 'primary'}" data-view="${esc(autoPhotos.map((p) => p.id).join(','))}">✓ Check ${autoPhotos.length}</button>` : ''}
      ${unidentified.length ? `<button class="btn" data-view="${esc(unidentified.map((p) => p.id).join(','))}">🔍 Identify ${unidentified.length}</button>` : ''}
      ${can && db.all('photos').some((p) => p.buckSortAt && !D.photoBucks(p).length) ? '<button class="btn" data-sort-again>↻ Retry unsure</button>' : ''}
    </div>
    ${!can ? '<p class="note warn small">Auto-sort needs the relay updated: re-run <b>Deploy relay</b> in GitHub Actions, then sync.</p>' : ''}
    <details class="lines bt-how"><summary class="small">${last ? `Last auto-sort ${esc(new Date(last.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}: ${last.sorted} looked at, ${last.filed} filed, ${plural(last.newBucks, 'new buck')}` : 'How auto-sort works'}</summary>
      <p class="small">When the app syncs, the AI looks at new buck photos together, files the ones it recognizes under your bucks, and starts a new buck (named for his rack) for each one it hasn't seen. Anything it files is marked 🤖 until you check it. Photos it can't place (rack not visible, too close to call) stay under <b>unidentified</b>.</p>
    </details>
  </section>`;
}

/** AI suggestions waiting for a yes/no (from per-photo matching). */
function suggestionsPanel() {
  const bucks = new Map(db.all('bucks').map((b) => [b.id, b]));
  const since = C.addDays(C.today(), -60);
  const sug = db.all('photos').filter((p) => p.date >= since && !D.photoBucks(p).length && bucks.has(p.buckAI?.match)).sort(byTime);
  if (!sug.length) return '';
  return `<section class="panel">
    <div class="panel-head"><h2>Suggested matches</h2>${pill(String(sug.length), 'warn')}</div>
    <ul class="plain buck-review">${sug.slice(0, 12).map((p) => { const b = bucks.get(p.buckAI.match); return `<li>
      ${thumb(p.id, 'buck-thumb', sug.map((x) => x.id).join(','))}
      <div class="grow"><b>${esc(b.name)}?</b> ${pill(p.buckAI.confidence, p.buckAI.confidence === 'high' ? 'good' : p.buckAI.confidence === 'low' ? 'bad' : 'warn')}
        <div class="small muted">${esc(camName(p.device))} · ${when(p)}</div>
        <div class="bt-row"><button class="btn sm primary" data-yes="${esc(p.id)}">✓ ${esc(b.name)}</button><button class="btn sm" data-no="${esc(p.id)}">✕ No</button></div></div></li>`; }).join('')}</ul>
  </section>`;
}

/** Possible duplicates from the last AI check, still standing. */
function dupesHTML() {
  const res = db.settings().buckDupes;
  // Pairs whose names matched once photo words ("Night", "Foggy") were removed, even before an AI check.
  const named = db.all('bucks').filter((b) => b.dupOf && db.get('bucks', b.dupOf)).map((b) => ({ keep: b.dupOf, merge: b.id, confidence: 'medium', reason: `Same name as ${db.get('bucks', b.dupOf).name} once the photo's conditions were taken out of it.` }));
  if (!res && !named.length) return '';
  const counts = (id) => photosOf(id).length;
  const pairs = D.planDedupe([...(res?.duplicates || []), ...named], db.all('bucks'), counts);
  const when = res ? new Date(res.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'by name';
  if (!pairs.length) return `<p class="small muted bt-dupes-none">✓ Duplicate check ${esc(when)}: no bucks look like the same deer.</p>`;
  return `<div class="bt-dupes"><div class="bt-dupes-head"><b>Possible duplicates</b> <small class="muted">checked ${esc(when)}</small></div>
    ${pairs.map((d) => { const k = db.get('bucks', d.keep), m = db.get('bucks', d.merge); const ids = [...photosOf(m.id), ...photosOf(k.id)].sort(byTime).map((p) => p.id); return `<div class="bt-dupe">
      <div class="bt-dupe-pair">
        <figure data-compare="${esc(m.id)}:${esc(k.id)}" data-reason="${esc(d.reason)}" data-conf="${esc(d.confidence)}">${thumb(buckRefIds(m)[0], 'bt-dupe-img')}<figcaption><b>${esc(m.name)}</b><small>${plural(counts(m.id), 'photo')}${m.auto ? ' · 🤖' : ''}</small></figcaption></figure>
        <span class="bt-dupe-arrow">→</span>
        <figure data-compare="${esc(m.id)}:${esc(k.id)}" data-reason="${esc(d.reason)}" data-conf="${esc(d.confidence)}">${thumb(buckRefIds(k)[0], 'bt-dupe-img')}<figcaption><b>${esc(k.name)}</b><small>${plural(counts(k.id), 'photo')}${k.auto ? ' · 🤖' : ''}</small></figcaption></figure>
      </div>
      <div class="small">${pill(d.confidence, d.confidence === 'high' ? 'good' : d.confidence === 'low' ? 'bad' : 'warn')} ${esc(d.reason)}</div>
      <div class="bt-row"><button class="btn sm primary" data-dmerge="${esc(m.id)}:${esc(k.id)}">Merge as one buck</button><button class="btn sm" data-compare="${esc(m.id)}:${esc(k.id)}" data-reason="${esc(d.reason)}" data-conf="${esc(d.confidence)}">Compare</button><button class="btn sm" data-dnot="${esc(m.id)}:${esc(k.id)}">Not the same</button></div>
    </div>`; }).join('')}</div>`;
}

function bucksPanel() {
  const all = db.all('bucks');
  const f = FILTERS.find((x) => x[0] === ui.filter) || FILTERS[0];
  const shown = all.filter(f[2]).sort((a, b) => (photosOf(b.id).length - photosOf(a.id).length) || String(a.name).localeCompare(b.name));
  const canDedupe = !!db.settings().relayInfo?.sources?.buckDedupe;
  const tiles = shown.map((b) => {
    const pt = patternFor(b);
    const toCheck = photosOf(b.id).filter((p) => p.buckAuto).length;
    return `<a class="bt-tile ${b.auto ? 'auto' : ''} ${esc(b.status || 'active')}" href="#/bucks?id=${esc(b.id)}">
      <div class="bt-tile-img">${thumb(buckRefIds(b)[0], 'bt-img')}${b.auto || toCheck ? `<span class="bt-flag">🤖 ${toCheck ? `${toCheck} to check` : 'new'}</span>` : ''}${pt.recentDaylight ? '<span class="bt-sun" title="Seen in daylight this week">☀️</span>' : ''}</div>
      <div class="bt-tile-body"><b class="bt-name">${esc(b.name)}</b>
        <span class="bt-meta">${plural(pt.sightings, 'photo')}${pt.daylight != null ? ` · ☀️ ${Math.round(pt.daylight * 100)}%` : ''}</span>
        <span class="bt-meta">${pt.last ? `last ${esc(dateLabel(pt.last.date).replace(/, \d{4}$/, ''))}` : 'no photos yet'}${isPast(b) ? ` · ${esc(b.status)}` : ''}</span></div>
    </a>`;
  }).join('');
  return `<section class="panel" id="bucks">
    <div class="panel-head"><h2>Your bucks</h2><button class="btn sm" data-add-buck>＋ Add</button></div>
    <div class="chips bt-filters">${FILTERS.map(([k, l, fn]) => { const n = all.filter(fn).length; return `<button class="chip ${k === f[0] ? 'on' : ''}" data-bfilter="${k}" ${n || k === 'all' ? '' : 'disabled'}>${l} · ${n}</button>`; }).join('')}</div>
    ${shown.length >= 2 ? `<div class="bt-dedupe-row">${canDedupe
      ? `<button class="btn" data-dedupe ${ui.dupesBusy ? 'disabled' : ''}>${ui.dupesBusy ? '🤖 Comparing…' : `🤖 Check ${shown.length > 12 ? 'the top 12' : `these ${shown.length}`} for duplicates`}</button>`
      : '<small class="muted">Duplicate checking needs the relay updated (re-run Deploy relay).</small>'}</div>` : ''}
    ${dupesHTML()}
    ${shown.length ? `<div class="bt-grid">${tiles}</div>` : all.length ? '<p class="empty">No bucks in this list.</p>'
      : `<p class="empty">No bucks yet. Auto-sort starts them as buck photos come in, or open a clear buck photo in the <a href="#/photos?tag=buck">Photo log</a> and tap <b>＋ New buck</b>.</p>`}
  </section>`;
}

function buckDetail(b) {
  const pt = patternFor(b);
  const photos = db.all('photos').filter((p) => D.hasBuck(p, b.id)).sort(byTime);
  const refs = buckRefIds(b);
  const max = Math.max(1, ...pt.hours);
  return `<section class="panel bd">
      <a class="bd-back small" href="#/bucks">← All bucks</a>
      <div class="bd-hero">${thumb(refs[0], 'bd-hero-img', photos.map((p) => p.id).join(','))}${photos.length ? `<span class="bd-count">${photos.length} photo${photos.length === 1 ? '' : 's'} ›</span>` : ''}</div>
      <div class="bd-head"><h2>${esc(b.name)}</h2>
        ${b.auto ? pill('🤖 auto', 'warn') : ''}${isPast(b) ? pill(b.status) : ''}
        <button class="btn sm" data-edit-buck="${esc(b.id)}">Edit</button></div>
      ${b.marks ? `<p class="bd-marks">${esc(b.marks)}</p>` : ''}
      ${(() => {
        const autoIds = photos.filter((p) => p.buckAuto).map((p) => p.id);
        if (!b.auto && !autoIds.length) return '';
        const others = db.all('bucks').filter((x) => x.id !== b.id && (x.status || 'active') === 'active').sort((x, y) => String(x.name).localeCompare(y.name));
        return `<div class="auto-banner">
          <div>🤖 ${b.auto ? `The AI grouped these ${photos.length} photo${photos.length === 1 ? '' : 's'} as one new buck and named him for his rack.` : `${autoIds.length} photo${autoIds.length === 1 ? ' was' : 's were'} auto-filed under ${esc(b.name)}.`} Page through them to check it's the same buck.</div>
          <div class="head-actions">
            <button class="btn sm" data-view="${esc((autoIds.length ? autoIds : photos.map((p) => p.id)).join(','))}">Page through</button>
            <button class="btn sm primary" data-keep>✓ Same buck, keep</button>
            ${b.auto ? '<button class="btn sm" data-rename>Rename</button>' : ''}
          </div>
          ${others.length ? `<div class="merge-row"><select data-merge-into><option value="">Merge into…</option>${others.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select><button class="btn sm" data-compare-with>Compare</button><button class="btn sm" data-merge>Merge</button></div>` : ''}
          <button class="btn sm link" data-unsort>${b.auto ? 'Not one buck: undo this group' : 'Undo the auto-filed photos'}</button>
        </div>`;
      })()}
      <div class="bd-stats">
        <div><b>${n0(pt.sightings)}</b><span>photos</span></div>
        <div><b>${pt.days}</b><span>days seen</span></div>
        <div class="${pt.recentDaylight ? 'good' : ''}"><b>${pt.daylight == null ? '—' : `${Math.round(pt.daylight * 100)}%`}</b><span>daylight</span></div>
        <div><b>${pt.peak == null ? '—' : hourLabel(pt.peak)}</b><span>busiest</span></div>
      </div>
      ${pt.last ? `<p class="small bd-last">Last seen <b>${esc(dateLabel(pt.last.date))}</b>${pt.last.time ? ` at ${esc(pt.last.time)}` : ''} · ${esc(camName(pt.last.device))}${pt.recentDaylight ? ` · <span class="good-t">☀️ ${pt.recentDaylight} daylight this week</span>` : ''}</p>` : ''}
      ${pt.sightings ? `<h3>Time of day</h3><div class="hour-chart">${pt.hours.map((n, h) => `<div class="hour-bar" title="${hourLabel(h)}: ${n}"><span style="height:${Math.round((n / max) * 100)}%"></span><small>${h % 6 === 0 ? hourLabel(h) : ''}</small></div>`).join('')}</div>
      <h3>Where</h3><ul class="plain">${pt.cameras.map((c) => `<li>${esc(camName(c.device))}: <b>${c.n}</b> photo${c.n === 1 ? '' : 's'}</li>`).join('')}</ul>` : ''}
      <h3>Reference photos</h3>
      <p class="small muted">The AI compares new photos against these. Pick clear shots from different angles; star them in the viewer.</p>
      <div class="buck-gallery">${refs.map((id) => thumb(id, 'buck-photo', refs.join(','))).join('') || '<p class="empty">None yet.</p>'}</div>
      <h3>All sightings</h3>
      <div class="buck-gallery">${photos.slice(0, 60).map((p) => `<figure class="${p.buckAuto ? 'is-auto' : ''}">${thumb(p.id, 'buck-photo', photos.map((x) => x.id).join(','))}<figcaption class="small">${p.buckAuto ? '🤖 ' : ''}${when(p)}<br>${esc(camName(p.device))}${D.photoBucks(p).length > 1 ? `<br><b>${esc(D.buckWhere(p, b.id) ? `${D.buckWhere(p, b.id)} of ${D.photoBucks(p).length}` : `1 of ${D.photoBucks(p).length} bucks`)}</b>` : ''}</figcaption></figure>`).join('')}</div>
      <div class="head-actions">
        ${(b.status || 'active') === 'active' ? `<button class="btn" data-status="harvested">Mark harvested</button><button class="btn" data-status="gone">Not seen anymore</button>` : '<button class="btn" data-status="active">Back to active</button>'}
      </div>
      <p class="note">Racks shed in late winter and grow back each summer. In the fall, confirm a few new photos of each buck and star them as references so the AI compares against this year's rack.</p>
    </section>`;
}

function censusPanel() {
  const { start, end, gap, days, photos, named, cams, acres, c, visits } = censusNow();
  const rc = reviewCounts(visits);
  const pct = rc.withDeer ? Math.round((rc.checked / rc.withDeer) * 100) : 0;
  const warn = [];
  if (days < 10) warn.push(`Run it at least 10 days (this window is ${days}). 14 is best.`);
  if (acres && cams && acres / cams > 160) warn.push(`${cams} camera${cams === 1 ? '' : 's'} on ${acres} ac: aim for about 1 per 100 acres.`);
  if (rc.unidentified) warn.push(`${rc.unidentified} buck visit${rc.unidentified === 1 ? ' has' : 's have'} no named buck, so the buck count may be low.`);
  if (!c.occ.buck) warn.push('No buck photos in this window.');
  const autoInWindow = photos.filter((p) => p.buckAuto).length;
  if (autoInWindow) warn.push(`${autoInWindow} buck photo${autoInWindow === 1 ? ' was' : 's were'} auto-sorted and not checked yet. The unique-buck count depends on them: tap “to check” at the top.`);
  const res = (k, label, value, sub, filter) => `<button type="button" class="cres" data-review="${filter}" ${rc[filter] ? '' : 'disabled'}>
    <span class="cres-label">${label}</span><span class="cres-value">${value}</span><span class="cres-sub">${sub}</span>${rc[filter] ? '<span class="cres-go">See photos ›</span>' : ''}</button>`;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  return `<section class="panel" id="census">
    <div class="panel-head"><h2>Camera census</h2>${pill('Jacobson method')}</div>

    <div class="csec">
      <div class="csec-title">1 · Survey window</div>
      <div class="census-setup">
        <label class="field">First day<input type="date" data-set="camCensus.start" value="${esc(start)}"></label>
        <label class="field">Last day<input type="date" data-set="camCensus.end" value="${esc(end)}"></label>
        <label class="field">Bursts<select data-set="camCensus.gap">${[[0, 'Count every photo'], [5, 'One visit if within 5 min'], [10, 'One visit if within 10 min'], [30, 'One visit if within 30 min']].map(([v, l]) => `<option value="${v}" ${gap === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>
      <p class="small muted">${days} days · ${plural(photos.length, 'photo')} from ${plural(cams, 'camera')} · ${plural(c.visits, 'visit')}</p>
    </div>

    <div class="csec">
      <div class="csec-title">2 · Check the photos</div>
      <div class="review-card">
        <div class="review-progress"><span style="width:${pct}%"></span></div>
        <div class="review-line"><b>${rc.checked} of ${rc.withDeer}</b> visits with deer checked${rc.withDeer && rc.checked === rc.withDeer ? ' ✓' : ''}</div>
        <button type="button" class="btn primary review-go" data-review="${rc.todo ? 'todo' : 'all'}" ${rc.withDeer ? '' : 'disabled'}>${rc.todo ? `🗂 Check ${plural(rc.todo, 'visit')}` : '🗂 Look through all visits'}</button>
        <p class="small muted">One visit at a time: look at the photos, tap how many bucks, does and fawns, name the buck, then <b>✓ next</b>. It takes a few seconds per visit. The AI's counts are filled in to start.</p>
      </div>
    </div>

    <div class="csec">
      <div class="csec-title">3 · Results</div>
      <div class="cres-grid">
        ${res('buck', 'Unique bucks', n0(named.size), `${plural(c.occ.buck, 'buck')} in ${plural(rc.buck, 'visit')}`, 'buck')}
        ${res('doe', 'Does', c.est ? `~${n0(c.est.does)}` : '—', `${plural(c.occ.doe, 'doe')} in ${plural(rc.doe, 'visit')}`, 'doe')}
        ${res('fawn', 'Fawns', c.est ? `~${n0(c.est.fawns)}` : '—', `${plural(c.occ.fawn, 'fawn')} in ${plural(rc.fawn, 'visit')}`, 'fawn')}
        <div class="cres total"><span class="cres-label">Total deer</span><span class="cres-value">${c.est ? `~${n0(c.est.total)}` : '—'}</span><span class="cres-sub">${c.acresPerDeer ? `${n1(c.acresPerDeer)} acres per deer` : c.est ? 'set ranch acres in Settings for acres per deer' : 'needs an identified buck'}</span></div>
      </div>
      <div class="cres-ratios"><span>Does per buck <b>${c.doesPerBuck == null ? '—' : n1(c.doesPerBuck)}</b></span><span>Fawns per doe <b>${c.fawnsPerDoe == null ? '—' : n2(c.fawnsPerDoe)}</b></span></div>
      ${named.size ? `<div class="chips census-chips">${[...named].map((id) => { const ids = photos.filter((p) => D.hasBuck(p, id) || p.review?.bucks?.includes(id)).map((p) => p.id); return `<button class="chip" data-cview-ids="${esc(ids.join(','))}">🦌 ${esc(db.get('bucks', id)?.name || 'Buck')} · ${ids.length}</button>`; }).join('')}
        ${rc.unidentified ? `<button class="chip warn-chip" data-review="unidentified">❓ Unidentified · ${rc.unidentified}</button>` : ''}</div>`
        : rc.unidentified ? `<div class="chips census-chips"><button class="chip warn-chip" data-review="unidentified">❓ Unidentified bucks · ${rc.unidentified}</button></div>` : ''}
      ${warn.map((w) => `<p class="note warn">${esc(w)}</p>`).join('')}
    </div>

    <div class="csec">
      <div class="head-actions"><button class="btn primary" data-save-census ${c.est ? '' : 'disabled'}>Save this census</button></div>
      <p class="small muted">Saved censuses count as the “census” practice in the <a href="#/valuation">valuation binder</a>.</p>
    </div>
    <details class="lines"><summary>How the camera census works</summary>
      <ul class="plain small" style="margin-top:8px">
        <li>• Run cameras over feeders or bait for 10–14 days, about one per 100 acres, usually late summer or early fall before the season.</li>
        <li>• Every buck gets identified individually. How often your known bucks show up then scales the doe and fawn visits into a herd estimate.</li>
        <li>• A <b>visit</b> is one camera's burst of photos within the burst setting (5 minutes recommended). It counts once, so a doe standing at the feeder through ten photos isn't ten does.</li>
        <li>• Estimates include the ${c.correction}× correction for deer the cameras never caught. Does per buck and fawns per doe come from the raw visit counts.</li>
      </ul>
    </details>
  </section>
  ${listPanel('camsurveys', { title: 'Saved camera censuses' })}`;
}

/** Start over: wipe the AI's buck work (optionally more), then let it sort again. Undoable. */
const reset = { confirmed: false, reviews: false, relabel: false, busy: '', open: false };
function startOverPanel() {
  const st = db.settings();
  const bucks = db.all('bucks'), photos = db.all('photos');
  const plan = D.planReset(bucks, photos, reset);
  const kept = plan.keepBucks.map((id) => db.get('bucks', id)?.name).filter(Boolean);
  const unfiled = plan.patches.filter((x) => 'buck' in x.patch).length;
  const reviewed = photos.filter((p) => p.review).length;
  const { start, end } = censusNow();
  const keepDays = 45;
  const relayFrom = C.addDays(C.today(), -keepDays);
  const relabelFrom = start > relayFrom ? start : relayFrom;
  const relabelN = photos.filter((p) => p.source === 'reveal' && p.date >= relabelFrom && p.date <= end).length;
  const canRelabel = !!st.relayInfo?.sources?.relabel;
  const undo = st.buckResetUndo;
  const box = (k, label, sub, dis = false) => `<label class="so-opt"><input type="checkbox" data-reset-opt="${k}" ${reset[k] ? 'checked' : ''} ${dis ? 'disabled' : ''}><span><b>${label}</b><small>${sub}</small></span></label>`;
  return `<section class="panel">
    <details class="so" ${reset.open || reset.busy ? 'open' : ''}>
      <summary><h2>↺ Start over with the AI</h2></summary>
      <p class="small">Clears what the AI sorted so it can go through your buck photos again with the improved rules. Your own work stays unless you tick it below. A snapshot is saved first, so you can undo it.</p>
      <div class="so-opts">
        <label class="so-opt"><input type="checkbox" checked disabled><span><b>The AI's buck sorting</b><small>Its unconfirmed bucks, the photos it filed, its suggestions, rack notes and places. Then it sorts again.</small></span></label>
        ${box('confirmed', 'Also bucks I confirmed or named', bucks.filter((b) => !b.auto).length ? `${bucks.filter((b) => !b.auto).map((b) => esc(b.name)).join(', ')}: removed, and their photos untagged` : 'none yet', !bucks.some((b) => !b.auto))}
        ${box('reviews', 'Also my census checks', reviewed ? `${plural(reviewed, 'photo')} with counts you checked or fixed` : 'none yet', !reviewed)}
        ${box('relabel', 'Re-label the photos with the AI', canRelabel ? `${relabelN} camera photo${relabelN === 1 ? '' : 's'} from ${esc(dateLabel(relabelFrom))} to ${esc(dateLabel(end))} (the relay keeps ${keepDays} days). Redoes the deer, doe and fawn counts the census uses. One AI request per photo, a few hundred a day.` : 'Needs the relay updated (re-run Deploy relay).', !canRelabel || !relabelN)}
      </div>
      <p class="so-preview"><b>This will:</b> remove ${plural(plan.removeBucks.length, 'buck')}${kept.length ? `, keep ${esc(kept.slice(0, 6).join(', '))}${kept.length > 6 ? ` and ${kept.length - 6} more` : ''}` : ''}, and clear AI work on ${plural(plan.patches.length, 'photo')}${unfiled ? ` (${unfiled} un-filed)` : ''}${reset.relabel ? `, then re-label ${relabelN} photos` : ''}.</p>
      <div class="bt-row">
        <button class="btn danger" data-reset-go ${reset.busy ? 'disabled' : ''}>${reset.busy || '↺ Start over'}</button>
        ${undo ? `<button class="btn" data-reset-undo>Undo the reset from ${esc(new Date(undo.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</button>` : ''}
      </div>
      ${undo ? '<p class="small muted">Undo puts back every buck and photo tag as they were before the reset, and removes bucks the new sort made. Re-labeled photos keep their new labels.</p>' : ''}
    </details>
  </section>`;
}

export function bucks(params) {
  const id = params.get('id');
  const b = id ? db.get('bucks', id) : null;
  if (b) return buckDetail(b);
  return `${summaryPanel()}${suggestionsPanel()}${bucksPanel()}${censusPanel()}${startOverPanel()}`;
}

export function bindBucks(el, rerender, params) {
  el.querySelectorAll('img[data-pid]').forEach(async (img) => { img.src = (await photoURL(img.dataset.pid)) || ''; });
  el.querySelectorAll('[data-view]').forEach((x) => x.addEventListener('click', (e) => {
    e.preventDefault();
    const ids = x.dataset.view.split(',');
    openViewer(ids, Math.max(0, ids.indexOf(x.dataset.pid || '')));
  }));
  el.querySelectorAll('[data-yes]').forEach((x) => x.addEventListener('click', async () => {
    const p = db.get('photos', x.dataset.yes);
    if (p) await db.put('photos', { ...p, buck: p.buckAI.match });
  }));
  el.querySelectorAll('[data-no]').forEach((x) => x.addEventListener('click', async () => {
    const p = db.get('photos', x.dataset.no);
    if (p) await db.put('photos', { ...p, buckAI: { ...p.buckAI, match: 'rejected' } });
  }));
  el.querySelectorAll('[data-sort-now]').forEach((x) => x.addEventListener('click', async (e) => {
    const btn = e.currentTarget; btn.disabled = true; btn.textContent = '🤖 Sorting…';
    try { const r = await sortPendingBucks({ batches: 6 }); toast(r ? `Sorted ${r.sorted}: ${r.filed} filed, ${r.newBucks} new buck${r.newBucks === 1 ? '' : 's'}` : 'Auto-sort isn\'t available yet'); }
    catch (err) { toast(`Couldn't sort: ${err.message}`); btn.disabled = false; }
  }));
  el.querySelector('[data-sort-again]')?.addEventListener('click', async () => {
    const ids = db.all('photos').filter((p) => p.buckSortAt && !D.photoBucks(p).length);
    await db.putMany('photos', ids.map((p) => { const { buckSortAt, ...rest } = p; return rest; }));
    try { const r = await sortPendingBucks({ batches: 6 }); toast(`Sorted ${r?.sorted || 0} again: ${r?.filed || 0} filed`); } catch (err) { toast(`Couldn't sort: ${err.message}`); }
  });
  const curBuck = () => db.get('bucks', params.get('id'));
  el.querySelector('[data-keep]')?.addEventListener('click', async () => {
    const b = curBuck(); if (!b) return;
    await db.putMany('photos', db.all('photos').filter((p) => D.hasBuck(p, b.id) && p.buckAuto).map((p) => ({ ...p, buckAuto: false })));
    await db.put('bucks', { ...b, auto: false });
    toast(`${b.name} confirmed`);
  });
  el.querySelector('[data-rename]')?.addEventListener('click', async () => {
    const b = curBuck(); if (!b) return;
    const name = (prompt('Name for this buck:', b.name) || '').trim();
    if (name) await db.put('bucks', { ...b, name });
  });
  el.querySelector('[data-merge]')?.addEventListener('click', async () => {
    const b = curBuck(); const into = db.get('bucks', el.querySelector('[data-merge-into]')?.value);
    if (!b || !into || !confirm(`Move all of ${b.name}'s photos to ${into.name}?`)) return;
    await mergeBucks(b.id, into.id);
    location.hash = `#/bucks?id=${into.id}`;
    toast(`Merged into ${db.get('bucks', into.id)?.name || into.name}`);
  });
  el.querySelector('[data-unsort]')?.addEventListener('click', async () => {
    const b = curBuck(); if (!b) return;
    if (!confirm(b.auto ? `Undo the ${b.name} group? Its photos go back to "still to identify".` : `Take the auto-filed photos back out of ${b.name}?`)) return;
    await db.putMany('photos', db.all('photos').filter((p) => D.hasBuck(p, b.id) && (p.buckAuto || b.auto)).map((p) => { const left = D.photoBucks(p).filter((x) => x !== b.id); return { ...D.withBucks(p, left), buckAuto: left.length ? p.buckAuto : false }; }));
    if (b.auto && !db.all('photos').some((p) => D.hasBuck(p, b.id))) { await db.del('bucks', b.id); location.hash = '#/bucks'; }
    toast('Undone');
  });
  cleanAutoBuckNames().catch(() => {});
  el.querySelectorAll('[data-bfilter]').forEach((x) => x.addEventListener('click', () => { ui.filter = x.dataset.bfilter; rerender(); }));
  el.querySelector('[data-jump="bucks"]')?.addEventListener('click', () => el.querySelector('#bucks')?.scrollIntoView({ behavior: 'smooth' }));
  el.querySelector('[data-dedupe]')?.addEventListener('click', async () => {
    const f = FILTERS.find((x) => x[0] === ui.filter) || FILTERS[0];
    const ids = db.all('bucks').filter(f[2]).sort((a, b) => photosOf(b.id).length - photosOf(a.id).length).slice(0, 12).map((b) => b.id);
    ui.dupesBusy = true; rerender();
    try {
      const r = await checkBuckDuplicates(ids);
      const n = D.planDedupe(r.duplicates, db.all('bucks'), (id) => photosOf(id).length).length;
      toast(n ? `${plural(n, 'possible duplicate')} found` : 'No duplicates found');
    } catch (err) { toast(`Couldn't check: ${err.message}`); }
    ui.dupesBusy = false; rerender();
  });
  el.querySelectorAll('[data-dmerge]').forEach((x) => x.addEventListener('click', async () => {
    const [from, into] = x.dataset.dmerge.split(':');
    const a = db.get('bucks', from), b = db.get('bucks', into);
    if (!a || !b || !confirm(`Merge ${a.name} into ${b.name}? All of ${a.name}'s photos move to ${b.name}.`)) return;
    await mergeBucks(from, into);
    toast(`Merged into ${db.get('bucks', into)?.name || b.name}`);
  }));
  el.querySelectorAll('[data-dnot]').forEach((x) => x.addEventListener('click', () => markNotSame(...x.dataset.dnot.split(':'))));
  // Side-by-side compare, with merge / not-the-same right there.
  const compare = (a, b, reason = '', confidence = '') => openBuckCompare(a, b, {
    reason, confidence,
    onMerge: async (from, into) => { await mergeBucks(from, into); toast(`Merged into ${db.get('bucks', into)?.name || 'buck'}`); if (params.get('id') === from) location.hash = `#/bucks?id=${into}`; },
    onNotSame: async (x, y) => { await markNotSame(x, y); toast('Marked as different bucks'); },
  });
  el.querySelectorAll('[data-compare]').forEach((x) => x.addEventListener('click', (e) => { e.preventDefault(); const [a, b] = x.dataset.compare.split(':'); compare(a, b, x.dataset.reason, x.dataset.conf); }));
  el.querySelector('[data-compare-with]')?.addEventListener('click', () => {
    const other = el.querySelector('[data-merge-into]')?.value;
    if (!other) return toast('Pick a buck to compare with first');
    compare(params.get('id'), other);
  });
  el.querySelector('details.so')?.addEventListener('toggle', (e) => { reset.open = e.currentTarget.open; });
  el.querySelectorAll('[data-reset-opt]').forEach((x) => x.addEventListener('change', () => { reset[x.dataset.resetOpt] = x.checked; rerender(); }));
  el.querySelector('[data-reset-go]')?.addEventListener('click', async () => {
    const what = ['the AI\'s buck sorting', reset.confirmed && 'your confirmed bucks', reset.reviews && 'your census checks'].filter(Boolean).join(', ');
    if (!confirm(`Start over? This clears ${what}${reset.relabel ? ' and re-labels the photos' : ''}. You can undo it.`)) return;
    try {
      reset.busy = 'Clearing…'; rerender();
      const r = await resetBuckAI({ confirmed: reset.confirmed, reviews: reset.reviews });
      let msg = `Cleared: ${plural(r.removedBucks, 'buck')} removed, ${plural(r.photos, 'photo')} reset.`;
      if (reset.relabel) {
        const { start, end } = censusNow();
        const from = start > C.addDays(C.today(), -45) ? start : C.addDays(C.today(), -45);
        const q = await relabelPhotos(from, end);
        msg += ` ${q.queued} photos queued for new labels (about ${q.days} day${q.days === 1 ? '' : 's'}).`;
      }
      reset.busy = '🤖 Sorting again…'; rerender();
      const sorted = await sortPendingBucks({ batches: 8 }).catch(() => null);
      if (sorted) msg += ` Re-sorted ${sorted.sorted}: ${plural(sorted.newBucks, 'buck')} found.`;
      toast(msg);
    } catch (err) { toast(`Couldn't finish: ${err.message}`); }
    Object.assign(reset, { busy: '', confirmed: false, reviews: false, relabel: false });
    rerender();
  });
  el.querySelector('[data-reset-undo]')?.addEventListener('click', async () => {
    if (!confirm('Undo the reset and put everything back as it was?')) return;
    const r = await undoBuckReset();
    toast(r ? `Restored ${plural(r.bucks, 'buck')}` : 'Nothing to undo');
  });
  el.querySelector('[data-add-buck]')?.addEventListener('click', () => openForm('bucks', null, { status: 'active' }));
  el.querySelector('[data-edit-buck]')?.addEventListener('click', (e) => openForm('bucks', db.get('bucks', e.currentTarget.dataset.editBuck)));
  el.querySelectorAll('[data-status]').forEach((x) => x.addEventListener('click', async () => {
    const b = db.get('bucks', params.get('id'));
    if (b) { await db.put('bucks', { ...b, status: x.dataset.status }); toast(`${b.name}: ${x.dataset.status}`); }
  }));
  el.querySelector('[data-save-census]')?.addEventListener('click', async () => {
    const { start, end, gap, named, photos, c } = censusNow();
    if (!c.est) return;
    await db.put('camsurveys', {
      date: start, end, cameras: new Set(photos.map((p) => p.device).filter(Boolean)).size, uniqueBucks: named.size,
      buckPhotos: c.occ.buck, doePhotos: c.occ.doe, fawnPhotos: c.occ.fawn,
      bucks: Math.round(c.est.bucks * 10) / 10, does: Math.round(c.est.does * 10) / 10, fawns: Math.round(c.est.fawns * 10) / 10, total: Math.round(c.est.total * 10) / 10,
      notes: `Jacobson camera survey, ${c.correction}× correction, ${gap ? `bursts within ${gap} min counted once (${c.visits} visits from ${photos.length} photos)` : 'every photo counted'}.${c.unidentified ? ` ${c.unidentified} buck visits were unidentified.` : ''}`,
    });
    toast('Camera census saved');
  });
  el.querySelectorAll('[data-review]').forEach((x) => x.addEventListener('click', () => openCensusReview({ filter: x.dataset.review })));
  el.querySelectorAll('[data-cview-ids]').forEach((x) => x.addEventListener('click', () => { const ids = x.dataset.cviewIds.split(',').filter(Boolean); if (ids.length) openViewer(ids, 0, { census: { gapMin: censusNow().gap, ids: censusNow().photos.map((p) => p.id) } }); }));
}
