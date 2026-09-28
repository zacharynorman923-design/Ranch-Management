/* Ambient Weather station: everything it reports, not just rain.
   Every run (15 min): current conditions for every sensor, from /devices.
   Hourly: the last ~24 h of 5-minute records, folded into a daily
   min / max / average per sensor, plus the rain gauge's daily total. The
   first days after setup also walk back through older history (up to
   WX_BACKFILL_DAYS, a few days per hour) so the app has a record from day one.
   Ambient allows one request per second per key. */
import { wxAccumulate, wxByDate, wxPublic, pressureTrend } from './lib.js';
import { kvGet, kvSet } from './store.js';

const AMBIENT = 'https://rt.ambientweather.net/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, what) {
  const r = await fetch(url);
  if (r.status === 401 || r.status === 403) throw new Error(`Ambient rejected the API/application key (${r.status})`);
  if (!r.ok) throw new Error(`Ambient ${what} HTTP ${r.status}`);
  return r.json();
}

/** Fold records into weather_days and copy each day's rain total into the rain table. */
async function store(env, records, tz) {
  const now = new Date().toISOString();
  let days = 0;
  for (const [date, recs] of Object.entries(wxByDate(records, tz))) {
    const row = await env.DB.prepare('SELECT data FROM weather_days WHERE date = ?1').bind(date).first();
    const { day, added } = wxAccumulate(row ? JSON.parse(row.data) : null, recs);
    if (!added) continue;
    await env.DB.prepare('INSERT INTO weather_days (date, data, updated) VALUES (?1, ?2, ?3) ON CONFLICT(date) DO UPDATE SET data = excluded.data, updated = excluded.updated')
      .bind(date, JSON.stringify(day), now).run();
    // dailyrainin resets at local midnight, so the day's max is the day's rain.
    const rain = day.f.dailyrainin?.[1];
    if (rain != null) {
      await env.DB.prepare('INSERT INTO rain (date, gauge, updated) VALUES (?1, ?2, ?3) ON CONFLICT(date) DO UPDATE SET gauge = excluded.gauge, updated = excluded.updated')
        .bind(date, Math.round(rain * 100) / 100, now).run();
    }
    days++;
  }
  return days;
}

export async function pollAmbient(env, { history = true } = {}) {
  if (!(env.AMBIENT_API_KEY && env.AMBIENT_APPLICATION_KEY)) return { skipped: 'no Ambient keys configured' };
  const keys = `apiKey=${encodeURIComponent(env.AMBIENT_API_KEY)}&applicationKey=${encodeURIComponent(env.AMBIENT_APPLICATION_KEY)}`;
  const devs = await get(`${AMBIENT}/devices?${keys}`, 'devices');
  if (!devs.length) throw new Error('Ambient account has no stations');
  const want = String(env.AMBIENT_MAC || '').trim().toLowerCase();
  const dev = devs.find((d) => want && String(d.macAddress).toLowerCase() === want) || devs[0];
  const tz = dev.lastData?.tz || env.RANCH_TZ || 'America/Chicago';
  // Pressure trend for the fishing outlook: the 3-hour change from readings kept here.
  const press = pressureTrend(await kvGet(env, 'wx_press'), Number(dev.lastData?.dateutc), Number(dev.lastData?.baromrelin));
  await kvSet(env, 'wx_press', press.hist);
  await kvSet(env, 'wx_current', {
    mac: dev.macAddress, name: dev.info?.name || '', place: dev.info?.location || '',
    fetched: new Date().toISOString(), data: dev.lastData || {}, pressTrend3h: press.trend,
  });
  const out = { station: dev.info?.name || dev.macAddress, current: !!dev.lastData };
  if (!history) return out;

  const mac = encodeURIComponent(dev.macAddress);
  await sleep(1100);
  // 288 five-minute records ≈ 24 h: yesterday's close and today so far.
  const recent = await get(`${AMBIENT}/devices/${mac}?${keys}&limit=288`, 'data');
  out.days = await store(env, recent, tz);

  // Walk back through older history a few windows per run until it runs out.
  const maxDays = Number(env.WX_BACKFILL_DAYS ?? 365);
  const bf = (await kvGet(env, 'wx_backfill')) || {};
  let end = bf.end || Math.min(...recent.map((r) => Number(r.dateutc)).filter(Number.isFinite));
  let done = !!bf.done || !(maxDays > 0) || !Number.isFinite(end);
  for (let i = 0; !done && i < Number(env.WX_BACKFILL_PER_RUN || 3); i++) {
    if (end < Date.now() - maxDays * 86400000) { done = true; break; }
    await sleep(1100);
    const older = (await get(`${AMBIENT}/devices/${mac}?${keys}&limit=288&endDate=${end}`, 'history'))
      .filter((r) => Number(r.dateutc) < end);
    if (!older.length) { done = true; break; }
    out.days += await store(env, older, tz);
    end = Math.min(...older.map((r) => Number(r.dateutc)));
  }
  if (Number.isFinite(end)) await kvSet(env, 'wx_backfill', { end, done });
  out.backfill = done ? 'done' : new Date(end).toISOString().slice(0, 10);
  return out;
}

/** For the app: current conditions plus day summaries changed since `after`. */
export async function weatherFeed(env, after) {
  const current = await kvGet(env, 'wx_current');
  const { results } = await env.DB.prepare('SELECT date, data, updated FROM weather_days WHERE updated > ?1 ORDER BY date LIMIT 400')
    .bind(after || '1970-01-01').all();
  return { current, days: results.map((r) => ({ date: r.date, updated: r.updated, f: wxPublic(JSON.parse(r.data)) })) };
}
