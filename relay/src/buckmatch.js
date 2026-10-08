/* Which buck is this? The phone sends one new camera photo plus 1–3
   reference photos for each buck you've named; Claude compares racks and
   body features and says which named buck it is, a new buck, or that it
   can't tell — with the features it used, so you can check it. */
import Anthropic from '@anthropic-ai/sdk';
import { localDate } from './lib.js';
import { kvGet, kvSet } from './store.js';
import { modelOptions } from './classify.js';

const SYSTEM = `You identify individual white-tailed deer bucks in trail-camera photos from a ranch in Mason County, Texas.
You are given reference photos of bucks the owner has already named, then one new photo. Decide whether the buck in the new photo is one of the named bucks, a different ("new") buck, or impossible to tell ("unsure").
Compare the antlers first: number of points per side, brow tines, drop tines, kickers or stickers, split or forked tines, main-beam curve, inside spread relative to the ears (about 15 in ear tip to ear tip), tine length and mass, and left/right asymmetry. Then body: size, neck, face markings, scars, torn ears.
Camera angle changes how a rack looks (head-on hides points; profile hides spread), and infrared night photos lose detail. Racks shed in late winter and regrow each summer, so velvet or a new year's rack can differ from last year's references.
Lighting, fog, mist, rain, dust, night/infrared (black-and-white), blur, distance, camera angle, which camera or feeder, and time of day are NOT differences between bucks. The same buck at night and in daylight, or in fog and in sun, is the same buck: never treat those as distinguishing features, never split a buck into separate groups because of them, and never mention them in a name or rack description.
When a photo has more than one buck, say which one you mean every time: give each buck's place in the frame ("left", "right, in front") and a rough box around him, and keep the descriptions for different bucks apart.
Only say a named buck when specific features match and none contradict. If the rack can't be seen clearly, answer "unsure". Never guess to fill a slot; a wrong match is worse than "unsure".`;

export async function matchBuck(env, body) {
  if (!env.ANTHROPIC_API_KEY) throw Object.assign(new Error('Buck matching needs an ANTHROPIC_API_KEY on the relay'), { status: 400 });
  const strip = (x) => String(x || '').replace(/^data:image\/\w+;base64,/, '');
  const image = strip(body?.image);
  if (image.length < 1000) throw Object.assign(new Error('No image received'), { status: 400 });
  const bucks = (Array.isArray(body?.bucks) ? body.bucks : [])
    .map((b) => ({ id: String(b.id || '').slice(0, 40), name: String(b.name || 'Buck').slice(0, 40), refs: (b.refs || []).map(strip).filter((r) => r.length >= 1000).slice(0, 3) }))
    .filter((b) => b.id && b.refs.length).slice(0, 10);
  if (!bucks.length) throw Object.assign(new Error('No named bucks with reference photos'), { status: 400 });

  const tz = env.RANCH_TZ || 'America/Chicago';
  const today = localDate(Date.now(), tz);
  const limit = Number(env.BUCK_MATCH_DAILY_LIMIT || 80);
  const day = (await kvGet(env, 'buck_day')) || {};
  const used = day.date === today ? day.n : 0;
  if (used >= limit) throw Object.assign(new Error(`Daily buck-matching limit reached (${limit}). It picks up again tomorrow.`), { status: 429 });
  await kvSet(env, 'buck_day', { date: today, n: used + 1 });

  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['antlers_visible', 'rack', 'where', 'box', 'compared', 'match', 'confidence', 'reason'],
    properties: {
      antlers_visible: { type: 'boolean', description: 'Whether the new photo shows antlers clearly enough to compare.' },
      rack: { type: 'string', description: 'The new photo\'s rack in a few words, e.g. "main-frame 8, split left brow, drop tine on right beam, ~16 in spread".' },
      compared: { type: 'string', description: 'Which features you compared against the closest named buck, and whether they match.' },
      match: { type: 'string', enum: [...bucks.map((b) => b.id), 'new', 'unsure'] },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      reason: { type: 'string', description: 'One short line for the owner, e.g. "Same split left brow and right drop tine as Big 8".' },
      where: { type: 'string', description: 'Where this buck is in the photo, in a few words a person would use: "left", "right, in front", "center, behind the feeder", "far back left".' },
      box: { type: 'array', items: { type: 'integer' }, description: 'Rough box around this buck as [x, y, width, height], each 0–1000 of the image width/height, from the top-left corner.' },
    },
  };
  const content = [{ type: 'text', text: `Named bucks (${bucks.length}), with reference photos:` }];
  for (const b of bucks) {
    content.push({ type: 'text', text: `Buck id "${b.id}", named "${b.name}":` });
    for (const r of b.refs) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: r } });
  }
  content.push({ type: 'text', text: `New photo${body.note ? ` (${String(body.note).slice(0, 200)})` : ''}:` });
  content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } });
  content.push({ type: 'text', text: 'Is the buck in the new photo one of the named bucks (answer with its id), a new buck ("new"), or can you not tell ("unsure")? If the photo has several bucks, answer for the clearest one and say where he is.' });

  const model = env.BUCK_MATCH_MODEL || 'claude-opus-5';
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 90_000, maxRetries: 1 });
  const res = await client.beta.messages.create({
    model, max_tokens: 3000, system: SYSTEM,
    messages: [{ role: 'user', content }],
    // Comparing racks across angles takes careful looking.
    ...modelOptions(model, schema, 'medium'),
  });
  if (res.stop_reason === 'refusal') throw Object.assign(new Error('The model declined to compare this photo'), { status: 422 });
  const out = JSON.parse(res.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
  if (!out.antlers_visible && out.match !== 'unsure') { out.match = 'unsure'; out.confidence = 'low'; }
  return { model, result: out };
}

