/* Financials: enterprise P&L, unit costs, and the land-use scenario toggle. */
import * as db from '../db.js';
import * as C from '../calc.js';
import { S, sales, stocking } from '../model.js';
import { esc, usd, n0, n1, n2, stat, pill, listPanel } from '../ui.js';

let year = null;
export function pnl() {
  const s = S();
  year = year ?? C.yearOf(C.today());
  const animals = db.all('animals'), events = db.all('events');
  const pl = C.enterprisePL(year, { ledger: db.all('ledger'), sales: sales(), animals, leases: db.all('leases') });
  const avg = C.yearAverageCount(animals, events, year);
  const lbsWeaned = events.filter((e) => e.type === 'wean' && C.yearOf(e.date) === year).reduce((t, e) => t + (Number(e.weight) || 0), 0);
  const u = C.cattleUnitCosts({ cattleExpense: pl.enterprises.cattle.expense, overhead: pl.enterprises.overhead.expense, overheadShare: s.overheadShare, avgCows: avg.avgCows, lbsWeaned });
  const years = [...new Set([C.yearOf(C.today()), ...db.all('ledger').map((t) => C.yearOf(t.date))])].sort((a, b) => b - a);
  return `
    <section class="panel">
      <div class="panel-head"><h2>Enterprise P&L ${year}</h2>
        <label class="inline">Year <select data-pyear>${years.map((y) => `<option ${y === year ? 'selected' : ''}>${y}</option>`).join('')}</select></label></div>
      <div class="stats">
        ${stat('Income', usd(pl.income))}
        ${stat('Expenses', usd(pl.expense))}
        ${stat('Net before land', usd(pl.net), '', pl.net < 0 ? 'bad' : 'good')}
      </div>
      <div class="table-wrap"><table class="tbl pl">
        <thead><tr><th></th>${C.ENTERPRISES.map((k) => `<th>${k}</th>`).join('')}<th>Total</th></tr></thead>
        <tbody>
          <tr><td>Income</td>${C.ENTERPRISES.map((k) => `<td class="num">${usd(pl.enterprises[k].income)}</td>`).join('')}<td class="num">${usd(pl.income)}</td></tr>
          <tr><td>Expenses</td>${C.ENTERPRISES.map((k) => `<td class="num">${usd(pl.enterprises[k].expense)}</td>`).join('')}<td class="num">${usd(pl.expense)}</td></tr>
          <tr class="total"><td>Net</td>${C.ENTERPRISES.map((k) => `<td class="num ${pl.enterprises[k].net < 0 ? 'bad-t' : ''}">${usd(pl.enterprises[k].net)}</td>`).join('')}<td class="num">${usd(pl.net)}</td></tr>
        </tbody></table></div>
      <details class="lines"><summary>Line items</summary>
        ${C.ENTERPRISES.map((k) => { const L = Object.entries(pl.enterprises[k].lines); return L.length ? `<h3>${k}</h3><table class="tbl compact">${L.sort((a, b) => a[1] - b[1]).map(([c, v]) => `<tr><td>${esc(c)}</td><td class="num ${v < 0 ? 'bad-t' : ''}">${usd(v)}</td></tr>`).join('')}</table>` : ''; }).join('')}
      </details>
      <p class="note">Cattle sales come from herd sale events, cattle purchases from each animal's purchase price, and hunting income from lease fees marked paid. Don't enter those in the ledger too.</p>
    </section>

    <section class="panel">
      <div class="panel-head"><h2>Cow-calf unit costs ${year}</h2></div>
      <div class="stats">
        ${stat('Average cows', avg.avgCows == null ? '—' : n1(avg.avgCows))}
        ${stat('Cost per cow per year', usd(u.costPerCow), `incl. ${Math.round(s.overheadShare * 100)}% of overhead`, 'accent')}
        ${stat('Lb weaned', n0(lbsWeaned))}
        ${stat('Breakeven', u.breakevenCwt == null ? '—' : `$${n2(u.breakevenCwt)}/cwt`, u.breakevenCwt ? `$${n2(u.breakevenCwt / 100)}/lb of calf` : 'log weaning weights')}
      </div>
      <div class="form-grid"><label class="field">Share of overhead charged to cattle<input type="number" step="0.05" min="0" max="1" data-set="overheadShare" value="${s.overheadShare}"></label></div>
    </section>
    ${listPanel('ledger', { rows: db.all('ledger').filter((t) => C.yearOf(t.date) === year), title: `Ledger ${year}`, note: 'Photograph receipts onto each entry. The paper trail is also your proof of business use.' })}`;
}
export function bindPnl(el, rerender) {
  el.querySelector('[data-pyear]')?.addEventListener('change', (e) => { year = Number(e.target.value); rerender(); });
}

