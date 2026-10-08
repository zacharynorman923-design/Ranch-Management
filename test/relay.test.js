/* The relay Worker, run in Node against a real SQLite database (standing in
   for D1) and a fake network (Tactacam, Open-Meteo, Ambient Weather). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../relay/src/index.js';
import * as L from '../relay/src/lib.js';
import { pollAmbient } from '../relay/src/weather.js';
import { classifyPending } from '../relay/src/classify.js';

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
  assert.deepEqual(st.sources, { tactacam: true, ambient: true, estimate: true, classifier: false, brushScan: false, buckMatch: false, buckSort: false, buckDedupe: false, relabel: false });
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

/* ---------------------------- photo classifier ---------------------------- */
test('classifier labels new photos, respects the daily cap, and the app gets tags', { timeout: 30000 }, async (t) => {
  const log = [];
  const sent = [];
  const base = fakeNet(log);
  const realFetch = globalThis.fetch;
  let reply = { empty: false, animals: [{ species: 'white-tailed deer', count: 1, sex: 'buck', antler_points: 8 }, { species: 'white-tailed deer', count: 2, sex: 'doe', antler_points: 0 }], summary: 'An 8-point buck and 2 does', confidence: 'high' };
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url instanceof Request ? url.url : url);
    if (u.startsWith('https://api.anthropic.com/')) {
      const req = url instanceof Request ? url : new Request(u, opts);
      sent.push({ url: u, headers: Object.fromEntries(req.headers), body: JSON.parse(await req.text()) });
      return new Response(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: JSON.stringify(reply) }], usage: { input_tokens: 1600, output_tokens: 80 },
      }), { headers: { 'content-type': 'application/json' } });
    }
    return base(url, opts);
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const env = { ...env0(), ANTHROPIC_API_KEY: 'sk-test', CLASSIFY_DAILY_LIMIT: '3' };

  const run = await (await call(env, '/run', { method: 'POST' })).json();
  assert.equal(run.labels.ok, true, JSON.stringify(run.labels));
  assert.equal(run.labels.labeled, 2);
  const first = sent[0];
  assert.equal(first.body.model, 'claude-opus-5');
  assert.equal(first.body.output_config.effort, 'low');
  assert.equal(first.body.output_config.format.type, 'json_schema');
  assert.equal(first.body.fallbacks, 'default');
  assert.match(first.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(first.headers['x-api-key'], 'sk-test');
  assert.deepEqual(first.body.messages[0].content[0].source, { type: 'url', url: 'https://s3.test/p2.jpg' });

  const photos = await (await call(env, '/photos?after=0')).json();
  assert.equal(photos.find((p) => p.id === 'p2').ai_tags, 'buck, doe');
  assert.equal(photos.find((p) => p.id === 'p2').ai_summary, 'An 8-point buck and 2 does');
  const labels = await (await call(env, '/labels?since=1970-01-01')).json();
  assert.equal(labels.length, 2);
  assert.equal(labels[0].labels.animals[0].antler_points, 8);

  // A failed URL fetch retries with our stored copy (base64); the cap (3/day) stops the rest.
  env.DB.prepare("UPDATE photo_labels SET status = 'error', attempts = 1 WHERE id = 'p1'");
  await env.DB.prepare("UPDATE photo_labels SET status = 'error', attempts = 1 WHERE id = 'p1'").run();
  reply = { empty: true, animals: [], summary: 'Nothing, grass moving', confidence: 'medium' };
  sent.length = 0;
  const again = await (await call(env, '/run', { method: 'POST' })).json();
  assert.equal(again.labels.labeled, 1);
  assert.equal(sent[0].body.messages[0].content[0].source.type, 'base64');
  assert.equal(sent[0].body.messages[0].content[0].source.data.length, Math.ceil(JPEG.length / 3) * 4);
  const capped = await (await call(env, '/run', { method: 'POST' })).json();
  assert.equal(capped.labels.capped, true);

  const st = await (await call(env, '/status')).json();
  assert.equal(st.sources.classifier, 'claude-opus-5');
});

