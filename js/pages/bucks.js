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
import { censusNow, reviewCounts, openCensusReview } from '../censusreview.js';

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

function censusPanel() {
  const { start, end, gap, days, photos, named, cams, acres, c, visits } = censusNow();
  const rc = reviewCounts(visits);
  const pct = rc.withDeer ? Math.round((rc.checked / rc.withDeer) * 100) : 0;
  const warn = [];
  if (days < 10) warn.push(`Run it at least 10 days (this window is ${days}). 14 is best.`);
  if (acres && cams && acres / cams > 160) warn.push(`${cams} camera${cams === 1 ? '' : 's'} on ${acres} ac: aim for about 1 per 100 acres.`);
  if (rc.unidentified) warn.push(`${rc.unidentified} buck visit${rc.unidentified === 1 ? ' has' : 's have'} no named buck, so the buck count may be low.`);
  if (!c.occ.buck) warn.push('No buck photos in this window.');
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
        <div class="cres total"><span class="cres-label">Total deer</span><span class="cres-value">${c.est ? `~${n0(c.est.total)}` : '—'}</span><span class="cres-sub">${c.acresPerDeer ? `${n1(c.acresPerDeer)} acres per deer` : 'needs a named buck'}</span></div>
      </div>
      <div class="cres-ratios"><span>Does per buck <b>${c.doesPerBuck == null ? '—' : n1(c.doesPerBuck)}</b></span><span>Fawns per doe <b>${c.fawnsPerDoe == null ? '—' : n2(c.fawnsPerDoe)}</b></span></div>
      ${named.size ? `<div class="chips census-chips">${[...named].map((id) => { const ids = photos.filter((p) => p.buck === id || p.review?.bucks?.includes(id)).map((p) => p.id); return `<button class="chip" data-cview-ids="${esc(ids.join(','))}">🦌 ${esc(db.get('bucks', id)?.name || 'Buck')} · ${ids.length}</button>`; }).join('')}
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
  el.querySelectorAll('[data-review]').forEach((x) => x.addEventListener('click', () => openCensusReview({ filter: x.dataset.review })));
  el.querySelectorAll('[data-cview-ids]').forEach((x) => x.addEventListener('click', () => { const ids = x.dataset.cviewIds.split(',').filter(Boolean); if (ids.length) openViewer(ids, 0, { census: { gapMin: censusNow().gap, ids: censusNow().photos.map((p) => p.id) } }); }));
}
