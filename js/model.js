/* =========================================================================
   Glue between stored records and calc.js: settings with defaults, the
   stocking picture, the latest deer census and the "what needs doing" list.
   ========================================================================= */
import * as db from './db.js';
import * as C from './calc.js';

export const DEFAULTS = {
  ranchName: 'Mason County place',
  owner: '',
  county: 'Mason',
  acres: 250,
  acresPerAU: 20,
  normals: C.MASON_NORMALS,
  maxFactor: 1,
  deductDeer: false,
  deerPerAU: 6,
  valuation: 'ag',          // 'ag' (1-d-1 agricultural) or 'wildlife' (1-d-1 wildlife management)
  cadAccount: '',
  cadIntensity: '',         // CAD's minimum degree of intensity, acres per AU (ask Mason CAD)
  opener: '09-01',
  targetAcresPerDeer: 10,
  targetDoesPerBuck: 2,
  calving: 'spring',
  waterStaleDays: 7,
  overheadShare: 0.5,       // share of overhead charged to cattle for cost/cow
  scenario: {
    calfCrop: 0.85, weanWt: 500, pricePerLb: 3.0, costPerCow: 900, cullRate: 0, cullWt: 1100, cullPricePerLb: 1.4,
    inWt: 500, adg: 1.75, days: 150, buyCwt: 330, sellCwt: 275, costPerHead: 140, deathLoss: 0.02, seasonShare: 0.6,
    grazingPerAcre: 8, leaseOwnerCosts: 500,
    huntPerAcre: 25, withHunting: false,
    wildlifeHuntPerAcre: 30, wildlifeCosts: 3000,
  },
};

export function S() {
  const s = db.settings();
  return { ...DEFAULTS, ...s, scenario: { ...DEFAULTS.scenario, ...(s.scenario || {}) } };
}

/** Spotlight runs from the most recent year that has any, pooled. */
export function latestCensus() {
  const runs = db.all('surveys').filter((r) => r.date);
  if (!runs.length) return null;
  const year = Math.max(...runs.map((r) => C.yearOf(r.date)));
  const these = runs.filter((r) => C.yearOf(r.date) === year);
  return { year, ...C.spotlightEstimate(these, S().acres) };
}

/** Everything the stocking calculator and dashboard need. */
export function stocking(asOf = C.today()) {
  const s = S();
  const rain = C.rainWindow(db.all('rain'), s.normals, asOf, 12);
  const census = latestCensus();
  const deer = s.deductDeer && census?.population ? census.population : 0;
  const cap = C.carryingCapacity({
    acres: s.acres, acresPerAU: s.acresPerAU, rainRatio: rain.ratio ?? 1,
    maxFactor: s.maxFactor, deer, deerPerAU: s.deerPerAU,
  });
  const herd = C.headCount(db.all('animals'), db.all('events'), asOf);
  const status = C.stockingStatus(herd.au, cap.available);
  const ladder = C.droughtLadder({ acres: s.acres, acresPerAU: s.acresPerAU, maxFactor: s.maxFactor, deer, deerPerAU: s.deerPerAU });
  return { s, rain, census, deer, cap, herd, status, ladder };
}

export const byId = (col) => new Map(db.all(col).map((r) => [r.id, r]));

/**
 * The absentee owner's short list: overdue/soon chores and paperwork.
 * Each item: { tone: 'bad'|'warn'|'info', text, href }
 */