test('classifier: Haiku gets no effort/fallbacks; no key means skipped', { timeout: 30000 }, async (t) => {
  const sent = [];
  const base = fakeNet([]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url instanceof Request ? url.url : url);
    if (u.startsWith('https://api.anthropic.com/')) {
      const req = url instanceof Request ? url : new Request(u, opts);
      sent.push({ headers: Object.fromEntries(req.headers), body: JSON.parse(await req.text()) });
      return new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: '{"empty":false,"animals":[{"species":"feral hog","count":5,"sex":"unknown","antler_points":0},{"species":"person","count":1,"sex":"unknown","antler_points":0}],"summary":"5 hogs and a person","confidence":"high"}' }], usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
    }
    return base(url, opts);
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const run = await (await call({ ...env0(), ANTHROPIC_API_KEY: 'k', CLASSIFIER_MODEL: 'claude-haiku-4-5' }, '/run', { method: 'POST' })).json();
  assert.equal(run.labels.labeled, 2);
  assert.equal(sent[0].body.output_config.effort, undefined);
  assert.equal(sent[0].body.fallbacks, undefined);
  assert.ok(!String(sent[0].headers['anthropic-beta'] || '').includes('fallback'));
  const none = await (await call(env0(), '/run', { method: 'POST' })).json();
  assert.match(none.labels.skipped, /ANTHROPIC_API_KEY/);
});

test('classifier tags', () => {
  assert.deepEqual(L.tagsFromLabels({ empty: true, animals: [] }), ['empty']);
  assert.deepEqual(L.tagsFromLabels({ empty: false, animals: [{ species: 'coyote' }, { species: 'feral hog' }, { species: 'white-tailed deer', sex: 'fawn' }, { species: 'axis deer' }] }), ['coyote', 'predator', 'hog', 'fawn', 'exotic']);
  assert.equal(L.toBase64(new TextEncoder().encode('hello')), 'aGVsbG8=');
});

/* ------------------------------ brush scan -------------------------------- */
test('brush-scan: sends the photo to Claude with the density schema, caps per day', { timeout: 30000 }, async (t) => {
  const sent = [];
  const realFetch = globalThis.fetch;
  const scan = { view: 'elevated', area_visible_sqft: 20000, species: [{ species: 'cedar', cedar_type: 'redberry', plants_counted: 60, canopy_cover_pct: 22, size_class: 'medium', typical_height_ft: 5, typical_canopy_ft: 5 }], confidence: 'medium', notes: 'Redberry cedar, scattered live oak.' };
  globalThis.fetch = async (url, opts = {}) => {
    const req = url instanceof Request ? url : new Request(String(url), opts);
    sent.push({ url: req.url, headers: Object.fromEntries(req.headers), body: JSON.parse(await req.text()) });
    return new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: JSON.stringify(scan) }], usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const env = { DB: fakeD1(), RELAY_TOKEN: 'secret', ANTHROPIC_API_KEY: 'sk', BRUSH_SCAN_DAILY_LIMIT: '2' };
  const image = 'data:image/jpeg;base64,' + 'A'.repeat(4000);
  const post = (b) => call(env, '/brush-scan', { method: 'POST', body: JSON.stringify(b), headers: { 'Content-Type': 'application/json' } });

  const r = await post({ image, view: 'elevated', note: 'north trap' });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.result.species[0].cedar_type, 'redberry');
  const body = sent[0].body;
  assert.equal(body.model, 'claude-opus-5');
  assert.equal(body.output_config.effort, 'medium');
  assert.ok(body.output_config.format.schema.properties.area_visible_sqft);
  assert.equal(body.messages[0].content[0].source.data.length, 4000); // data: prefix stripped
  assert.match(body.messages[0].content[1].text, /raised spot/);
  assert.equal(body.fallbacks, 'default');

  assert.equal((await post({ image })).status, 200);
  const capped = await post({ image });
  assert.equal(capped.status, 429);
  assert.match((await capped.json()).error, /limit/);
  assert.equal((await call({ ...env, ANTHROPIC_API_KEY: '' }, '/brush-scan', { method: 'POST', body: JSON.stringify({ image }) })).status, 400);
  assert.equal((await post({ image: 'x' })).status, 400); // no usable image
});

