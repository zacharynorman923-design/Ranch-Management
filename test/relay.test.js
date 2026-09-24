/* The relay Worker, run in Node against a real SQLite database (standing in
   for D1) and a fake network (Tactacam, Open-Meteo, Ambient Weather). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../relay/src/index.js';
import * as L from '../relay/src/lib.js';

/* Minimal D1 look-alike: prepare().bind().first/all/run and batch(). */
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../relay/schema.sql', import.meta.url), 'utf8'));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => db.prepare(sql).run(...args),
  });
  return { prepare: (sql) => stmt(sql), batch: async (list) => { for (const s of list) await s.run(); } };
}

const JPEG = new Uint8Array(2_000_000).map((_, i) => i % 251); // big enough to need 3 chunks
function fakeNet(log) {
  return async (url, opts = {}) => {
    const u = String(url);
    log.push(u.split('?')[0]);
    const j = (x, status = 200) => new Response(JSON.stringify(x), { status });
    if (u.startsWith('https://cognito-idp')) {
      const body = JSON.parse(opts.body);
      if (body.AuthParameters.PASSWORD !== 'pw' && !body.AuthParameters.REFRESH_TOKEN) return j({ __type: 'NotAuthorizedException', message: 'Incorrect username or password.' }, 400);
      return j({ AuthenticationResult: { AccessToken: 'AT', RefreshToken: 'RT', ExpiresIn: 3600 } });
    }
    if (u.includes('/v1/cameras')) return j({ response: { cameras: [{ cameraId: 'c1', cameraName: 'Creek cam' }] } });
    if (u.includes('/v1/photos')) {
      const page = Number(new URL(u).searchParams.get('page'));
      const now = Date.now();
      const photos = page > 0 ? [] : [
        { photoId: 'p2', cameraId: 'c1', photoDateUtc: new Date(now - 3600e3).toISOString(), photoUrl: 'https://s3.test/p2.jpg', gpsLocation: { lat: 30.75, lon: -99.23 }, metadata: { batteryLevel: '64', signal: '3' }, weatherRecord: { temperature: 71, moonPhase: 'Waxing Gibbous' } },
        { photoId: 'p1', cameraId: 'c1', photoDateUtc: new Date(now - 7200e3).toISOString(), photoUrl: 'https://s3.test/p1.jpg', metadata: { batteryLevel: '65' } },
        { photoId: 'old', cameraId: 'c1', photoDateUtc: new Date(now - 30 * 86400e3).toISOString(), photoUrl: 'https://s3.test/old.jpg' },
      ];
      return j({ response: { photos } });
    }
    if (u.startsWith('https://s3.test/')) return new Response(JPEG);
    if (u.includes('archive-api.open-meteo.com')) return j({ daily: { time: ['2025-09-01', '2025-09-02'], precipitation_sum: [0.4, 0] } });
    if (u.includes('api.open-meteo.com')) {
      const today = L.localDate(Date.now());
      return j({ daily: { time: [L.addDaysISO(today, -1), today], precipitation_sum: [1.23, 9.99] } });
    }
    if (u.includes('ambientweather.net/v1/devices/')) {
      const t = Date.now();
      return j([{ dateutc: t, dailyrainin: 0.3 }, { dateutc: t - 600e3, dailyrainin: 0.1 }]);
    }
    if (u.includes('ambientweather.net/v1/devices')) return j([{ macAddress: 'AA:BB', lastData: { tz: 'America/Chicago' } }]);
    return j({ error: 'unexpected ' + u }, 500);
  };
}

const env0 = () => ({ DB: fakeD1(), RELAY_TOKEN: 'secret', TACTACAM_EMAIL: 'me@x.com', TACTACAM_PASSWORD: 'pw', RANCH_LAT: '30.7', RANCH_LON: '-99.2', AMBIENT_API_KEY: 'k', AMBIENT_APPLICATION_KEY: 'a', AMBIENT_MAC: '' });
const call = (env, path, init = {}) => worker.fetch(new Request('https://relay.test' + path, { ...init, headers: { Authorization: 'Bearer secret', ...(init.headers || {}) } }), env);

