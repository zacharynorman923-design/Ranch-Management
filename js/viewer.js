/* Full-screen photo viewer. Pinch or double-tap to zoom, drag to pan, swipe
   left/right for the next photo, swipe down (or ✕) to close. With signal, a
   camera photo is swapped for the full-resolution original from the relay so
   zooming shows real detail. The tag buttons correct the AI's label. */
import * as db from './db.js';
import { photoURL, photoTags, needsReview, markPhotosOk } from './photos.js';
import { relayPhotoBlob, relayConfigured, matchBuckPhoto } from './relay.js';
import { cameraCensus, photoDeer, photoBucks, withBucks, bucksLabel, buckWhere, normBox } from './deer.js';
import { spotBoxes, fitOverlay, boxAt, boxToggle, showBoxes } from './spots.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FIX_TAGS = ['buck', 'doe', 'fawn', 'hog', 'javelina', 'cattle', 'coyote', 'predator', 'turkey', 'bird', 'person', 'vehicle', 'nothing'];
const MAX_ZOOM = 6;

export function openViewer(ids, index = 0, { onEdit, census = null } = {}) {
  // Tag and buck pickers stay folded into one line until you ask for them.
  const open = { tags: false, bucks: false };
  let moveFor = null; // a buck id while you're tapping to place his box
  ids = ids.filter(Boolean);
  if (!ids.length) return;
  let i = Math.min(Math.max(0, index), ids.length - 1);
  let hdUrl = null;
  const dlg = document.createElement('dialog');
  dlg.className = 'viewer';
  dlg.innerHTML = `
    <div class="v-stage" data-stage><img data-img alt="" draggable="false"><div class="spots" data-spots></div></div>
    <div class="v-top">
      <div class="v-cap" data-cap></div>
      <span data-boxbtn></span>
      <button type="button" class="v-btn" data-x aria-label="Close">✕</button>
    </div>
    <button type="button" class="v-nav v-prev" data-prev aria-label="Previous photo">‹</button>
    <button type="button" class="v-nav v-next" data-next aria-label="Next photo">›</button>
    <div class="v-bottom">
      <div class="v-census" data-census hidden></div>
      <div class="v-ai" data-ai></div>
      <button type="button" class="v-ok" data-okay hidden>✓ OK, that was us</button>
      <div class="v-tags" data-tags></div>
      <div class="v-buck" data-buck hidden></div>
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
    // The who's-who outlines ride along with the photo when you zoom and pan.
    const ov = $('[data-spots]');
    if (ov) { ov.style.transition = img.style.transition; ov.style.transform = img.style.transform; }
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
  // Which named buck is this? AI suggestion to confirm, or pick one yourself.
  const renderBuck = (p, eff) => {
    const box = $('[data-buck]');
    const mineIds = photoBucks(p);
    const bucks = db.all('bucks').filter((b) => (b.status || 'active') === 'active' || mineIds.includes(b.id)).sort((a, b) => String(a.name).localeCompare(b.name));
    if (!eff.includes('buck') && !mineIds.length) { box.hidden = true; return; }
    box.hidden = false;
    const names = mineIds.map((id) => db.get('bucks', id)?.name || 'Buck');
    const label = bucksLabel(p, (id) => db.get('bucks', id)?.name || 'Buck');
    const ai = p.buckAI;
    const aiBuck = ai && !mineIds.includes(ai.match) && db.get('bucks', ai.match);
    let line = '';
    if (mineIds.length && p.buckAuto) {
      line = `🤖 Auto-sorted as <b>${esc(label)}</b>${p.buckRack ? ` <small>(${esc(p.buckRack)})</small>` : ''}${p.buckVia === 'visit' ? '<br><small>Followed from his other shots in this visit; his rack doesn\'t show well here.</small>' : ''}
        <div class="v-row"><button type="button" class="v-tag on" data-bk-ok>✓ Yes, that's right</button><button type="button" class="v-tag" data-bk-clear>✕ Wrong, clear it</button></div>`;
    } else if (mineIds.length) {
      line = `🦌 In this photo: <b>${names.map(esc).join(' + ')}</b>`;
    } else if (aiBuck) {
      line = `🤖 Looks like <b>${esc(aiBuck.name)}</b>${ai.where ? ` <small>(the buck ${esc(/^(in |on |at |behind|near|far)/.test(ai.where) ? ai.where : `on the ${ai.where}`)})</small>` : ''} <small>(${esc(ai.confidence)})</small>${ai.reason ? `<br><small>${esc(ai.reason)}</small>` : ''}
        <div class="v-row"><button type="button" class="v-tag on" data-bk-yes>✓ Yes, ${esc(aiBuck.name)}</button><button type="button" class="v-tag" data-bk-no>✕ No</button></div>`;
    } else if (ai?.match === 'new') {
      line = `🤖 Looks like a buck you haven't named yet${ai.rack ? `: <small>${esc(ai.rack)}</small>` : ''}`;
    } else if (ai?.match === 'unsure') {
      line = `🤖 Can't tell which buck${ai.rack ? ` <small>(${esc(ai.rack)})</small>` : ''}`;
    } else if (ai?.match === 'error') {
      line = `<small>Buck match failed: ${esc(ai.reason || '')}</small>`;
    }
    // Every named buck is a toggle, so a photo with two bucks gets both.
    const summary = `<div class="v-sum"><span>🦌 ${mineIds.length ? `<b>${esc(label)}</b>` : '<span class="v-dim">No buck named</span>'}</span>
      <button type="button" class="v-sum-btn" data-toggle="bucks">${open.bucks ? 'Done ▴' : mineIds.length ? 'Change ▾' : 'Name him ▾'}</button></div>`;
    const actionLine = line && !(mineIds.length && !p.buckAuto) ? `<div>${line}</div>` : '';
    if (!open.bucks) { box.innerHTML = `${actionLine}${summary}`; return; }
    box.innerHTML = `${actionLine}${summary}
      <div class="v-row"><small>Tap every buck in the photo:</small></div>
      <div class="v-row">${bucks.map((b) => `<button type="button" class="v-tag ${mineIds.includes(b.id) ? 'on' : ''}" data-bk="${esc(b.id)}">${mineIds.includes(b.id) ? '✓ ' : ''}${esc(b.name)}</button>`).join('')}
        <button type="button" class="v-tag" data-bk-new>＋ New buck</button>
        ${bucks.length && relayConfigured() && !mineIds.length ? '<button type="button" class="v-tag" data-bk-ask>🤖 Ask AI</button>' : ''}</div>
      ${mineIds.length > 1 ? `<div class="v-places"><small>Which is which?</small>${mineIds.map((id) => `<div class="v-place"><b>${esc(db.get('bucks', id)?.name || 'Buck')}</b>${['left', 'middle', 'right', 'front', 'back'].map((w) => `<button type="button" class="v-tag ${buckWhere(p, id) === w ? 'on' : ''}" data-place="${esc(id)}:${w}">${w}</button>`).join('')}<button type="button" class="v-tag ${moveFor === id ? 'on' : ''}" data-move-box="${esc(id)}">📍 ${moveFor === id ? 'tap him…' : 'move box'}</button></div>`).join('')}</div>` : ''}
      ${mineIds.length ? `<div class="v-row">${mineIds.map((id) => { const b = db.get('bucks', id); const star = (b?.refs || []).includes(p.id); return `<button type="button" class="v-link" data-bk-star="${esc(id)}">${star ? '★' : '☆'} reference for ${esc(b?.name || 'buck')}</button>`; }).join('')}</div>` : ''}`;
  };

  // Opened from the camera census: how this photo is counted, its visit, and fixable counts.
  const renderCensus = (p) => {
    const box = $('[data-census]');
    if (!census) { box.hidden = true; return; }
    box.hidden = false;
    const recs = census.ids.map((id) => db.get('photos', id)).filter(Boolean);
    const c = cameraCensus({ photos: recs, uniqueBucks: 0, days: 14, gapMin: census.gapMin });
    const v = c.visitOf[p.id];
    const mine = photoDeer(p);
    const t = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const kinds = [['buck', 'Bucks'], ['doe', 'Does'], ['fawn', 'Fawns']];
    const one = { buck: 'buck', doe: 'doe', fawn: 'fawn' };
    const said = (o) => kinds.filter(([k]) => o[k]).map(([k, l]) => `${o[k]} ${o[k] === 1 ? one[k] : l.toLowerCase()}`).join(', ') || 'no deer';
    const cam = db.get('devices', p.device)?.name || 'this camera';
    if (v?.reviewed) {
      box.innerHTML = `<div>📊 <b>Census</b> · ✓ checked visit${v.ids.length > 1 ? ` (${v.ids.length} photos on ${esc(cam)})` : ''}: counted as <b>${esc(said(v.counts))}</b>.</div><div><small>To change it, use <b>Check the photos</b> in the camera census.</small></div>`;
      return;
    }
    box.innerHTML = `<div>📊 <b>Census</b> · this photo: ${kinds.map(([k, l]) => `<span class="v-cnt">${l} <button type="button" data-cnt="${k}:-1" aria-label="fewer ${l}">−</button><b>${mine[k] || 0}</b><button type="button" data-cnt="${k}:1" aria-label="more ${l}">+</button></span>`).join('')}
        <small>${p.counts ? '✏️ your count · <button type="button" class="v-link" data-cnt-reset>use the AI\'s</button>' : 'from the AI label'}</small></div>
      <div><small>${v && v.ids.length > 1
        ? `Part of one visit: ${v.ids.length} photos on ${esc(cam)}${v.start != null ? `, ${t(v.start)}–${t(v.last)}` : ''}. Counted <b>once</b> as ${esc(said(v.counts))} (the most seen in any one photo).`
        : census.gapMin ? `A visit on its own. Counted as ${esc(said(v?.counts || mine))}.` : `Every photo counts separately. Counted as ${esc(said(mine))}.`}
        ${p.buck ? ` Named buck: <b>${esc(db.get('bucks', p.buck)?.name || '?')}</b>.` : mine.buck ? ' Buck not identified yet.' : ''}</small></div>`;
  };

  const renderInfo = () => {
    const p = db.get('photos', ids[i]);
    if (!p) return;
    const cam = db.get('devices', p.device)?.name;
    $('[data-cap]').innerHTML = `<b>${esc(p.caption || cam || 'Photo')}</b><br><small>${esc([p.date, p.time, cam && !String(p.caption || '').includes(cam) ? cam : '', p.temp !== '' && p.temp != null ? `${p.temp}°` : '', p.moon].filter(Boolean).join(' · '))}</small>`;
    const mine = String(p.tags || '').trim();
    const eff = photoTags(p);
    $('[data-ai]').innerHTML = [
      p.aiSummary ? `🤖 ${esc(p.aiSummary)}${p.aiTags ? ` <small>(${esc(p.aiTags)})</small>` : ''}` : p.aiTags === 'empty' ? '🤖 AI saw nothing in this frame' : '',
      mine ? `<small>✏️ Your tags override the AI's.</small>` : '',
    ].filter(Boolean).join('<br>');
    $('[data-tags]').innerHTML = `<div class="v-sum"><span>🏷 ${eff.length ? esc(eff.filter((t) => t !== 'empty').join(', ') || 'nothing in it') : '<span class="v-dim">no tags</span>'}</span>
      <button type="button" class="v-sum-btn" data-toggle="tags">${open.tags ? 'Done ▴' : 'Edit ▾'}</button></div>
      ${open.tags ? `<div class="v-row">${FIX_TAGS.map((t) => {
        const on = t === 'nothing' ? eff.length === 1 && eff[0] === 'empty' : eff.includes(t);
        return `<button type="button" class="v-tag ${on ? 'on' : ''}" data-fix="${t}">${t}</button>`;
      }).join('')}</div>` : ''}`;
    $('[data-okay]').hidden = !needsReview(p);
    renderBuck(p, eff);
    $('[data-spots]').innerHTML = spotBoxes(p);
    $('[data-boxbtn]').innerHTML = boxToggle(p, { extra: 'v-btn' });
    renderCensus(p);
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
    if (quickTap && moveFor) {
      // Placing a box: put it where you tapped on the photo.
      const r = img.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
      const id = moveFor; moveFor = null; dlg.classList.remove('moving');
      if (fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1) {
        const ph = db.get('photos', ids[i]);
        db.put('photos', { ...ph, buckSpots: { ...(ph.buckSpots || {}), [id]: boxAt(fx, fy, ph.buckSpots?.[id]) } }).then(renderInfo);
      } else renderInfo();
      return;
    }
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
  fitOverlay(img, $('[data-spots]'));

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
    const mv = e.target.closest('[data-move-box]');
    if (mv) {
      moveFor = moveFor === mv.dataset.moveBox ? null : mv.dataset.moveBox;
      if (moveFor) await showBoxes(); // you need to see the box you're placing
      dlg.classList.toggle('moving', !!moveFor);
      dlg.dataset.hint = moveFor ? `Tap ${db.get('bucks', moveFor)?.name || 'the buck'} in the photo` : '';
      renderInfo();
      return;
    }
    const pl = e.target.closest('[data-place]');
    if (pl) {
      const p = db.get('photos', ids[i]);
      const [bid, where] = pl.dataset.place.split(':');
      // Your word wins; the AI's outline goes if it no longer matches what you said.
      const old = p.buckSpots?.[bid];
      const keepBox = old?.box && buckWhere({ buckSpots: { x: { box: old.box } } }, 'x') === where ? old.box : null;
      await db.put('photos', { ...p, buckSpots: { ...(p.buckSpots || {}), [bid]: { where, box: keepBox, by: 'you' } } });
      renderInfo();
      return;
    }
    const tg = e.target.closest('[data-toggle]');
    if (tg) { open[tg.dataset.toggle] = !open[tg.dataset.toggle]; renderInfo(); return; }
    const cnt = e.target.closest('[data-cnt],[data-cnt-reset]');
    if (cnt) {
      const p = db.get('photos', ids[i]);
      if (!p) return;
      if (cnt.hasAttribute('data-cnt-reset')) { const { counts, ...rest } = p; await db.put('photos', rest); }
      else {
        const [k, d] = cnt.dataset.cnt.split(':');
        const cur = photoDeer(p);
        await db.put('photos', { ...p, counts: { buck: cur.buck || 0, doe: cur.doe || 0, fawn: cur.fawn || 0, [k]: Math.max(0, (cur[k] || 0) + Number(d)) } });
      }
      renderInfo();
      return;
    }
    const bk = e.target.closest('[data-bk],[data-bk-new],[data-bk-yes],[data-bk-no],[data-bk-clear],[data-bk-star],[data-bk-ask],[data-bk-ok]');
    if (bk) {
      const p = db.get('photos', ids[i]);
      if (!p) return;
      const tagged = (x) => (photoTags(x).includes('buck') ? x : { ...x, tags: [...photoTags(x).filter((t) => t !== 'empty'), 'buck'].join(', ') });
      const cur = photoBucks(p);
      if (bk.dataset.bk) {
        const id = bk.dataset.bk;
        await db.put('photos', tagged({ ...withBucks(p, cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]), buckAuto: false }));
      } else if (bk.hasAttribute('data-bk-ok')) await db.put('photos', { ...p, buckAuto: false });
      else if (bk.hasAttribute('data-bk-yes')) await db.put('photos', tagged({ ...withBucks(p, [...cur, p.buckAI.match]), buckAuto: false, ...(p.buckAI.where || p.buckAI.box ? { buckSpots: { ...(p.buckSpots || {}), [p.buckAI.match]: { where: p.buckAI.where || '', box: normBox(p.buckAI.box), bv: p.buckAI.box_v || p.buckAI.bv || 0, by: 'ai' } } } : {}) }));
      else if (bk.hasAttribute('data-bk-no')) await db.put('photos', { ...p, buckAI: { ...p.buckAI, match: 'rejected' } });
      else if (bk.hasAttribute('data-bk-clear')) await db.put('photos', { ...withBucks(p, []), buckAuto: false });
      else if (bk.hasAttribute('data-bk-new')) {
        const name = (prompt('Name this buck (e.g. Big 8, Drop Tine):') || '').trim();
        if (!name) return;
        const b = await db.put('bucks', { name, status: 'active', refs: [p.id], points: p.buckAI?.rack?.match(/\b(\d{1,2})\b/)?.[1] || '' });
        await db.put('photos', tagged({ ...withBucks(p, [...cur, b.id]), buckAuto: false }));
      } else if (bk.dataset.bkStar) {
        const b = db.get('bucks', bk.dataset.bkStar);
        if (b) {
          const refs = b.refs || [];
          await db.put('bucks', { ...b, refs: refs.includes(p.id) ? refs.filter((x) => x !== p.id) : [p.id, ...refs].slice(0, 3) });
        }
      } else if (bk.hasAttribute('data-bk-ask')) {
        bk.disabled = true; bk.textContent = '🤖 Comparing…';
        try { await matchBuckPhoto(p.id); } catch (err) { bk.textContent = `🤖 ${err.message}`; return; }
      }
      renderInfo();
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
