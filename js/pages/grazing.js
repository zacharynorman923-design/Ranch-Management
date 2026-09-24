/* Grazing & stocking: rain log, carrying capacity, pasture rotation, herd. */
import * as db from '../db.js';
import * as C from '../calc.js';
import { S, stocking } from '../model.js';
import { EVENT_TYPES } from '../schema.js';
import { esc, n1, n2, n0, pct, stat, pill, listPanel, barChart, openForm, toast, dateLabel } from '../ui.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (ym) => MONTHS[Number(ym.slice(5, 7)) - 1];

/* --------------------------------- rain ---------------------------------- */
const MASON_TOWN = { lat: 30.7488, lon: -99.2303 };
/** Where the rain numbers come from, and how much to trust them. */
function rainSourcePanel(s, t) {
  const mix = C.rainSourceMix(db.all('rain'), t);
  const loc = s.relayInfo?.location;
  const isTown = loc && Math.abs(loc.lat - MASON_TOWN.lat) < 0.001 && Math.abs(loc.lon - MASON_TOWN.lon) < 0.001;
  const rows = [
    ['gauge', 'Your rain gauge (automatic)', 'Measured at the gauge. The most accurate source.'],
    ['estimate', 'Weather-model estimate (automatic)', loc ? `Computed for ${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)}${isTown ? ' — <b>Mason town, not your place</b>' : ''}.` : 'Computed by the relay for the ranch coordinates.'],
    ['manual', 'Logged by hand', 'Readings you typed in. These replace the automatic reading for that day.'],
    ['sample', 'Sample ranch data', 'Made-up numbers from “Load sample ranch”.'],
  ].filter(([k]) => mix[k].days > 0);
  const total = Object.values(mix).reduce((a, x) => a + x.inches, 0);
  let verdict;
  if (mix.sample.days) verdict = `<p class="note warn"><b>Sample data is mixed into your rain.</b> It changes every total above. Remove it under <a href="#/settings">Settings → Remove sample data</a>.</p>`;
  else if (mix.gauge.days && !mix.estimate.days) verdict = '<p class="note">All automatic rain comes from your gauge. ✓</p>';
  else if (mix.estimate.days) verdict = `<p class="note">These are <b>estimates, not measurements</b>. They come from a weather model's rainfall for a grid square a few miles across. They're good for 12-month trends like stocking decisions, but a single thunderstorm can be off by half or more because Hill Country storms are patchy. ${isTown ? 'The relay is estimating for Mason town. Set <code>RANCH_LAT</code> / <code>RANCH_LON</code> to your pasture (see relay/README) so it estimates for your place. ' : ''}A gauge on the place replaces these day by day.</p>`;
  else if (!rows.length) verdict = '<p class="note">No rain recorded in the last 12 months.</p>';
  else verdict = '<p class="note">All rain here was logged by hand.</p>';
  return `<section class="panel">
    <div class="panel-head"><h2>Where these numbers come from</h2>${mix.sample.days ? pill('sample data mixed in', 'bad') : mix.estimate.days > mix.gauge.days + mix.manual.days ? pill('mostly estimated', 'warn') : rows.length ? pill('measured', 'good') : ''}</div>
    ${rows.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Source · last 12 months</th><th>Days</th><th>Inches</th><th>Share</th></tr></thead><tbody>
      ${rows.map(([k, label, help]) => `<tr><td><b>${label}</b><br><small class="muted">${help}</small></td><td class="num">${mix[k].days}</td><td class="num">${n2(mix[k].inches)}″</td><td class="num">${total ? pct(mix[k].inches / total) : '—'}</td></tr>`).join('')}
    </tbody></table></div>` : ''}
    ${verdict}
    <details class="lines"><summary>How to check the numbers</summary>
      <ul class="plain small" style="margin-top:8px">
        <li>• Put a plain 4-inch plastic rain gauge (the kind CoCoRaHS volunteers use) by the house, and log it by hand a few times after storms. Compare with the automatic value for the same day.</li>
        <li>• Compare monthly totals with the CoCoRaHS volunteer reports for Mason County at cocorahs.org (Maps → Texas).</li>
        <li>• The long-term <b>normal</b> in the chart comes from Settings → Rain normals. Those are the approximate Mason averages, not your rainfall.</li>
      </ul>
    </details>
  </section>`;
}
export function rain() {
  const s = S();
  const t = C.today();
  const w = C.rainWindow(db.all('rain'), s.normals, t, 12);
  const year = C.yearOf(t);
  const ytd = C.rainWindow(db.all('rain'), s.normals, t, C.monthOf(t));
  const thisMonth = w.rows[w.rows.length - 1];
  return `
    <section class="panel">
      <div class="panel-head"><h2>Rainfall</h2>${pill(`normals: ${n1(s.normals.reduce((a, b) => a + Number(b), 0))} in/yr`)}</div>
      <div class="stats">
        ${stat('This month', thisMonth.actual == null ? '—' : `${n2(thisMonth.actual)}″`, `normal to date ${n2(thisMonth.normal)}″`)}
        ${stat(`${year} to date`, `${n2(ytd.actual)}″`, `${pct(ytd.ratio)} of normal`)}
        ${stat('Trailing 12 months', `${n2(w.actual)}″`, `${pct(w.ratio)} of normal`, w.ratio != null && w.ratio < 0.75 ? 'bad' : '')}
      </div>
      ${barChart(w.rows.map((r) => ({ label: monthName(r.ym), value: r.actual, ref: r.normal, tone: r.actual != null && r.actual < r.normal * 0.6 ? 'low' : '' })), { unit: '″' })}
      <p class="legend"><span class="sw bar"></span> actual <span class="sw ref"></span> normal</p>
      ${w.missing.length ? `<p class="note warn">No readings for ${w.missing.map(monthName).join(', ')}. Those months are left out of the % of normal rather than counted as zero — log <b>0.00</b> if it really didn't rain.</p>` : ''}
      <p class="note">Trailing-12-month rain feeds the <a href="#/stocking">stocking calculator</a>.</p>
    </section>
    ${rainSourcePanel(s, t)}
    ${listPanel('rain', {
      title: 'Gauge readings',
      rows: db.all('rain').filter((r) => !(r.auto && !(Number(r.inches) > 0))),
      note: db.all('rain').some((r) => r.auto)
        ? 'Readings marked <b>(auto)</b> come from the relay. Dry days are counted but hidden here. A reading you log by hand replaces that day’s automatic one.'
        : 'Want this filled in automatically? Set up the relay under <a href="#/settings">Settings</a>.',
    })}`;
}

/* ------------------------------- stocking -------------------------------- */
export function stockingPage() {
  const st = stocking();
  const { s, cap, rain, herd, status, ladder, census } = st;
  const ratio = rain.ratio ?? 1;
  const tone = status.state === 'over' ? 'bad' : status.state === 'full' ? 'warn' : 'good';
  const classRows = Object.entries(herd.byClass).sort((a, b) => b[1] - a[1]);
  return `
    <section class="panel">
      <div class="panel-head"><h2>Carrying capacity</h2>${pill(status.msg, tone)}</div>
      <div class="stats">
        ${stat('Base capacity', `${n1(cap.base)} AU`, `${s.acres} ac ÷ ${s.acresPerAU} ac/AU`)}
        ${stat('Rain, trailing 12 mo', rain.ratio == null ? 'no data' : pct(rain.ratio), rain.ratio == null ? 'assuming normal' : `${n2(rain.actual)}″ of ${n2(rain.normal)}″`)}
        ${stat('Capacity now', `${cap.head} hd`, `${n1(cap.available)} AU${cap.deerAU ? ` after ${n1(cap.deerAU)} AU of deer` : ''}`, tone)}
        ${stat('On the place', `${n1(herd.au)} AU`, `${herd.total} head`)}
      </div>
      <h3>Destock triggers</h3>
      <p class="note">What the place carries at each rain level. When trailing rain falls to a row, that row's head count is the most you should be holding.</p>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Rain vs normal</th><th>AU supported</th><th>Head</th><th>vs. today</th></tr></thead>
        <tbody>${ladder.map((l) => {
          const cur = Math.abs(ratio - l.ratio) < 0.1 || (l.ratio === 1 && ratio >= 1);
          const diff = l.head - herd.au;
          return `<tr class="${cur ? 'hl' : ''}"><td>${pct(l.ratio)}${cur ? ' ← now' : ''}</td><td class="num">${n1(l.available)}</td><td class="num"><b>${l.head}</b></td><td class="${diff < 0 ? 'bad-t' : ''}">${diff < 0 ? `sell ${n1(-diff)} AU` : 'OK'}</td></tr>`;
        }).join('')}</tbody></table></div>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>Assumptions</h2></div>
      <div class="form-grid">
        <label class="field">Acres grazed<input type="number" data-set="acres" value="${s.acres}"></label>
        <label class="field">Acres per AU (normal year)<input type="number" step="0.5" data-set="acresPerAU" value="${s.acresPerAU}"></label>
        <label class="field">Wet-year cap (× base)<input type="number" step="0.05" data-set="maxFactor" value="${s.maxFactor}"><small class="help">1.0 = never stock above base in a wet year.</small></label>
        <label class="field">Deer per AU<input type="number" step="0.5" data-set="deerPerAU" value="${s.deerPerAU}"></label>
        <label class="field wide check"><span><input type="checkbox" data-set="deductDeer" ${s.deductDeer ? 'checked' : ''}> Charge deer against the grass (uses the latest spotlight estimate${census?.population ? `: ~${n0(census.population)} deer` : ', none yet'})</span></label>
      </div>
      <p class="note">Rain normals and AU equivalents are under <a href="#/settings">Settings</a>. Mason County's NRCS office can give you the ecological-site stocking rate for your soils.</p>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>Herd on the place today</h2><a class="btn" href="#/herd">Herd records →</a></div>
      ${classRows.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Class</th><th>Head</th><th>AU each</th><th>AU</th></tr></thead><tbody>
        ${classRows.map(([k, n]) => `<tr><td>${esc(k)}</td><td class="num">${n}</td><td class="num">${k === 'calf' ? '0 nursing · 0.5 weaned' : C.AU_EQUIV[k] ?? 1}</td><td class="num">${n1(herd.auByClass[k])}</td></tr>`).join('')}
        <tr class="total"><td>Total</td><td class="num">${herd.total}</td><td></td><td class="num">${n1(herd.au)}</td></tr></tbody></table></div>`
        : '<p class="empty">No animals yet. Add them under Herd.</p>'}
    </section>`;
}

