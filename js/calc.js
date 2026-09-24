/* =========================================================================
   Ranch math. Pure functions only — no DOM, no storage — so every number the
   app shows can be unit-tested (see test/calc.test.js).

   Dates are ISO strings 'YYYY-MM-DD' throughout; they are compared as strings
   and split by hand so nothing shifts with the device's time zone.
   ========================================================================= */

/* ------------------------------ date helpers ----------------------------- */
export const ymd = (d) => {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
};
export const today = () => ymd(new Date());
export const yearOf = (iso) => Number(String(iso).slice(0, 4));
export const monthOf = (iso) => Number(String(iso).slice(5, 7));
export const ymOf = (iso) => String(iso).slice(0, 7);
const toUTC = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
export const daysBetween = (a, b) => Math.round((toUTC(b) - toUTC(a)) / 86400000);
export const addDays = (iso, n) => {
  const t = new Date(toUTC(iso) + n * 86400000);
  const z = (v) => String(v).padStart(2, '0');
  return `${t.getUTCFullYear()}-${z(t.getUTCMonth() + 1)}-${z(t.getUTCDate())}`;
};
export const addYears = (iso, n) => {
  const y = yearOf(iso) + Math.floor(n);
  const rest = iso.slice(4);
  return rest === '-02-29' ? `${y}-02-28` : `${y}${rest}`;
};
export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** 'YYYY-MM' n months before/after ym. */
export const shiftYM = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
};
const sum = (a) => a.reduce((s, x) => s + (Number(x) || 0), 0);
const mean = (a) => (a.length ? sum(a) / a.length : null);
const num = (v, d = 0) => (v === '' || v == null || isNaN(Number(v)) ? d : Number(v));

/* ------------------------------ Mason defaults --------------------------- */
/* Approximate 1991–2020 monthly normals for Mason, TX (inches). They are only a
   starting point — Settings lets the owner replace them with NOAA's figures. */
export const MASON_NORMALS = [1.2, 1.5, 2.0, 1.9, 3.3, 3.0, 1.8, 2.3, 3.0, 2.9, 1.6, 1.3];

/* Animal-unit equivalents by class (1 AU = 1,000 lb cow with calf <6 mo). */
export const AU_EQUIV = {
  cow: 1.0, 'bred heifer': 0.9, heifer: 0.75, bull: 1.35,
  steer: 0.6, calf: 0.5, horse: 1.25, goat: 0.15, sheep: 0.2,
};

/* ------------------------------ 1. rainfall ------------------------------ */
/**
 * Rain over the trailing `months` months ending with asOf's month, against
 * the normal. A month with no gauge readings counts as MISSING, not as zero,
 * so a forgotten gauge doesn't look like drought (log 0.00 for a dry month).
 * The current month's normal is prorated by how far into the month asOf is.
 */
export function rainWindow(readings, normals, asOf, months = 12) {
  const end = ymOf(asOf);
  const byYM = new Map();
  for (const r of readings) {
    if (!r.date) continue;
    const k = ymOf(r.date);
    byYM.set(k, (byYM.get(k) || 0) + num(r.inches));
  }
  const rows = [];
  for (let i = months - 1; i >= 0; i--) {
    const ym = shiftYM(end, -i);
    const [y, m] = ym.split('-').map(Number);
    let normal = num(normals[m - 1]);
    if (ym === end) normal *= Math.min(1, monthDay(asOf) / daysInMonth(y, m));
    const covered = byYM.has(ym);
    rows.push({ ym, actual: covered ? byYM.get(ym) : null, normal, covered });
  }
  const cov = rows.filter((r) => r.covered);
  const actual = sum(cov.map((r) => r.actual));
  const normal = sum(cov.map((r) => r.normal));
  return {
    rows, actual, normal,
    fullNormal: sum(rows.map((r) => r.normal)),
    ratio: normal > 0 ? actual / normal : null,
    missing: rows.filter((r) => !r.covered).map((r) => r.ym),
  };
}
const monthDay = (iso) => Number(iso.slice(8, 10));

/** Where a rain record came from: 'gauge' | 'estimate' (relay) | 'sample' | 'manual'. */
export function rainSource(r) {
  if (r.sample) return 'sample';
  if (r.auto) return /gauge/i.test(r.gauge || '') ? 'gauge' : 'estimate';
  return 'manual';
}
/** Days and inches by source over the trailing `months` months (same window as rainWindow). */
export function rainSourceMix(readings, asOf, months = 12) {
  const start = `${shiftYM(ymOf(asOf), -(months - 1))}-01`;
  const out = { gauge: { days: 0, inches: 0 }, estimate: { days: 0, inches: 0 }, manual: { days: 0, inches: 0 }, sample: { days: 0, inches: 0 } };
  for (const r of readings) {
    if (!r.date || r.date < start || r.date > asOf) continue;
    const o = out[rainSource(r)];
    o.days++;
    o.inches += num(r.inches);
  }
  return out;
}

/** Calendar-year monthly totals: [{m, actual|null, normal}] for 12 months. */
export function rainByMonth(readings, normals, year) {
  const out = Array.from({ length: 12 }, (_, i) => ({ m: i + 1, actual: null, normal: num(normals[i]) }));
  for (const r of readings) {
    if (!r.date || yearOf(r.date) !== year) continue;
    const o = out[monthOf(r.date) - 1];
    o.actual = (o.actual || 0) + num(r.inches);
  }
  return out;
}