/* ---------------------------- weather station ----------------------------- */
test('weather: day summaries skip overlap, rain totals, direction and battery flags', () => {
  const recs = [{ dateutc: 3, tempf: 90, dailyrainin: 0.2, winddir: 180, battout: 1 }, { dateutc: 1, tempf: 70, dailyrainin: 0 }, { dateutc: 2, tempf: 80, weeklyrainin: 5 }];
  const { day, added } = L.wxAccumulate(null, recs);
  assert.equal(added, 3);
  assert.deepEqual(day.f.tempf, [70, 90, 240, 3]);
  assert.deepEqual(Object.keys(day.f).sort(), ['dailyrainin', 'tempf']);
  const again = L.wxAccumulate(day, [...recs, { dateutc: 4, tempf: 100 }]);
  assert.equal(again.added, 1); // only the new record counts
  assert.deepEqual(L.wxPublic(again.day).tempf, [70, 100, 85]);
});

test('weather: 3-hour pressure trend from readings kept between runs', () => {
  const H = 3600e3, t0 = Date.UTC(2026, 8, 1, 12);
  let st = L.pressureTrend([], t0, 30.10);
  assert.equal(st.trend, null); // not enough history yet
  for (let i = 1; i <= 12; i++) st = L.pressureTrend(st.hist, t0 + i * H / 4, 30.10 - 0.01 * i);
  assert.equal(st.trend, -0.12); // 0.04 inHg/hr falling
  assert.ok(st.hist.every(([ts]) => ts > t0 + 3 * H - 4.5 * H));
  st = L.pressureTrend(st.hist, t0 + 6 * H, 29.98); // 3 hr after the last reading
  assert.equal(st.trend, 0);
});

test('weather: current conditions, daily history with backfill, gauge rain', { timeout: 30000 }, async (t) => {
  const realFetch = globalThis.fetch;
  const H = 3600e3;
  const T = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - 1, 18); // ~1 pm Central yesterday
  const urls = [];
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    urls.push(u.pathname + (u.searchParams.get('endDate') ? '?end' : ''));
    const j = (x) => new Response(JSON.stringify(x));
    if (u.pathname === '/v1/devices') return j([{ macAddress: 'AA:BB', info: { name: 'Ranch HQ' }, lastData: { dateutc: Date.now(), tempf: 88, humidity: 40, tz: 'America/Chicago' } }]);
    const end = Number(u.searchParams.get('endDate'));
    if (!end) return j([{ dateutc: T, tempf: 90, humidity: 30, dailyrainin: 0.2, winddir: 200 }, { dateutc: T - H, tempf: 80, humidity: 50, dailyrainin: 0.1 }, { dateutc: T - 2 * H, tempf: 70, humidity: 70, dailyrainin: 0 }]);
    if (end === T - 2 * H) return j([{ dateutc: T - 2 * H, tempf: 70 }, { dateutc: T - 26 * H, tempf: 60, dailyrainin: 1.5 }, { dateutc: T - 27 * H, tempf: 55, dailyrainin: 1.1 }]);
    return j([]);
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const env = { DB: fakeD1(), RELAY_TOKEN: 'secret', AMBIENT_API_KEY: 'k', AMBIENT_APPLICATION_KEY: 'a', WX_BACKFILL_PER_RUN: '3' };

  const out = await pollAmbient(env);
  assert.equal(out.station, 'Ranch HQ');
  assert.equal(out.backfill, 'done');
  assert.equal(urls.filter((x) => x.endsWith('?end')).length, 2); // one window of history, then empty
  const day = L.localDate(T), prev = L.localDate(T - 26 * H);
  const feed = await (await call(env, '/weather')).json();
  assert.equal(feed.current.data.tempf, 88);
  assert.equal(feed.current.name, 'Ranch HQ');
  assert.equal(feed.current.pressTrend3h, null); // first reading
  const d = feed.days.find((x) => x.date === day);
  assert.deepEqual(d.f.tempf, [70, 90, 80]);
  assert.deepEqual(d.f.humidity, [30, 70, 50]);
  assert.equal(d.f.winddir, undefined);
  assert.deepEqual(feed.days.find((x) => x.date === prev).f.tempf, [55, 60, 57.5]);
  const rain = await (await call(env, '/rain')).json();
  assert.equal(rain.find((r) => r.date === day).gauge, 0.2);
  assert.equal(rain.find((r) => r.date === prev).gauge, 1.5);

  // Hourly again: same records aren't double-counted and backfill stays done.
  urls.length = 0;
  await pollAmbient(env);
  assert.ok(!urls.some((x) => x.endsWith('?end')));
  const again = (await (await call(env, '/weather')).json()).days.find((x) => x.date === day);
  assert.deepEqual(again.f.tempf, [70, 90, 80]);
  assert.equal((await (await call(env, '/weather?after=2999-01-01')).json()).days.length, 0);
  // Current-only run makes one request.
  urls.length = 0;
  await pollAmbient(env, { history: false });
  assert.deepEqual(urls, ['/v1/devices']);
});

