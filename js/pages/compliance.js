/* Compliance: ag / wildlife valuation binder + year-end packet, hunting
   leases, NRCS / EQIP contract milestones. */
import * as db from '../db.js';
import * as C from '../calc.js';
import { S, practiceCoverage, sales } from '../model.js';
import { titleOf } from '../schema.js';
import { photoURL } from '../photos.js';
import { esc, n0, n1, n2, usd, pct, stat, pill, listPanel, dateLabel, daysLabel } from '../ui.js';

let year = null;
const yearSelect = () => {
  const y0 = C.yearOf(C.today());
  year = year ?? (C.monthOf(C.today()) <= 4 ? y0 - 1 : y0);
  return `<label class="inline">Year <select data-vyear>${[y0, y0 - 1, y0 - 2, y0 - 3].map((y) => `<option ${y === year ? 'selected' : ''}>${y}</option>`).join('')}</select></label>`;
};

/* ------------------------------- valuation ------------------------------- */
export function valuation() {
  const s = S();
  yearSelect();
  const cov = practiceCoverage(year);
  const avg = C.yearAverageCount(db.all('animals'), db.all('events'), year);
  const jan1 = C.headCount(db.all('animals'), db.all('events'), `${year}-01-01`);
  const realized = avg.avgAU > 0 ? s.acres / avg.avgAU : null;
  const intensity = Number(s.cadIntensity) || null;
  const ySales = sales().filter((e) => C.yearOf(e.date) === year);
  const missingReceipts = ySales.filter((e) => !(e.photos || []).length).length;
  return `
    <section class="panel">
      <div class="panel-head"><h2>Valuation binder</h2><div class="head-actions">${yearSelect()}<a class="btn primary" href="#/packet?year=${year}">Year-end packet →</a></div></div>
      <div class="seg" role="radiogroup">
        <button class="${s.valuation === 'ag' ? 'on' : ''}" data-setv="ag">1-d-1 Agricultural (grazing)</button>
        <button class="${s.valuation === 'wildlife' ? 'on' : ''}" data-setv="wildlife">1-d-1 Wildlife management</button>
      </div>
      <p class="note">The CAD can ask for proof of use at any time. Keep every year's packet. ${s.valuation === 'wildlife' ? 'Wildlife valuation requires a written plan and at least 3 of the 7 practices each year.' : 'Agricultural valuation requires use to the degree of intensity typical for the county.'}</p>
      <div class="form-grid">
        <label class="field">Owner name<input data-set="owner" value="${esc(s.owner)}"></label>
        <label class="field">Place name<input data-set="ranchName" value="${esc(s.ranchName)}"></label>
        <label class="field">CAD account / property ID<input data-set="cadAccount" value="${esc(s.cadAccount)}"></label>
        <label class="field">CAD minimum intensity (ac per AU)<input type="number" data-set="cadIntensity" value="${esc(s.cadIntensity)}"><small class="help">Ask Mason CAD for its degree-of-intensity standard.</small></label>
      </div>
    </section>

    ${s.valuation === 'wildlife' ? '' : `
    <section class="panel">
      <div class="panel-head"><h2>Grazing use ${year}</h2>${realized && intensity ? pill(realized <= intensity ? 'meets intensity' : 'below intensity', realized <= intensity ? 'good' : 'bad') : ''}</div>
      <div class="stats">
        ${stat('Head Jan 1', jan1.total, `${n1(jan1.au)} AU`)}
        ${stat('Average AU', n1(avg.avgAU), 'across 12 month-ends')}
        ${stat('Realized stocking', realized ? `${n1(realized)} ac/AU` : '—', intensity ? `CAD standard ${intensity} ac/AU` : '')}
        ${stat('Sales logged', ySales.length, !ySales.length ? 'none this year' : missingReceipts ? `${missingReceipts} missing a receipt photo` : 'all have receipts', missingReceipts ? 'warn' : '')}
      </div>
    </section>`}

    <section class="panel">
      <div class="panel-head"><h2>Wildlife practices ${year}</h2>${pill(`${cov.met} of 7 · need 3`, cov.ok ? 'good' : 'bad')}</div>
      <div class="practices">${cov.practices.map((p) => `
        <div class="practice ${p.met ? 'met' : ''}">
          <div class="practice-head"><span class="tick">${p.met ? '✓' : '○'}</span><b>${esc(p.label)}</b>
            <button class="btn sm link" data-add="practices" data-preset='${esc(JSON.stringify({ practice: p.key, date: `${year}-${C.today().slice(5)}` }))}'>＋ log</button></div>
          ${p.evidence.length ? `<ul>${p.evidence.slice(0, 6).map((e) => `<li><span class="muted">${e.date}</span> ${esc(e.text)} <small class="muted">· ${esc(e.source)}</small></li>`).join('')}${p.evidence.length > 6 ? `<li class="muted">+${p.evidence.length - 6} more</li>` : ''}</ul>` : ''}
        </div>`).join('')}</div>
      <p class="note">Evidence is pulled automatically from brush work (habitat control), spotlight runs (census), wildlife water work (supplemental water), feeder refills and food plots (supplemental food). Log anything else, like hog trapping, erosion work or brush piles, as a practice entry.</p>
    </section>
    ${listPanel('practices', { rows: db.all('practices').filter((p) => C.yearOf(p.date) === year), title: `Practice log ${year}` })}`;
}
export function bindValuation(el, rerender) {
  el.querySelector('[data-vyear]')?.addEventListener('change', (e) => { year = Number(e.target.value); rerender(); });
  el.querySelectorAll('[data-setv]').forEach((b) => b.addEventListener('click', () => db.saveSettings({ valuation: b.dataset.setv })));
}