/* ------------------------- 2. carrying capacity -------------------------- */
/**
 * acres ÷ acres/AU, scaled by the rain ratio (capped — by default you don't
 * stock up past the base rate in a wet year), less any deer AU you choose to
 * charge against the grass. `head` is floored: 12.5 AU supports 12 cows.
 */
export function carryingCapacity({ acres, acresPerAU, rainRatio = 1, maxFactor = 1, deer = 0, deerPerAU = 6 }) {
  const base = acresPerAU > 0 ? acres / acresPerAU : 0;
  const factor = Math.max(0, Math.min(rainRatio == null ? 1 : rainRatio, maxFactor));
  const adjusted = base * factor;
  const deerAU = deerPerAU > 0 ? deer / deerPerAU : 0;
  const available = Math.max(0, adjusted - deerAU);
  return { base, factor, adjusted, deerAU, available, head: Math.floor(available + 1e-9) };
}

/** Drought ladder: head supported at each rain level — the destock triggers. */
export function droughtLadder(opts, levels = [1, 0.8, 0.6, 0.4]) {
  return levels.map((r) => ({ ratio: r, ...carryingCapacity({ ...opts, rainRatio: r }) }));
}

/** Current stocking vs capacity: 'over' | 'full' | 'room'. */
export function stockingStatus(currentAU, availableAU) {
  const diff = availableAU - currentAU;
  if (diff < -0.05) return { state: 'over', diff, msg: `Over capacity by ${(-diff).toFixed(1)} AU — destock` };
  if (diff < 1) return { state: 'full', diff, msg: 'At capacity' };
  return { state: 'room', diff, msg: `Room for ${diff.toFixed(1)} AU` };
}

/* --------------------------- 3. pasture rotation ------------------------- */
/** One row per pasture: grazing now?, last period, rest days, AU-days this year. */
export function rotationSummary(pastures, grazings, asOf) {
  const year = yearOf(asOf);
  return pastures.map((p) => {
    const gs = grazings.filter((g) => g.pasture === p.id && g.dateIn && g.dateIn <= asOf)
      .sort((a, b) => (a.dateIn < b.dateIn ? -1 : 1));
    const last = gs[gs.length - 1];
    const grazingNow = !!last && (!last.dateOut || last.dateOut > asOf);
    let auDays = 0;
    for (const g of gs) {
      const s = g.dateIn > `${year}-01-01` ? g.dateIn : `${year}-01-01`;
      const e0 = g.dateOut && g.dateOut < asOf ? g.dateOut : asOf;
      const e = e0 < `${year}-12-31` ? e0 : `${year}-12-31`;
      if (e > s) auDays += daysBetween(s, e) * num(g.au);
    }
    const scored = gs.filter((g) => g.score !== '' && g.score != null);
    return {
      pasture: p, last, grazingNow,
      daysGrazed: last ? daysBetween(last.dateIn, grazingNow ? asOf : last.dateOut) : null,
      restDays: last && !grazingNow ? daysBetween(last.dateOut, asOf) : null,
      score: scored.length ? num(scored[scored.length - 1].score) : null,
      auDays, auDaysPerAcre: num(p.acres) > 0 ? auDays / num(p.acres) : null,
    };
  });
}

/* ------------------------------ 4. herd ---------------------------------- */
const OUT_TYPES = ['sale', 'death'];
/** When an animal came onto and left the place. */
export function animalSpan(animal, events) {
  const inDate = animal.purchaseDate || animal.birthDate || null;
  const outs = events.filter((e) => e.animal === animal.id && OUT_TYPES.includes(e.type) && e.date)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return { inDate, outDate: outs[0]?.date || null, outType: outs[0]?.type || null };
}
export function isOnPlace(animal, events, asOf) {
  const { inDate, outDate } = animalSpan(animal, events);
  return (!inDate || inDate <= asOf) && (!outDate || outDate > asOf);
}
/** AU for one animal on a date. A nursing (unweaned) calf rides on its dam's 1.0. */
export function animalAU(animal, events, asOf, table = AU_EQUIV) {
  if (animal.au !== '' && animal.au != null && !isNaN(Number(animal.au))) return Number(animal.au);
  if (animal.cls === 'calf') {
    const weaned = events.some((e) => e.animal === animal.id && e.type === 'wean' && e.date <= asOf);
    if (!weaned) return 0;
  }
  return table[animal.cls] ?? 1;
}
/** Head count by class and total AU on a date. */
export function headCount(animals, events, asOf, table = AU_EQUIV) {
  const byClass = {}, auByClass = {};
  let total = 0, au = 0;
  for (const a of animals) {
    if (!isOnPlace(a, events, asOf)) continue;
    const x = animalAU(a, events, asOf, table);
    byClass[a.cls] = (byClass[a.cls] || 0) + 1;
    auByClass[a.cls] = (auByClass[a.cls] || 0) + x;
    total += 1;
    au += x;
  }
  return { byClass, auByClass, total, au };
}
/** Average head/AU across the 12 month-ends of a year (for packets and cost/cow). */
export function yearAverageCount(animals, events, year, table = AU_EQUIV) {
  const pts = [];
  for (let m = 1; m <= 12; m++) {
    const iso = `${year}-${String(m).padStart(2, '0')}-${String(daysInMonth(year, m)).padStart(2, '0')}`;
    pts.push(headCount(animals, events, iso, table));
  }
  const cows = pts.map((p) => (p.byClass.cow || 0) + (p.byClass['bred heifer'] || 0));
  return { avgHead: mean(pts.map((p) => p.total)), avgAU: mean(pts.map((p) => p.au)), avgCows: mean(cows), monthly: pts };
}