test('classifier: hog rules — javelina, unsure guesses, evidence first, recent hog labels re-checked once', { timeout: 30000 }, async (t) => {
  assert.deepEqual(L.tagsFromLabels({ empty: false, animals: [{ species: 'javelina', id_confidence: 'high' }] }), ['javelina']);
  assert.deepEqual(L.tagsFromLabels({ empty: false, animals: [{ species: 'feral hog', id_confidence: 'low' }, { species: 'person', id_confidence: 'low' }] }), ['unsure', 'person']);
  const item = L.LABEL_SCHEMA.properties.animals.items;
  assert.equal(Object.keys(item.properties)[0], 'evidence');
  assert.ok(item.required.includes('id_confidence'));

  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const req = url instanceof Request ? url : new Request(String(url), opts);
    sent.push(JSON.parse(await req.text()));
    return new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: JSON.stringify({ empty: false, animals: [{ evidence: 'grizzled coat, pale collar, short snout', species: 'javelina', id_confidence: 'high', count: 3, sex: 'unknown', antler_points: 0 }], summary: '3 javelina', confidence: 'high' }) }],
      usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const env = { DB: fakeD1(), ANTHROPIC_API_KEY: 'k' };
  const now = new Date().toISOString(), old = new Date(Date.now() - 60 * 86400e3).toISOString();
  for (const [id, taken, tags] of [['h1', now, 'hog'], ['h2', old, 'hog'], ['d1', now, 'doe']]) {
    await env.DB.prepare("INSERT INTO photos (id, camera_id, camera, taken, fetched_at) VALUES (?1, 'c', 'Cam', ?2, ?2)").bind(id, taken).run();
    await env.DB.prepare("INSERT INTO photo_labels (id, url, status, attempts, tags, updated) VALUES (?1, 'https://s3.test/x.jpg', 'done', 1, ?2, ?3)").bind(id, tags, old).run();
  }
  const r = await classifyPending(env);
  assert.equal(r.labeled, 1); // only the recent hog photo
  assert.match(sent[0].system, /flat disc nose/);
  assert.match(sent[0].system, /javelina/);
  const row = await env.DB.prepare("SELECT tags, summary FROM photo_labels WHERE id = 'h1'").first();
  assert.equal(row.tags, 'javelina');
  assert.equal((await env.DB.prepare("SELECT tags FROM photo_labels WHERE id = 'h2'").first()).tags, 'hog'); // too old to re-check
  sent.length = 0;
  assert.equal((await classifyPending(env)).labeled, 0); // the re-check runs once
});