const SORT_SYSTEM = `${SYSTEM}
You may also be given several new photos at once. Sort them: put photos of the same buck in the same group. A photo can show more than one buck: list each buck in it separately. Use a named buck's id when the photo is that buck, a new group label ("new1", "new2", …) for a buck that isn't named yet (the same label for every photo of that same buck), or "unsure" when the rack can't be compared.
For each new group, suggest a short name from the most distinctive feature of the rack (or body) a hunter would use (e.g. "Split Brow 8", "Tall 10", "Drop Tine", "Wide 9", "Kicker 7"), and pick the photo that shows the rack best. Names describe the deer only: never words like Night, Foggy, Misty, Rainy, Dark, Blurry, IR, Day, Morning, Evening, Feeder or Cam.`;

const DEDUPE_SYSTEM = `${SYSTEM}
Now you are checking a list of bucks the owner (or an earlier automatic sort) has already named, to find any that are really the same buck photographed under different conditions: night infrared vs daylight, fog, rain, a different camera, or a different angle. Compare antlers and body only.
Report only pairs that are likely the same buck, each once. For each, say which to keep (the one with the clearer reference photos or more confirmed photos, if you can tell) and which to merge into it, how confident you are, and the matching features. If none look like the same buck, return an empty list.`;

/**
 * Look for duplicates among named bucks (e.g. a buck the auto-sort split into
 * a "night" and a "day" version). body: { bucks: [{ id, name, photos, refs: [base64…] }] }
 */
export async function dedupeBucks(env, body) {
  if (!env.ANTHROPIC_API_KEY) throw Object.assign(new Error('Duplicate checking needs an ANTHROPIC_API_KEY on the relay'), { status: 400 });
  const strip = (x) => String(x || '').replace(/^data:image\/\w+;base64,/, '');
  const bucks = (Array.isArray(body?.bucks) ? body.bucks : [])
    .map((b) => ({ id: String(b.id || '').slice(0, 40), name: String(b.name || 'Buck').slice(0, 40), photos: Number(b.photos) || 0, confirmed: !!b.confirmed, refs: (b.refs || []).map(strip).filter((r) => r.length >= 1000).slice(0, 3) }))
    .filter((b) => b.id && b.refs.length).slice(0, 12);
  if (bucks.length < 2) throw Object.assign(new Error('Need at least two bucks with photos to compare'), { status: 400 });

  const tz = env.RANCH_TZ || 'America/Chicago';
  const today = localDate(Date.now(), tz);
  const limit = Number(env.BUCK_MATCH_DAILY_LIMIT || 80);
  const day = (await kvGet(env, 'buck_day')) || {};
  const used = day.date === today ? day.n : 0;
  if (used >= limit) throw Object.assign(new Error(`Daily buck-matching limit reached (${limit}). It picks up again tomorrow.`), { status: 429 });
  await kvSet(env, 'buck_day', { date: today, n: used + 1 });

  const ids = bucks.map((b) => b.id);
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['duplicates'],
    properties: {
      duplicates: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['keep', 'merge', 'confidence', 'reason'],
          properties: {
            keep: { type: 'string', enum: ids },
            merge: { type: 'string', enum: ids },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            reason: { type: 'string', description: 'The rack/body features that match, e.g. "same split left brow and drop tine; the night photos just hide the brow".' },
          },
        },
      },
    },
  };
  const content = [{ type: 'text', text: `Named bucks to check (${bucks.length}):` }];
  for (const b of bucks) {
    content.push({ type: 'text', text: `Buck id "${b.id}", named "${b.name}" (${b.photos} photos${b.confirmed ? ', confirmed by the owner' : ', sorted automatically'}):` });
    for (const r of b.refs) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: r } });
  }
  content.push({ type: 'text', text: 'Which of these are the same buck? List each likely duplicate pair once.' });

  const model = env.BUCK_MATCH_MODEL || 'claude-opus-5';
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 120_000, maxRetries: 1 });
  const res = await client.beta.messages.create({
    model, max_tokens: 4000, system: DEDUPE_SYSTEM,
    messages: [{ role: 'user', content }],
    ...modelOptions(model, schema, 'medium'),
  });
  if (res.stop_reason === 'refusal') throw Object.assign(new Error('The model declined to compare these bucks'), { status: 422 });
  const out = JSON.parse(res.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
  out.duplicates = (out.duplicates || []).filter((d) => d.keep !== d.merge);
  return { model, result: out };
}