/** 205-day adjusted weaning weight (BIF): (WW − BW) / age × 205 + BW. */
export function adj205(weanWt, birthWt, ageDays) {
  if (!(weanWt > 0) || !(ageDays > 0)) return null;
  const bw = birthWt > 0 ? birthWt : 70;
  return ((weanWt - bw) / ageDays) * 205 + bw;
}

/**
 * Calf-crop KPIs for the crop year Y (the year the calves are born).
 * Exposed cows = distinct animals with an 'expose' event whose crop is Y.
 * The KPI that matters: pounds weaned per exposed cow.
 */
export function calfCropKPIs(animals, events, cropYear) {
  const crop = Number(cropYear);
  const cropStr = String(crop);
  const exposed = new Set(events.filter((e) => e.type === 'expose' && String(e.crop) === cropStr).map((e) => e.animal));
  const pregs = events.filter((e) => e.type === 'preg' && String(e.crop) === cropStr && exposed.has(e.animal));
  const lastPreg = new Map();
  for (const e of pregs.sort((a, b) => (a.date < b.date ? -1 : 1))) lastPreg.set(e.animal, e.result);
  const bred = [...lastPreg.values()].filter((r) => r === 'bred').length;
  const calves = animals.filter((a) => a.dam && exposed.has(a.dam) && a.birthDate && yearOf(a.birthDate) === crop);
  const weanings = [];
  for (const c of calves) {
    const w = events.filter((e) => e.animal === c.id && e.type === 'wean' && num(e.weight) > 0)
      .sort((a, b) => (a.date < b.date ? -1 : 1))[0];
    if (!w) continue;
    const age = c.birthDate ? daysBetween(c.birthDate, w.date) : null;
    weanings.push({ calf: c, weight: num(w.weight), adj: adj205(num(w.weight), num(c.birthWeight), age) });
  }
  const n = exposed.size;
  const lbs = sum(weanings.map((w) => w.weight));
  const adjs = weanings.map((w) => w.adj).filter((x) => x != null);
  return {
    crop, exposed: n, pregChecked: lastPreg.size, bred,
    pregRate: lastPreg.size ? bred / lastPreg.size : null,
    born: calves.length, calvingPct: n ? calves.length / n : null,
    weaned: weanings.length, weaningPct: n ? weanings.length / n : null,
    avgWeanWt: weanings.length ? lbs / weanings.length : null,
    avgAdj205: adjs.length ? mean(adjs) : null,
    lbsWeaned: lbs, lbsPerExposed: n ? lbs / n : null,
  };
}

/** Sale proceeds: the receipt's net amount if entered, else weight × $/cwt. */
export const saleAmount = (e) =>
  e.amount !== '' && e.amount != null && !isNaN(Number(e.amount)) ? Number(e.amount) : (num(e.weight) / 100) * num(e.price);

/* ------------------------------ 5. deer ---------------------------------- */
/** Deer season label: Aug–Dec belong to that year's season, Jan–Jul to the prior. */
export const deerSeason = (iso) => {
  const y = yearOf(iso);
  const s = monthOf(iso) >= 8 ? y : y - 1;
  return `${s}-${String((s + 1) % 100).padStart(2, '0')}`;
};

export function harvestSummary(harvests) {
  const bucks = harvests.filter((h) => h.sex === 'buck');
  const does = harvests.filter((h) => h.sex === 'doe');
  const ages = {};
  for (const h of harvests) {
    if (h.age === '' || h.age == null) continue;
    const k = `${h.sex}|${num(h.age)}`;
    (ages[k] ||= { sex: h.sex, age: num(h.age), n: 0, w: [], s: [] });
    ages[k].n++;
    if (num(h.weight) > 0) ages[k].w.push(num(h.weight));
    if (num(h.score) > 0) ages[k].s.push(num(h.score));
  }
  const buckAges = bucks.map((b) => b.age).filter((a) => a !== '' && a != null).map(Number);
  const scores = bucks.map((b) => num(b.score)).filter((s) => s > 0);
  return {
    total: harvests.length, bucks: bucks.length, does: does.length,
    doesPerBuck: bucks.length ? does.length / bucks.length : null,
    avgBuckAge: mean(buckAges), mature: buckAges.filter((a) => a >= 5.5).length,
    avgScore: mean(scores),
    byAge: Object.values(ages).sort((a, b) => (a.sex === b.sex ? a.age - b.age : a.sex < b.sex ? -1 : 1))
      .map((g) => ({ sex: g.sex, age: g.age, n: g.n, avgWeight: mean(g.w), avgScore: mean(g.s) })),
  };
}

/**
 * One spotlight run. Acres seen = transect length × visible width
 * (miles × 1,760 yd × width yd ÷ 4,840 yd²/acre).
 */
export function spotlightRun({ miles, width, bucks = 0, does = 0, fawns = 0, unknown = 0 }) {
  const deer = num(bucks) + num(does) + num(fawns) + num(unknown);
  const acresSeen = (num(miles) * 1760 * num(width)) / 4840;
  return {
    deer, acresSeen,
    deerPerMile: num(miles) > 0 ? deer / num(miles) : null,
    acresPerDeer: deer > 0 ? acresSeen / deer : null,
  };
}

