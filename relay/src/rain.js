/* Rain estimate: Open-Meteo's free weather-model rainfall for the ranch's
   coordinates (always, as a fallback and to backfill history). The on-site
   Ambient gauge is read in weather.js. */
import { openMeteoDaily, localDate, addDaysISO, fixRanchCoords } from './lib.js';
import { kvGet, kvSet } from './store.js';


async function upsert(env, rows, field) {
  if (!rows.length) return 0;
  const now = new Date().toISOString();
  const sql = field === 'gauge'
    ? 'INSERT INTO rain (date, gauge, updated) VALUES (?1, ?2, ?3) ON CONFLICT(date) DO UPDATE SET gauge = excluded.gauge, updated = excluded.updated'
    : 'INSERT INTO rain (date, est, updated) VALUES (?1, ?2, ?3) ON CONFLICT(date) DO UPDATE SET est = excluded.est, updated = excluded.updated';
  const stmt = env.DB.prepare(sql);
  await env.DB.batch(rows.map((r) => stmt.bind(r.date, r.inches, now)));
  return rows.length;
}

export async function pollRain(env) {
  const tz = env.RANCH_TZ || 'America/Chicago';
  const today = localDate(Date.now(), tz);
  const out = { estimate: 0 };

  const place = fixRanchCoords(env.RANCH_LAT, env.RANCH_LON, tz);
  if (place) {
    const { lat, lon } = place;
    const q = `latitude=${lat}&longitude=${lon}&daily=precipitation_sum&precipitation_unit=inch&timezone=${encodeURIComponent(tz)}`;
    // Backfill 12+ months so the stocking calculator has history on day one,
    // and again whenever the ranch location changes (or was corrected).
    const where = `${lat},${lon}`;
    const done = await kvGet(env, 'rain_backfilled');
    if (!done || (await kvGet(env, 'rain_backfill_at')) !== where) {
      const r = await fetch(`https://archive-api.open-meteo.com/v1/archive?${q}&start_date=${addDaysISO(today, -400)}&end_date=${addDaysISO(today, -3)}`);
      if (!r.ok) throw new Error(`Open-Meteo archive HTTP ${r.status}`);
      out.estimate += await upsert(env, openMeteoDaily(await r.json()), 'est');
      await kvSet(env, 'rain_backfilled', today);
      await kvSet(env, 'rain_backfill_at', where);
    }
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?${q}&past_days=10&forecast_days=1`);
    if (!r.ok) throw new Error(`Open-Meteo HTTP ${r.status}`);
    // Today is still a forecast — only finished days are stored.
    out.estimate += await upsert(env, openMeteoDaily(await r.json()).filter((x) => x.date < today), 'est');
  }

  // The Ambient gauge's daily totals are written by weather.js.
  return out;
}
