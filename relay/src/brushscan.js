/* Brush density from a photo. The phone sends one picture of a pasture; Claude
   (vision + structured outputs) identifies cedar, mesquite and prickly pear,
   counts what it can see, estimates canopy cover and plant size, and judges
   how much ground is in the frame so the app can work out plants per acre. */
import Anthropic from '@anthropic-ai/sdk';
import { localDate } from './lib.js';
import { kvGet, kvSet } from './store.js';
import { modelOptions } from './classify.js';

export const SCAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['view', 'area_visible_sqft', 'species', 'confidence', 'notes'],
  properties: {
    view: { type: 'string', enum: ['ground', 'elevated', 'overhead', 'unclear'], description: 'How the photo was taken.' },
    area_visible_sqft: { type: 'number', description: 'Best estimate of the ground area (square feet) in which the counted plants stand — the usable, in-focus part of the scene, not distant hillsides.' },
    species: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['species', 'cedar_type', 'plants_counted', 'canopy_cover_pct', 'size_class', 'typical_height_ft', 'typical_canopy_ft'],
        properties: {
          species: { type: 'string', enum: ['cedar', 'mesquite', 'prickly pear', 'other brush'] },
          cedar_type: { type: 'string', enum: ['ashe', 'redberry', 'unknown', 'n/a'], description: 'For cedar: Ashe (blueberry, single trunk, doesn’t resprout) vs redberry (multi-stem from the base). n/a for other species.' },
          plants_counted: { type: 'integer', description: 'Individual plants (pear: clumps) counted inside area_visible_sqft.' },
          canopy_cover_pct: { type: 'number', description: 'Percent of the visible ground covered by this species’ canopy, 0–100.' },
          size_class: { type: 'string', enum: ['seedling', 'small', 'medium', 'large', 'mixed'], description: 'Cedar/mesquite: small <3 ft, medium 3–8 ft, large >8 ft. Pear: small <2 ft, medium 2–4 ft, large >4 ft.' },
          typical_height_ft: { type: 'number' },
          typical_canopy_ft: { type: 'number', description: 'Typical canopy width (ft).' },
        },
      },
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    notes: { type: 'string', description: 'One or two sentences: what limits the estimate and anything a rancher should know (e.g. mostly Ashe juniper with scattered live oak).' },
  },
};

const SYSTEM = `You are a rangeland ecologist estimating brush density from a single photo taken on a ranch in Mason County, Texas (Edwards Plateau).
Identify only: cedar (Ashe juniper = blueberry cedar, usually single-trunked; redberry juniper = multi-stemmed from the base), honey mesquite, and prickly pear cactus. Anything else woody (live oak, shin oak, elbowbush, etc.) is not counted unless it is listed as "other brush".
Use scale cues — fence posts (usually 10–15 ft apart, ~4 ft tall), cattle, vehicles, people, grass height — to judge distances. Limit the counted area to the part of the scene where individual plants can be distinguished; don't include far hillsides.
Count plants inside that area, estimate each species' canopy cover as a percent of that ground, and estimate typical height and canopy width. Be honest: if the view is too distant, too close or obstructed to count, lower confidence and say why in notes. Never invent species that aren't visible.`;

export async function analyzeBrushPhoto(env, body) {
  if (!env.ANTHROPIC_API_KEY) throw Object.assign(new Error('Photo analysis needs an ANTHROPIC_API_KEY on the relay'), { status: 400 });
  const data = String(body?.image || '').replace(/^data:image\/\w+;base64,/, '');
  if (data.length < 1000) throw Object.assign(new Error('No image received'), { status: 400 });
  const tz = env.RANCH_TZ || 'America/Chicago';
  const today = localDate(Date.now(), tz);
  const limit = Number(env.BRUSH_SCAN_DAILY_LIMIT || 40);
  const day = (await kvGet(env, 'scan_day')) || {};
  const used = day.date === today ? day.n : 0;
  if (used >= limit) throw Object.assign(new Error(`Daily photo-analysis limit reached (${limit}). Try again tomorrow or raise BRUSH_SCAN_DAILY_LIMIT.`), { status: 429 });
  await kvSet(env, 'scan_day', { date: today, n: used + 1 });

  const model = env.BRUSH_SCAN_MODEL || 'claude-opus-5';
  const view = ['ground', 'elevated', 'overhead'].includes(body.view) ? body.view : 'ground';
  const hint = { ground: 'standing at ground level looking across the pasture', elevated: 'from a raised spot (truck bed, hill, stand)', overhead: 'from a drone looking straight down' }[view];
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 90_000, maxRetries: 1 });
  const res = await client.beta.messages.create({
    model,
    max_tokens: 4000,
    system: SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: body.mediaType || 'image/jpeg', data } },
        { type: 'text', text: `Photo taken ${hint}.${body.note ? ` Owner's note: ${String(body.note).slice(0, 300)}` : ''} Estimate cedar, mesquite and prickly pear density.` },
      ],
    }],
    // Judging distance and counting takes more thought than a trail-cam label.
    ...modelOptions(model, SCAN_SCHEMA, 'medium'),
  });
  if (res.stop_reason === 'refusal') throw Object.assign(new Error('The model declined to analyze this photo'), { status: 422 });
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { model, result: JSON.parse(text) };
}
