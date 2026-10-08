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

test('auto-sort plan: file high matches, suggest medium, provisional bucks for new groups', () => {
  const result = {
    photos: [
      { photo: 1, antlers_visible: true, rack: '8 pts', group: 'big8', confidence: 'high' },
      { photo: 2, antlers_visible: true, rack: '8 pts?', group: 'big8', confidence: 'medium' },
      { photo: 3, antlers_visible: true, rack: 'tall 10', group: 'new1', confidence: 'high' },
      { photo: 4, antlers_visible: true, rack: 'tall 10', group: 'new1', confidence: 'medium' },
      { photo: 5, antlers_visible: true, rack: 'spike', group: 'new2', confidence: 'low' },
      { photo: 6, antlers_visible: false, rack: '', group: 'unsure', confidence: 'low' },
    ],
    new_bucks: [{ group: 'new1', name: 'Tall 10', rack: 'tall 10, long G2s', best_photo: 4 }, { group: 'new2', name: 'Spike', rack: 'spike', best_photo: 5 }],
  };
  const plan = D.planBuckSort(result, ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'], ['big8']);
  assert.deepEqual(plan.assign, [{ id: 'p1', buck: 'big8', confidence: 'high' }]);
  assert.deepEqual(plan.suggest, [{ id: 'p2', buck: 'big8', confidence: 'medium' }]);
  assert.equal(plan.newBucks.length, 1); // the low-confidence spike doesn't become a buck
  assert.deepEqual(plan.newBucks[0], { group: 'new1', name: 'Tall 10', rack: 'tall 10, long G2s', refId: 'p4', photoIds: ['p3', 'p4'] });
  assert.equal(plan.rack.p5, 'spike');
});

test('auto-sort plan: two bucks in one photo go to both', () => {
  const plan = D.planBuckSort({
    photos: [
      { photo: 1, antlers_visible: true, bucks: [{ group: 'big8', rack: '8', confidence: 'high' }, { group: 'new1', rack: 'tall 10', confidence: 'high' }] },
      { photo: 2, antlers_visible: true, bucks: [{ group: 'new1', rack: 'tall 10', confidence: 'medium' }] },
    ],
    new_bucks: [{ group: 'new1', name: 'Tall 10', rack: 'tall 10', best_photo: 2 }],
  }, ['p1', 'p2'], ['big8']);
  assert.deepEqual(plan.assign, [{ id: 'p1', buck: 'big8', confidence: 'high' }]);
  assert.deepEqual(plan.newBucks[0].photoIds, ['p1', 'p2']);
  assert.equal(plan.rack.p1, '8 + tall 10');
  // Helpers
  const p = D.withBucks({ id: 'x' }, ['big8', 'tall', 'big8']);
  assert.deepEqual([p.buck, p.bucks], ['big8', ['big8', 'tall']]);
  assert.deepEqual(D.photoBucks({ buck: 'a', bucks: ['b'] }), ['a', 'b']);
  assert.ok(D.hasBuck({ buck: '', bucks: ['b'] }, 'b'));
  // Census: 2 bucks counted but 1 named is still unidentified
  const c = D.cameraCensus({ photos: [{ id: 'v1', aiCounts: { buck: 2 }, buck: 'big8' }], uniqueBucks: 1, days: 14 });
  assert.equal(c.unidentified, 1);
  const c2 = D.cameraCensus({ photos: [{ id: 'v1', aiCounts: { buck: 2 }, buck: 'big8', bucks: ['big8', 'tall'] }], uniqueBucks: 2, days: 14 });
  assert.equal(c2.unidentified, 0);
});

test('buck names and racks drop lighting/weather words; duplicate plan keeps the confirmed buck', () => {
  assert.equal(D.cleanBuckName('Night Kicker 9'), 'Kicker 9');
  assert.equal(D.cleanBuckName('Foggy Tall 10'), 'Tall 10');
  assert.equal(D.cleanBuckName('IR Wide 6 (night)'), 'Wide 6');
  assert.equal(D.cleanBuckName('Drop Tine'), 'Drop Tine');
  assert.equal(D.cleanBuckName('Split Brow 8'), 'Split Brow 8');
  assert.equal(D.cleanBuckName('Night'), 'Buck');
  assert.equal(D.cleanBuckName('Night 9'), '9 Point');
  assert.equal(D.cleanRack('tall 10, long G2s, foggy morning'), 'tall 10, long G2s');
  assert.equal(D.cleanRack('kicker off right G2, IR night'), 'kicker off right G2');
  assert.equal(D.cleanRack('main-frame 8, split left brow'), 'main-frame 8, split left brow');

  const bucks = [{ id: 'a', auto: true }, { id: 'b', auto: false }, { id: 'c', auto: true }, { id: 'd', auto: true, notSame: ['c'] }];
  const counts = { a: 9, b: 2, c: 5, d: 1 };
  const plan = D.planDedupe([
    { keep: 'a', merge: 'b', confidence: 'medium', reason: 'x' }, // b is confirmed, so keep b
    { keep: 'c', merge: 'd', confidence: 'high', reason: 'y' },   // you said not the same
    { keep: 'a', merge: 'c', confidence: 'high', reason: 'z' },   // a has more photos
    { keep: 'c', merge: 'a', confidence: 'high', reason: 'dup' }, // same pair again
    { keep: 'a', merge: 'gone', confidence: 'high', reason: '' },
  ], bucks, (id) => counts[id]);
  assert.deepEqual(plan.map((p) => [p.keep, p.merge]), [['a', 'c'], ['b', 'a']]);
});

test('which buck is where: boxes, place words and labels', () => {
  assert.deepEqual(D.normBox([40, 300, 380, 500]), [0.04, 0.3, 0.38, 0.5]);
  assert.deepEqual(D.normBox([0.5, 0.2, 0.3, 0.4]), [0.5, 0.2, 0.3, 0.4]);
  assert.equal(D.normBox([1, 2, 3]), null);
  assert.equal(D.normBox([990, 990, 5, 5]), null);
  const plan = D.planBuckSort({ photos: [{ photo: 1, antlers_visible: true, bucks: [
    { group: 'big8', rack: '8', where: 'left', box: [40, 300, 380, 500], confidence: 'high' },
    { group: 'new1', rack: 'tall 10', where: 'right, behind', box: [600, 250, 300, 450], confidence: 'high' },
  ] }], new_bucks: [{ group: 'new1', name: 'Tall 10', rack: 'tall 10', best_photo: 1 }] }, ['p1'], ['big8']);
  assert.deepEqual(plan.spots.p1.big8, { where: 'left', box: [0.04, 0.3, 0.38, 0.5] });
  assert.equal(plan.spots.p1.new1.where, 'right, behind');
  const p = { buck: 'a', bucks: ['a', 'b'], buckSpots: { a: { where: 'left' }, b: { box: [0.7, 0.2, 0.2, 0.3] } } };
  assert.equal(D.buckWhere(p, 'b'), 'right');
  const names = { a: 'Big 8', b: 'Tall 10' };
  assert.equal(D.bucksLabel(p, (id) => names[id]), 'Big 8 (left) + Tall 10 (right)');
  assert.equal(D.bucksLabel({ buck: 'a', buckSpots: { a: { where: 'left' } } }, (id) => names[id]), 'Big 8'); // one buck: no place needed
});

test('start over: clears the AI work, keeps yours unless asked', () => {
  const bucks = [{ id: 'big8', name: 'Big 8' }, { id: 'auto1', name: 'Tall 10', auto: true }];
  const photos = [
    { id: 'p1', buck: 'auto1', bucks: ['auto1'], buckAuto: true, buckSortAt: 't', buckRack: 'tall 10', buckSpots: { auto1: { where: 'left', by: 'ai' } } },
    { id: 'p2', buck: 'big8', bucks: ['big8'], buckSortAt: 't', buckSpots: { big8: { where: 'right', by: 'you' } }, review: { ids: ['p2'] }, counts: { buck: 1 } },
    { id: 'p3', buck: 'big8', bucks: ['big8'], buckAuto: true },           // the AI filed this under your buck
    { id: 'p4', buckAI: { match: 'big8' } },
    { id: 'p5' },
  ];
  const r = D.planReset(bucks, photos);
  assert.deepEqual(r.removeBucks, ['auto1']);
  assert.deepEqual(r.keepBucks, ['big8']);
  const by = Object.fromEntries(r.patches.map((x) => [x.id, x.patch]));
  assert.deepEqual(by.p1, { buck: '', bucks: [], buckAuto: false, buckSortAt: null, buckRack: null, buckSpots: null });
  assert.deepEqual(by.p2, { buckSortAt: null }); // your tag, your place and your census check stay
  assert.deepEqual(by.p3, { buck: '', bucks: [], buckAuto: false });
  assert.deepEqual(by.p4, { buckAI: null });
  assert.equal(by.p5, undefined);
  const all = D.planReset(bucks, photos, { confirmed: true, reviews: true });
  assert.deepEqual(all.removeBucks, ['big8', 'auto1']);
  const p2 = all.patches.find((x) => x.id === 'p2').patch;
  assert.deepEqual(p2, { buck: '', bucks: [], buckSortAt: null, buckSpots: null, review: null, counts: null });
});

test('auto-sort batches: whole visits, newest first, shots in order', () => {
  const ph = (id, device, time, date = '2026-10-05') => ({ id, device, date, time });
  const photos = [
    ph('a3', 'cam1', '06:46'), ph('a1', 'cam1', '06:40'), ph('a2', 'cam1', '06:43'), // one visit
    ph('b1', 'cam2', '06:41'), ph('b2', 'cam2', '06:44'), // another camera
    ph('c1', 'cam1', '19:10'), // later visit, same camera
    ph('d1', 'cam1', '07:30', '2026-10-04'),
  ];
  const bs = D.sortBatches(photos, { max: 5 });
  assert.deepEqual(bs[0], { ids: ['c1', 'a1', 'a2', 'a3'], visits: [1, 2, 2, 2] });
  // b's visit wouldn't fit after a's: it starts the next batch rather than splitting.
  assert.deepEqual(bs[1], { ids: ['b1', 'b2', 'd1'], visits: [1, 1, 2] });
  // A visit bigger than a batch goes alone, cut into pieces of `hard`.
  const big = Array.from({ length: 7 }, (_, i) => ph(`x${i}`, 'cam1', `08:0${i}`));
  const bb = D.sortBatches(big, { max: 4, hard: 5 });
  assert.deepEqual(bb.map((b) => b.ids.length), [5, 2]);
  assert.deepEqual(bb[0].ids, ['x0', 'x1', 'x2', 'x3', 'x4']);
});

test('buck carries through a one-buck visit, not past a second buck or your no', () => {
  const ph = (id, time, extra = {}) => ({ id, device: 'cam1', date: '2026-10-05', time, tags: 'buck', ...extra });
  const photos = [
    ph('p1', '06:40', { buck: 'b1', bucks: ['b1'] }),
    ph('p2', '06:42', { buckAI: { match: 'unsure' } }),
    ph('p3', '06:43'),
    ph('p4', '06:44', { buckAI: { match: 'rejected' } }),
    ph('p5', '07:30'), // its own visit
    // A visit with two different bucks: nothing carries.
    ph('q1', '09:00', { buck: 'b1', bucks: ['b1'] }), ph('q2', '09:01', { buck: 'b2', bucks: ['b2'] }), ph('q3', '09:02'),
    // A shot showing two bucks: nothing carries.
    ph('r1', '11:00', { buck: 'b1', bucks: ['b1'] }), ph('r2', '11:01', { aiCounts: { buck: 2 } }),
  ];
  const c = D.planVisitCarry(photos, ['p2', 'p3', 'p4', 'p5', 'q3', 'r2']);
  assert.deepEqual(c, [{ id: 'p2', buck: 'b1', shots: 1 }, { id: 'p3', buck: 'b1', shots: 1 }]);
  // Only shots just sorted get carried to.
  assert.deepEqual(D.planVisitCarry(photos, ['p5']), []);
});

test('sort plan: a headless shot keeps a buck only when he was followed through the visit', () => {
  const plan = D.planBuckSort({ photos: [
    { photo: 1, antlers_visible: true, bucks: [{ group: 'b1', confidence: 'high' }] },
    { photo: 2, antlers_visible: false, bucks: [{ group: 'b1', confidence: 'high', tracked: 1 }] },
    { photo: 3, antlers_visible: false, bucks: [{ group: 'b1', confidence: 'high' }] },
  ] }, ['p1', 'p2', 'p3'], ['b1']);
  assert.deepEqual(plan.assign.map((a) => a.id), ['p1', 'p2']);
  assert.deepEqual(plan.tracked, { p2: ['b1'] });
});