test('ranch coordinates: missing minus sign and swapped numbers are fixed; rain re-backfills when the place changes', { timeout: 30000 }, async (t) => {
  assert.deepEqual(L.fixRanchCoords('30.7488', '-99.2303'), { lat: 30.7488, lon: -99.2303, fixed: [] });
  assert.deepEqual(L.fixRanchCoords('30.7488', '99.2303'), { lat: 30.7488, lon: -99.2303, fixed: ['sign'] });
  assert.deepEqual(L.fixRanchCoords('-99.2303', '30.7488'), { lat: 30.7488, lon: -99.2303, fixed: ['swapped'] });
  assert.deepEqual(L.fixRanchCoords('99.2303', '30.7488'), { lat: 30.7488, lon: -99.2303, fixed: ['swapped', 'sign'] });
  assert.equal(L.fixRanchCoords('', ''), null);

  const urls = [];
  const realFetch = globalThis.fetch;
  const base = fakeNet([]);
  globalThis.fetch = (u, o) => { urls.push(String(u instanceof Request ? u.url : u)); return base(u, o); };
  t.after(() => { globalThis.fetch = realFetch; });
  const env = { ...env0(), RANCH_LON: '99.2' }; // typed without the minus sign
  await call(env, '/run', { method: 'POST' });
  const archive = urls.filter((u) => u.includes('archive-api'));
  assert.equal(archive.length, 1);
  assert.match(archive[0], /longitude=-99\.2/);
  const st = await (await call(env, '/status')).json();
  assert.equal(st.location.lon, -99.2);
  assert.deepEqual(st.location.fixed, ['sign']);
  assert.equal(st.location.entered.lon, '99.2');
  // Corrected in GitHub to a different spot: the estimate history is fetched again for it.
  urls.length = 0;
  await call({ ...env, RANCH_LON: '-99.25' }, '/run', { method: 'POST' });
  assert.equal(urls.filter((u) => u.includes('archive-api')).length, 1);
  urls.length = 0;
  await call({ ...env, RANCH_LON: '-99.25' }, '/run', { method: 'POST' });
  assert.equal(urls.filter((u) => u.includes('archive-api')).length, 0);
});

test('buck-match: sends refs per named buck plus the new photo, ids in the schema, unsure without antlers, daily cap', { timeout: 30000 }, async (t) => {
  const sent = [];
  let reply = { antlers_visible: true, rack: 'main-frame 8, split left brow', compared: 'split brow and drop tine match', match: 'b1', confidence: 'high', reason: 'Same split left brow as Big 8' };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const req = url instanceof Request ? url : new Request(String(url), opts);
    sent.push(JSON.parse(await req.text()));
    return new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: JSON.stringify(reply) }], usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const env = { DB: fakeD1(), RELAY_TOKEN: 'secret', ANTHROPIC_API_KEY: 'k', BUCK_MATCH_DAILY_LIMIT: '3' };
  const img = 'data:image/jpeg;base64,' + 'B'.repeat(3000);
  const bucks = [{ id: 'b1', name: 'Big 8', refs: [img, img] }, { id: 'b2', name: 'Drop Tine', refs: [img] }, { id: 'b3', name: 'No refs', refs: [] }];
  const post = (b) => call(env, '/buck-match', { method: 'POST', body: JSON.stringify(b), headers: { 'Content-Type': 'application/json' } });

  const r = await post({ image: img, bucks });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).result.match, 'b1');
  const body = sent[0];
  const imgs = body.messages[0].content.filter((c) => c.type === 'image');
  assert.equal(imgs.length, 4); // 2 + 1 refs, then the new photo
  assert.equal(imgs[3].source.data.length, 3000);
  assert.deepEqual(body.output_config.format.schema.properties.match.enum, ['b1', 'b2', 'new', 'unsure']);
  assert.match(body.system, /drop tines/);

  reply = { ...reply, antlers_visible: false, match: 'b2', confidence: 'medium' };
  const blind = await (await post({ image: img, bucks })).json();
  assert.equal(blind.result.match, 'unsure');
  assert.equal((await post({ image: img, bucks })).status, 200);
  assert.equal((await post({ image: img, bucks })).status, 429);
  assert.equal((await post({ image: img, bucks: [{ id: 'x', name: 'x', refs: [] }] })).status, 400);
});

