/* Individual bucks and the Jacobson camera census. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../js/deer.js';

// Photo times are ranch-local clock times, as on the phone.
process.env.TZ = 'America/Chicago';

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);

test('deer counts from AI labels and your tags', () => {
  const labels = { animals: [
    { species: 'white-tailed deer', sex: 'doe', count: 3 }, { species: 'white-tailed deer', sex: 'fawn', count: 2 },
    { species: 'white-tailed deer', sex: 'buck', count: 1 }, { species: 'white-tailed deer', sex: 'unknown', count: 1 },
    { species: 'white-tailed deer', sex: 'doe', count: 1, id_confidence: 'low' }, { species: 'feral hog', count: 4 },
  ] };
  assert.deepEqual(D.deerCounts(labels), { buck: 1, doe: 3, fawn: 2, deer: 1 });
  assert.deepEqual(D.photoDeer({ aiCounts: { doe: 3, fawn: 2 }, aiTags: 'doe, fawn' }), { buck: 0, doe: 3, fawn: 2, deer: 0 });
  assert.deepEqual(D.photoDeer({ tags: 'buck', aiCounts: { doe: 3 } }), { buck: 1, doe: 0, fawn: 0, deer: 0 }); // your tag wins
  assert.deepEqual(D.photoDeer({ aiTags: 'doe, fawn' }), { buck: 0, doe: 1, fawn: 1, deer: 0 });
});

test('camera census: Jacobson factor and 10/14-day correction', () => {
  assert.equal(D.censusCorrection(14), 1.11);
  assert.equal(D.censusCorrection(21), 1.11);
  assert.equal(D.censusCorrection(10), 1.18);
  assert.equal(D.censusCorrection(12), 1.145);
  // 5 unique bucks in 20 buck occurrences → factor 0.25; 60 doe and 30 fawn occurrences.
  const photos = [
    ...Array.from({ length: 20 }, (_, i) => ({ aiCounts: { buck: 1 }, buck: i < 18 ? 'b' : '' })),
    ...Array.from({ length: 30 }, () => ({ aiCounts: { doe: 2, fawn: 1 } })),
  ];
  const c = D.cameraCensus({ photos, uniqueBucks: 5, days: 14, acres: 250 });
  assert.deepEqual(c.occ, { buck: 20, doe: 60, fawn: 30, deer: 0 });
  assert.equal(c.factor, 0.25);
  near(c.est.bucks, 5.55); near(c.est.does, 16.65); near(c.est.fawns, 8.325);
  near(c.est.total, 30.525);
  near(c.acresPerDeer, 250 / 30.525);
  assert.equal(c.doesPerBuck, 3);
  assert.equal(c.fawnsPerDoe, 0.5);
  assert.equal(c.unidentified, 2);
  assert.equal(D.cameraCensus({ photos, uniqueBucks: 0, days: 14 }).est, null);
});

test('buck pattern: cameras, peak hour, daylight share and recent daylight', () => {
  const lat = 30.7488, lon = -99.2303;
  const photos = [
    { date: '2026-11-10', time: '06:10', device: 'feeder' },  // before sunrise (~7 am CST)
    { date: '2026-11-12', time: '22:40', device: 'feeder' },
    { date: '2026-11-18', time: '09:30', device: 'creek' },   // daylight
    { date: '2026-11-19', time: '16:15', device: 'feeder' },  // daylight
  ];
  const pat = D.buckPattern(photos, { lat, lon, today: new Date(2026, 10, 20) });
  assert.equal(pat.sightings, 4);
  assert.equal(pat.first.date, '2026-11-10');
  assert.deepEqual(pat.cameras[0], { device: 'feeder', n: 3 });
  assert.equal(pat.daylightCount, 2);
  assert.equal(pat.daylight, 0.5);
  assert.equal(pat.recent, 2);
  assert.equal(pat.recentDaylight, 2);
});

test('census visits: bursts on one camera count once, at the most seen in any photo', () => {
  const ph = (id, device, time, counts, extra = {}) => ({ id, date: '2026-09-10', time, device, aiCounts: counts, ...extra });
  const photos = [
    ph('a1', 'feeder', '19:02', { doe: 2 }), ph('a2', 'feeder', '19:03', { doe: 3, fawn: 1 }), ph('a3', 'feeder', '19:06', { doe: 1 }), // one visit
    ph('b1', 'feeder', '19:30', { doe: 1 }),                               // new visit (gap 24 min)
    ph('c1', 'creek', '19:03', { buck: 1 }, { buck: 'big8' }), ph('c2', 'creek', '19:04', { buck: 1 }), // one visit, identified
    ph('d1', 'creek', '21:00', { buck: 1 }),                                // unidentified buck visit
  ];
  const v = D.censusVisits(photos, 5);
  assert.equal(v.length, 4);
  const feeder = v.find((x) => x.ids.includes('a1'));
  assert.deepEqual(feeder.ids, ['a1', 'a2', 'a3']);
  assert.deepEqual(feeder.counts, { buck: 0, doe: 3, fawn: 1, deer: 0 });
  const c = D.cameraCensus({ photos, uniqueBucks: 1, days: 14, gapMin: 5 });
  assert.deepEqual(c.occ, { buck: 2, doe: 4, fawn: 1, deer: 0 });
  assert.equal(c.visits, 4);
  assert.equal(c.unidentified, 1);
  assert.deepEqual(c.photosFor.unidentified, ['d1']);
  assert.deepEqual(c.photosFor.fawn, ['a1', 'a2', 'a3']);
  assert.deepEqual(c.visitOf.a2.ids, feeder.ids);
  // Every photo on its own: no grouping.
  assert.deepEqual(D.cameraCensus({ photos, uniqueBucks: 1, days: 14, gapMin: 0 }).occ, { buck: 3, doe: 7, fawn: 1, deer: 0 });
  // Your hand count wins.
  assert.deepEqual(D.photoDeer({ counts: { doe: 1 }, tags: 'doe, fawn', aiCounts: { doe: 4 } }), { buck: 0, doe: 1, fawn: 0, deer: 0 });
});

test('census review: a checked visit keeps your counts and bucks until it regroups', () => {
  const ids = ['a1', 'a2'];
  const review = { ids, counts: { doe: 1, fawn: 2 }, bucks: ['big8'] };
  const photos = [
    { id: 'a1', date: '2026-09-10', time: '19:02', device: 'feeder', aiCounts: { doe: 3 }, review },
    { id: 'a2', date: '2026-09-10', time: '19:04', device: 'feeder', aiCounts: { doe: 2, buck: 1 }, review },
  ];
  const [v] = D.censusVisits(photos, 5);
  assert.equal(v.reviewed, true);
  assert.deepEqual(v.counts, { buck: 0, doe: 1, fawn: 2, deer: 0 });
  assert.deepEqual([...v.bucks], ['big8']);
  assert.deepEqual([...D.censusBuckIds(photos)], ['big8']);
  // Every photo on its own: the review no longer matches, so the AI counts are used.
  const split = D.censusVisits(photos, 0);
  assert.equal(split.length, 2);
  assert.ok(split.every((x) => !x.reviewed));
  assert.equal(split.find((x) => x.ids[0] === 'a1').counts.doe, 3);
});
