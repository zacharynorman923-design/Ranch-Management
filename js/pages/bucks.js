/* Buck tracker: named bucks, AI matches to confirm, each buck's pattern
   (when, where, daylight), and the camera census built from them. */
import * as db from '../db.js';
import * as C from '../calc.js';
import * as D from '../deer.js';
import { esc, n0, n1, n2, stat, pill, listPanel, dateLabel, openForm, toast } from '../ui.js';
import { photoURL, photoTags } from '../photos.js';
import { buckRefIds } from '../relay.js';
import { openViewer } from '../viewer.js';
import { ranchPlace } from '../place.js';

const byTime = (a, b) => (`${a.date} ${a.time || ''}` < `${b.date} ${b.time || ''}` ? 1 : -1);
const camName = (id) => db.get('devices', id)?.name || 'Other camera';
const hourLabel = (h) => `${h % 12 || 12} ${h < 12 ? 'am' : 'pm'}`;
const when = (p) => `${dateLabel(p.date)}${p.time ? ` ${p.time}` : ''}`;
const thumb = (id, cls = 'buck-thumb', view = '') => (id ? `<img class="${cls}" data-pid="${esc(id)}" ${view ? `data-view="${esc(view)}"` : ''} alt="">` : `<div class="${cls} empty-thumb">🦌</div>`);

function patternFor(b) {
  const pl = ranchPlace();
  return D.buckPattern(db.all('photos').filter((p) => p.buck === b.id), { lat: pl.lat, lon: pl.lon, today: new Date() });
}

function reviewPanel() {
  const since = C.addDays(C.today(), -60);
  const bucks = new Map(db.all('bucks').map((b) => [b.id, b]));
  const buckPhotos = db.all('photos').filter((p) => p.date >= since && !p.buck && photoTags(p).includes('buck')).sort(byTime);
  const suggested = buckPhotos.filter((p) => bucks.has(p.buckAI?.match));
  const newOnes = buckPhotos.filter((p) => p.buckAI?.match === 'new');
  const rest = buckPhotos.filter((p) => !bucks.has(p.buckAI?.match) && p.buckAI?.match !== 'new');
  if (!buckPhotos.length) return '';
  return `<section class="panel">
    <div class="panel-head"><h2>To identify</h2>${pill(`${buckPhotos.length} buck photo${buckPhotos.length === 1 ? '' : 's'}`, 'warn')}</div>
    ${suggested.length ? `<ul class="plain buck-review">${suggested.slice(0, 20).map((p) => { const b = bucks.get(p.buckAI.match); return `<li>
      ${thumb(p.id, 'buck-thumb', suggested.map((x) => x.id).join(','))}
      <div class="grow"><b>${esc(b.name)}?</b> ${pill(p.buckAI.confidence, p.buckAI.confidence === 'high' ? 'good' : p.buckAI.confidence === 'low' ? 'bad' : 'warn')}
        <div class="small muted">${esc(camName(p.device))} · ${when(p)}</div>${p.buckAI.reason ? `<div class="small">${esc(p.buckAI.reason)}</div>` : ''}
        <div class="head-actions"><button class="btn sm primary" data-yes="${esc(p.id)}">✓ ${esc(b.name)}</button><button class="btn sm" data-no="${esc(p.id)}">✕ Not him</button></div></div></li>`; }).join('')}</ul>` : ''}
    <div class="head-actions">
      ${newOnes.length ? `<button class="btn" data-view="${esc(newOnes.map((p) => p.id).join(','))}">🆕 ${newOnes.length} look like unnamed bucks</button>` : ''}
      ${rest.length ? `<button class="btn" data-view="${esc(rest.map((p) => p.id).join(','))}">🔍 Identify ${rest.length} more</button>` : ''}
    </div>
    <p class="note">Open a photo and tap the buck's name, or <b>＋ New buck</b> to name him. The AI compares new buck photos with each named buck's reference photos when the app syncs. Confirm or reject its guesses here.</p>
  </section>`;
}

