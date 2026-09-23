import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../js/calc.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('carrying capacity: 250 ac at 20 ac/AU is 12 head, 60% rain drops to 7', () => {
  const base = C.carryingCapacity({ acres: 250, acresPerAU: 20 });
  near(base.base, 12.5);
  assert.equal(base.head, 12);
  const dry = C.carryingCapacity({ acres: 250, acresPerAU: 20, rainRatio: 0.6 });
  near(dry.available, 7.5);
  assert.equal(dry.head, 7);
});

test('carrying capacity caps wet years and charges deer against the grass', () => {
  assert.equal(C.carryingCapacity({ acres: 250, acresPerAU: 20, rainRatio: 1.4 }).head, 12);
  assert.equal(C.carryingCapacity({ acres: 250, acresPerAU: 20, rainRatio: 1.4, maxFactor: 1.2 }).head, 15);
  const d = C.carryingCapacity({ acres: 250, acresPerAU: 20, deer: 30, deerPerAU: 6 });
  near(d.deerAU, 5);
  assert.equal(d.head, 7);
});

test('drought ladder and stocking status', () => {
  const l = C.droughtLadder({ acres: 250, acresPerAU: 20 });
  assert.deepEqual(l.map((x) => x.head), [12, 10, 7, 5]);
  assert.equal(C.stockingStatus(9, 7.5).state, 'over');
  assert.equal(C.stockingStatus(7, 7.5).state, 'full');
  assert.equal(C.stockingStatus(4, 7.5).state, 'room');
});

test('rain window: missing months are missing, current month prorated', () => {
  const normals = Array(12).fill(2);
  const readings = [
    { date: '2026-07-03', inches: 0.5 }, { date: '2026-07-20', inches: 0.7 },
    { date: '2026-08-10', inches: 0 },
    { date: '2026-09-05', inches: 1 },
  ];
  const w = C.rainWindow(readings, normals, '2026-09-15', 3);
  assert.deepEqual(w.rows.map((r) => r.ym), ['2026-07', '2026-08', '2026-09']);
  near(w.actual, 2.2);
  near(w.normal, 2 + 2 + 2 * 15 / 30);
  near(w.ratio, 2.2 / 5);
  const w12 = C.rainWindow(readings, normals, '2026-09-15');
  assert.equal(w12.missing.length, 9);
  assert.equal(w12.missing[0], '2025-10');
});

test('rain by month', () => {
  const r = C.rainByMonth([{ date: '2026-05-01', inches: 1 }, { date: '2026-05-09', inches: 2.5 }, { date: '2025-05-09', inches: 9 }], C.MASON_NORMALS, 2026);
  near(r[4].actual, 3.5);
  assert.equal(r[0].actual, null);
});

test('date helpers', () => {
  assert.equal(C.addDays('2026-02-27', 3), '2026-03-02');
  assert.equal(C.daysBetween('2026-01-01', '2026-12-31'), 364);
  assert.equal(C.shiftYM('2026-01', -1), '2025-12');
  assert.equal(C.shiftYM('2025-12', 1), '2026-01');
  assert.equal(C.addYears('2024-02-29', 1), '2025-02-28');
  assert.equal(C.nextWeekday('2026-11-01', 6), '2026-11-07');
  assert.equal(C.deerSeason('2026-11-10'), '2026-27');
  assert.equal(C.deerSeason('2027-01-03'), '2026-27');
});

/* A small herd: 3 cows exposed for the 2026 crop, 2 calves, 1 weaned + sold. */
const animals = [
  { id: 'c1', tag: '101', cls: 'cow', birthDate: '2019-03-01' },
  { id: 'c2', tag: '102', cls: 'cow', purchaseDate: '2025-06-01', purchasePrice: 1800 },
  { id: 'c3', tag: '103', cls: 'cow', birthDate: '2020-03-01' },
  { id: 'b1', tag: 'B1', cls: 'bull', birthDate: '2021-01-01' },
  { id: 'k1', tag: '601', cls: 'calf', dam: 'c1', birthDate: '2026-02-10', birthWeight: 75 },
  { id: 'k2', tag: '602', cls: 'calf', dam: 'c2', birthDate: '2026-03-01' },
];
const events = [
  ...['c1', 'c2', 'c3'].map((a) => ({ animal: a, type: 'expose', date: '2025-05-01', crop: 2026 })),
  { animal: 'c1', type: 'preg', date: '2025-09-15', crop: 2026, result: 'bred' },
  { animal: 'c2', type: 'preg', date: '2025-09-15', crop: 2026, result: 'bred' },
  { animal: 'c3', type: 'preg', date: '2025-09-15', crop: 2026, result: 'open' },
  { animal: 'k1', type: 'wean', date: '2026-09-09', weight: 520 },
  { animal: 'k2', type: 'wean', date: '2026-09-09', weight: 480 },
  { animal: 'c3', type: 'sale', date: '2025-10-01', weight: 1150, price: 110 },
];

