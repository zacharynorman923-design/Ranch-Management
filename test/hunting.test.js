/* Hunting outlook: seasons, legal hours, and scoring by species. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as H from '../js/hunting.js';

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