/* ------------------------------ the packet ------------------------------- */
export function packet(params) {
  const s = S();
  const Y = Number(params.get('year')) || year || C.yearOf(C.today()) - 1;
  const animals = db.all('animals'), events = db.all('events');
  const inY = (d) => d && C.yearOf(d) === Y;
  const avg = C.yearAverageCount(animals, events, Y);
  const jan1 = C.headCount(animals, events, `${Y}-01-01`);
  const dec31 = C.headCount(animals, events, `${Y}-12-31`);
  const classes = [...new Set([...Object.keys(jan1.byClass), ...Object.keys(dec31.byClass)])];
  const ySales = sales().filter((e) => inY(e.date)).sort((a, b) => (a.date < b.date ? -1 : 1));
  const buys = animals.filter((a) => inY(a.purchaseDate));
  const vacc = events.filter((e) => inY(e.date) && ['vaccinate', 'treat'].includes(e.type));
  const vaccDays = {};
  for (const v of vacc) { const k = `${v.date}|${v.product || v.type}`; vaccDays[k] = (vaccDays[k] || 0) + 1; }
  const graz = db.all('grazings').filter((g) => inY(g.dateIn) || inY(g.dateOut)).sort((a, b) => (a.dateIn < b.dateIn ? -1 : 1));
  const cov = practiceCoverage(Y);
  const rain = C.rainByMonth(db.all('rain'), s.normals, Y);
  const rainTot = rain.reduce((t, r) => t + (r.actual || 0), 0);
  const runs = db.all('surveys').filter((r) => inY(r.date));
  const est = runs.length ? C.spotlightEstimate(runs, s.acres) : null;
  const hv = db.all('harvests').filter((h) => C.deerSeason(h.date) === `${Y}-${String((Y + 1) % 100).padStart(2, '0')}`);
  const hs = C.harvestSummary(hv);
  const brush = db.all('brush').filter((b) => inY(b.date));
  const ww = db.all('waterwork').filter((w) => inY(w.date));
  const fl = db.all('fencelog').filter((f) => inY(f.date) && (f.work || f.cost));
  const nrcs = db.all('nrcs').filter((m) => inY(m.done) || inY(m.paidDate));
  const pl = C.enterprisePL(Y, { ledger: db.all('ledger'), sales: sales(), animals, leases: db.all('leases') });
  const pics = db.all('photos').filter((p) => p.packet && inY(p.date));
  const receiptIds = ySales.flatMap((e) => e.photos || []);
  const ha = (s.valuation === 'wildlife');
  let sec = 0;
  const H = (t) => `<h2>${++sec}. ${esc(t)}</h2>`;

  return `
  <div class="packet-bar noprint"><a class="btn" href="#/valuation">← Back</a><span class="grow"></span><button class="btn primary" onclick="window.print()">Print / save PDF</button></div>
  <article class="packet">
    <header class="packet-cover">
      <div class="packet-kicker">${ha ? 'Wildlife management use: annual report & proof of use' : 'Agricultural use: proof of use'}</div>
      <h1>${esc(s.ranchName)}</h1>
      <table class="kv">
        <tr><th>Owner</th><td>${esc(s.owner || '—')}</td></tr>
        <tr><th>County / appraisal district</th><td>${esc(s.county)} County Appraisal District</td></tr>
        <tr><th>Account / property ID</th><td>${esc(s.cadAccount || '—')}</td></tr>
        <tr><th>Acres</th><td>${s.acres}</td></tr>
        <tr><th>Valuation</th><td>${ha ? 'Open-space (1-d-1), wildlife management use (Tax Code §23.51(7))' : 'Open-space (1-d-1), agricultural use: livestock grazing'}</td></tr>
        <tr><th>Reporting year</th><td>January 1 – December 31, ${Y}</td></tr>
        <tr><th>Prepared</th><td>${dateLabel(C.today())}</td></tr>
      </table>
    </header>

    ${H('Livestock inventory')}
    <table class="tbl"><thead><tr><th>Class</th><th>Jan 1</th><th>Dec 31</th></tr></thead><tbody>
      ${classes.map((c) => `<tr><td>${esc(c)}</td><td>${jan1.byClass[c] || 0}</td><td>${dec31.byClass[c] || 0}</td></tr>`).join('') || '<tr><td colspan="3">No livestock recorded.</td></tr>'}
      <tr class="total"><td>Total head</td><td>${jan1.total}</td><td>${dec31.total}</td></tr>
      <tr><td>Animal units</td><td>${n1(jan1.au)}</td><td>${n1(dec31.au)}</td></tr></tbody></table>
    <p>Average of 12 month-end counts: <b>${n1(avg.avgHead)} head / ${n1(avg.avgAU)} AU</b>. Realized stocking rate: <b>${avg.avgAU ? n1(s.acres / avg.avgAU) : '—'} acres per AU</b>${s.cadIntensity ? ` (district standard: ${esc(s.cadIntensity)} ac/AU)` : ''}.</p>
    <table class="tbl compact"><thead><tr>${['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'].map((m) => `<th>${m}</th>`).join('')}</tr></thead>
      <tbody><tr>${avg.monthly.map((m) => `<td>${m.total}</td>`).join('')}</tr></tbody></table>

    ${H('Livestock sales and purchases')}
    ${ySales.length ? `<table class="tbl"><thead><tr><th>Date</th><th>Animal</th><th>Weight</th><th>$/cwt</th><th>Proceeds</th><th>Buyer</th><th>Receipt</th></tr></thead><tbody>
      ${ySales.map((e) => { const a = db.get('animals', e.animal); return `<tr><td>${e.date}</td><td>${esc(a ? titleOf('animals', a) : '?')}</td><td>${e.weight ? n0(e.weight) + ' lb' : ''}</td><td>${e.price ? n2(e.price) : ''}</td><td>${usd(C.saleAmount(e))}</td><td>${esc(e.buyer || '')}</td><td>${(e.photos || []).length ? 'attached' : '<b>missing</b>'}</td></tr>`; }).join('')}
      <tr class="total"><td colspan="4">Total</td><td>${usd(ySales.reduce((t, e) => t + C.saleAmount(e), 0))}</td><td colspan="2"></td></tr></tbody></table>` : '<p>No livestock sold this year.</p>'}
    ${buys.length ? `<p>Purchased: ${buys.map((a) => `${esc(a.tag)} (${esc(a.cls)}, ${a.purchaseDate}${a.purchasePrice ? ', ' + usd(a.purchasePrice) : ''}${a.seller ? ', from ' + esc(a.seller) : ''})`).join('; ')}.</p>` : ''}

    ${H('Herd health and management')}
    ${Object.keys(vaccDays).length ? `<ul>${Object.entries(vaccDays).sort().map(([k, n]) => { const [d, p] = k.split('|'); return `<li>${d}: ${esc(p)}, ${n} head</li>`; }).join('')}</ul>` : '<p>No vaccinations or treatments logged.</p>'}
    ${graz.length ? `<h3>Pasture rotation</h3><table class="tbl"><thead><tr><th>Pasture</th><th>In</th><th>Out</th><th>AU</th><th>Condition at exit</th></tr></thead><tbody>
      ${graz.map((g) => `<tr><td>${esc(db.get('pastures', g.pasture)?.name || '?')}</td><td>${g.dateIn}</td><td>${g.dateOut || 'current'}</td><td>${esc(g.au)}</td><td>${g.score ? g.score + '/5' : ''}</td></tr>`).join('')}</tbody></table>` : ''}

    ${H('Land and water improvements')}
    ${brush.length || ww.length || fl.length || nrcs.length ? `<table class="tbl"><thead><tr><th>Date</th><th>Work</th><th>Extent</th><th>Cost</th></tr></thead><tbody>
      ${brush.map((b) => `<tr><td>${b.date}</td><td>Brush management: ${esc(b.species)}, ${esc(b.method || '')}${b.area ? ' — ' + esc(b.area) : ''}</td><td>${n1(b.acres)} ac</td><td>${b.cost ? usd(b.cost) : ''}</td></tr>`).join('')}
      ${ww.map((w) => `<tr><td>${w.date}</td><td>Water: ${esc(w.work)} — ${esc(db.get('waterpoints', w.point)?.name || '')}</td><td></td><td>${w.cost ? usd(w.cost) : ''}</td></tr>`).join('')}
      ${fl.map((f) => `<tr><td>${f.date}</td><td>Fence: ${esc(f.work || 'repair')} — ${esc(db.get('fences', f.fence)?.name || '')}</td><td></td><td>${f.cost ? usd(f.cost) : ''}</td></tr>`).join('')}
      ${nrcs.map((m) => `<tr><td>${m.done || m.paidDate}</td><td>NRCS ${esc(m.program)} ${esc(m.contract)}: ${esc(m.code || '')} ${esc(m.description)}</td><td>${esc(m.units || '')}</td><td>${m.payment ? usd(m.payment) + ' cost-share' : ''}</td></tr>`).join('')}
    </tbody></table>` : '<p>No improvements logged.</p>'}

    ${H(ha ? 'Wildlife management practices (3 of 7 required)' : 'Wildlife management practices')}
    <p><b>${cov.met} of 7</b> practices documented in ${Y}${ha ? (cov.ok ? ', which meets the three-practice minimum.' : '. <b>This is below the three-practice minimum.</b>') : '.'}</p>
    <table class="tbl"><thead><tr><th>Practice</th><th>Activities</th></tr></thead><tbody>
      ${cov.practices.map((p) => `<tr><td>${p.met ? '☑' : '☐'} ${esc(p.label)}</td><td>${p.evidence.map((e) => `${e.date}: ${esc(e.text)}`).join('<br>') || '—'}</td></tr>`).join('')}</tbody></table>
    ${est ? `<h3>Census</h3><p>${est.runs} spotlight run(s), ${n1(est.miles)} miles, ${est.deer} deer observed over ${n0(est.acresSeen)} acres: <b>${n1(est.acresPerDeer)} acres per deer</b>, estimated ${n0(est.population)} deer on the property. Does per buck ${est.doesPerBuck == null ? '—' : n1(est.doesPerBuck)}; fawns per doe ${est.fawnsPerDoe == null ? '—' : n2(est.fawnsPerDoe)}.</p>` : ''}
    ${hv.length ? `<h3>Harvest, ${Y}–${String((Y + 1) % 100).padStart(2, '0')} season</h3><p>${hs.bucks} bucks (average age ${hs.avgBuckAge == null ? '—' : n1(hs.avgBuckAge)}), ${hs.does} does.</p>` : ''}

    ${H('Rainfall')}
    <table class="tbl compact"><thead><tr>${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Total'].map((m) => `<th>${m}</th>`).join('')}</tr></thead>
      <tbody><tr>${rain.map((r) => `<td>${r.actual == null ? '—' : n2(r.actual)}</td>`).join('')}<td><b>${n2(rainTot)}</b></td></tr>
      <tr class="muted">${rain.map((r) => `<td>${n2(r.normal)}</td>`).join('')}<td>${n2(rain.reduce((t, r) => t + r.normal, 0))}</td></tr></tbody></table>
    <p class="small">Top row: on-site gauge (inches). Bottom row: long-term normal.</p>

    ${H('Operating income and expenses')}
    <table class="tbl"><thead><tr><th>Enterprise</th><th>Income</th><th>Expenses</th><th>Net</th></tr></thead><tbody>
      ${C.ENTERPRISES.map((k) => `<tr><td>${k}</td><td>${usd(pl.enterprises[k].income)}</td><td>${usd(pl.enterprises[k].expense)}</td><td>${usd(pl.enterprises[k].net)}</td></tr>`).join('')}
      <tr class="total"><td>Total</td><td>${usd(pl.income)}</td><td>${usd(pl.expense)}</td><td>${usd(pl.net)}</td></tr></tbody></table>

    ${receiptIds.length || pics.length ? `${H('Receipts and photographs')}
      <div class="packet-photos">${[...receiptIds.map((id) => ({ id, cap: 'Sale receipt' })), ...pics.map((p) => ({ id: p.id, cap: `${p.caption || ''}` }))].map(({ id, cap }) => {
        const p = db.get('photos', id);
        return `<figure><img data-pid="${esc(id)}" alt=""><figcaption>${esc(cap)} · ${p?.date || ''}${p?.loc?.lat ? ` · ${p.loc.lat.toFixed(5)}, ${p.loc.lon.toFixed(5)}` : ''}</figcaption></figure>`;
      }).join('')}</div>` : ''}

    <footer class="attest">
      <p>I certify that the information above is true and correct to the best of my knowledge and reflects the use of the property during ${Y}.</p>
      <div class="sig"><span>Signature</span><span>Date</span></div>
    </footer>
  </article>`;
}
export function bindPacket(el) {
  el.querySelectorAll('img[data-pid]').forEach(async (img) => { img.src = (await photoURL(img.dataset.pid)) || ''; });
}