test('buck-sort: groups a batch into named and new bucks; no antlers means unsure', { timeout: 30000 }, async (t) => {
  const sent = [];
  const reply = {
    photos: [
      { photo: 1, antlers_visible: true, bucks: [{ rack: 'main-frame 8, split brow', where: 'left', box: [36, 270, 342, 540], group: 'b1', confidence: 'high' }, { rack: 'tall 10', where: 'right, behind', box: [540, 225, 810, 540], group: 'new1', confidence: 'high' }] },
      { photo: 2, antlers_visible: true, bucks: [{ rack: 'tall 10', group: 'new1', confidence: 'high' }] },
      { photo: 3, antlers_visible: true, bucks: [{ rack: 'tall 10', group: 'new1', confidence: 'medium' }] },
      { photo: 4, antlers_visible: false, bucks: [{ rack: 'head down', group: 'new2', confidence: 'medium' }] },
    ],
    new_bucks: [{ group: 'new1', name: 'Tall 10', rack: 'tall 10, long G2s', best_photo: 2 }],
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const req = url instanceof Request ? url : new Request(String(url), opts);
    sent.push(JSON.parse(await req.text()));
    return new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: JSON.stringify(reply) }], usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const env = { DB: fakeD1(), RELAY_TOKEN: 'secret', ANTHROPIC_API_KEY: 'k' };
  const img = 'data:image/jpeg;base64,' + 'C'.repeat(2000);
  const r = await call(env, '/buck-sort', { method: 'POST', body: JSON.stringify({ photos: [img, img, img, img], sizes: [[900, 675], [900, 675], [900, 675], [900, 675]], bucks: [{ id: 'b1', name: 'Big 8', refs: [img, img, img] }] }), headers: { 'Content-Type': 'application/json' } });
  assert.equal(r.status, 200);
  const out = (await r.json()).result;
  assert.equal(out.photos[3].bucks[0].group, 'unsure');
  assert.equal(out.photos[0].bucks.length, 2); // two bucks in one photo
  assert.equal(out.photos[0].bucks[1].where, 'right, behind');
  // Pixel box on a 900×675 photo → that photo's own proportions (y scaled by height, not width).
  assert.deepEqual(out.photos[0].bucks[0].box, [40, 400, 340, 400]);
  assert.equal(out.photos[0].bucks[0].box_v, 2);
  assert.match(sent[0].messages[0].content.find((c) => c.text?.startsWith('New photo 1')).text, /900 × 675 pixels/);
  assert.deepEqual(sent[0].output_config.format.schema.properties.photos.items.properties.bucks.items.required, ['rack', 'where', 'box', 'group', 'confidence']);
  assert.match(sent[0].system, /say which one you mean every time/);
  assert.equal(out.new_bucks[0].name, 'Tall 10');
  const body = sent[0];
  assert.equal(body.messages[0].content.filter((c) => c.type === 'image').length, 6); // 2 refs (capped) + 4 photos
  assert.deepEqual(body.output_config.format.schema.properties.photos.items.properties.bucks.items.properties.group.enum, ['b1', 'new1', 'new2', 'new3', 'new4', 'unsure']);
  assert.match(body.system, /Split Brow 8/);
  assert.equal((await call(env, '/buck-sort', { method: 'POST', body: JSON.stringify({ photos: [] }) })).status, 400);
});

