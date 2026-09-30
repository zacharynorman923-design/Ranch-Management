/* Hunting outlook: seasons, legal hours, and scoring by species. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as H from '../js/hunting.js';
import { moonAge, sunTimes } from '../js/calc.js';

const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);

// Camera times are ranch-local clock times, as on the phone.
process.env.TZ = 'America/Chicago';

const lat = 30.7488, lon = -99.2303;
// Local (Central) wall-clock time → epoch ms. CDT = UTC−5 until Nov 1, CST = UTC−6 after.
const ct = (iso, hh, mm = 0) => { const [y, m, d] = iso.split('-').map(Number); const off = iso < '2026-11-01' || (iso >= '2027-03-14' && iso < '2027-11-07') ? 5 : 6; return Date.UTC(y, m - 1, d, hh + off, mm); };

test('seasons: open, closed, next opening, no closed season for varmints', () => {
  assert.equal(H.seasonStatus('dove', '2026-09-30').open, true);
  assert.equal(H.seasonStatus('dove', '2026-11-15').open, false);
  assert.equal(H.seasonStatus('dove', '2026-11-15').next.start, '2026-12-11');
  const archery = H.seasonStatus('deer', '2026-10-24');
  assert.equal(archery.label, 'Archery only + Youth only');
  assert.equal(H.seasonStatus('deer', '2026-11-07').label, 'General season (North Zone)');
  assert.equal(H.seasonStatus('turkey', '2027-02-15').next.start, '2027-03-27');
  assert.equal(H.seasonStatus('turkey', '2027-06-01').expired, true);
  assert.equal(H.seasonStatus(null, '2026-07-01').always, true);
});

test('legal hours: 30 min before sunrise to 30 min after sunset; dove ends at sunset', () => {
  const t = ct('2026-11-15', 12);
  const deer = H.legalHours('game', lat, lon, t), dove = H.legalHours('sunset', lat, lon, t);
  assert.equal(deer.rise - deer.start, 30 * 60000);
  assert.equal(deer.end - deer.set, 30 * 60000);
  assert.equal(dove.end, dove.set);
  assert.equal(H.legalHours('any', lat, lon, t).any, true);
});

test('deer: cold rut morning after a front beats a hot midday', () => {
  const env = { lat, lon };
  const great = H.huntingOutlook('deer', { ...env, now: ct('2026-11-16', 7, 15), data: { tempf: 38, windspeedmph: 5 }, pressTrend: 0.05, dailyAvgTemps: [45, 48, 60, 62] });
  assert.equal(great.level, 'excellent');
  assert.ok(great.factors.some((f) => f.label === 'Rut'));
  assert.ok(great.factors.some((f) => f.label === 'Cold front'));
  const slow = H.huntingOutlook('deer', { ...env, now: ct('2026-11-16', 13), data: { tempf: 82, windspeedmph: 24 }, dailyAvgTemps: [75, 75, 74, 74] });
  assert.ok(slow.score < great.score - 40);
  assert.equal(H.huntingOutlook('deer', { ...env, now: ct('2026-08-10', 7), data: { tempf: 80 } }).level, 'closed');
  const late = H.huntingOutlook('deer', { ...env, now: ct('2026-11-16', 23), data: { tempf: 40 } });
  assert.equal(late.legalNow, false);
  assert.match(late.headline, /Outside legal shooting hours/);
  assert.match(H.huntingOutlook('turkey', { ...env, now: ct('2026-09-30', 8), data: {} }).headline, /Season closed/);
});

test('dove, turkey, varmints respond to wind, time and weather', () => {
  const env = { lat, lon };
  const dove = H.huntingOutlook('dove', { ...env, now: ct('2026-09-30', 18, 0), data: { tempf: 88, windspeedmph: 6 } });
  assert.ok(['good', 'excellent'].includes(dove.level), dove.level);
  const doveRain = H.huntingOutlook('dove', { ...env, now: ct('2026-09-30', 18), data: { tempf: 70, windspeedmph: 22, hourlyrainin: 0.3 } });
  assert.equal(doveRain.level, 'poor');
  const gobble = H.huntingOutlook('turkey', { ...env, now: ct('2027-04-10', 7, 30), data: { tempf: 52, windspeedmph: 3, solarradiation: 50 }, pressTrend: 0 });
  assert.equal(gobble.level, 'excellent');
  const hogNight = H.huntingOutlook('hog', { ...env, now: ct('2026-07-20', 23), data: { tempf: 88, windspeedmph: 6, dailyrainin: 0.4 } });
  assert.ok(hogNight.score >= 70, String(hogNight.score));
  assert.equal(hogNight.season.always, true);
  const yoteWindy = H.huntingOutlook('coyote', { ...env, now: ct('2027-01-10', 13), data: { tempf: 90, windspeedmph: 25 } });
  assert.equal(yoteWindy.level, 'poor');
  const cat = H.huntingOutlook('bobcat', { ...env, now: ct('2027-01-10', 7, 20), data: { tempf: 35, windspeedmph: 4 } });
  assert.equal(cat.level, 'excellent');
  const storm = H.huntingOutlook('hog', { ...env, now: ct('2026-07-20', 21), data: { lightning_time: ct('2026-07-20', 20, 50), lightning_distance: 3 } });
  assert.equal(storm.level, 'unsafe');
});

import * as P from '../js/huntplan.js';

test('forecast: parse Open-Meteo, conditions at a sit time, front from a 24-hour drop', () => {
  const t0 = Date.UTC(2026, 10, 14, 0);
  const n = 24 * 6;
  const json = { hourly: {
    time: Array.from({ length: n }, (_, i) => t0 / 1000 + i * 3600),
    temperature_2m: Array.from({ length: n }, (_, i) => (i < 72 ? 70 : 48)), // front lands at hour 72
    relative_humidity_2m: Array(n).fill(60), precipitation_probability: Array(n).fill(10), precipitation: Array(n).fill(0),
    cloud_cover: Array(n).fill(20), wind_speed_10m: Array(n).fill(6), wind_direction_10m: Array(n).fill(350), wind_gusts_10m: Array(n).fill(12),
    pressure_msl: Array.from({ length: n }, (_, i) => 1010 + (i >= 70 ? (i - 70) * 0.5 : 0)),
  } };
  const hours = P.forecastHours(json);
  assert.equal(hours.length, n);
  assert.equal(hours[0].pressInHg, 29.83);
  const c = P.conditionsAt(hours, t0 + 80 * 3600e3);
  assert.equal(c.tempChange24h, -22);
  assert.ok(c.pressTrend > 0.03);
  const o = H.huntingOutlook('deer', { lat, lon, now: ct('2026-11-17', 7, 30), data: c.data, pressTrend: c.pressTrend, tempChange24h: c.tempChange24h, cloud: c.cloud });
  assert.ok(o.factors.some((f) => f.label === 'Cold front' && /colder than this time yesterday/.test(f.note)));
  assert.equal(P.conditionsAt(hours, t0 + 400 * 3600e3), null); // beyond the forecast
  const sits = P.planSits('deer', hours, { lat, lon, now: t0 + 60 * 3600e3, days: 3 });
  assert.ok(sits.length >= 4);
  assert.ok(sits.every((x) => ['AM', 'PM'].includes(x.session) && x.outlook.score >= 0));
});

test('solunar: full moon rises near sunset; periods are 2 h major / 1 h minor', () => {
  // Scan for a full moon (age ≈ 14.8 days) in Oct–Nov 2026.
  let full = null;
  for (let t = Date.UTC(2026, 9, 1, 18); t < Date.UTC(2026, 10, 15); t += 3600e3) if (Math.abs(moonAge(t) - 14.77) < 0.3) { full = t; break; }
  assert.ok(full, 'found a full moon');
  const s = P.solunarDay(lat, lon, full);
  assert.ok(s.illumination > 95, String(s.illumination));
  const sun = sunTimes(lat, lon, full);
  assert.ok(s.rise && Math.abs(s.rise - sun.set) < 2 * 3600e3, `moonrise ${new Date(s.rise).toISOString()} vs sunset ${new Date(sun.set).toISOString()}`);
  assert.ok(s.periods.some((p) => p.major));
  for (const p of s.periods) assert.equal((p.end - p.start) / 60000, p.major ? 120 : 60);
  // Moon overhead is about 12 h from underfoot.
  near(Math.abs(s.transit - s.underfoot) / 3600e3, 12.4, 1.2);
});

test('camera activity windows, stands by wind, and what worked', () => {
  const today = new Date(2026, 10, 20);
  const photos = [
    ...['19:05', '19:20', '19:30', '19:45', '18:55'].map((time, i) => ({ date: `2026-11-${10 + i}`, time, device: 'c1', tags: ['doe'] })),
    { date: '2026-11-15', time: '07:10', device: 'c2', tags: ['buck'] },
    { date: '2026-11-15', time: '07:30', device: 'c2', tags: ['hog'] },
    { date: '2026-10-01', time: '19:00', device: 'c1', tags: ['doe'] }, // too old
  ];
  const act = H.cameraActivity(photos, 'deer', { today, cameraName: (x) => ({ c1: 'Feeder cam', c2: 'Creek cam' }[x]) });
  assert.equal(act.total, 6);
  assert.equal(act.cameras[0].name, 'Feeder cam');
  assert.ok(act.cameras[0].window.start <= 18 * 60 + 55 && act.cameras[0].window.end >= 19 * 60 + 45);
  const eve = H.huntingOutlook('deer', { lat, lon, now: ct('2026-11-20', 19, 15), data: { tempf: 50, windspeedmph: 5 }, activity: act });
  assert.ok(eve.factors.some((f) => f.label === 'Your cameras' && f.pts > 0 && /Feeder cam/.test(f.note)));
  const noon = H.huntingOutlook('deer', { lat, lon, now: ct('2026-11-20', 12, 30), data: { tempf: 50, windspeedmph: 5 }, activity: act });
  assert.ok(noon.factors.some((f) => f.label === 'Your cameras' && f.pts < 0));

  assert.equal(H.compass8(190), 'S');
  assert.deepEqual(H.parseWinds('S, sw and W'), ['S', 'SW', 'W']);
  const stands = [{ name: 'Creek', winds: 'S, SW', camera: 'c2', species: 'deer' }, { name: 'North', winds: 'N, NE' }, { name: 'Hog blind', winds: 'S', species: 'hog' }];
  const rec = H.recommendStands(stands, { key: 'deer', winddir: 200, activity: act });
  assert.equal(rec[0].stand.name, 'Creek');
  assert.ok(rec[0].ok);
  assert.equal(rec.at(-1).stand.name, 'North');
  assert.ok(!rec.some((r) => r.stand.name === 'Hog blind'));
  assert.ok(H.recommendStands(stands, { key: 'deer', winddir: 250 })[0].why.some((w) => /marginal/.test(w)));

  const hunts = [
    { species: 'deer', seen: 8, session: 'AM', standName: 'Creek', cond: { dir: 'N', wind: 5, tempf: 40, front: true } },
    { species: 'deer', seen: 6, session: 'AM', standName: 'Creek', cond: { dir: 'N', wind: 6, tempf: 42, front: true } },
    { species: 'deer', seen: 1, session: 'PM', standName: 'North', cond: { dir: 'S', wind: 18, tempf: 78, front: false } },
    { species: 'deer', seen: 2, session: 'PM', standName: 'North', cond: { dir: 'S', wind: 12, tempf: 70, front: false } },
    { species: 'hog', seen: 5 },
  ];
  const ins = H.huntInsights(hunts, 'deer');
  assert.equal(ins.n, 4);
  assert.equal(ins.avg, 4.25);
  const wind = ins.groups.find((g) => g.label === 'Wind direction');
  assert.deepEqual(wind.rows.map((r) => [r.k, r.avg]), [['N', 7], ['S', 1.5]]);
  assert.ok(ins.groups.some((g) => g.label === 'After a front'));
});