export function alerts(asOf = C.today()) {
  const s = S();
  const out = [];
  const push = (tone, text, href, sort = 0) => out.push({ tone, text, href, sort });

  const st = stocking(asOf);
  if (st.status.state === 'over') push('bad', `${st.status.msg} (${C.carryingCapacity({ acres: s.acres, acresPerAU: s.acresPerAU }).head} hd at normal rain; now ${Math.round((st.rain.ratio ?? 1) * 100)}% of normal)`, '#/stocking', -100);
  if (st.rain.missing.length >= 3) push('warn', `Rain log is missing ${st.rain.missing.length} of the last 12 months — the stocking calculator is guessing`, '#/rain', -10);

  for (const d of db.all('devices')) {
    const b = C.dueInfo(d.batteryDate, d.batteryDays, asOf);
    if (b && b.state !== 'ok') push(b.state === 'overdue' ? 'bad' : 'warn', `${d.name}: batteries ${daysTxt(b.daysLeft)}`, '#/devices', b.daysLeft);
    if (['feeder', 'protein'].includes(d.type)) {
      const f = C.dueInfo(d.refillDate, d.refillDays, asOf);
      if (f && f.state !== 'ok') push(f.state === 'overdue' ? 'bad' : 'warn', `${d.name}: refill ${daysTxt(f.daysLeft)}`, '#/devices', f.daysLeft);
    }
  }

  const checks = db.all('waterchecks');
  for (const w of db.all('waterpoints')) {
    const mine = checks.filter((c) => c.point === w.id).sort((a, b) => (a.date < b.date ? 1 : -1));
    const last = mine[0];
    if (!last) { push('warn', `${w.name}: never checked`, '#/water', 0); continue; }
    const age = C.daysBetween(last.date, asOf);
    if (last.working === 'no') push('bad', `${w.name}: last check says it needs work`, '#/water', -50);
    else if (last.level !== '' && last.level != null && Number(last.level) < 25) push('bad', `${w.name}: ${last.level}% full`, '#/water', -40);
    else if (age > s.waterStaleDays) push('warn', `${w.name}: not checked in ${age} days`, '#/water', -age);
  }
  for (const m of db.all('waterwork')) {
    if (!m.nextDue) continue;
    const d = C.daysBetween(asOf, m.nextDue);
    const superseded = db.all('waterwork').some((x) => x.point === m.point && x.date > m.date);
    if (!superseded && d <= 14) push(d < 0 ? 'bad' : 'warn', `Water service due: ${m.work} ${daysTxt(d)}`, '#/water', d);
  }

  for (const l of db.all('leases')) {
    if (l.insExpires) {
      const d = C.daysBetween(asOf, l.insExpires);
      if (d <= 30 && d > -120) push(d < 0 ? 'bad' : 'warn', `${l.lessee}: liability insurance ${d < 0 ? 'expired' : 'expires'} ${daysTxt(d)}`, '#/leases', d);
    }
    if (l.fee && !l.paidDate) push('warn', `${l.lessee} (${l.season}): lease fee not marked paid`, '#/leases', 5);
  }
  for (const m of db.all('nrcs')) {
    if (m.done || !m.due) continue;
    const d = C.daysBetween(asOf, m.due);
    if (d <= 60) push(d < 0 ? 'bad' : 'warn', `NRCS ${m.contract}: ${m.description} ${daysTxt(d)}`, '#/nrcs', d);
  }
  for (const b of db.all('brush')) {
    const r = C.brushRow(b, asOf);
    if (r.daysLeft != null && r.daysLeft <= 180) {
      const redone = db.all('brush').some((x) => x.area === b.area && x.species === b.species && x.date > b.date);
      if (!redone) push(r.overdue ? 'warn' : 'info', `Brush retreatment due: ${b.species}${b.area ? ', ' + b.area : ''} ${daysTxt(r.daysLeft)}`, '#/brush', r.daysLeft + 30);
    }
  }
  for (const t of db.all('tasks')) {
    if (t.done || !t.date) continue;
    const d = C.daysBetween(asOf, t.date);
    if (d <= 14) push(d < 0 ? 'bad' : 'info', `${t.title} — ${daysTxt(d)}`, '#/tasks', d);
  }
  if (s.valuation === 'wildlife') {
    const y = C.yearOf(asOf);
    const cov = practiceCoverage(y);
    if (!cov.ok && C.monthOf(asOf) >= 6) push(C.monthOf(asOf) >= 10 ? 'bad' : 'warn', `Wildlife valuation: ${cov.met} of 3 required practices documented for ${y}`, '#/valuation', -20);
  }
  const rank = { bad: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.tone] - rank[b.tone] || a.sort - b.sort);
}
const daysTxt = (d) => (d < 0 ? `${-d} d overdue` : d === 0 ? 'today' : `in ${d} d`);

export function practiceCoverage(year) {
  return C.practiceCoverage(year, {
    practices: db.all('practices'),
    brush: db.all('brush'),
    surveys: db.all('surveys'),
    waterWork: db.all('waterwork'),
    doveFields: db.all('dovefields'),
    feedings: db.all('devicelog').filter((l) => l.action === 'refill').map((l) => ({
      date: l.date, what: `Supplemental feed${l.qty ? `, ${l.qty} lb` : ''}`, device: db.get('devices', l.device)?.name,
    })),
  });
}

/** Sale events with their amounts, for P&L and the packet. */
export const sales = () => db.all('events').filter((e) => e.type === 'sale');