test('head count and AU on a date (nursing calves ride on the cow)', () => {
  const pre = C.headCount(animals, events, '2026-06-01');
  assert.equal(pre.total, 5);
  near(pre.au, 1 + 1 + 1.35);
  const post = C.headCount(animals, events, '2026-09-10');
  near(post.au, 1 + 1 + 1.35 + 0.5 + 0.5);
  assert.equal(C.headCount(animals, events, '2025-07-01').byClass.cow, 3);
});

test('calf crop KPIs: pounds weaned per exposed cow', () => {
  const k = C.calfCropKPIs(animals, events, 2026);
  assert.equal(k.exposed, 3);
  assert.equal(k.bred, 2);
  near(k.pregRate, 2 / 3);
  assert.equal(k.born, 2);
  assert.equal(k.weaned, 2);
  near(k.avgWeanWt, 500);
  near(k.lbsPerExposed, 1000 / 3);
  // k1: 211 days old, (520-75)/211*205+75
  near(k.avgAdj205, (((520 - 75) / 211) * 205 + 75 + ((480 - 70) / 192) * 205 + 70) / 2);
  assert.equal(C.calfCropKPIs(animals, events, '2026').exposed, 3);
});

test('sale amount uses receipt net if present else weight × $/cwt', () => {
  near(C.saleAmount({ weight: 1150, price: 110 }), 1265);
  near(C.saleAmount({ weight: 1150, price: 110, amount: 1200 }), 1200);
  near(C.saleAmount({ weight: 1150, price: 110, amount: '' }), 1265);
});

test('worked example scenario: 12 cows nets about $4.5k before land', () => {
  const s = C.scenarioCowCalf({ cows: 12, calfCrop: 0.85, weanWt: 500, pricePerLb: 3, costPerCow: 900 });
  near(s.gross, 15300);
  near(s.costs, 10800);
  near(s.net, 4500);
});

test('stocker, lease and wildlife scenarios', () => {
  const st = C.scenarioStockers({ capacityAU: 12, seasonShare: 0.6, inWt: 500, adg: 2, days: 150, buyCwt: 300, sellCwt: 250, costPerHead: 120, deathLoss: 0.02 });
  assert.equal(st.outWt, 800);
  // 12*365*0.6 = 2628 AU-days; per head 0.65*150 = 97.5 → 26 hd
  assert.equal(st.head, 26);
  const l = C.scenarioGrazingLease({ acres: 250, grazingPerAcre: 8, withHunting: true, huntPerAcre: 25 });
  near(l.gross, 2000 + 6250);
  const w = C.scenarioWildlife({ acres: 250, wildlifeHuntPerAcre: 30, wildlifeCosts: 3000 });
  near(w.net, 4500);
});

test('spotlight: acres per deer and population', () => {
  const r = C.spotlightRun({ miles: 5, width: 220, bucks: 5, does: 12, fawns: 3 });
  near(r.acresSeen, (5 * 1760 * 220) / 4840); // 400 ac
  near(r.acresPerDeer, 20);
  near(r.deerPerMile, 4);
  const e = C.spotlightEstimate([
    { miles: 5, width: 220, bucks: 5, does: 12, fawns: 3 },
    { miles: 5, width: 220, bucks: 5, does: 8, fawns: 7 },
  ], 250);
  near(e.acresPerDeer, 20);
  near(e.population, 12.5);
  near(e.doesPerBuck, 2);
  near(e.est.bucks, 12.5 * 10 / 40);
});

test('harvest quota takes surplus does first', () => {
  const q = C.harvestQuota({ population: 50, bucks: 10, does: 30, acres: 250, targetAcresPerDeer: 10, targetDoesPerBuck: 2 });
  assert.equal(q.target, 25);
  assert.equal(q.excess, 25);
  // 10 surplus does first, then 15 split 2:1 → 10 does + 5 bucks
  assert.equal(q.does, 20);
  assert.equal(q.bucks, 5);
  assert.equal(C.harvestQuota({ population: 20, bucks: 5, does: 10, acres: 250, targetAcresPerDeer: 10 }).does, 0);
});