test('relay pulls photos, rain and camera health, then serves them to the app', { timeout: 30000 }, async (t) => {
  const log = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeNet(log);
  t.after(() => { globalThis.fetch = realFetch; });
  const env = env0();

  assert.equal((await worker.fetch(new Request('https://relay.test/status'), env)).status, 401);

  const run = await (await call(env, '/run', { method: 'POST' })).json();
  assert.equal(run.cameras.ok, true, JSON.stringify(run.cameras));
  assert.equal(run.cameras.added, 2); // 'old' is before the 3-day backfill window
  assert.equal(run.rain.ok, true, JSON.stringify(run.rain));

  const photos = await (await call(env, '/photos?after=0')).json();
  assert.deepEqual(photos.map((p) => p.id).sort(), ['p1', 'p2']);
  const p2 = photos.find((p) => p.id === 'p2');
  assert.equal(p2.camera, 'Creek cam');
  assert.equal(p2.moon, 'Waxing Gibbous');
  const img = new Uint8Array(await (await call(env, '/photo/p2')).arrayBuffer());
  assert.equal(img.length, JPEG.length);
  assert.deepEqual(img.subarray(1_799_990, 1_800_010), JPEG.subarray(1_799_990, 1_800_010));
  assert.equal((await (await call(env, `/photos?after=${Math.max(...photos.map((p) => p.seq))}`)).json()).length, 0);

  const cams = await (await call(env, '/cameras')).json();
  assert.equal(cams[0].battery, 64);
  assert.equal(cams[0].lat, 30.75);

  const rain = await (await call(env, '/rain?since=2000-01-01')).json();
  const today = L.localDate(Date.now());
  assert.ok(rain.find((r) => r.date === '2025-09-01' && r.est === 0.4), 'backfill stored');
  assert.ok(!rain.find((r) => r.date === today && r.est != null), "today's forecast is not stored as rain");
  assert.equal(rain.find((r) => r.date === L.addDaysISO(today, -1)).est, 1.23);
  assert.equal(rain.find((r) => r.date === today).gauge, 0.3);

  // Second run: nothing new, no re-download, no second backfill, token reused.
  log.length = 0;
  const again = await (await call(env, '/run', { method: 'POST' })).json();
  assert.equal(again.cameras.added, 0);
  assert.ok(!log.some((u) => u.startsWith('https://s3.test/')));
  assert.ok(!log.some((u) => u.includes('archive-api')));
  assert.ok(!log.some((u) => u.startsWith('https://cognito-idp')));

  const st = await (await call(env, '/status')).json();
  assert.equal(st.counts.photos, 2);
  assert.deepEqual(st.sources, { tactacam: true, ambient: true, estimate: true });
});

test('a bad Tactacam password is reported on /status, rain still runs', { timeout: 30000 }, async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeNet([]);
  t.after(() => { globalThis.fetch = realFetch; });
  const env = { ...env0(), TACTACAM_PASSWORD: 'wrong' };
  const run = await (await call(env, '/run', { method: 'POST' })).json();
  assert.equal(run.cameras.ok, false);
  assert.match(run.cameras.error, /Incorrect username or password/);
  assert.equal(run.rain.ok, true);
});

test('relay helpers', () => {
  // 11:30 pm Central on Sep 1 is Sep 2 in UTC but Sep 1 on the ranch.
  const late = Date.UTC(2026, 8, 2, 4, 30);
  assert.equal(L.localDate(late, 'America/Chicago'), '2026-09-01');
  assert.deepEqual(L.ambientDailyTotals([
    { dateutc: late, dailyrainin: 0.8 }, { dateutc: late - 3600e3, dailyrainin: 0.5 },
    { dateutc: late + 3600e3, dailyrainin: 0.02 },
  ], 'America/Chicago'), { '2026-09-01': 0.8, '2026-09-02': 0.02 });
  assert.deepEqual(L.openMeteoDaily({ daily: { time: ['a', 'b'], precipitation_sum: [0.123, null] } }), [{ date: 'a', inches: 0.12 }]);
  assert.equal(L.chunk(new Uint8Array(10), 4).length, 3);
  assert.ok(L.safeEqual('abc', 'abc'));
  assert.ok(!L.safeEqual('abc', 'abd'));
  assert.ok(!L.safeEqual('', ''));
  const m = L.revealPhotoMeta({ filename: 'x.jpg', photoDateUtc: 'garbage' });
  assert.equal(m.id, 'x.jpg');
  assert.equal(m.taken, null);
});

test('app rain import: one auto record per day, hand-logged days win', async () => {
  const { planRainImport, AUTO_GAUGE, AUTO_EST } = await import('../js/relay.js');
  const existing = [
    { id: 'm1', date: '2026-09-02', inches: 1.1, gauge: 'HQ' },
    { id: 'auto-rain-2026-09-02', date: '2026-09-02', inches: 0.9, gauge: AUTO_EST, auto: true },
    { id: 'auto-rain-2026-09-03', date: '2026-09-03', inches: 0.2, gauge: AUTO_EST, auto: true },
  ];
  const rows = [
    { date: '2026-09-01', gauge: null, est: 0.5 },
    { date: '2026-09-02', gauge: null, est: 0.9 },
    { date: '2026-09-03', gauge: null, est: 0.2 },
    { date: '2026-09-04', gauge: 0.75, est: 0.4 },
    { date: '2026-09-05', gauge: null, est: null },
  ];
  const p = planRainImport(rows, existing);
  assert.deepEqual(p.del, ['auto-rain-2026-09-02']);
  assert.deepEqual(p.put.map((r) => [r.date, r.inches, r.gauge]), [['2026-09-01', 0.5, AUTO_EST], ['2026-09-04', 0.75, AUTO_GAUGE]]);
});