/* ------------------------------- pastures -------------------------------- */
export function pastures() {
  const t = C.today();
  const rows = C.rotationSummary(db.all('pastures'), db.all('grazings'), t);
  return `
    <section class="panel">
      <div class="panel-head"><h2>Rotation</h2><button class="btn primary" data-move>Move cattle</button></div>
      ${rows.length ? `<div class="table-wrap"><table class="tbl">
        <thead><tr><th>Pasture</th><th>Acres</th><th>Status</th><th>Last graze</th><th>Condition</th><th>AU-days/ac ${C.yearOf(t)}</th></tr></thead>
        <tbody>${rows.map((r) => `<tr data-edit="pastures:${esc(r.pasture.id)}">
          <td><b>${esc(r.pasture.name)}</b></td><td class="num">${esc(r.pasture.acres)}</td>
          <td>${r.grazingNow ? pill(`grazing · day ${r.daysGrazed}`, 'warn') : r.restDays != null ? pill(`rested ${r.restDays} d`, r.restDays >= 60 ? 'good' : '') : pill('never grazed')}</td>
          <td>${r.last ? `${dateLabel(r.last.dateIn)} · ${r.daysGrazed} d` : '—'}</td>
          <td>${r.score != null ? `${r.score}/5` : '—'}</td>
          <td class="num">${r.auDaysPerAcre == null ? '—' : n1(r.auDaysPerAcre)}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="empty">Add your pastures first, then log each move.</p>'}
      <p class="note">Rest days are counted from the last move-out. Hill Country rule of thumb: 60–90+ days rest in the growing season, longer in drought.</p>
    </section>
    ${listPanel('pastures')}
    ${listPanel('grazings', { title: 'Grazing log' })}`;
}
export function bindPastures(el) {
  el.querySelector('[data-move]')?.addEventListener('click', async () => {
    const open = db.all('grazings').filter((g) => !g.dateOut);
    const last = open[0];
    const saved = await openForm('grazings', null, last ? { au: last.au, head: last.head } : {});
    if (!saved) return;
    for (const g of open) {
      if (g.id === saved.id || g.pasture === saved.pasture || g.dateIn > saved.dateIn) continue;
      const name = db.get('pastures', g.pasture)?.name || 'previous pasture';
      if (confirm(`Close out ${name} on ${saved.dateIn}?`)) {
        const score = prompt(`Forage condition left in ${name} (1 poor – 5 excellent)?`, '3');
        await db.put('grazings', { ...g, dateOut: saved.dateIn, score: score && /^[1-5]$/.test(score.trim()) ? score.trim() : g.score });
      }
    }
  });
}

/* --------------------------------- herd ---------------------------------- */
let showAll = false;
let crop = null;
export function herd() {
  const t = C.today();
  const animals = db.all('animals'), events = db.all('events');
  const years = [...new Set(events.filter((e) => e.type === 'expose' && e.crop).map((e) => Number(e.crop)))].sort((a, b) => b - a);
  // Default to the latest crop that has weaning weights; before weaning, this year's KPI is all zeros.
  const weanedCrops = years.filter((y) => C.calfCropKPIs(animals, events, y).weaned > 0);
  crop = crop ?? weanedCrops[0] ?? years.find((y) => y <= C.yearOf(t)) ?? years[0] ?? C.yearOf(t);
  const k = C.calfCropKPIs(animals, events, crop);
  const hc = C.headCount(animals, events, t);
  const onPlace = animals.filter((a) => C.isOnPlace(a, events, t));
  const lastWeight = (id) => events.filter((e) => e.animal === id && Number(e.weight) > 0).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  const status = (a) => {
    const sp = C.animalSpan(a, events);
    return sp.outDate ? `${sp.outType === 'sale' ? 'Sold' : 'Died'} ${sp.outDate}` : 'On place';
  };
  return `
    <section class="panel">
      <div class="panel-head"><h2>Calf crop ${crop}</h2>
        <label class="inline">Crop year <select data-crop>${[...new Set([...years, C.yearOf(t)])].sort((a, b) => b - a).map((y) => `<option ${y === crop ? 'selected' : ''}>${y}</option>`).join('')}</select></label></div>
      <div class="stats">
        ${stat('Lb weaned / exposed cow', k.lbsPerExposed == null ? '—' : n0(k.lbsPerExposed), 'the KPI', 'accent')}
        ${stat('Cows exposed', k.exposed, `${k.pregChecked} preg checked`)}
        ${stat('Pregnancy rate', pct(k.pregRate), `${k.bred} bred`)}
        ${stat('Calving %', pct(k.calvingPct), `${k.born} born`)}
        ${stat('Weaning %', pct(k.weaningPct), `${k.weaned} weaned`)}
        ${stat('Avg weaning wt', k.avgWeanWt == null ? '—' : `${n0(k.avgWeanWt)} lb`, k.avgAdj205 ? `205-day adj ${n0(k.avgAdj205)} lb` : '')}
      </div>
      <p class="note">Exposed cows come from “Exposed to bull” events with this crop year. Calves count when their dam was exposed and they were born in ${crop}. Log each calf as an animal with its dam, then a “Weaned” event with its weight.</p>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>On the place</h2><button class="btn primary" data-work>Work cattle (bulk event)</button></div>
      <div class="stats">${Object.entries(hc.byClass).map(([c, n]) => stat(c, n)).join('')}${stat('Animal units', n1(hc.au))}</div>
    </section>
    ${listPanel('animals', {
      title: showAll ? 'All animals' : 'Animals on the place',
      rows: showAll ? animals : onPlace,
      actions: `<button class="btn" data-showall>${showAll ? 'On place only' : 'Show sold / dead'}</button>`,
      extraCols: [
        { label: 'Status', html: (a) => esc(status(a)) },
        { label: 'Last wt', html: (a) => { const w = lastWeight(a.id); return w ? `<span class="num">${n0(w.weight)}</span>` : ''; } },
      ],
    })}
    ${listPanel('events', { title: 'Herd events', note: 'Breeding, preg checks, weaning weights, vaccinations and sales. Attach the sale-barn receipt photo to each sale — the valuation packet includes it.' })}`;
}
export function bindHerd(el, rerender) {
  el.querySelector('[data-crop]')?.addEventListener('change', (e) => { crop = Number(e.target.value); rerender(); });
  el.querySelector('[data-showall]')?.addEventListener('click', () => { showAll = !showAll; rerender(); });
  el.querySelector('[data-work]')?.addEventListener('click', bulkEvent);
}

/** Apply one event (vaccinate, expose, preg, wean, sell) to many head at once. */
function bulkEvent() {
  const t = C.today();
  const events = db.all('events');
  const animals = db.all('animals').filter((a) => C.isOnPlace(a, events, t))
    .sort((a, b) => String(a.tag).localeCompare(String(b.tag), undefined, { numeric: true }));
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet';
  dlg.innerHTML = `<form method="dialog" class="sheet-form">
    <header class="sheet-head"><h2>Work cattle</h2><button type="button" class="icon-btn" data-x>✕</button></header>
    <div class="sheet-body">
      <div class="field"><label>Date</label><input type="date" name="date" value="${t}"></div>
      <div class="field"><label>Event</label><select name="type">${EVENT_TYPES.filter((x) => !['death'].includes(x.v)).map((x) => `<option value="${x.v}">${esc(x.l)}</option>`).join('')}</select></div>
      <div class="field"><label>Product / buyer / result</label><input name="extra" placeholder="e.g. Vision 7, 2 cc SQ"><small class="help">Product for vaccinations, buyer for sales, “bred” / “open” for preg checks (set per head afterwards if mixed).</small></div>
      <div class="field"><label>Calf crop year</label><input type="number" name="crop" value="${C.yearOf(t) + 1}"><small class="help">For exposure and preg checks.</small></div>
      <div class="field wide"><label>Animals <button type="button" class="btn link" data-all>select all</button></label>
        <div class="checks">${animals.map((a) => `<label><input type="checkbox" name="a" value="${esc(a.id)}"> ${esc(a.tag)} <small>${esc(a.cls)}</small></label>`).join('') || '<p class="empty">No animals on the place.</p>'}</div></div>
    </div>
    <footer class="sheet-foot"><span class="grow"></span><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Save</button></footer></form>`;
  document.body.appendChild(dlg);
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.addEventListener('click', (e) => {
    if (e.target.closest('[data-x]')) close();
    if (e.target.closest('[data-all]')) dlg.querySelectorAll('[name=a]').forEach((c) => { c.checked = true; });
  });
  dlg.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(dlg.querySelector('form'));
    const ids = f.getAll('a');
    if (!ids.length) return toast('Pick at least one animal');
    const type = f.get('type'), extra = String(f.get('extra') || '').trim();
    const recs = ids.map((animal) => ({
      animal, date: f.get('date'), type,
      crop: ['expose', 'preg'].includes(type) ? Number(f.get('crop')) : '',
      product: ['vaccinate', 'treat'].includes(type) ? extra : '',
      buyer: type === 'sale' ? extra : '',
      result: type === 'preg' ? (extra.toLowerCase() === 'open' ? 'open' : 'bred') : '',
    }));
    await db.putMany('events', recs);
    toast(`Logged ${recs.length} events`);
    close();
  });
  dlg.showModal();
}
