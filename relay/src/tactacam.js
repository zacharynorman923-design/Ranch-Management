/* Tactacam Reveal cellular cameras.
   Tactacam has no public API. This uses the same endpoints as the Reveal web
   app (account.revealcellcam.com), signing in with your own Tactacam login.
   If Tactacam changes their web app this can break — the relay then reports
   the error on /status and the rest keeps working. */
import { revealPhotoMeta, cameraName, chunk } from './lib.js';
import { kvGet, kvSet } from './store.js';

const COGNITO = 'https://cognito-idp.us-east-1.amazonaws.com/';
const CLIENT_ID = '6r9tpojvgvkci5trla0ip14mon'; // Reveal web app's public Cognito client
const API = 'https://api.reveal.ishareit.net/v1';
const WEB = 'https://account.revealcellcam.com';
const PAGE = 50;
const MAX_PAGES = 6;
const MAX_NEW = 150; // per run, to stay well inside the Worker's time limit

async function cognito(flow, params) {
  const r = await fetch(COGNITO, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
      Origin: WEB, Referer: `${WEB}/`,
    },
    body: JSON.stringify({ AuthFlow: flow, AuthParameters: params, ClientId: CLIENT_ID }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.AuthenticationResult) throw new Error(`Tactacam sign-in failed (${j.__type || r.status}${j.message ? ': ' + j.message : ''})`);
  return j.AuthenticationResult;
}

async function accessToken(env, force = false) {
  const t = await kvGet(env, 'tt_token');
  const now = Date.now();
  if (!force && t?.access && t.exp - 5 * 60_000 > now) return t.access;
  let a;
  if (t?.refresh && !force) {
    try { a = await cognito('REFRESH_TOKEN_AUTH', { REFRESH_TOKEN: t.refresh }); } catch { a = null; }
  }
  if (!a) a = await cognito('USER_PASSWORD_AUTH', { USERNAME: env.TACTACAM_EMAIL, PASSWORD: env.TACTACAM_PASSWORD });
  await kvSet(env, 'tt_token', { access: a.AccessToken, refresh: a.RefreshToken || t?.refresh, exp: now + (a.ExpiresIn || 3600) * 1000 });
  return a.AccessToken;
}

async function api(env, path) {
  for (const force of [false, true]) {
    const tok = await accessToken(env, force);
    const r = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${tok}`, 'reveal-user-agent': 'RevealWeb/5.4.0', Accept: 'application/json', Origin: WEB, Referer: `${WEB}/` },
    });
    if (r.status === 401 && !force) continue;
    if (!r.ok) throw new Error(`Tactacam ${path.split('?')[0]} HTTP ${r.status}`);
    return (await r.json())?.response || {};
  }
}

export async function pollTactacam(env) {
  if (!env.TACTACAM_EMAIL || !env.TACTACAM_PASSWORD) return { skipped: 'no Tactacam login configured' };
  const now = new Date().toISOString();

  const cams = (await api(env, '/cameras')).cameras || [];
  const names = Object.fromEntries(cams.map((c) => [c.cameraId, cameraName(c)]));
  const camStmt = env.DB.prepare(`INSERT INTO cameras (id, name, updated) VALUES (?1, ?2, ?3)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated = excluded.updated`);
  if (cams.length) await env.DB.batch(cams.map((c) => camStmt.bind(c.cameraId, names[c.cameraId], now)));

  // First run only looks back a few days; after that, everything newer than the last photo seen.
  const backfillDays = Number(env.CAMERA_BACKFILL_DAYS || 3);
  const since = (await kvGet(env, 'tt_last')) || new Date(Date.now() - backfillDays * 86400000).toISOString();
  let newest = since;
  let added = 0, seen = 0;

  outer:
  for (let page = 0; page < MAX_PAGES; page++) {
    const photos = (await api(env, `/photos?size=${PAGE}&page=${page}&includeWeatherData=true`)).photos || [];
    if (!photos.length) break;
    for (const raw of photos) {
      const m = revealPhotoMeta(raw, names);
      seen++;
      if (!m.id || !m.taken) continue;
      if (m.taken <= since) break outer; // newest-first: everything after this is old
      if (m.taken > newest) newest = m.taken;
      const exists = await env.DB.prepare('SELECT 1 FROM photos WHERE id = ?1').bind(m.id).first();
      if (exists || !m.url) continue;
      const img = await fetch(m.url);
      if (!img.ok) continue;
      const bytes = new Uint8Array(await img.arrayBuffer());
      const parts = chunk(bytes);
      const partStmt = env.DB.prepare('INSERT OR REPLACE INTO photo_chunks (id, n, data) VALUES (?1, ?2, ?3)');
      await env.DB.batch([
        ...parts.map((p, n) => partStmt.bind(m.id, n, p)),
        env.DB.prepare(`INSERT OR IGNORE INTO photos (id, camera_id, camera, taken, lat, lon, temp, moon, battery, signal, bytes, chunks, fetched_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`)
          .bind(m.id, m.cameraId, m.camera, m.taken, m.lat, m.lon, m.temp, m.moon, m.battery, m.signal, bytes.length, parts.length, now),
      ]);
      added++;
      if (added >= MAX_NEW) break outer;
    }
  }
  // Only advance the cursor when this run caught up; otherwise the next run continues.
  if (added < MAX_NEW) await kvSet(env, 'tt_last', newest);

  // Latest battery / signal / GPS per camera, from its newest photo.
  await env.DB.prepare(`UPDATE cameras SET
      battery = (SELECT battery FROM photos p WHERE p.camera_id = cameras.id AND p.battery IS NOT NULL ORDER BY taken DESC LIMIT 1),
      signal  = (SELECT signal  FROM photos p WHERE p.camera_id = cameras.id AND p.signal  IS NOT NULL ORDER BY taken DESC LIMIT 1),
      lat     = COALESCE((SELECT lat FROM photos p WHERE p.camera_id = cameras.id AND p.lat IS NOT NULL ORDER BY taken DESC LIMIT 1), lat),
      lon     = COALESCE((SELECT lon FROM photos p WHERE p.camera_id = cameras.id AND p.lon IS NOT NULL ORDER BY taken DESC LIMIT 1), lon),
      last_photo = (SELECT MAX(taken) FROM photos p WHERE p.camera_id = cameras.id)`).run();

  return { cameras: cams.length, checked: seen, added };
}

/** Drop relay copies of photos older than KEEP days; the phones keep their own. */
export async function prunePhotos(env) {
  const keep = Number(env.PHOTO_KEEP_DAYS || 45);
  const cutoff = new Date(Date.now() - keep * 86400000).toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM photo_chunks WHERE id IN (SELECT id FROM photos WHERE fetched_at < ?1)').bind(cutoff),
    env.DB.prepare('DELETE FROM photos WHERE fetched_at < ?1').bind(cutoff),
  ]);
}
