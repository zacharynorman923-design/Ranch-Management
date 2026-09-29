/* Full-screen photo viewer. Pinch or double-tap to zoom, drag to pan, swipe
   left/right for the next photo, swipe down (or ✕) to close. With signal, a
   camera photo is swapped for the full-resolution original from the relay so
   zooming shows real detail. The tag buttons correct the AI's label. */
import * as db from './db.js';
import { photoURL, photoTags, needsReview, markPhotosOk } from './photos.js';
import { relayPhotoBlob } from './relay.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FIX_TAGS = ['buck', 'doe', 'fawn', 'hog', 'javelina', 'cattle', 'coyote', 'predator', 'turkey', 'bird', 'person', 'vehicle', 'nothing'];
const MAX_ZOOM = 6;

export function openViewer(ids, index = 0, { onEdit } = {}) {
  ids = ids.filter(Boolean);
  if (!ids.length) return;
  let i = Math.min(Math.max(0, index), ids.length - 1);
  let hdUrl = null;
  const dlg = document.createElement('dialog');
  dlg.className = 'viewer';
  dlg.innerHTML = `
    <div class="v-stage" data-stage><img data-img alt="" draggable="false"></div>
    <div class="v-top">
      <div class="v-cap" data-cap></div>
      <button type="button" class="v-btn" data-x aria-label="Close">✕</button>
    </div>
    <button type="button" class="v-nav v-prev" data-prev aria-label="Previous photo">‹</button>
    <button type="button" class="v-nav v-next" data-next aria-label="Next photo">›</button>
    <div class="v-bottom">
      <div class="v-ai" data-ai></div>
      <button type="button" class="v-ok" data-okay hidden>✓ OK, that was us</button>
      <div class="v-tags" data-tags></div>
      <div class="v-actions"><span class="v-count" data-count></span><span class="v-hd" data-hd></span>
        <a class="v-btn" data-save download>Save</a>${onEdit ? '<button type="button" class="v-btn" data-edit>Edit details</button>' : ''}</div>
    </div>`;
  document.body.appendChild(dlg);
  const $ = (s) => dlg.querySelector(s);
  const stage = $('[data-stage]'), img = $('[data-img]');

  // ---- zoom state: the image is centered; transform = translate(tx, ty) scale(s) ----
  let s = 1, tx = 0, ty = 0;
  const apply = (anim = false) => {
    img.style.transition = anim ? 'transform .2s ease-out' : 'none';
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    dlg.classList.toggle('zoomed', s > 1.01);
  };
  const clampPan = () => {
    const r = stage.getBoundingClientRect();
    const mx = Math.max(0, (img.offsetWidth * s - r.width) / 2), my = Math.max(0, (img.offsetHeight * s - r.height) / 2);
    tx = Math.min(mx, Math.max(-mx, tx));
    ty = Math.min(my, Math.max(-my, ty));
  };
  const local = (e) => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 }; };
  // Zoom so the image point under `p` stays under `p`.
  const zoomAt = (p, ns, from = { s, tx, ty }) => {
    const qx = (p.x - from.tx) / from.s, qy = (p.y - from.ty) / from.s;
    s = Math.min(MAX_ZOOM, Math.max(1, ns));
    tx = p.x - qx * s; ty = p.y - qy * s;
    if (s === 1) { tx = 0; ty = 0; }
    clampPan();
  };
  const reset = () => { s = 1; tx = 0; ty = 0; apply(); };

  // ---- showing a photo ----
  const renderInfo = () => {
    const p = db.get('photos', ids[i]);
    if (!p) return;
    const cam = db.get('devices', p.device)?.name;
    $('[data-cap]').innerHTML = `<b>${esc(p.caption || cam || 'Photo')}</b><br><small>${esc([p.date, p.time, cam && !String(p.caption || '').includes(cam) ? cam : '', p.temp !== '' && p.temp != null ? `${p.temp}°` : '', p.moon].filter(Boolean).join(' · '))}</small>`;
    const mine = String(p.tags || '').trim();
    const eff = photoTags(p);
    $('[data-ai]').innerHTML = [
      p.aiSummary ? `🤖 ${esc(p.aiSummary)}${p.aiTags ? ` <small>(${esc(p.aiTags)})</small>` : ''}` : p.aiTags === 'empty' ? '🤖 AI saw nothing in this frame' : '',
      mine ? `✏️ Your tag: <b>${esc(mine)}</b>${p.aiTags ? ' <small>(overrides the AI)</small>' : ''}` : p.aiTags ? '<small>Wrong? Tap the right tag below.</small>' : '',
    ].filter(Boolean).join('<br>');
    $('[data-tags]').innerHTML = FIX_TAGS.map((t) => {
      const on = t === 'nothing' ? eff.length === 1 && eff[0] === 'empty' : eff.includes(t);
      return `<button type="button" class="v-tag ${on ? 'on' : ''}" data-fix="${t}">${t}</button>`;
    }).join('');
    $('[data-okay]').hidden = !needsReview(p);
    $('[data-count]').textContent = ids.length > 1 ? `${i + 1} / ${ids.length}` : '';
    $('[data-prev]').hidden = i === 0;
    $('[data-next]').hidden = i === ids.length - 1;
  };
  const show = async (k) => {
    i = k;
    if (hdUrl) { URL.revokeObjectURL(hdUrl); hdUrl = null; }
    reset();
    $('[data-hd]').textContent = '';
    const id = ids[i];
    renderInfo();
    const src = (await photoURL(id)) || '';
    if (ids[i] !== id) return;
    img.src = src;
    $('[data-save]').href = src;
    $('[data-save]').setAttribute('download', `${id}.jpg`);
    // Swap in the full-size original when the relay still has it.
    const blob = await relayPhotoBlob(id);
    if (!blob || ids[i] !== id || !dlg.open) return;
    hdUrl = URL.createObjectURL(blob);
    img.src = hdUrl;
    $('[data-save]').href = hdUrl;
    $('[data-hd]').textContent = 'full resolution';
  };
  const go = (d) => { const k = i + d; if (k >= 0 && k < ids.length) show(k); else { tx = 0; ty = 0; apply(true); } };
  const close = () => { if (hdUrl) URL.revokeObjectURL(hdUrl); document.removeEventListener('keydown', onKey); dlg.close(); dlg.remove(); };
  const onKey = (e) => { if (e.key === 'ArrowLeft') go(-1); if (e.key === 'ArrowRight') go(1); };

  // ---- gestures ----
  const pts = new Map();
  let g = null; // current gesture
  let lastTap = { t: 0, x: 0, y: 0 };
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, local(e));
    const [a, b] = [...pts.values()];
    if (pts.size === 2) {
      g = { kind: 'pinch', d0: Math.hypot(b.x - a.x, b.y - a.y) || 1, mid0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, from: { s, tx, ty } };
    } else if (pts.size === 1) {
      g = { kind: 'drag', p0: a, from: { s, tx, ty }, t0: Date.now(), moved: 0 };
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId) || !g) return;
    pts.set(e.pointerId, local(e));
    const [a, b] = [...pts.values()];
    if (g.kind === 'pinch' && pts.size >= 2) {
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const qx = (g.mid0.x - g.from.tx) / g.from.s, qy = (g.mid0.y - g.from.ty) / g.from.s;
      s = Math.min(MAX_ZOOM, Math.max(1, g.from.s * Math.hypot(b.x - a.x, b.y - a.y) / g.d0));
      tx = mid.x - qx * s; ty = mid.y - qy * s;
      clampPan();
      apply();
    } else if (g.kind === 'drag') {
      const dx = a.x - g.p0.x, dy = a.y - g.p0.y;
      g.moved = Math.max(g.moved, Math.hypot(dx, dy));
      if (g.from.s > 1.01) { tx = g.from.tx + dx; ty = g.from.ty + dy; clampPan(); }
      else { tx = dx; ty = Math.max(0, dy) * 0.6; } // swipe feedback
      apply();
    }
  });
  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    const p = pts.get(e.pointerId);
    pts.delete(e.pointerId);
    if (g?.kind === 'pinch') {
      // One finger still down: keep panning from here without a jump.
      const rest = [...pts.values()][0];
      g = rest ? { kind: 'drag', p0: rest, from: { s, tx, ty }, t0: Date.now(), moved: 99 } : null;
      if (s <= 1.01) { reset(); }
      return;
    }
    if (g?.kind !== 'drag') return;
    const dx = p.x - g.p0.x, dy = p.y - g.p0.y;
    const quickTap = g.moved < 10 && Date.now() - g.t0 < 350;
    const wasZoomed = g.from.s > 1.01;
    g = null;
    if (quickTap) {
      const now = Date.now();
      if (now - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) {
        if (s > 1.01) { s = 1; tx = 0; ty = 0; } else zoomAt(p, 2.5, { s: 1, tx: 0, ty: 0 });
        apply(true);
        lastTap = { t: 0, x: 0, y: 0 };
      } else lastTap = { t: now, x: p.x, y: p.y };
      dlg.classList.toggle('bare'); // a single tap hides/shows the bars (a double tap undoes it)
      return;
    }
    if (wasZoomed) return;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
    else if (dy > 120) close();
    else { tx = 0; ty = 0; apply(true); }
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(local(e), s * (e.deltaY < 0 ? 1.25 : 0.8)); apply(); }, { passive: false });
  img.addEventListener('load', () => { clampPan(); apply(); });

  // ---- buttons ----
  dlg.addEventListener('click', async (e) => {
    if (e.target.closest('[data-x]')) return close();
    if (e.target.closest('[data-prev]')) return go(-1);
    if (e.target.closest('[data-next]')) return go(1);
    if (e.target.closest('[data-okay]')) {
      await markPhotosOk([ids[i]]);
      renderInfo();
      // Next photo in a burst that still needs a look.
      const k = ids.findIndex((id, j) => j > i && needsReview(db.get('photos', id)));
      if (k > 0) setTimeout(() => show(k), 350);
      return;
    }
    const fix = e.target.closest('[data-fix]');
    if (fix) {
      const p = db.get('photos', ids[i]);
      if (!p) return;
      const tag = fix.dataset.fix === 'nothing' ? 'empty' : fix.dataset.fix;
      // Tapping your current tag again clears it and goes back to the AI's label.
      await db.put('photos', { ...p, tags: String(p.tags || '').trim().toLowerCase() === tag ? '' : tag });
      renderInfo();
      return;
    }
    if (e.target.closest('[data-edit]') && onEdit) { const id = ids[i]; close(); onEdit(id); }
  });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  document.addEventListener('keydown', onKey);
  dlg.showModal();
  show(i);
}