test('buck-dedupe: compares named bucks, ignores conditions, drops self-pairs', { timeout: 30000 }, async (t) => {
  const sent = [];
  const reply = { duplicates: [
    { keep: 'b1', merge: 'b2', confidence: 'high', reason: 'same split brow; night photos hide it' },
    { keep: 'b3', merge: 'b3', confidence: 'low', reason: 'self' },
  ] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const req = url instanceof Request ? url : new Request(String(url), opts);
    sent.push(JSON.parse(await req.text()));
    return new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: JSON.stringify(reply) }], usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const env = { DB: fakeD1(), RELAY_TOKEN: 'secret', ANTHROPIC_API_KEY: 'k' };
  const img = 'data:image/jpeg;base64,' + 'D'.repeat(2000);
  const post = (bucks) => call(env, '/buck-dedupe', { method: 'POST', body: JSON.stringify({ bucks }), headers: { 'Content-Type': 'application/json' } });
  const r = await post([{ id: 'b1', name: 'Split Brow 8', refs: [img], photos: 9, confirmed: true }, { id: 'b2', name: 'Night Split Brow', refs: [img, img] }, { id: 'b3', name: 'Tall 10', refs: [img] }]);
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).result.duplicates.map((d) => [d.keep, d.merge]), [['b1', 'b2']]);
  assert.match(sent[0].system, /NOT differences between bucks/);
  assert.deepEqual(sent[0].output_config.format.schema.properties.duplicates.items.properties.keep.enum, ['b1', 'b2', 'b3']);
  assert.match(sent[0].messages[0].content.find((c) => c.text?.includes('b1')).text, /confirmed by the owner/);
  assert.equal((await post([{ id: 'b1', name: 'x', refs: [img] }])).status, 400);
});

test('relabel: puts photos in a date range back in the labeling queue', async () => {
  const env = { DB: fakeD1(), RELAY_TOKEN: 'secret', ANTHROPIC_API_KEY: 'k' };
  for (const [id, taken, status] of [['a', '2026-09-20T12:00:00Z', 'done'], ['b', '2026-09-25T12:00:00Z', 'done'], ['c', '2026-08-01T12:00:00Z', 'done'], ['d', '2026-09-26T08:00:00Z', null]]) {
    await env.DB.prepare("INSERT INTO photos (id, camera_id, camera, taken, fetched_at) VALUES (?1, 'c', 'Cam', ?2, ?2)").bind(id, taken).run();
    if (status) await env.DB.prepare("INSERT INTO photo_labels (id, status, attempts, tags, updated) VALUES (?1, ?2, 1, 'doe', '2026-09-27')").bind(id, status).run();
  }
  const r = await call(env, '/relabel', { method: 'POST', body: JSON.stringify({ since: '2026-09-15', until: '2026-09-30' }), headers: { 'Content-Type': 'application/json' } });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.keepDays, 45);
  const rows = await env.DB.prepare('SELECT id, status, attempts FROM photo_labels ORDER BY id').all();
  assert.deepEqual(rows.results.map((x) => `${x.id}:${x.status}:${x.attempts}`), ['a:pending:0', 'b:pending:0', 'c:done:1', 'd:pending:0']);
  assert.equal((await call(env, '/relabel', { method: 'POST', body: JSON.stringify({ since: 'yesterday' }) })).status, 400);
});

test('pixel boxes scale each axis by its own side', () => {
  assert.deepEqual(L.pixelBoxToNorm([450, 337.5, 900, 675], 900, 675), [500, 500, 500, 500]);
  assert.deepEqual(L.pixelBoxToNorm([900, 675, 450, 337], 900, 675), [500, 499, 500, 501]); // corners given backwards
  assert.equal(L.pixelBoxToNorm([10, 10, 12, 12], 900, 675), null); // too small to mean anything
  assert.equal(L.pixelBoxToNorm([1, 2, 3], 900, 675), null);
  assert.equal(L.pixelBoxToNorm([0, 0, 100, 100], 0, 675), null);
});