/** Pool several runs (TPWD wants ≥3 nights) into a density and herd estimate. */
export function spotlightEstimate(runs, propertyAcres) {
  const r = runs.map((x) => ({ ...x, ...spotlightRun(x) }));
  const deer = sum(r.map((x) => x.deer));
  const acres = sum(r.map((x) => x.acresSeen));
  const miles = sum(r.map((x) => num(x.miles)));
  const b = sum(r.map((x) => num(x.bucks))), d = sum(r.map((x) => num(x.does))), f = sum(r.map((x) => num(x.fawns)));
  const acresPerDeer = deer > 0 ? acres / deer : null;
  const population = acresPerDeer ? propertyAcres / acresPerDeer : null;
  const ident = b + d + f;
  return {
    runs: r.length, deer, miles, acresSeen: acres, acresPerDeer,
    deerPerMile: miles > 0 ? deer / miles : null,
    population,
    doesPerBuck: b > 0 ? d / b : null,
    fawnsPerDoe: d > 0 ? f / d : null,
    est: population && ident ? { bucks: population * b / ident, does: population * d / ident, fawns: population * f / ident } : null,
  };
}

/**
 * Harvest quota to move the herd toward a target density and sex ratio.
 * Excess = population − acres/targetAcresPerDeer. Does come off first until
 * the doe:buck ratio reaches target; the rest splits at the target ratio.
 */
export function harvestQuota({ population, bucks, does, acres, targetAcresPerDeer, targetDoesPerBuck = 2 }) {
  if (!population || !targetAcresPerDeer) return null;
  const target = acres / targetAcresPerDeer;
  const excess = Math.max(0, population - target);
  const surplusDoes = Math.max(0, (does || 0) - (bucks || 0) * targetDoesPerBuck);
  const doesFirst = Math.min(excess, surplusDoes);
  const rest = excess - doesFirst;
  const r = targetDoesPerBuck;
  return {
    target, excess,
    does: Math.round(doesFirst + (rest * r) / (1 + r)),
    bucks: Math.round(rest / (1 + r)),
  };
}

/* ------------------------------ 6. dove ---------------------------------- */
/** Plan a dove field back from the opener. */
export function doveSchedule({ plantDate, daysToMaturity = 100, opener }) {
  if (!plantDate || !opener) return null;
  const maturity = addDays(plantDate, num(daysToMaturity, 100));
  const lead = daysBetween(maturity, opener);
  const mows = [21, 14, 7].map((d) => ({ date: addDays(opener, -d), label: `Mow/shred strip (${d} days out)` }));
  let status = 'ok', msg = `Grain matures ${lead} days before the opener.`;
  if (lead < 21) { status = 'late'; msg = `Matures only ${lead} days before the opener — too late for the first mow strip 3 weeks out. Plant earlier or pick a shorter-season hybrid.`; }
  else if (lead > 60) { status = 'early'; msg = `Matures ${lead} days early — heads may shatter or be eaten out before the opener.`; }
  return { maturity, lead, mows, status, msg, latestPlant: addDays(opener, -(num(daysToMaturity, 100) + 21)) };
}

/* ------------------------------ 7. land & gear --------------------------- */
export const BRUSH_RETREAT_YEARS = { cedar: 10, mesquite: 7, 'prickly pear': 5, other: 7 };
export function brushRow(t, asOf) {
  const acres = num(t.acres);
  const cost = num(t.cost);
  const yrs = num(t.retreatYears, BRUSH_RETREAT_YEARS[t.species] ?? 7);
  const due = t.date ? addYears(t.date, yrs) : null;
  const daysLeft = due ? daysBetween(asOf, due) : null;
  return { ...t, costPerAcre: acres > 0 ? cost / acres : null, due, daysLeft, overdue: daysLeft != null && daysLeft < 0 };
}

/** Next due date for a recurring chore (e.g. feeder refill every 14 days). */
export function dueInfo(lastDate, everyDays, asOf) {
  if (!lastDate || !(num(everyDays) > 0)) return null;
  const due = addDays(lastDate, num(everyDays));
  const daysLeft = daysBetween(asOf, due);
  return { due, daysLeft, state: daysLeft < 0 ? 'overdue' : daysLeft <= 3 ? 'soon' : 'ok' };
}

/* ------------------------- 8. wildlife valuation ------------------------- */
/* Texas Tax Code §23.51(7) / 34 TAC §9.2003: at least 3 of these 7 practices
   must be carried out each year under a wildlife management plan. */
export const WILDLIFE_PRACTICES = [
  { key: 'habitat', label: 'Habitat control' },
  { key: 'erosion', label: 'Erosion control' },
  { key: 'predator', label: 'Predator control' },
  { key: 'water', label: 'Providing supplemental water' },
  { key: 'food', label: 'Providing supplemental food' },
  { key: 'shelter', label: 'Providing shelters' },
  { key: 'census', label: 'Making census counts to determine population' },
];

/**
 * Which of the seven practices have evidence in a year. Logged practice
 * entries count directly; other modules contribute derived evidence
 * (brush work → habitat control, spotlight runs → census, and so on).
 */
