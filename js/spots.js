/* Who's who in a photo with more than one buck: labeled outlines drawn over
   the picture from each buck's saved box (p.buckSpots). The overlay is sized
   to the image as laid out, so it lines up whatever the screen size. */
import * as db from './db.js';
import { photoBucks, buckWhere } from './deer.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLORS = ['#F59E0B', '#38BDF8', '#F472B6', '#A3E635', '#C084FC'];

/** Outline boxes for the bucks in a photo. only: show just this buck (compare screen). */
export function spotBoxes(p, { only = null, min = 2 } = {}) {
  const ids = photoBucks(p);
  if (!only && ids.length < min) return '';
  return ids.map((id, i) => {
    if (only && id !== only) return '';
    const box = drawable(p.buckSpots?.[id]);
    if (!box) return '';
    const [x, y, w, h] = box.map((v) => `${(v * 100).toFixed(1)}%`);
    const name = db.get('bucks', id)?.name || 'Buck';
    return `<div class="spot ${box[1] < 0.06 ? 'low' : ''}" style="left:${x};top:${y};width:${w};height:${h};--c:${COLORS[i % COLORS.length]}"><span>${esc(name)}</span></div>`;
  }).join('');
}
/** Does this photo have outlines worth drawing? */
export const hasSpots = (p, only = null) => photoBucks(p).filter((id) => (!only || id === only) && drawable(p.buckSpots?.[id])).length > 0 && (only || photoBucks(p).length > 1);
/** Boxes are drawn when you placed them or they came in the pixel format (bv 2);
    older AI boxes measured height on the wrong scale and sat too high. */
export const drawable = (spot) => (spot?.box && (spot.by === 'you' || spot.bv >= 2) ? spot.box : null);

/** A box you set by tapping the buck at (fx, fy), 0–1 of the photo. Keeps the old size if there was one. */
export function boxAt(fx, fy, old) {
  const [w, h] = old?.box ? [old.box[2], old.box[3]] : [0.3, 0.4];
  const x = Math.max(0, Math.min(1 - w, fx - w / 2)), y = Math.max(0, Math.min(1 - h, fy - h / 2));
  return { where: fx < 0.38 ? 'left' : fx > 0.62 ? 'right' : 'middle', box: [x, y, w, h].map((v) => Math.round(v * 1000) / 1000), by: 'you', bv: 2 };
}

/* Boxes on or off: one switch for every photo screen (viewer, compare, census
   review), remembered on this phone. Off hides the outlines so they never
   cover the antlers; the left/right notes stay. */
export const boxesOff = () => !!db.settings().hideBoxes;
const syncBoxes = () => document.documentElement.classList.toggle('no-spots', boxesOff());
const toggleLabel = () => (boxesOff() ? '▢ Show boxes' : '▣ Hide boxes');
/** The on/off button for a photo, or '' when it has no boxes to show. extra: more classes. */
export function boxToggle(p, { only = null, extra = '' } = {}) {
  syncBoxes();
  if (!p || !hasSpots(p, only)) return '';
  return `<button type="button" class="box-toggle ${extra}" data-box-toggle aria-pressed="${!boxesOff()}">${toggleLabel()}</button>`;
}
/** Turn boxes back on (when you're about to place one). */
export async function showBoxes() { if (boxesOff()) { await db.saveSettings({ hideBoxes: false }); syncBoxes(); } }
document.addEventListener('click', async (e) => {
  const b = e.target.closest?.('[data-box-toggle]');
  if (!b) return;
  e.stopPropagation();
  await db.saveSettings({ hideBoxes: !boxesOff() });
  syncBoxes();
  document.querySelectorAll('[data-box-toggle]').forEach((x) => { x.textContent = toggleLabel(); x.setAttribute('aria-pressed', String(!boxesOff())); });
}, true);

/** Size the overlay to the image's laid-out box (call on load and resize). */
export function fitOverlay(img, overlay) {
  if (!img || !overlay) return;
  const place = () => {
    overlay.style.left = `${img.offsetLeft}px`; overlay.style.top = `${img.offsetTop}px`;
    overlay.style.width = `${img.offsetWidth}px`; overlay.style.height = `${img.offsetHeight}px`;
  };
  if (img.complete && img.naturalWidth) place();
  img.addEventListener('load', place);
  window.addEventListener('resize', place);
}

/** "Big 8 is on the left" style line for a photo with several bucks, or ''. */
export function placeLine(p, id) {
  if (photoBucks(p).length < 2) return '';
  const w = buckWhere(p, id);
  return w ? `${db.get('bucks', id)?.name || 'This buck'}: ${w}` : '';
}