function buckList() {
  const bucks = db.all('bucks').sort((a, b) => ((a.status || 'active') === 'active' ? 0 : 1) - ((b.status || 'active') === 'active' ? 0 : 1) || String(a.name).localeCompare(b.name));
  return `<section class="panel">
    <div class="panel-head"><h2>Your bucks</h2><button class="btn primary" data-add-buck>＋ Add</button></div>
    ${bucks.length ? `<div class="cards">${bucks.map((b) => {
      const pt = patternFor(b);
      const ref = buckRefIds(b)[0];
      return `<a class="card buck-card ${esc(b.status || 'active')}" href="#/bucks?id=${esc(b.id)}">
        <div class="buck-card-top">${thumb(ref)}<div class="grow"><b>${esc(b.name)}</b> ${(b.status || 'active') !== 'active' ? pill(b.status) : ''}
          <div class="small muted">${[b.points ? `${b.points} pts` : '', b.age ? `${b.age}+ yrs`.replace('.5+', '½') : '', b.marks].filter(Boolean).map(esc).join(' · ')}</div></div></div>
        <div class="small">${pt.sightings ? `${pt.sightings} sighting${pt.sightings === 1 ? '' : 's'} · last ${when(pt.last)} at ${esc(camName(pt.last.device))}` : 'No confirmed photos yet'}</div>
        ${pt.daylight != null ? `<div class="small">☀️ ${Math.round(pt.daylight * 100)}% in daylight${pt.recentDaylight ? ` · ${pill(`${pt.recentDaylight} daylight this week`, 'good')}` : ''}</div>` : ''}
      </a>`;
    }).join('')}</div>` : `<p class="empty">No named bucks yet.</p>
      <ol class="steps"><li>Open a good, clear buck photo (daylight or broadside is best) in the <a href="#/photos?tag=buck">Photo log</a>.</li>
        <li>Tap <b>＋ New buck</b> and give him a name. That photo becomes his reference.</li>
        <li>Add 1–2 more photos of him from other angles with <b>☆ use as reference</b>.</li>
        <li>From then on, new buck photos are compared with your named bucks automatically.</li></ol>`}
  </section>`;
}

function buckDetail(b) {
  const pt = patternFor(b);
  const photos = db.all('photos').filter((p) => p.buck === b.id).sort(byTime);
  const refs = buckRefIds(b);
  const max = Math.max(1, ...pt.hours);
  return `<section class="panel">
      <div class="panel-head"><h2>🦌 ${esc(b.name)}</h2>${pill(b.status || 'active', (b.status || 'active') === 'active' ? 'good' : '')}
        <button class="btn sm" data-edit-buck="${esc(b.id)}">Edit</button></div>
      <p class="small"><a href="#/bucks">← All bucks</a></p>
      ${b.marks ? `<p>${esc(b.marks)}</p>` : ''}
      <div class="stats">
        ${stat('Sightings', n0(pt.sightings), `${pt.days} different day${pt.days === 1 ? '' : 's'}`)}
        ${stat('Last seen', pt.last ? dateLabel(pt.last.date) : '—', pt.last ? `${pt.last.time || ''} · ${camName(pt.last.device)}` : '')}
        ${stat('In daylight', pt.daylight == null ? '—' : `${Math.round(pt.daylight * 100)}%`, pt.recent ? `${pt.recentDaylight} of ${pt.recent} this week` : '', pt.recentDaylight ? 'good' : '')}
        ${stat('Busiest hour', pt.peak == null ? '—' : hourLabel(pt.peak))}
      </div>
      ${pt.sightings ? `<h3>Time of day</h3><div class="hour-chart">${pt.hours.map((n, h) => `<div class="hour-bar" title="${hourLabel(h)}: ${n}"><span style="height:${Math.round((n / max) * 100)}%"></span><small>${h % 6 === 0 ? hourLabel(h) : ''}</small></div>`).join('')}</div>
      <h3>Where</h3><ul class="plain">${pt.cameras.map((c) => `<li>${esc(camName(c.device))}: <b>${c.n}</b> photo${c.n === 1 ? '' : 's'}</li>`).join('')}</ul>` : ''}
      <h3>Reference photos</h3>
      <p class="small muted">The AI compares new photos against these. Pick clear shots from different angles; star them in the viewer.</p>
      <div class="buck-gallery">${refs.map((id) => thumb(id, 'buck-photo', refs.join(','))).join('') || '<p class="empty">None yet.</p>'}</div>
      <h3>All sightings</h3>
      <div class="buck-gallery">${photos.slice(0, 60).map((p) => `<figure>${thumb(p.id, 'buck-photo', photos.map((x) => x.id).join(','))}<figcaption class="small">${when(p)}<br>${esc(camName(p.device))}</figcaption></figure>`).join('')}</div>
      <div class="head-actions">
        ${(b.status || 'active') === 'active' ? `<button class="btn" data-status="harvested">Mark harvested</button><button class="btn" data-status="gone">Not seen anymore</button>` : '<button class="btn" data-status="active">Back to active</button>'}
      </div>
      <p class="note">Racks shed in late winter and grow back each summer. In the fall, confirm a few new photos of each buck and star them as references so the AI compares against this year's rack.</p>
    </section>`;
}