/* -------------------------------- leases --------------------------------- */
export function leases() {
  const t = C.today();
  const ls = db.all('leases');
  const cur = C.deerSeason(t);
  const now = ls.filter((l) => l.season === cur);
  const fee = now.reduce((s, l) => s + (Number(l.fee) || 0), 0);
  const ins = (l) => {
    if (!l.insExpires) return pill('no insurance on file', 'bad');
    const d = C.daysBetween(t, l.insExpires);
    return pill(d < 0 ? 'insurance expired' : `insured · ${daysLabel(d)}`, d < 0 ? 'bad' : d <= 30 ? 'warn' : 'good');
  };
  return `
    <section class="panel">
      <div class="panel-head"><h2>Hunting leases ${cur}</h2></div>
      <div class="stats">
        ${stat('Lessees', now.length)}
        ${stat('Lease income', usd(fee), `${usd(fee / (S().acres || 1))}/ac`)}
        ${stat('Unpaid', now.filter((l) => l.fee && !l.paidDate).length)}
        ${stat('Insurance problems', now.filter((l) => !l.insExpires || l.insExpires < t).length, '', now.some((l) => !l.insExpires || l.insExpires < t) ? 'bad' : '')}
      </div>
      <p class="note">Keep a signed lease, a release/waiver and a certificate of insurance naming you as additional insured for every lessee. Attach photos of each to the lease record. Texas's recreational use statute (Civ. Prac. & Rem. Code ch. 75) limits landowner liability, but it depends on the fee and the paperwork, so check with your attorney.</p>
    </section>
    ${listPanel('leases', { extraCols: [{ label: 'Insurance', html: ins }, { label: 'Paperwork', html: (l) => (l.signed ? '✓ signed' : '<span class="bad-t">unsigned</span>') }] })}`;
}

