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
    required: ['antlers_visible', 'rack', 'compared', 'match', 'confidence', 'reason'],
    properties: {
      antlers_visible: { type: 'boolean', description: 'Whether the new photo shows antlers clearly enough to compare.' },
      rack: { type: 'string', description: 'The new photo\'s rack in a few words, e.g. "main-frame 8, split left brow, drop tine on right beam, ~16 in spread".' },
      compared: { type: 'string', description: 'Which features you compared against the closest named buck, and whether they match.' },
      match: { type: 'string', enum: [...bucks.map((b) => b.id), 'new', 'unsure'] },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      reason: { type: 'string', description: 'One short line for the owner, e.g. "Same split left brow and right drop tine as Big 8".' },
    },
  };
  const content = [{ type: 'text', text: `Named bucks (${bucks.length}), with reference photos:` }];
  for (const b of bucks) {
    content.push({ type: 'text', text: `Buck id "${b.id}", named "${b.name}":` });
    for (const r of b.refs) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: r } });
  }
  content.push({ type: 'text', text: `New photo${body.note ? ` (${String(body.note).slice(0, 200)})` : ''}:` });
  content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } });
  content.push({ type: 'text', text: 'Is the buck in the new photo one of the named bucks (answer with its id), a new buck ("new"), or can you not tell ("unsure")?' });

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