export function practiceCoverage(year, src) {
  const inYear = (d) => d && yearOf(d) === year;
  const ev = Object.fromEntries(WILDLIFE_PRACTICES.map((p) => [p.key, []]));
  for (const p of src.practices || []) if (inYear(p.date) && ev[p.practice]) ev[p.practice].push({ date: p.date, text: p.activity || '', source: 'Practice log' });
  for (const b of src.brush || []) if (inYear(b.date)) ev.habitat.push({ date: b.date, text: `${b.species} ${b.method || 'treatment'}, ${num(b.acres)} ac${b.area ? ' — ' + b.area : ''}`, source: 'Brush management' });
  for (const s of src.surveys || []) if (inYear(s.date)) ev.census.push({ date: s.date, text: `Spotlight count, ${s.route || 'route'} (${num(s.miles)} mi)`, source: 'Spotlight survey' });
  for (const m of src.waterWork || []) if (inYear(m.date) && m.wildlife) ev.water.push({ date: m.date, text: m.work || 'Water point work', source: 'Water points' });
  for (const f of src.feedings || []) if (inYear(f.date)) ev.food.push({ date: f.date, text: `${f.what || 'Feeder refill'}${f.device ? ' — ' + f.device : ''}`, source: 'Feeders' });
  for (const f of src.doveFields || []) if (inYear(f.plantDate)) ev.food.push({ date: f.plantDate, text: `${f.crop || 'Food plot'} planted, ${num(f.acres)} ac — ${f.name}`, source: 'Food plots' });
  const byKey = WILDLIFE_PRACTICES.map((p) => ({ ...p, evidence: ev[p.key].sort((a, b) => (a.date < b.date ? -1 : 1)), met: ev[p.key].length > 0 }));
  const met = byKey.filter((p) => p.met).length;
  return { year, practices: byKey, met, ok: met >= 3 };
}

/* ------------------------------ 9. money --------------------------------- */
export const ENTERPRISES = ['cattle', 'hunting', 'dove', 'overhead'];

/**
 * Enterprise P&L for a year. Cattle sales come from the herd's sale events,
 * cattle purchases from animals' purchase price, and lease fees from the
 * hunting leases — they're never typed into the ledger twice.
 */
export function enterprisePL(year, { ledger = [], sales = [], animals = [], leases = [] }) {
  const E = Object.fromEntries(ENTERPRISES.map((k) => [k, { income: 0, expense: 0, lines: {} }]));
  const add = (ent, cat, amt) => {
    const e = E[ent] || E.overhead;
    if (amt >= 0) e.income += amt; else e.expense += -amt;
    e.lines[cat] = (e.lines[cat] || 0) + amt;
  };
  for (const t of ledger) if (t.date && yearOf(t.date) === year) add(t.enterprise, t.category || 'Other', (t.kind === 'income' ? 1 : -1) * Math.abs(num(t.amount)));
  for (const s of sales) if (s.date && yearOf(s.date) === year) add('cattle', 'Cattle sales', saleAmount(s));
  for (const a of animals) if (a.purchaseDate && yearOf(a.purchaseDate) === year && num(a.purchasePrice) > 0) add('cattle', 'Cattle purchases', -num(a.purchasePrice));
  for (const l of leases) if (l.paidDate && yearOf(l.paidDate) === year && num(l.fee) > 0) add(l.enterprise === 'dove' ? 'dove' : 'hunting', 'Lease fees', num(l.fee));
  let income = 0, expense = 0;
  for (const k of ENTERPRISES) { E[k].net = E[k].income - E[k].expense; income += E[k].income; expense += E[k].expense; }
  return { year, enterprises: E, income, expense, net: income - expense };
}

/** Cost per cow per year and breakeven $/cwt of calf weaned. */
export function cattleUnitCosts({ cattleExpense, overhead = 0, overheadShare = 0, avgCows, lbsWeaned }) {
  const cost = cattleExpense + overhead * overheadShare;
  return {
    cost,
    costPerCow: avgCows > 0 ? cost / avgCows : null,
    breakevenCwt: lbsWeaned > 0 ? cost / (lbsWeaned / 100) : null,
  };
}

/* ------------------------------ 10. scenarios ---------------------------- */
/* Every scenario is before land costs (taxes, insurance, debt). Hunting lease
   income is optional in the grazing scenarios and built in to wildlife-only. */
export function scenarioCowCalf(p) {
  const cows = num(p.cows);
  const calves = cows * num(p.calfCrop);
  const calfRevenue = calves * num(p.weanWt) * num(p.pricePerLb);
  const culls = Math.round(cows * num(p.cullRate));
  const cullRevenue = culls * num(p.cullWt) * num(p.cullPricePerLb);
  const hunting = p.withHunting ? num(p.acres) * num(p.huntPerAcre) : 0;
  const gross = calfRevenue + cullRevenue + hunting;
  const costs = cows * num(p.costPerCow);
  return { key: 'cowcalf', label: 'Cow-calf', head: cows, gross, costs, net: gross - costs,
    detail: `${cows} cows × ${fmtPct(p.calfCrop)} calf crop × ${num(p.weanWt)} lb × $${num(p.pricePerLb).toFixed(2)}/lb` };
}
export function scenarioStockers(p) {
  const days = num(p.days);
  const outWt = num(p.inWt) + num(p.adg) * days;
  const avgAU = ((num(p.inWt) + outWt) / 2) / 1000;
  const auDaysAvail = num(p.capacityAU) * 365 * num(p.seasonShare);
  const head = avgAU > 0 && days > 0 ? Math.floor(auDaysAvail / (avgAU * days)) : 0;
  const sold = head * (1 - num(p.deathLoss));
  const revenue = sold * (outWt / 100) * num(p.sellCwt);
  const purchase = head * (num(p.inWt) / 100) * num(p.buyCwt);
  const hunting = p.withHunting ? num(p.acres) * num(p.huntPerAcre) : 0;
  const costs = purchase + head * num(p.costPerHead);
  const gross = revenue + hunting;
  return { key: 'stockers', label: 'Stockers', head, outWt, gross, costs, net: gross - costs,
    detail: `${head} hd, ${num(p.inWt)}→${Math.round(outWt)} lb over ${days} d, buy $${num(p.buyCwt)}/cwt, sell $${num(p.sellCwt)}/cwt` };
}
export function scenarioGrazingLease(p) {
  const lease = num(p.acres) * num(p.grazingPerAcre);
  const hunting = p.withHunting ? num(p.acres) * num(p.huntPerAcre) : 0;
  const costs = num(p.leaseOwnerCosts);
  return { key: 'lease', label: 'Lease-only', head: 0, gross: lease + hunting, costs, net: lease + hunting - costs,
    detail: `${num(p.acres)} ac × $${num(p.grazingPerAcre)}/ac grazing lease` };
}
export function scenarioWildlife(p) {
  const gross = num(p.acres) * num(p.wildlifeHuntPerAcre);
  const costs = num(p.wildlifeCosts);
  return { key: 'wildlife', label: 'Wildlife-only', head: 0, gross, costs, net: gross - costs,
    detail: `${num(p.acres)} ac × $${num(p.wildlifeHuntPerAcre)}/ac hunting, no cattle` };
}
const fmtPct = (x) => `${Math.round(num(x) * 100)}%`;