/* ------------------------------- scenarios ------------------------------- */
let pick = 'cowcalf';
export function scenarios() {
  const s = S();
  const p = s.scenario;
  const st = stocking();
  const capBase = C.carryingCapacity({ acres: s.acres, acresPerAU: s.acresPerAU });
  const cows = p.cows === '' || p.cows == null ? capBase.head : Number(p.cows);
  const common = { acres: s.acres, huntPerAcre: p.huntPerAcre, withHunting: p.withHunting };
  const list = [
    C.scenarioCowCalf({ ...p, ...common, cows }),
    C.scenarioStockers({ ...p, ...common, capacityAU: capBase.available }),
    C.scenarioGrazingLease({ ...p, ...common }),
    C.scenarioWildlife({ ...p, acres: s.acres }),
  ];
  const best = list.reduce((a, b) => (b.net > a.net ? b : a));
  const cur = list.find((x) => x.key === pick);
  const inp = (k, label, step = 'any', help = '') => `<label class="field">${esc(label)}<input type="number" step="${step}" data-set="scenario.${k}" value="${esc(p[k] ?? '')}">${help ? `<small class="help">${help}</small>` : ''}</label>`;
  const panels = {
    cowcalf: `${inp('cows', 'Cows', 1, `Blank = capacity at normal rain (${capBase.head})`)}${inp('calfCrop', 'Calf crop (weaned / exposed)', 0.01)}${inp('weanWt', 'Weaning weight (lb)', 5)}${inp('pricePerLb', 'Calf price ($/lb)', 0.05)}${inp('costPerCow', 'Cost per cow per year ($)', 10)}${inp('cullRate', 'Cull rate', 0.01)}${inp('cullWt', 'Cull weight (lb)', 10)}${inp('cullPricePerLb', 'Cull price ($/lb)', 0.05)}`,
    stockers: `${inp('inWt', 'In weight (lb)', 5)}${inp('adg', 'Average daily gain (lb)', 0.05)}${inp('days', 'Days on grass', 1)}${inp('buyCwt', 'Buy price ($/cwt)', 1)}${inp('sellCwt', 'Sell price ($/cwt)', 1)}${inp('costPerHead', 'Cost per head (vet, mineral, freight)', 1)}${inp('deathLoss', 'Death loss', 0.005)}${inp('seasonShare', 'Share of year\'s forage used', 0.05, 'Stockers only graze part of the year')}`,
    lease: `${inp('grazingPerAcre', 'Grazing lease ($/ac/yr)', 0.5)}${inp('leaseOwnerCosts', 'Owner costs you keep ($/yr)', 50, 'Fence and water upkeep')}`,
    wildlife: `${inp('wildlifeHuntPerAcre', 'Hunting lease, no cattle ($/ac)', 0.5, 'Usually a premium over a lease with cattle on it')}${inp('wildlifeCosts', 'Wildlife costs ($/yr)', 50, 'Protein, feeders, water, census')}`,
  };
  return `
    <section class="panel">
      <div class="panel-head"><h2>What should the place do?</h2>${pill(`best: ${best.label}`, 'good')}</div>
      <div class="seg">${list.map((x) => `<button class="${x.key === pick ? 'on' : ''}" data-pick="${x.key}">${esc(x.label)}</button>`).join('')}</div>
      <div class="stats">
        ${stat('Gross', usd(cur.gross))}
        ${stat('Costs', usd(cur.costs))}
        ${stat('Net before land', usd(cur.net), `${usd(cur.net / s.acres)}/ac`, cur.net < 0 ? 'bad' : 'accent')}
      </div>
      <p class="note">${esc(cur.detail)}</p>
      <div class="form-grid">${panels[pick]}
        ${pick !== 'wildlife' ? `${inp('huntPerAcre', 'Hunting lease alongside ($/ac)', 0.5)}<label class="field wide check"><span><input type="checkbox" data-set="scenario.withHunting" ${p.withHunting ? 'checked' : ''}> Also lease the hunting</span></label>` : ''}
      </div>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Side by side</h2></div>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th></th>${list.map((x) => `<th class="${x.key === pick ? 'hl' : ''}">${esc(x.label)}</th>`).join('')}</tr></thead>
        <tbody>
          <tr><td>Head</td>${list.map((x) => `<td class="num">${x.head || '—'}</td>`).join('')}</tr>
          <tr><td>Gross</td>${list.map((x) => `<td class="num">${usd(x.gross)}</td>`).join('')}</tr>
          <tr><td>Costs</td>${list.map((x) => `<td class="num">${usd(x.costs)}</td>`).join('')}</tr>
          <tr class="total"><td>Net before land</td>${list.map((x) => `<td class="num ${x.net < 0 ? 'bad-t' : ''}">${usd(x.net)}</td>`).join('')}</tr>
          <tr><td>Per acre</td>${list.map((x) => `<td class="num">${usd(x.net / s.acres)}</td>`).join('')}</tr>
        </tbody></table></div>
      <p class="note">Cattle numbers use capacity at <b>normal</b> rain (${capBase.head} hd on ${s.acres} ac at ${s.acresPerAU} ac/AU). Rain right now is ${st.rain.ratio == null ? 'unknown' : Math.round(st.rain.ratio * 100) + '% of normal'}, so this year's capacity is ${st.cap.head} hd. Wildlife-only still needs a wildlife-management plan and 3 of 7 practices to keep the 1-d-1 valuation. Switching from ag use to wildlife use requires the land to have qualified for ag use the year before.</p>
      <p class="note">Worked example with the defaults: 12 cows × 85% × 500 lb × $3.00 = $15,300 gross, less 12 × $900 = $10,800, nets about $4,500 before land.</p>
    </section>`;
}
export function bindScenarios(el, rerender) {
  el.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => { pick = b.dataset.pick; rerender(); }));
}