/**
 * Sort a batch of unidentified buck photos into named bucks and new groups.
 * body: { photos: [base64…] (≤12), bucks: [{ id, name, refs: [base64…] }] }
 */
export async function sortBucks(env, body) {
  if (!env.ANTHROPIC_API_KEY) throw Object.assign(new Error('Buck sorting needs an ANTHROPIC_API_KEY on the relay'), { status: 400 });
  const strip = (x) => String(x || '').replace(/^data:image\/\w+;base64,/, '');
  const photos = (Array.isArray(body?.photos) ? body.photos : []).map(strip).filter((x) => x.length >= 1000).slice(0, 12);
  if (!photos.length) throw Object.assign(new Error('No photos received'), { status: 400 });
  const bucks = (Array.isArray(body?.bucks) ? body.bucks : [])
    .map((b) => ({ id: String(b.id || '').slice(0, 40), name: String(b.name || 'Buck').slice(0, 40), refs: (b.refs || []).map(strip).filter((r) => r.length >= 1000).slice(0, 2) }))
    .filter((b) => b.id && b.refs.length).slice(0, 8);

  const tz = env.RANCH_TZ || 'America/Chicago';
  const today = localDate(Date.now(), tz);
  const limit = Number(env.BUCK_MATCH_DAILY_LIMIT || 80);
  const day = (await kvGet(env, 'buck_day')) || {};
  const used = day.date === today ? day.n : 0;
  if (used >= limit) throw Object.assign(new Error(`Daily buck-matching limit reached (${limit}). It picks up again tomorrow.`), { status: 429 });
  await kvSet(env, 'buck_day', { date: today, n: used + 1 });

  const groups = [...bucks.map((b) => b.id), ...photos.map((_, i) => `new${i + 1}`), 'unsure'];
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['photos', 'new_bucks'],
    properties: {
      photos: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['photo', 'antlers_visible', 'bucks'],
          properties: {
            photo: { type: 'integer', description: 'Number of the new photo (1-based).' },
            antlers_visible: { type: 'boolean' },
            bucks: {
              type: 'array',
              description: 'Every buck in this photo, one entry each (left to right).',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['rack', 'where', 'box', 'group', 'confidence'],
                properties: {
                  rack: { type: 'string', description: 'The rack in a few words, e.g. "main-frame 8, split left brow, ~16 in".' },
                  where: { type: 'string', description: 'Where this buck is in the photo, in a few words a person would use: "left", "right, in front", "center, behind the feeder", "far back left".' },
                  box: { type: 'array', items: { type: 'integer' }, description: 'Rough box around this buck as [x, y, width, height], each 0–1000 of the image width/height, from the top-left corner.' },
                  group: { type: 'string', enum: groups },
                  confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                },
              },
            },
          },
        },
      },
      new_bucks: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['group', 'name', 'rack', 'best_photo'],
          properties: {
            group: { type: 'string', enum: groups.filter((g) => g.startsWith('new')) },
            name: { type: 'string', description: 'Short name from the rack, e.g. "Split Brow 8".' },
            rack: { type: 'string' },
            best_photo: { type: 'integer', description: 'Number of the new photo that shows this rack best.' },
          },
        },
      },
    },
  };
  const content = [];
  if (bucks.length) {
    content.push({ type: 'text', text: `Named bucks (${bucks.length}), with reference photos:` });
    for (const b of bucks) {
      content.push({ type: 'text', text: `Buck id "${b.id}", named "${b.name}":` });
      for (const r of b.refs) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: r } });
    }
  } else content.push({ type: 'text', text: 'No bucks are named yet.' });
  content.push({ type: 'text', text: `New photos to sort (${photos.length}):` });
  photos.forEach((ph, i) => {
    content.push({ type: 'text', text: `New photo ${i + 1}${body.notes?.[i] ? ` (${String(body.notes[i]).slice(0, 80)})` : ''}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: ph } });
  });
  content.push({ type: 'text', text: 'Sort every new photo into a named buck, a new group, or "unsure". Give each new group a name and its best photo.' });

  const model = env.BUCK_MATCH_MODEL || 'claude-opus-5';
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 120_000, maxRetries: 1 });
  const res = await client.beta.messages.create({
    model, max_tokens: 6000, system: SORT_SYSTEM,
    messages: [{ role: 'user', content }],
    ...modelOptions(model, schema, 'medium'),
  });
  if (res.stop_reason === 'refusal') throw Object.assign(new Error('The model declined to sort these photos'), { status: 422 });
  const out = JSON.parse(res.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
  // No antlers to compare means no group, whatever the model said.
  for (const p of out.photos || []) if (!p.antlers_visible) for (const b of p.bucks || []) { b.group = 'unsure'; b.confidence = 'low'; }
  return { model, result: out };
}
