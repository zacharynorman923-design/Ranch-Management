/* Wildlife: deer harvest, spotlight census, cameras & feeders, dove fields. */
import * as db from '../db.js';
import * as C from '../calc.js';
import { S, latestCensus } from '../model.js';
import { esc, n0, n1, n2, stat, pill, listPanel, dateLabel, daysLabel, toast } from '../ui.js';

/* --------------------------------- deer ---------------------------------- */
let season = null;
export function harvest() {
  const all = db.all('harvests');
  const seasons = [...new Set(all.map((h) => C.deerSeason(h.date)))].sort().reverse();
  const cur = C.deerSeason(C.today());
  season = season && seasons.includes(season) ? season : seasons[0] || cur;
  const rows = all.filter((h) => C.deerSeason(h.date) === season);
  const s = C.harvestSummary(rows);
  const census = latestCensus();
  const q = census ? C.harvestQuota({ population: census.population, bucks: census.est?.bucks, does: census.est?.does, acres: S().acres, targetAcresPerDeer: S().targetAcresPerDeer, targetDoesPerBuck: S().targetDoesPerBuck }) : null;
  const leases = db.all('leases').filter((l) => l.season === season);
  return `
    <section class="panel">
      <div class="panel-head"><h2>Deer harvest ${esc(season)}</h2>
        <label class="inline">Season <select data-season>${[...new Set([cur, ...seasons])].map((x) => `<option ${x === season ? 'selected' : ''}>${x}</option>`).join('')}</select></label></div>
      <div class="stats">
        ${stat('Bucks', s.bucks, q ? `quota ${q.bucks}` : '')}
        ${stat('Does', s.does, q ? `quota ${q.does}` : '', q && s.does < q.does ? 'warn' : '')}
        ${stat('Does per buck (harvest)', s.doesPerBuck == null ? '—' : n1(s.doesPerBuck))}
        ${stat('Avg buck age', s.avgBuckAge == null ? '—' : `${n1(s.avgBuckAge)} yr`, `${s.mature} mature (5.5+)`)}
        ${stat('Avg gross score', s.avgScore == null ? '—' : n1(s.avgScore))}
      </div>
      ${s.byAge.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Sex</th><th>Age</th><th>n</th><th>Avg weight</th><th>Avg score</th></tr></thead><tbody>
        ${s.byAge.map((g) => `<tr><td>${g.sex}</td><td class="num">${g.age}</td><td class="num">${g.n}</td><td class="num">${g.avgWeight == null ? '—' : n0(g.avgWeight)}</td><td class="num">${g.avgScore == null ? '—' : n1(g.avgScore)}</td></tr>`).join('')}
      </tbody></table></div><p class="note">Weight by age class is your best read on herd condition — falling weights at the same age mean too many deer for the habitat.</p>` : ''}
      ${leases.length ? `<h3>Lease limits</h3><div class="table-wrap"><table class="tbl"><thead><tr><th>Lessee</th><th>Bucks</th><th>Does</th></tr></thead><tbody>
        ${leases.map((l) => { const mine = rows.filter((h) => h.lease === l.id); const b = mine.filter((h) => h.sex === 'buck').length, d = mine.filter((h) => h.sex === 'doe').length;
          return `<tr><td>${esc(l.lessee)}</td><td class="${l.bucks !== '' && b > Number(l.bucks) ? 'bad-t' : ''}">${b} / ${l.bucks === '' || l.bucks == null ? '—' : l.bucks}</td><td>${d} / ${l.does === '' || l.does == null ? '—' : l.does}</td></tr>`; }).join('')}
      </tbody></table></div>` : ''}
    </section>
    ${listPanel('harvests', { rows, title: `Harvest log ${season}`, empty: 'Nothing logged this season.' })}`;
}
export function bindHarvest(el, rerender) {
  el.querySelector('[data-season]')?.addEventListener('change', (e) => { season = e.target.value; rerender(); });
}

/* -------------------------------- census --------------------------------- */
export function census() {
  const s = S();
  const runs = db.all('surveys');
  const years = [...new Set(runs.map((r) => C.yearOf(r.date)))].sort((a, b) => b - a);
  const hist = years.map((y) => ({ y, ...C.spotlightEstimate(runs.filter((r) => C.yearOf(r.date) === y), s.acres) }));
  const cur = hist[0];
  const q = cur?.est ? C.harvestQuota({ population: cur.population, bucks: cur.est.bucks, does: cur.est.does, acres: s.acres, targetAcresPerDeer: s.targetAcresPerDeer, targetDoesPerBuck: s.targetDoesPerBuck }) : null;
  return `
    <section class="panel">
      <div class="panel-head"><h2>Spotlight census${cur ? ` ${cur.y}` : ''}</h2>${cur ? pill(`${cur.runs} run${cur.runs === 1 ? '' : 's'}`, cur.runs >= 3 ? 'good' : 'warn') : ''}</div>
      ${cur ? `<div class="stats">
        ${stat('Deer per mile', n1(cur.deerPerMile), `${cur.deer} deer / ${n1(cur.miles)} mi`)}
        ${stat('Acres per deer', n1(cur.acresPerDeer), `${n0(cur.acresSeen)} ac observed`, 'accent')}
        ${stat('Estimated herd', `~${n0(cur.population)}`, `on ${s.acres} ac`)}
        ${stat('Does per buck', cur.doesPerBuck == null ? '—' : n1(cur.doesPerBuck))}
        ${stat('Fawns per doe', cur.fawnsPerDoe == null ? '—' : n2(cur.fawnsPerDoe), 'recruitment')}
      </div>
      ${cur.runs < 3 ? '<p class="note warn">TPWD recommends at least 3 nights on the same route — one night swings a lot with weather and moon.</p>' : ''}
      ${q ? `<h3>Suggested harvest</h3>
        <p class="big">${q.excess < 0.5 ? 'At or under target density — hold doe harvest, take only mature bucks.' : `Take about <b>${q.does} does</b> and <b>${q.bucks} bucks</b>`}</p>
        <p class="note">Target ${s.targetAcresPerDeer} ac/deer = ${n0(q.target)} deer on ${s.acres} ac; estimate ${n0(cur.population)}. Does come off first until the ratio reaches ${s.targetDoesPerBuck} does per buck. Bucks should be mature (5.5+) or culls. A starting point to take to your TPWD wildlife biologist, not a permit number.</p>
        <div class="form-grid">
          <label class="field">Target acres per deer<input type="number" step="0.5" data-set="targetAcresPerDeer" value="${s.targetAcresPerDeer}"></label>
          <label class="field">Target does per buck<input type="number" step="0.1" data-set="targetDoesPerBuck" value="${s.targetDoesPerBuck}"></label>
        </div>` : ''}`
        : '<p class="empty">Log spotlight runs to get deer per mile, acres per deer and a harvest quota.</p>'}
      ${hist.length > 1 ? `<h3>Trend</h3><div class="table-wrap"><table class="tbl"><thead><tr><th>Year</th><th>Runs</th><th>Deer/mi</th><th>Ac/deer</th><th>Est. herd</th><th>Does/buck</th><th>Fawns/doe</th></tr></thead><tbody>
        ${hist.map((h) => `<tr><td>${h.y}</td><td class="num">${h.runs}</td><td class="num">${n1(h.deerPerMile)}</td><td class="num">${n1(h.acresPerDeer)}</td><td class="num">${n0(h.population)}</td><td class="num">${h.doesPerBuck == null ? '—' : n1(h.doesPerBuck)}</td><td class="num">${h.fawnsPerDoe == null ? '—' : n2(h.fawnsPerDoe)}</td></tr>`).join('')}
      </tbody></table></div>` : ''}
    </section>
    ${listPanel('surveys', {
      title: 'Spotlight runs',
      extraCols: [
        { label: 'Deer/mi', html: (r) => n1(C.spotlightRun(r).deerPerMile) },
        { label: 'Ac/deer', html: (r) => n1(C.spotlightRun(r).acresPerDeer) },
      ],
      note: 'Acres observed = miles × visible width. Keep the route, speed and time of night the same every run.',
    })}`;
}

/* --------------------------- cameras & feeders --------------------------- */
export function devices() {
  const t = C.today();
  const ds = db.all('devices');
  const photos = db.all('photos');
  const due = (d) => {
    const parts = [];
    if (d.batteryPct !== '' && d.batteryPct != null) parts.push(pill(`🔋 ${Math.round(d.batteryPct)}%`, d.batteryPct < 20 ? 'bad' : d.batteryPct < 40 ? 'warn' : 'good'));
    if (d.signal !== '' && d.signal != null) parts.push(pill(`📶 ${d.signal}`));
    if (d.lastPhoto) {
      const hrs = Math.round((Date.now() - Date.parse(d.lastPhoto)) / 3600e3);
      parts.push(pill(`last photo ${hrs < 48 ? hrs + ' h' : Math.round(hrs / 24) + ' d'} ago`, hrs > 72 ? 'warn' : ''));
    }
    const b = C.dueInfo(d.batteryDate, d.batteryDays, t);
    if (b) parts.push(pill(`batteries ${daysLabel(b.daysLeft)}`, b.state === 'overdue' ? 'bad' : b.state === 'soon' ? 'warn' : ''));
    if (['feeder', 'protein'].includes(d.type)) {
      const f = C.dueInfo(d.refillDate, d.refillDays, t);
      if (f) parts.push(pill(`feed ${daysLabel(f.daysLeft)}`, f.state === 'overdue' ? 'bad' : f.state === 'soon' ? 'warn' : ''));
    }
    return parts.join(' ');
  };
  return `
    <section class="panel">
      <div class="panel-head"><h2>Cameras & feeders</h2></div>
      ${ds.length ? `<div class="cards">${ds.sort((a, b) => a.name.localeCompare(b.name)).map((d) => `
        <div class="card">
          <div class="card-head"><b>${esc(d.name)}</b><small>${esc(d.type)}</small></div>
          <div class="card-body">${due(d) || '<span class="muted">no service dates yet</span>'}
            ${d.type === 'camera' ? `<div class="muted small">${photos.filter((p) => p.device === d.id).length} photos on this phone</div>` : ''}</div>
          <div class="card-foot">
            ${['feeder', 'protein'].includes(d.type) ? `<button class="btn sm" data-svc="${esc(d.id)}:refill">Filled</button>` : ''}
            ${d.type !== 'blind' ? `<button class="btn sm" data-svc="${esc(d.id)}:battery">Batteries</button>` : ''}
            ${d.type === 'camera' ? `<a class="btn sm" href="#/photos?device=${esc(d.id)}">Photos</a>` : ''}
            <button class="btn sm link" data-edit="devices:${esc(d.id)}">Edit</button>
          </div>
        </div>`).join('')}</div>` : '<p class="empty">Add your cameras, feeders and remote sensors.</p>'}
      <p class="note">Tactacam Reveal cameras appear here on their own once the <a href="#/settings">relay</a> is set up. Battery, signal and photos update every 15 minutes.</p>
      <p class="note warn">Feeders are bait for doves. Turn off and clean up around any feeder near a dove field at least 10 days before you hunt it — see the <a href="#/dove">dove planner</a>.</p>
    </section>
    ${listPanel('devices')}
    ${listPanel('devicelog', { title: 'Service log', note: 'Feeder refills here also count as “supplemental food” evidence for the wildlife valuation.' })}`;
}
export function bindDevices(el) {
  el.querySelectorAll('[data-svc]').forEach((b) => b.addEventListener('click', async () => {
    const [id, action] = b.dataset.svc.split(':');
    const d = db.get('devices', id);
    const t = C.today();
    let qty = '';
    if (action === 'refill') qty = prompt(`Pounds of ${d.feed || 'feed'} put in ${d.name}?`, '') ?? '';
    await db.put('devicelog', { device: id, date: t, action, qty: qty === '' ? '' : Number(qty) });
    await db.put('devices', { ...d, [action === 'refill' ? 'refillDate' : 'batteryDate']: t });
    toast(`${d.name}: ${action === 'refill' ? 'filled' : 'batteries changed'}`);
  }));
}

/* --------------------------------- dove ---------------------------------- */
/* Federal rule 50 CFR 20.21(i) + TPWD. Doves (unlike ducks) may be hunted over
   a crop manipulated where it grew — but never over grain that was added. */
export const DOVE_CHECKLIST = [
  ['planted', 'Grain was planted in this field, not hauled in and spread.'],
  ['normal', 'Planting date and seeding rate follow Texas A&M AgriLife Extension recommendations (a “normal agricultural planting”).'],
  ['manip', 'Mowing, shredding, disking or burning was done to the crop where it grew, and no grain was added.'],
  ['notopsow', 'No grain top-sown, re-spread or piled after the crop was manipulated or harvested.'],
  ['feeders', 'Every feeder in range of the field is turned off or removed, and spilled grain is cleaned up. The area stays baited for 10 days after bait is gone.'],
  ['roads', 'No grain, salt or other feed on roads, tanks or fence lines near the field.'],
  ['licenses', 'Every hunter has a Texas hunting license, a migratory game bird endorsement and HIP certification.'],
  ['plugs', 'Shotguns hold no more than 3 shells. Shooting hours run from ½ hour before sunrise to sunset.'],
  ['bag', 'Daily bag and zone dates checked in this year’s TPWD Outdoor Annual.'],
];
export function dove() {
  const s = S();
  const t = C.today();
  const y = C.yearOf(t);
  const opener = `${C.monthOf(t) > Number(s.opener.slice(0, 2)) + 2 ? y + 1 : y}-${s.opener}`;
  const fields = db.all('dovefields').sort((a, b) => (a.plantDate < b.plantDate ? 1 : -1));
  const hunts = db.all('dovehunts');
  const checks = s.doveChecks?.[opener.slice(0, 4)] || {};
  const done = DOVE_CHECKLIST.filter(([k]) => checks[k]).length;
  const byDate = {};
  for (const h of hunts) { (byDate[h.date] ||= { hunters: 0, birds: 0 }); byDate[h.date].hunters += Number(h.hunters) || 0; byDate[h.date].birds += Number(h.birds) || 0; }
  const seasonDates = Object.keys(byDate).filter((d) => C.yearOf(d) === C.yearOf(opener)).sort();
  return `
    <section class="panel">
      <div class="panel-head"><h2>Dove fields for the ${dateLabel(opener)} opener</h2>${pill(`${C.daysBetween(t, opener) >= 0 ? C.daysBetween(t, opener) + ' days out' : 'season open'}`)}</div>
      ${fields.length ? fields.map((f) => {
        const sch = f.plantDate ? C.doveSchedule({ plantDate: f.plantDate, daysToMaturity: f.daysToMaturity, opener: `${C.yearOf(f.plantDate)}-${s.opener}` }) : null;
        return `<div class="dove-field">
          <div class="card-head"><b>${esc(f.name)}</b> <small>${esc(f.crop || '')} · ${esc(f.acres || '?')} ac</small> <button class="btn sm link" data-edit="dovefields:${esc(f.id)}">Edit</button></div>
          ${sch ? `<ul class="timeline">
            <li><span>${dateLabel(f.plantDate)}</span> Planted</li>
            <li><span>${dateLabel(sch.maturity)}</span> Grain mature (${f.daysToMaturity || 100} days)</li>
            ${sch.mows.map((m) => `<li class="${m.date < t ? 'past' : ''}"><span>${dateLabel(m.date)}</span> ${esc(m.label)}</li>`).join('')}
            <li><span>${dateLabel(`${C.yearOf(f.plantDate)}-${s.opener}`)}</span> <b>Opener</b></li>
          </ul>
          <p class="note ${sch.status === 'ok' ? '' : 'warn'}">${esc(sch.msg)} Latest planting date for this hybrid: ${dateLabel(sch.latestPlant)}.</p>`
          : `<p class="note">No planting date yet. For a ${dateLabel(opener)} opener with a 100-day milo, plant by ${dateLabel(C.addDays(opener, -121))}.</p>`}
        </div>`;
      }).join('') : `<p class="empty">Add a dove field. For a ${dateLabel(opener)} opener with a 100-day milo, plant by ${dateLabel(C.addDays(opener, -121))}.</p>`}
    </section>

    <section class="panel">
      <div class="panel-head"><h2>Legal manipulation checklist · ${opener.slice(0, 4)}</h2>${pill(`${done}/${DOVE_CHECKLIST.length}`, done === DOVE_CHECKLIST.length ? 'good' : 'warn')}</div>
      <p class="note">Baiting is strict liability. You can be cited even if you didn't know the grain was there, and the landowner who placed it is liable too. Tick each item before every hunt.</p>
      <ul class="checklist">${DOVE_CHECKLIST.map(([k, txt]) => `<li><label><input type="checkbox" data-dcheck="${k}" data-year="${opener.slice(0, 4)}" ${checks[k] ? 'checked' : ''}> ${esc(txt)}</label></li>`).join('')}</ul>
      <p class="note">Source: 50 CFR 20.21(i) (federal baiting rule) and the TPWD Outdoor Annual. When in doubt, call your game warden <i>before</i> the hunt.</p>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>Harvest by date · ${opener.slice(0, 4)}</h2></div>
      ${seasonDates.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Hunters</th><th>Birds</th><th>Birds / hunter</th></tr></thead><tbody>
        ${seasonDates.map((d) => `<tr><td>${dateLabel(d)}</td><td class="num">${byDate[d].hunters}</td><td class="num">${byDate[d].birds}</td><td class="num">${byDate[d].hunters ? n1(byDate[d].birds / byDate[d].hunters) : '—'}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="empty">No hunts logged this season.</p>'}
    </section>
    ${listPanel('dovefields')}
    ${listPanel('dovehunts', { title: 'Dove hunts' })}`;
}
export function bindDove(el) {
  el.querySelectorAll('[data-dcheck]').forEach((c) => c.addEventListener('change', async () => {
    const s = db.settings();
    const all = { ...(s.doveChecks || {}) };
    all[c.dataset.year] = { ...(all[c.dataset.year] || {}), [c.dataset.dcheck]: c.checked };
    await db.saveSettings({ doveChecks: all });
  }));
}