test('harvest summary', () => {
  const s = C.harvestSummary([
    { sex: 'buck', age: 5.5, weight: 150, score: 140 },
    { sex: 'buck', age: 3.5, weight: 120, score: 110 },
    { sex: 'doe', age: 2.5, weight: 80 },
    { sex: 'doe', age: 2.5, weight: 90 },
  ]);
  assert.equal(s.doesPerBuck, 1);
  assert.equal(s.mature, 1);
  near(s.avgBuckAge, 4.5);
  near(s.byAge.find((g) => g.sex === 'doe').avgWeight, 85);
});

test('dove schedule flags late plantings', () => {
  const ok = C.doveSchedule({ plantDate: '2026-05-01', daysToMaturity: 100, opener: '2026-09-01' });
  assert.equal(ok.maturity, '2026-08-09');
  assert.equal(ok.status, 'ok');
  assert.equal(ok.mows[0].date, '2026-08-11');
  assert.equal(C.doveSchedule({ plantDate: '2026-06-10', daysToMaturity: 100, opener: '2026-09-01' }).status, 'late');
  assert.equal(ok.latestPlant, '2026-05-03');
});

test('wildlife practices: 3 of 7 from logs and derived evidence', () => {
  const c = C.practiceCoverage(2026, {
    brush: [{ date: '2026-02-01', species: 'cedar', acres: 20 }],
    surveys: [{ date: '2026-08-10', route: 'Main', miles: 4 }],
    waterWork: [{ date: '2026-05-01', work: 'Wildlife guzzler', wildlife: true }, { date: '2026-05-02', work: 'Trough float' }],
    practices: [{ date: '2025-12-01', practice: 'predator' }],
  });
  assert.equal(c.met, 3);
  assert.equal(c.ok, true);
  assert.equal(c.practices.find((p) => p.key === 'water').evidence.length, 1);
  assert.equal(c.practices.find((p) => p.key === 'predator').met, false);
});

test('enterprise P&L pulls sales, purchases and lease fees', () => {
  const pl = C.enterprisePL(2025, {
    ledger: [
      { date: '2025-03-01', enterprise: 'cattle', kind: 'expense', category: 'Hay', amount: 2000 },
      { date: '2025-03-01', enterprise: 'dove', kind: 'expense', category: 'Seed', amount: 300 },
      { date: '2024-03-01', enterprise: 'cattle', kind: 'expense', category: 'Hay', amount: 999 },
    ],
    sales: events.filter((e) => e.type === 'sale'),
    animals,
    leases: [{ fee: 5000, paidDate: '2025-08-01' }],
  });
  near(pl.enterprises.cattle.income, 1265);
  near(pl.enterprises.cattle.expense, 3800);
  near(pl.enterprises.hunting.income, 5000);
  near(pl.net, 1265 + 5000 - 3800 - 300);
});

test('cattle unit costs', () => {
  const u = C.cattleUnitCosts({ cattleExpense: 10800, avgCows: 12, lbsWeaned: 5100 });
  near(u.costPerCow, 900);
  near(u.breakevenCwt, 10800 / 51);
});

test('brush retreatment and chore due dates', () => {
  const b = C.brushRow({ date: '2018-02-01', species: 'mesquite', acres: 40, cost: 3200 }, '2026-01-01');
  near(b.costPerAcre, 80);
  assert.equal(b.due, '2025-02-01');
  assert.equal(b.overdue, true);
  assert.equal(C.dueInfo('2026-09-01', 14, '2026-09-13').state, 'soon');
  assert.equal(C.dueInfo('2026-09-01', 14, '2026-09-20').state, 'overdue');
});

test('rotation summary', () => {
  const p = [{ id: 'p1', acres: 100 }, { id: 'p2', acres: 150 }];
  const g = [
    { pasture: 'p1', dateIn: '2026-01-01', dateOut: '2026-03-01', au: 12, score: 3 },
    { pasture: 'p2', dateIn: '2026-03-01', au: 12 },
  ];
  const [a, b] = C.rotationSummary(p, g, '2026-04-01');
  assert.equal(a.grazingNow, false);
  assert.equal(a.restDays, 31);
  assert.equal(a.daysGrazed, 59);
  near(a.auDays, 59 * 12);
  assert.equal(b.grazingNow, true);
  assert.equal(b.daysGrazed, 31);
});

test('seasonal template has deer openers on Saturdays', () => {
  const t = C.seasonalTemplate(2026);
  assert.ok(t.find((x) => x.date === '2026-11-07' && /General deer/.test(x.title)));
  assert.ok(t.find((x) => x.date === '2026-10-03' && /Archery/.test(x.title)));
  assert.ok(t.every((x, i) => i === 0 || t[i - 1].date <= x.date));
});
