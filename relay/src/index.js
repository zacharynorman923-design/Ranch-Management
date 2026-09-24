/* =========================================================================
   Ranch relay — a Cloudflare Worker that runs while your phone is off.
   Every 15 minutes it pulls new Tactacam Reveal photos; every hour it pulls
   rain (gauge + weather-model estimate). The app pulls from here whenever it
   has signal.

   All endpoints need   Authorization: Bearer <RELAY_TOKEN>
     GET  /status                 last run results and errors
     GET  /rain?since=YYYY-MM-DD  [{date, gauge, est}]
     GET  /cameras                [{id, name, battery, signal, lat, lon, last_photo}]
     GET  /photos?after=SEQ       [{seq, id, camera_id, camera, taken, …}] (50 max)
     GET  /photo/:id              the JPEG
     POST /run                    run every poll now (for setup/testing)
   ========================================================================= */
import { safeEqual } from './lib.js';
import { kvGet, kvSet } from './store.js';
import { pollRain } from './rain.js';
import { pollTactacam, prunePhotos } from './tactacam.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

async function step(env, name, fn) {
  const at = new Date().toISOString();
  let result;
  try { result = { at, ok: true, ...(await fn()) }; } catch (err) { result = { at, ok: false, error: String(err.message || err) }; }
  const status = (await kvGet(env, 'status')) || {};
  status[name] = result;
  await kvSet(env, 'status', status);
  return result;
}

async function runAll(env, { rain = true } = {}) {
  const out = {};
  out.cameras = await step(env, 'cameras', () => pollTactacam(env));
  if (rain) out.rain = await step(env, 'rain', () => pollRain(env));
  await prunePhotos(env).catch(() => {});
  return out;
}

export default {
  async scheduled(event, env, ctx) {
    // Cameras every run (15 min); rain once an hour.
    const minute = new Date(event.scheduledTime).getUTCMinutes();
    ctx.waitUntil(runAll(env, { rain: minute < 15 }));
  },

  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    if (url.pathname === '/') return json({ app: 'ranch-relay', ok: true });
    const auth = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!env.RELAY_TOKEN || !safeEqual(auth, env.RELAY_TOKEN)) return json({ error: 'unauthorized' }, 401);

    const p = url.pathname.replace(/\/+$/, '');
    if (p === '/status') {
      const counts = await env.DB.prepare('SELECT (SELECT COUNT(*) FROM photos) AS photos, (SELECT COUNT(*) FROM rain) AS rain_days, (SELECT COUNT(*) FROM cameras) AS cameras').first();
      return json({
        status: (await kvGet(env, 'status')) || {}, counts,
        sources: {
          tactacam: !!(env.TACTACAM_EMAIL && env.TACTACAM_PASSWORD),
          ambient: !!(env.AMBIENT_API_KEY && env.AMBIENT_APPLICATION_KEY),
          estimate: !!(env.RANCH_LAT && env.RANCH_LON),
        },
        // Where the weather-model estimate is computed. 30.7488, -99.2303 is Mason town (the default).
        location: { lat: Number(env.RANCH_LAT), lon: Number(env.RANCH_LON), tz: env.RANCH_TZ || 'America/Chicago' },
      });
    }
    if (p === '/rain') {
      const since = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('since') || '') ? url.searchParams.get('since') : '1900-01-01';
      const { results } = await env.DB.prepare('SELECT date, gauge, est FROM rain WHERE date >= ?1 ORDER BY date').bind(since).all();
      return json(results);
    }
    if (p === '/cameras') {
      const { results } = await env.DB.prepare('SELECT id, name, battery, signal, lat, lon, last_photo FROM cameras ORDER BY name').all();
      return json(results);
    }
    if (p === '/photos') {
      const after = Number(url.searchParams.get('after')) || 0;
      const limit = Math.min(50, Number(url.searchParams.get('limit')) || 50);
      const { results } = await env.DB.prepare(`SELECT seq, id, camera_id, camera, taken, lat, lon, temp, moon, battery, signal, bytes
        FROM photos WHERE seq > ?1 ORDER BY seq LIMIT ?2`).bind(after, limit).all();
      return json(results);
    }
    const m = p.match(/^\/photo\/(.+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const { results } = await env.DB.prepare('SELECT data FROM photo_chunks WHERE id = ?1 ORDER BY n').bind(id).all();
      if (!results.length) return json({ error: 'not found' }, 404);
      const parts = results.map((r) => new Uint8Array(r.data));
      const body = new Uint8Array(parts.reduce((s, x) => s + x.length, 0));
      let o = 0;
      for (const x of parts) { body.set(x, o); o += x.length; }
      return new Response(body, { headers: { ...CORS, 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' } });
    }
    if (p === '/run' && req.method === 'POST') return json(await runAll(env));
    return json({ error: 'not found' }, 404);
  },
};