/* --------------------------------- NRCS ---------------------------------- */
export function nrcs() {
  const t = C.today();
  const ms = db.all('nrcs');
  const byC = {};
  for (const m of ms) (byC[m.contract] ||= []).push(m);
  return `
    <section class="panel">
      <div class="panel-head"><h2>EQIP / NRCS contracts</h2></div>
      ${Object.keys(byC).length ? Object.entries(byC).map(([c, list]) => {
        const done = list.filter((m) => m.done).length;
        const pay = list.reduce((s, m) => s + (Number(m.payment) || 0), 0);
        const paid = list.filter((m) => m.paidDate).reduce((s, m) => s + (Number(m.payment) || 0), 0);
        return `<div class="contract"><div class="card-head"><b>${esc(list[0].program || '')} ${esc(c)}</b><small>${done}/${list.length} milestones · ${usd(paid)} of ${usd(pay)} paid</small></div>
          <div class="progress"><span style="width:${pct(done / list.length)}"></span></div>
          <ul class="plain">${list.sort((a, b) => (a.due < b.due ? -1 : 1)).map((m) => {
            const d = C.daysBetween(t, m.due);
            return `<li data-edit="nrcs:${esc(m.id)}">${m.done ? pill('done', 'good') : pill(daysLabel(d), d < 0 ? 'bad' : d <= 60 ? 'warn' : '')} <b>${esc(m.code || '')}</b> ${esc(m.description)} <span class="muted">due ${dateLabel(m.due)}${m.payment ? ` · ${usd(m.payment)}` : ''}</span></li>`;
          }).join('')}</ul></div>`;
      }).join('') : '<p class="empty">Enter each practice from your EQIP contract’s schedule of operations as a milestone.</p>'}
      <p class="note">Practices usually have to be certified by the NRCS office before payment. Keep receipts and before/after photos on each milestone. Missing a scheduled year can mean a contract modification or cancellation, so ask NRCS early for an extension.</p>
    </section>
    ${listPanel('nrcs', { title: 'Milestones' })}`;
}
