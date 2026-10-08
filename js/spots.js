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
    const box = p.buckSpots?.[id]?.box;
    if (!box) return '';
    const [x, y, w, h] = box.map((v) => `${(v * 100).toFixed(1)}%`);
    const name = db.get('bucks', id)?.name || 'Buck';
    return `<div class="spot ${box[1] < 0.06 ? 'low' : ''}" style="left:${x};top:${y};width:${w};height:${h};--c:${COLORS[i % COLORS.length]}"><span>${esc(name)}</span></div>`;
  }).join('');
}
/** Does this photo have outlines worth drawing? */
export const hasSpots = (p, only = null) => photoBucks(p).filter((id) => (!only || id === only) && p.buckSpots?.[id]?.box).length > 0 && (only || photoBucks(p).length > 1);

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
