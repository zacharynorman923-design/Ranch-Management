/* A believable sample year for a 250-acre Mason County place, built around
   today's date so every screen has something to show. Every record carries
   sample: true so it can be removed in one step. */
import * as db from './db.js';
import * as C from './calc.js';
import { MASON_NORMALS } from './calc.js';

let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const pickInt = (a, b) => Math.round(a + rnd() * (b - a));
const pad = (n) => String(n).padStart(2, '0');

export async function loadSample() {
  seed = 7;
  const t = C.today();
  const Y = C.yearOf(t);
  const past = (d) => d <= t;
  const R = {};
  const add = (col, rec) => { (R[col] ||= []).push({ ...rec, id: rec.id || db.uid(), sample: true }); return R[col][R[col].length - 1]; };

  /* rain: ~70% of normal lately so the destock trigger shows */
  for (let i = 20; i >= 0; i--) {
    const ym = C.shiftYM(C.ymOf(t), -i);
    const [y, m] = ym.split('-').map(Number);
    const target = MASON_NORMALS[m - 1] * (i < 12 ? 0.62 : 0.95);
    const n = pickInt(1, 3);
    for (let k = 0; k < n; k++) {
      const d = `${ym}-${pad(pickInt(2, 27))}`;
      if (!past(d)) continue;
      add('rain', { date: d, inches: Math.round((target / n) * (0.5 + rnd()) * 100) / 100, gauge: 'Headquarters' });
    }
  }

  /* pastures + rotation */
  const P = ['North trap|90', 'Creek pasture|70', 'South pasture|90'].map((x) => { const [name, acres] = x.split('|'); return add('pastures', { name, acres: Number(acres), water: '' }); });
  let d = `${Y - 1}-01-05`;
  for (let i = 0; d < t; i++) {
    const out = C.addDays(d, pickInt(35, 55));
    add('grazings', { pasture: P[i % 3].id, dateIn: d, dateOut: out < t ? out : '', head: 13, au: 13.35, score: out < t ? String(pickInt(2, 4)) : '' });
    d = out;
  }

  /* herd: 12 cows + a bull, two calf crops */
  const cows = Array.from({ length: 12 }, (_, i) => add('animals', { tag: String(101 + i), cls: 'cow', breed: i % 3 ? 'Angus x Hereford' : 'Brangus', birthDate: `${Y - 4 - (i % 5)}-03-${pad(1 + i)}` }));
  add('animals', { tag: 'B1', cls: 'bull', breed: 'Angus', purchaseDate: `${Y - 3}-04-10`, purchasePrice: 4500, seller: 'Sample Bull Test' });
  for (const crop of [Y - 1, Y]) {
    for (const c of cows) add('events', { animal: c.id, type: 'expose', date: `${crop - 1}-05-01`, crop });
    cows.forEach((c, i) => add('events', { animal: c.id, type: 'preg', date: `${crop - 1}-09-15`, crop, result: i === (crop % 12) ? 'open' : 'bred' }));
    cows.forEach((c, i) => {
      if (i === (crop % 12) || (crop === Y && i === 5)) return; // open cow, one lost calf
      const bd = `${crop}-0${2 + (i % 2)}-${pad(3 + i * 2)}`;
      if (!past(bd)) return;
      const calf = add('animals', { tag: `${String(crop).slice(2)}${pad(i + 1)}`, cls: 'calf', dam: c.id, birthDate: bd, birthWeight: pickInt(68, 82), breed: c.breed });
      add('events', { animal: calf.id, type: 'vaccinate', date: `${crop}-04-20`, product: '7-way clostridial + IBR/BVD MLV' });
      const wd = `${crop}-10-01`;
      if (past(wd)) {
        const w = pickInt(470, 560);
        add('events', { animal: calf.id, type: 'wean', date: wd, weight: w });
        const sd = `${crop}-10-15`;
        if (past(sd)) add('events', { animal: calf.id, type: 'sale', date: sd, weight: w + 10, price: pickInt(285, 330), buyer: 'Sample Livestock Auction' });
      }
    });
    const open = cows[crop % 12];
    if (crop === Y - 1) add('events', { animal: open.id, type: 'sale', date: `${crop - 1}-10-20`, weight: 1180, price: 128, buyer: 'Sample Livestock Auction' });
  }
  for (const c of cows) add('events', { animal: c.id, type: 'vaccinate', date: `${Y}-04-20`, product: 'Lepto-5 / Vibrio' });
  // Replace the cow sold as open, so the herd stays at 12.
  const rep = add('animals', { tag: '113', cls: 'bred heifer', breed: 'Angus x Hereford', purchaseDate: `${Y - 2}-11-02`, purchasePrice: 2600, seller: 'Neighbor' });
  add('events', { animal: rep.id, type: 'expose', date: `${Y - 1}-05-01`, crop: Y });

  /* wildlife */
  const censusY = C.monthOf(t) >= 8 ? Y : Y - 1;
  for (const [i, dd] of [`${censusY}-08-12`, `${censusY}-08-19`, `${censusY}-08-26`].entries()) {
    if (past(dd)) add('surveys', { date: dd, route: 'Main route', miles: 4.2, width: 180, bucks: 4 + i, does: 13 + i * 2, fawns: 5 - i, unknown: 2 });
  }
  const s0 = `${Y - 1}`;
  [['buck', '5.5', 142, 138.5], ['buck', '3.5', 118, 104], ['doe', '2.5', 78], ['doe', '3.5', 84], ['doe', '1.5', 66], ['doe', '4.5', 88]]
    .forEach(([sex, age, weight, score], i) => add('harvests', { date: `${s0}-${i < 3 ? '11' : '12'}-${pad(8 + i * 3)}`, sex, age, weight, weightType: 'field-dressed', score: score || '', hunter: i % 2 ? 'Lessee' : 'Owner', stand: ['Creek blind', 'North tower', 'South feeder'][i % 3] }));
  const HQ = { lat: 30.7488, lon: -99.2303 };
  const at = (dx, dy) => ({ lat: +(HQ.lat + dy).toFixed(6), lon: +(HQ.lon + dx).toFixed(6) });
  const devs = [
    add('devices', { name: 'Creek cam', type: 'camera', loc: at(0.004, -0.003), batteryDate: C.addDays(t, -80), batteryDays: 90 }),
    add('devices', { name: 'North feeder', type: 'feeder', loc: at(0.001, 0.005), batteryDate: C.addDays(t, -40), batteryDays: 120, refillDate: C.addDays(t, -19), refillDays: 21, feed: 'Corn' }),
    add('devices', { name: 'Protein feeder', type: 'protein', loc: at(-0.004, 0.001), batteryDate: C.addDays(t, -30), batteryDays: 180, refillDate: C.addDays(t, -9), refillDays: 28, feed: '20% protein pellets' }),
    add('devices', { name: 'Tank sensor', type: 'sensor', loc: at(0.002, -0.001), batteryDate: C.addDays(t, -200), batteryDays: 365 }),
  ];
  for (let k = 1; k <= 8; k++) add('devicelog', { device: devs[1].id, date: C.addDays(t, -19 - (k - 1) * 21), action: 'refill', qty: 300 });
  const dove = add('dovefields', { name: 'Milo field', acres: 12, crop: 'milo', hybrid: 'Early-maturing grain sorghum', plantDate: `${Y}-04-28`, daysToMaturity: 100, seedRate: 5, loc: at(-0.002, -0.004) });
  if (past(`${Y}-09-01`)) add('dovehunts', { date: `${Y}-09-01`, field: dove.id, hunters: 6, birds: 71 });
  if (past(`${Y}-09-06`)) add('dovehunts', { date: `${Y}-09-06`, field: dove.id, hunters: 4, birds: 38 });

  /* land & water */
  const W = [
    add('waterpoints', { name: 'Stock tank', type: 'tank', pasture: P[1].id, sensor: true, loc: at(0.002, -0.001) }),
    add('waterpoints', { name: 'HQ trough', type: 'trough', pasture: P[0].id, loc: at(0, 0) }),
    add('waterpoints', { name: 'Aermotor windmill', type: 'windmill', pasture: P[2].id, loc: at(-0.003, -0.005) }),
    add('waterpoints', { name: 'Wildlife guzzler', type: 'guzzler', loc: at(-0.005, 0.004) }),
  ];
  for (let k = 0; k < 10; k++) add('waterchecks', { point: W[0].id, date: C.addDays(t, -k * 3), level: 64 - k * 1.5 + k * 0.4, working: 'yes', source: 'sensor' });
  add('waterchecks', { point: W[1].id, date: C.addDays(t, -4), level: 90, working: 'yes', source: 'visit' });
  add('waterchecks', { point: W[2].id, date: C.addDays(t, -12), level: 70, working: 'no', source: 'neighbor', notes: 'Sucker rod leathers worn — pumping slow' });
  add('waterwork', { point: W[2].id, date: `${Y - 1}-06-14`, work: 'Replaced leathers and check valve', cost: 850, nextDue: `${Y}-06-14` });
  add('waterwork', { point: W[3].id, date: `${Y}-03-09`, work: 'Installed 1,000-gal wildlife guzzler with walk-in ramp', cost: 2100, wildlife: true });
  add('brush', { date: `${Y - 9}-01-20`, area: 'North trap', species: 'cedar', method: 'mechanical', acres: 30, cost: 7500, costShare: 3750, retreatYears: 10, loc: at(0.001, 0.004) });
  add('brush', { date: `${Y - 1}-06-10`, area: 'Creek pasture', species: 'mesquite', method: 'ipt', acres: 20, cost: 1400, retreatYears: 7, loc: at(0.003, -0.002) });
  add('brush', { date: `${Y}-02-15`, area: 'South pasture', species: 'cedar', method: 'hand', acres: 15, cost: 2250, retreatYears: 10, loc: at(-0.002, -0.003) });
  const F = [
    add('fences', { name: 'North boundary — county road', kind: 'segment', length: 3300, material: '5-strand barbed', boundary: true }),
    add('fences', { name: 'Creek water gap', kind: 'watergap', material: 'Cable + hog panels' }),
    add('fences', { name: 'Front gate', kind: 'gate', material: '16 ft pipe', lock: 'combo on file', loc: at(0.0005, 0.006) }),
    add('fences', { name: 'South cross fence', kind: 'segment', length: 2600, material: '5-strand barbed' }),
  ];
  add('fencelog', { fence: F[0].id, date: `${Y}-03-02`, condition: '4', work: 'Tightened 2 spans' });
  add('fencelog', { fence: F[1].id, date: C.addDays(t, -30), condition: '2', work: 'Washed out after storm — temp panel', cost: 180 });
  add('fencelog', { fence: F[3].id, date: `${Y}-01-15`, condition: '3' });

  /* compliance */
  add('practices', { date: `${Y}-02-20`, practice: 'predator', activity: 'Trapped feral hogs at creek', qty: '9 hogs', cost: 0 });
  const season = `${Y}-${pad((Y + 1) % 100)}`;
  add('leases', { lessee: 'Sample Hunting Group', season, enterprise: 'hunting', hunters: 3, fee: 6250, paidDate: `${Y}-08-01`, insurer: 'Sample Insurance Co.', policy: 'HL-000000', coverage: 1000000, insExpires: C.addDays(t, 20), bucks: 2, does: 6, signed: true });
  add('leases', { lessee: 'Sample Hunting Group', season: `${Y - 1}-${pad(Y % 100)}`, enterprise: 'hunting', hunters: 3, fee: 6000, paidDate: `${Y - 1}-08-01`, insExpires: `${Y}-08-31`, bucks: 2, does: 6, signed: true });
  add('nrcs', { contract: `74XX-${Y - 1}-001`, program: 'EQIP', code: '614', description: 'Watering facility (trough + pipeline)', units: '1 ea', due: `${Y}-06-30`, done: `${Y}-05-20`, payment: 3200, paidDate: `${Y}-07-15` });
  add('nrcs', { contract: `74XX-${Y - 1}-001`, program: 'EQIP', code: '314', description: 'Brush management — cedar, South pasture', units: '40 ac', due: `${Y + 1}-03-31`, payment: 6400 });
  add('nrcs', { contract: `74XX-${Y - 1}-001`, program: 'EQIP', code: '528', description: 'Prescribed grazing — rotation records', units: '250 ac', due: C.addDays(t, 45), payment: 1100 });

  /* money */
  for (const y of [Y - 1, Y]) {
    const L = [
      ['cattle', 'Hay', 2400, '02-10'], ['cattle', 'Feed / cubes', 1800, '01-15'], ['cattle', 'Mineral', 650, '04-01'],
      ['cattle', 'Vet & medicine', 900, '04-20'], ['cattle', 'Fuel', 700, '06-30'], ['cattle', 'Trucking', 450, '10-15'], ['cattle', 'Commission', 380, '10-15'],
      ['hunting', 'Deer feed', 2100, '09-01'], ['hunting', 'Protein', 1500, '06-01'], ['hunting', 'Game cameras', 300, '08-15'],
      ['dove', 'Seed', 180, '04-25'], ['dove', 'Fuel', 220, '08-10'],
      ['overhead', 'Insurance', 1900, '01-05'], ['overhead', 'Property tax', 850, '01-25'], ['overhead', 'Equipment', 1200, '05-05'],
    ];
    for (const [enterprise, category, amount, md] of L) if (past(`${y}-${md}`)) add('ledger', { date: `${y}-${md}`, kind: 'expense', enterprise, category, amount: Math.round(amount * (0.9 + rnd() * 0.2)) });
  }

  /* ops */
  for (const x of C.seasonalTemplate(Y)) add('tasks', { ...x, done: x.date < C.addDays(t, -10) });
  add('contacts', { name: 'Large-animal vet (sample)', role: 'Veterinarian', phone: '325-555-0100' });
  add('contacts', { name: 'Mason CAD (verify number)', role: 'Mason CAD', notes: 'Ask for the ag/wildlife degree-of-intensity standard and annual report deadline.' });
  add('contacts', { name: 'NRCS field office (sample)', role: 'NRCS', phone: '325-555-0102' });
  add('contacts', { name: 'Neighbor who checks water (sample)', role: 'Neighbor', phone: '325-555-0103' });

  for (const [col, recs] of Object.entries(R)) await db.putMany(col, recs);
  const s = db.settings();
  const ring = [[-0.0062, 0.0068], [0.0058, 0.0071], [0.0064, -0.0012], [0.0049, -0.0066], [-0.0055, -0.0069], [-0.0066, 0.0004], [-0.0062, 0.0068]]
    .map(([dx, dy]) => [+(HQ.lon + dx).toFixed(6), +(HQ.lat + dy).toFixed(6)]);
  const patch = s.boundary ? {} : { boundary: { type: 'Feature', properties: { sample: true }, geometry: { type: 'Polygon', coordinates: [ring] } } };
  if (!s.owner) Object.assign(patch, { owner: 'Sample Owner', ranchName: 'Sample — Mason County place', cadAccount: 'R000000' });
  await db.saveSettings(patch);
}

export async function removeSample() {
  const cols = ['rain', 'pastures', 'grazings', 'animals', 'events', 'surveys', 'harvests', 'devices', 'devicelog', 'dovefields', 'dovehunts', 'waterpoints', 'waterchecks', 'waterwork', 'brush', 'fences', 'fencelog', 'practices', 'leases', 'nrcs', 'ledger', 'tasks', 'contacts'];
  let n = 0;
  for (const c of cols) {
    const ids = db.all(c).filter((x) => x.sample).map((x) => x.id);
    if (ids.length) await db.delMany(c, ids);
    n += ids.length;
  }
  if (db.settings().boundary?.properties?.sample) await db.saveSettings({ boundary: null });
  return n;
}