/** The census as currently set up: window, gap, photos and the numbers. */
function censusNow() {
  const s = db.settings();
  const cfg = s.camCensus || {};
  const end = cfg.end || C.today();
  const start = cfg.start || C.addDays(end, -13);
  const gap = Number(cfg.gap ?? 5);
  const days = C.daysBetween(start, end) + 1;
  const photos = db.all('photos').filter((p) => p.date >= start && p.date <= end && (p.source === 'reveal' || db.get('devices', p.device)?.type === 'camera'));
  const named = new Map();
  for (const p of photos) if (p.buck) named.set(p.buck, [...(named.get(p.buck) || []), p.id]);
  const cams = new Set(photos.map((p) => p.device).filter(Boolean)).size;
  const acres = Number(s.acres) || 0;
  const c = D.cameraCensus({ photos, uniqueBucks: named.size, days, acres, gapMin: gap });
  return { start, end, gap, days, photos, named, cams, acres, c };
}
const sortIds = (ids) => ids.map((id) => db.get('photos', id)).filter(Boolean).sort((a, b) => (`${a.date} ${a.time || ''}` < `${b.date} ${b.time || ''}` ? -1 : 1)).map((p) => p.id);

function censusPanel() {
  const { start, end, gap, days, photos, named, cams, acres, c } = censusNow();
  const warn = [];
  if (days < 10) warn.push(`Run it at least 10 days (this window is ${days}). 14 is best.`);
  if (acres && cams && acres / cams > 160) warn.push(`${cams} camera${cams === 1 ? '' : 's'} on ${acres} ac: aim for about 1 per 100 acres.`);
  if (c.unidentified) warn.push(`${c.unidentified} buck visit${c.unidentified === 1 ? ' has' : 's have'} no named buck yet. Identify them (tap “Unidentified” below), or the buck count is low.`);
  if (!c.occ.buck) warn.push('No buck photos in this window.');
  const visits = (k) => new Set(c.photosFor[k].map((id) => c.visitOf[id])).size;
  const tile = (k, html) => `<button type="button" class="stat-btn" data-cview="${k}" ${c.photosFor[k]?.length ? '' : 'disabled'}>${html}</button>`;
  return `<section class="panel" id="census">
    <div class="panel-head"><h2>Camera census</h2>${pill('Jacobson method')}</div>
    <p class="note">The standard trail-camera deer survey: 10–14 days over feeders or bait, about one camera per 100 acres, usually late summer or early fall before the season. Every buck is identified individually. Their photo rate then scales the doe and fawn photos into a herd estimate.</p>
    <div class="form-grid">
      <label class="field">First day<input type="date" data-set="camCensus.start" value="${esc(start)}"></label>
      <label class="field">Last day<input type="date" data-set="camCensus.end" value="${esc(end)}"></label>
      <label class="field">Count a burst once<select data-set="camCensus.gap">${[[0, 'No: every photo counts'], [5, 'Within 5 minutes (recommended)'], [10, 'Within 10 minutes'], [30, 'Within 30 minutes']].map(([v, l]) => `<option value="${v}" ${gap === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <small class="help">Photos from the same camera this close together are one visit, counted at the most deer seen in any one of its photos. It stops a doe standing at the feeder for a burst of photos from counting 5 times.</small></label>
    </div>
    <div class="stats">
      ${tile('buck', stat('Unique bucks', n0(named.size), `${c.occ.buck} buck occurrence${c.occ.buck === 1 ? '' : 's'} in ${visits('buck')} visit${visits('buck') === 1 ? '' : 's'}`))}
      ${tile('doe', stat('Does', c.est ? `~${n0(c.est.does)}` : '—', `${c.occ.doe} doe occurrence${c.occ.doe === 1 ? '' : 's'} in ${visits('doe')} visit${visits('doe') === 1 ? '' : 's'}`))}
      ${tile('fawn', stat('Fawns', c.est ? `~${n0(c.est.fawns)}` : '—', `${c.occ.fawn} fawn occurrence${c.occ.fawn === 1 ? '' : 's'} in ${visits('fawn')} visit${visits('fawn') === 1 ? '' : 's'}`))}
      ${stat('Total deer', c.est ? `~${n0(c.est.total)}` : '—', c.acresPerDeer ? `${n1(c.acresPerDeer)} ac/deer` : '', 'accent')}
      ${stat('Does per buck', c.doesPerBuck == null ? '—' : n1(c.doesPerBuck))}
      ${stat('Fawns per doe', c.fawnsPerDoe == null ? '—' : n2(c.fawnsPerDoe), 'fawn crop')}
    </div>
    <h3>Check the photos behind the numbers</h3>
    <div class="chips census-chips">
      ${named.size ? [...named.entries()].map(([id, ids]) => `<button class="chip" data-cview-ids="${esc(sortIds(ids).join(','))}">🦌 ${esc(db.get('bucks', id)?.name || 'Buck')} · ${ids.length}</button>`).join('') : ''}
      ${c.photosFor.unidentified.length ? `<button class="chip warn-chip" data-cview="unidentified">❓ Unidentified bucks · ${c.photosFor.unidentified.length}</button>` : ''}
      ${c.photosFor.deer.length ? `<button class="chip" data-cview="deer">Deer, sex unknown · ${c.photosFor.deer.length}</button>` : ''}
      <button class="chip" data-cview-ids="${esc(sortIds(photos.map((p) => p.id)).join(','))}">All ${photos.length} photos</button>
    </div>
    <p class="small muted">Tap a number or a chip to page through the exact photos it counts. Each photo shows how it was counted and which visit it belongs to, and you can fix a count right there.</p>
    ${warn.map((w) => `<p class="note warn">${esc(w)}</p>`).join('')}
    <p class="small muted">${photos.length} camera photos in ${c.visits} visit${c.visits === 1 ? '' : 's'} from ${cams} camera${cams === 1 ? '' : 's'}, ${days} days. Estimates include the ${c.correction}× correction for deer never photographed. Counts come from your own counts or tags first, then the AI labels. Does-per-buck and fawns-per-doe use raw visit counts.</p>
    <div class="head-actions"><button class="btn primary" data-save-census ${c.est ? '' : 'disabled'}>Save this census</button></div>
    <p class="note">Saved camera censuses count as the “census” practice in the <a href="#/valuation">valuation binder</a>, alongside spotlight runs.</p>
  </section>
  ${listPanel('camsurveys', { title: 'Saved camera censuses' })}`;
}

export function bucks(params) {
  const id = params.get('id');
  const b = id ? db.get('bucks', id) : null;
  if (b) return buckDetail(b);
  return `${reviewPanel()}${buckList()}${censusPanel()}`;
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
  // Open the photos behind a census number, with how each one was counted.
  const censusView = (ids) => { if (ids.length) openViewer(ids, 0, { census: { gapMin: censusNow().gap, ids: censusNow().photos.map((p) => p.id) } }); };
  el.querySelectorAll('[data-cview]').forEach((x) => x.addEventListener('click', () => censusView(sortIds(censusNow().c.photosFor[x.dataset.cview] || []))));
  el.querySelectorAll('[data-cview-ids]').forEach((x) => x.addEventListener('click', () => censusView(x.dataset.cviewIds.split(',').filter(Boolean))));
}
