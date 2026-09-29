/* Labels new camera photos with Claude (vision + structured outputs):
   species, counts, buck/doe/fawn, rough antler points, people and vehicles.
   Runs only when ANTHROPIC_API_KEY is set, a few photos per cron run, under a
   daily cap (CLASSIFY_DAILY_LIMIT) so the bill can't run away. */
import Anthropic from '@anthropic-ai/sdk';
import { LABEL_SCHEMA, tagsFromLabels, toBase64, localDate } from './lib.js';
import { kvGet, kvSet } from './store.js';

const DEFAULT_MODEL = 'claude-opus-5';

const SYSTEM = `You label trail-camera photos for a 250-acre ranch in Mason County, Texas (Edwards Plateau / Hill Country).
Photos are often infrared black-and-white at night, motion-blurred, partly out of frame, or triggered by wind-blown grass.
Count every individual you can actually see. For white-tailed deer: "buck" only if antlers (or fresh pedicels) are visible, "fawn" if spotted or clearly this year's young, otherwise "doe" when clearly antlerless and adult, else "unknown". Estimate antler points only when the rack is clearly visible; otherwise 0.
Axis and fallow deer are common exotics here; feral hogs, coyotes, bobcats, raccoons, turkeys and armadillos are common too. This is a cattle ranch, so cows and calves (often black Angus) walk past cameras, and javelina occur here too.
Feral hog: only when you can see the diagnostic features: a long, wedge-shaped snout ending in a flat disc nose, no visible neck (head blends into the shoulders), a low barrel body with a ridge of coarse bristles along the back, short legs, and a thin straight tail. A dark, low shape by the feeder is NOT enough.
Things that get mistaken for hogs, so rule them out: javelina (smaller, 40–60 lb, grizzled salt-and-pepper coat with a pale collar band, short snout, no visible tail); black calves and cows (longer legs, ears sticking out sideways, broad blocky face, dewlap); deer with their heads down feeding or bedded, which look low and dark in infrared; armadillos, raccoons, skunks; and rocks, stumps, feeder legs, shadows, feed piles or water troughs.
Before choosing a species, write in "evidence" what you actually see. If the animal is too dark, blurred, distant or partly out of frame to see those features, set id_confidence to "low".
Never report an animal you can't point to in the frame.
If a person or vehicle is in frame, list it (species "person" or "vehicle") — the owner uses this to spot trespassing.
Ignore the camera's own date/time/temperature banner. Don't guess: when unsure of species or sex, say so with "unknown"/"other" and lower confidence.`;

/** Anthropic-specific request knobs that not every model accepts. */
export function modelOptions(model, schema = LABEL_SCHEMA, effort = 'low') {
  const frontier = /^claude-(opus-5|fable-5|mythos-5)/.test(model);
  return {
    ...(frontier ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
    // Labeling is a simple task, so low effort keeps it fast and cheap. Haiku 4.5 takes no effort setting.
    output_config: {
      ...(/haiku-4-5/.test(model) ? {} : { effort }),
      format: { type: 'json_schema', schema },
    },
  };
}

async function imageSource(env, row) {
  // Prefer Tactacam's own URL (no work for the Worker); fall back to our stored copy.
  if (row.url && row.attempts === 0) return { type: 'url', url: row.url };
  const { results } = await env.DB.prepare('SELECT data FROM photo_chunks WHERE id = ?1 ORDER BY n').bind(row.id).all();
  if (!results.length) return null;
  const parts = results.map((r) => new Uint8Array(r.data));
  const all = new Uint8Array(parts.reduce((s, x) => s + x.length, 0));
  let o = 0;
  for (const x of parts) { all.set(x, o); o += x.length; }
  return { type: 'base64', media_type: 'image/jpeg', data: toBase64(all) };
}

export async function classifyPending(env) {
  if (!env.ANTHROPIC_API_KEY) return { skipped: 'no ANTHROPIC_API_KEY configured' };
  const model = env.CLASSIFIER_MODEL || DEFAULT_MODEL;
  const perRun = Number(env.CLASSIFY_PER_RUN || 12);
  const dailyLimit = Number(env.CLASSIFY_DAILY_LIMIT || 150);
  const now = new Date().toISOString();
  const today = localDate(Date.now(), env.RANCH_TZ || 'America/Chicago');

  // Queue recent photos that predate the classifier (or arrived without a URL).
  const backfill = new Date(Date.now() - Number(env.CLASSIFY_BACKFILL_DAYS || 3) * 86400000).toISOString();
  await env.DB.prepare(`INSERT OR IGNORE INTO photo_labels (id, status, updated)
    SELECT id, 'pending', ?1 FROM photos WHERE taken > ?2`).bind(now, backfill).run();

  // Labels made before the hog rules were tightened: check recent hog photos again, once.
  if (!(await kvGet(env, 'relabel_hogs_v2'))) {
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    await env.DB.prepare(`UPDATE photo_labels SET status = 'pending', attempts = 0, updated = ?1
      WHERE status = 'done' AND tags LIKE '%hog%' AND id IN (SELECT id FROM photos WHERE taken > ?2)`).bind(now, since).run();
    await kvSet(env, 'relabel_hogs_v2', now);
  }

  const day = (await kvGet(env, 'cls_day')) || {};
  let used = day.date === today ? day.n : 0;
  if (used >= dailyLimit) return { model, labeled: 0, capped: true, today: used };

  const { results: rows } = await env.DB.prepare(`SELECT l.id, l.url, l.attempts, p.camera, p.taken FROM photo_labels l
    JOIN photos p ON p.id = l.id
    WHERE l.status = 'pending' OR (l.status = 'error' AND l.attempts < 3)
    ORDER BY p.taken DESC LIMIT ?1`).bind(Math.min(perRun, dailyLimit - used)).all();

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 60_000, maxRetries: 1 });
  let labeled = 0, failed = 0;
  for (const row of rows) {
    const done = (fields) => env.DB.prepare(`UPDATE photo_labels SET status = ?2, attempts = attempts + 1, tags = ?3, summary = ?4, labels = ?5, model = ?6, updated = ?7 WHERE id = ?1`)
      .bind(row.id, fields.status, fields.tags ?? null, fields.summary ?? null, fields.labels ?? null, model, new Date().toISOString()).run();
    try {
      const source = await imageSource(env, row);
      if (!source) { await done({ status: 'skipped', summary: 'image no longer stored' }); continue; }
      used++;
      const res = await client.beta.messages.create({
        model,
        max_tokens: 2000,
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source },
            { type: 'text', text: `Camera: ${row.camera || 'unknown'}. Taken: ${row.taken || 'unknown'} (UTC). Label this photo.` },
          ],
        }],
        ...modelOptions(model),
      });
      if (res.stop_reason === 'refusal') { await done({ status: 'skipped', summary: 'model declined to label this photo' }); continue; }
      const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const labels = JSON.parse(text);
      await done({ status: 'done', tags: tagsFromLabels(labels).join(', '), summary: String(labels.summary || '').slice(0, 200), labels: JSON.stringify(labels) });
      labeled++;
    } catch (err) {
      failed++;
      await done({ status: 'error', summary: String(err?.message || err).slice(0, 200) });
      if (err?.status === 401 || err?.status === 403) throw new Error(`Anthropic rejected the API key (${err.status})`);
    }
  }
  await kvSet(env, 'cls_day', { date: today, n: used });
  return { model, labeled, failed, today: used, dailyLimit };
}