/* ------------------------------ 11. calendar ----------------------------- */
/** First given weekday (0=Sun…6=Sat) on/after an ISO date. */
export function nextWeekday(iso, dow) {
  const d = new Date(toUTC(iso)).getUTCDay();
  return addDays(iso, (dow - d + 7) % 7);
}
/**
 * Seasonal task template for a Mason County cow-calf / deer / dove place.
 * Deer dates follow TPWD's usual pattern (general season opens the first
 * Saturday of November; archery five weeks earlier) — confirm each year in
 * the Outdoor Annual.
 */
export function seasonalTemplate(year, { doveOpener = '09-01', calving = 'spring' } = {}) {
  const Y = year;
  const gen = nextWeekday(`${Y}-11-01`, 6);
  const t = (date, title, category, notes = '') => ({ date, title, category, notes });
  const out = [
    t(`${Y}-01-15`, 'Prescribed burn window opens — check Mason County burn ban, line up crew', 'land', 'Winter burns Jan–Mar; need a burn plan and notify neighbors.'),
    t(`${Y}-02-01`, 'Brush retreatment walk — cedar/mesquite regrowth', 'land'),
    t(`${Y}-03-15`, 'Burn window closing — finish burns before green-up', 'land'),
    t(`${Y}-04-01`, 'Wildlife valuation annual report — confirm Mason CAD deadline and file', 'compliance', 'Year-end packet lives under Compliance → Valuation packet.'),
    t(`${Y}-04-15`, 'Milo planting window opens (dove fields)', 'dove'),
    t(`${Y}-05-15`, 'Property tax protest deadline (typical) — review appraisal notice', 'compliance'),
    t(`${Y}-05-31`, 'Last call to plant milo for a Sept opener', 'dove'),
    t(`${Y}-08-01`, 'Spotlight census — 3 nights, same route', 'wildlife'),
    t(addDays(`${Y}-${doveOpener}`, -21), 'Dove field: first mow strip; pull deer feeders near dove fields (10-day rule)', 'dove'),
    t(`${Y}-${doveOpener}`, 'Dove season opener', 'dove'),
    t(addDays(gen, -35), 'Archery deer season opens (verify)', 'wildlife'),
    t(gen, 'General deer season opens (verify)', 'wildlife'),
    t(`${Y}-12-15`, 'Year-end: rain gauge, head count and receipts complete for valuation packet', 'compliance'),
    t(`${Y}-12-31`, 'Hunting lease renewals & liability insurance certificates', 'compliance'),
  ];
  if (calving === 'spring') {
    out.push(
      t(`${Y}-02-01`, 'Calving season starts — check heifers twice daily', 'cattle'),
      t(`${Y}-04-20`, 'Work calves: brand, vaccinate, castrate', 'cattle'),
      t(`${Y}-05-01`, 'Turn out bull (breeding season)', 'cattle'),
      t(`${Y}-07-15`, 'Pull bull', 'cattle'),
      t(`${Y}-09-15`, 'Preg check cows (~60 days after bull out); cull opens', 'cattle'),
      t(`${Y}-10-01`, 'Wean calves — weigh every calf', 'cattle'),
    );
  } else {
    out.push(
      t(`${Y}-09-01`, 'Calving season starts', 'cattle'),
      t(`${Y}-12-01`, 'Turn out bull', 'cattle'),
      t(`${Y}-04-15`, 'Preg check cows; cull opens', 'cattle'),
      t(`${Y}-05-15`, 'Wean calves — weigh every calf', 'cattle'),
    );
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/* ------------------------- 12. stock tank sealing ------------------------ */
/**
 * Stock-tank geometry at the full-pool waterline. Shapes: 'round' (diameter),
 * 'rect' (length × width) or 'area' (known surface area, treated as round).
 * `slope` is the side slope as horizontal run per 1 ft of drop (3 = 3:1).
 * If the sides meet before `depth`, the tank is a cone/trough and the real
 * depth is capped where they meet. All results in square feet / gallons.
 */
export function tankGeometry({ shape = 'round', diameter, length, width, surfaceSqft, depth, slope = 3 }) {
  const d = Math.max(0, num(depth)), z = Math.max(0, num(slope, 3));
  const GAL_PER_FT3 = 7.48052;
  if (shape === 'rect') {
    const L = num(length), W = num(width);
    if (!(L > 0 && W > 0)) return null;
    const dEff = z > 0 ? Math.min(d, Math.min(L, W) / (2 * z)) : d;
    const Lb = Math.max(0, L - 2 * z * dEff), Wb = Math.max(0, W - 2 * z * dEff);
    const h = dEff * Math.sqrt(1 + z * z); // slant height of each side
    const top = L * W, bottom = Lb * Wb;
    const sides = (L + Lb) * h + (W + Wb) * h;
    const mid = ((L + Lb) / 2) * ((W + Wb) / 2);
    const ft3 = (dEff / 6) * (top + 4 * mid + bottom);
    return { surface: top, bottom, sides, wetted: bottom + sides, depth: dEff, gallons: ft3 * GAL_PER_FT3, acreFeet: ft3 / 43560 };
  }
  const D = shape === 'area' ? 2 * Math.sqrt(num(surfaceSqft) / Math.PI) : num(diameter);
  if (!(D > 0)) return null;
  const Rr = D / 2;
  const dEff = z > 0 ? Math.min(d, Rr / z) : d;
  const r = Math.max(0, Rr - z * dEff);
  const sides = Math.PI * (Rr + r) * Math.sqrt((Rr - r) ** 2 + dEff ** 2);
  const bottom = Math.PI * r * r;
  const ft3 = (Math.PI * dEff / 3) * (Rr * Rr + Rr * r + r * r);
  return { surface: Math.PI * Rr * Rr, bottom, sides, wetted: bottom + sides, depth: dEff, gallons: ft3 * GAL_PER_FT3, acreFeet: ft3 / 43560 };
}

/* Starting rates, lb of sodium bentonite per ft² (commonly cited ranges from
   Texas A&M AgriLife and bentonite suppliers). A soil test or a trial plot
   beats any table, and every number is editable in the app. */
export const BENTONITE_SOILS = [
  { key: 'clay', label: 'Clay / silty clay', mixed: 1.5, sprinkle: 3, range: '1–2' },
  { key: 'loam', label: 'Loam / silt loam', mixed: 2, sprinkle: 3.5, range: '1.5–3' },
  { key: 'sandyloam', label: 'Sandy loam', mixed: 3, sprinkle: 4, range: '2–4' },
  { key: 'sand', label: 'Sand', mixed: 4, sprinkle: 5, range: '3–5' },
  { key: 'gravel', label: 'Gravel / rock / fractured limestone', mixed: 5.5, sprinkle: 6, range: '5–6+' },
];

/**
 * Pounds, bags and sacks of bentonite for an area.
 * Rate gets +1 lb/ft² per 8 ft of water beyond the first 8 ft, then a
 * safety margin for uneven spreading (Texas A&M suggests 25–50%).
 */
export function bentoniteNeed({ area, rate, depth = 0, margin = 0.25, bagLb = 50, bagPrice, tonPrice }) {
  const a = num(area);
  if (!(a > 0) || !(num(rate) > 0)) return null;
  const depthAdd = Math.max(0, num(depth) - 8) / 8;
  const rateAdj = (num(rate) + depthAdd) * (1 + num(margin));
  const lbs = a * rateAdj;
  const bags = Math.ceil(lbs / num(bagLb, 50));
  const tons = lbs / 2000;
  return {
    area: a, baseRate: num(rate), depthAdd, rateAdj, lbs, bags, tons,
    sacks: Math.ceil(lbs / 2000), // 1-ton bulk super sacks
    perSquare: rateAdj * 100,     // lb per 10 × 10 ft square
    bagsPerSquare: (rateAdj * 100) / num(bagLb, 50),
    costBags: num(bagPrice) > 0 ? bags * num(bagPrice) : null,
    costBulk: num(tonPrice) > 0 ? tons * num(tonPrice) : null,
  };
}

/* ------------------------ 13. dove crop recommendations ------------------ */
/* Texas A&M AgriLife recommendations. Dove crops: "Dove Hunting and Normal
   Agricultural Operations" (EWF-104): broadcast lb/acre, drilled at half the
   broadcast rate, and Texas planting windows. Grain sorghum window: AgriLife
   San Angelo, West Central Texas (plant from ~Apr 15 once soil is ≥60–65 °F;
   yields drop after Jun 15). Wheat: AgriLife grain-wheat rates for Central
   Texas. Planting inside these rates and dates is what makes a field a
   "normal agricultural planting" under the federal baiting rule. */
export const DOVE_CROPS = [
  { key: 'milo', label: 'Grain sorghum / milo', broadcast: [10, 20], drilledFactor: 0.5, window: ['04-15', '06-15'], days: [90, 110], source: 'EWF-104; AgriLife San Angelo (West Central TX sorghum)',
    tip: 'Plant when the soil is at least 60–65 °F at seed depth (read it at 7–8 am). An early or medium-early hybrid gives time for staggered mowing before the opener.' },
  { key: 'sunflower', label: 'Sunflower (Peredovik)', broadcast: [10, 15], drilledFactor: 0.5, window: ['04-01', '04-30'], days: [65, 90], source: 'EWF-104',
    tip: 'AgriLife lists April. April sunflowers can mature by July, so leave some rows standing and mow in strips from mid-August.' },
  { key: 'millet', label: 'Proso millet (dove / white proso)', broadcast: [20, 30], drilledFactor: 0.5, window: ['03-01', '09-30'], days: [60, 75], source: 'EWF-104',
    tip: 'Fast. Plant 2–3 strips a couple of weeks apart so seed is fresh at the opener.' },
  { key: 'browntop', label: 'Browntop millet', broadcast: [20, 30], drilledFactor: 0.5, window: ['03-01', '09-30'], days: [45, 60], source: 'EWF-104',
    tip: 'The fastest option. It is also a good late planting for the second split.' },
  { key: 'wheat', label: 'Wheat (grain)', broadcast: [90, 120], drilled: [60, 90], window: ['10-15', '11-30'], days: [200, 230], source: 'AgriLife wheat recommendations, Central Texas',
    tip: 'Wheat planted in fall gives seed the next spring, not by Sept 1. Top-sowing wheat on a dove field is legal only at AgriLife rates and dates for wheat planting. Outside them it is baiting.' },
  { key: 'croton', label: 'Croton / dove weed (seeded)', broadcast: [3, 5], drilled: [3, 5], window: ['12-01', '03-31'], startPrev: true, days: null, seedNote: 'Aug → frost', agrilife: false,
    source: 'Native-seed supplier rates (3–5 lb/ac). AgriLife’s dove table (EWF-104) does not list croton; species info from AgriLife “Plants of Texas Rangelands”.',
    tip: 'Sow in winter or early spring and cover it with shallow disking (under 3 in). Croton seed is mostly dormant and needs a winter to break dormancy, so a spring or summer sowing mostly waits a year. It grows slowly through early summer, then drops seed from August until frost, which is right for the opener. Woolly and Texas croton like sandy soils (Mason’s granite sands). One-seed croton grows on shallow limestone. Cattle avoid it, and it is toxic in quantity, so keep it out of hay fields. Once a stand is established, disking in winter keeps it coming back. Don’t broadcast croton seed in summer on a field you’ll hunt.' },
  { key: 'native', label: 'Native (disk only: croton, sunflower, ragweed)', broadcast: null, window: ['12-01', '02-28'], startPrev: true, days: null, seedNote: 'Jul → frost',
    source: 'TPWD / AgriLife fallow-disking guidance',
    tip: 'No seed. Disk strips shallowly (2–3 in) in winter to wake the seed bank of croton, native sunflower and ragweed, all top dove foods. Rotate strips each year so there is always first-year growth. It works best where croton or sunflowers already grow nearby.' },
];
export const doveCrop = (key) => DOVE_CROPS.find((c) => c.key === key) || null;

/**
 * AgriLife seeding rate, planting window and "plant by" date for a crop,
 * for the season whose opener is `opener` (ISO). `method` = broadcast|drilled.
 * `plantDate` / `seedRate` (lb/ac) are checked against the recommendation.
 */
export function doveCropAdvice(key, { opener, method = 'broadcast', acres, plantDate, seedRate } = {}) {
  const c = doveCrop(key);
  if (!c) return null;
  const year = yearOf(opener);
  // EWF-104: drilled = half the broadcast rate, unless the crop lists its own drilled rate.
  const rate = !c.broadcast ? null
    : method === 'drilled' ? (c.drilled || c.broadcast.map((x) => Math.round(x * (c.drilledFactor ?? 0.5) * 10) / 10))
    : c.broadcast;
  // Wheat for this opener was planted the previous fall; croton and disking
  // run from December of the previous year into late winter.
  const wYear = c.key === 'wheat' ? year - 1 : year;
  const window = [`${c.startPrev ? year - 1 : wYear}-${c.window[0]}`, `${wYear}-${c.window[1]}`];
  let plantBy = c.days ? null : window[1], plantFrom = window[0];
  if (c.days) {
    // Mature at least 21 days before the opener, for the first mow strip.
    plantBy = addDays(opener, -(c.days[1] + 21));
    if (plantBy > window[1]) plantBy = window[1];
    if (c.key === 'millet' || c.key === 'browntop') plantFrom = addDays(opener, -(c.days[1] + 45)) > window[0] ? addDays(opener, -(c.days[1] + 45)) : window[0];
  }
  const checks = [];
  if (plantDate) {
    const inWindow = plantDate >= window[0] && plantDate <= window[1];
    const who = c.agrilife === false ? 'recommended' : 'AgriLife';
    checks.push({ ok: inWindow, text: inWindow ? `Planting date is inside the ${who} window.` : `Planting date is outside the ${who} window (${window[0]} to ${window[1]}). Keep records showing it was a normal agricultural planting.` });
  }
  if (seedRate !== '' && seedRate != null && rate) {
    const r = Number(seedRate);
    const ok = r >= rate[0] * 0.9 && r <= rate[1] * 1.1;
    checks.push({ ok, text: ok ? `Seeding rate ${r} lb/ac is within the ${rate[0]}–${rate[1]} lb/ac ${method} range.` : `Seeding rate ${r} lb/ac is outside the ${rate[0]}–${rate[1]} lb/ac ${c.agrilife === false ? 'recommended' : 'AgriLife'} ${method} range. Heavy seeding on a dove field can be treated as baiting.` });
  }
  return {
    crop: c, method, rate, window, plantFrom, plantBy,
    daysMid: c.days ? Math.round((c.days[0] + c.days[1]) / 2) : null,
    seedLbs: rate && num(acres) > 0 ? [Math.ceil(rate[0] * num(acres)), Math.ceil(rate[1] * num(acres))] : null,
    checks,
  };
}
