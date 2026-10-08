/* Same buck? Two bucks side by side (stacked on a phone, side by side when
   there's room), each with his own photo strip, and the decision buttons
   right there: merge them into one buck, or mark them as different. */
import * as db from './db.js';
import { photoURL } from './photos.js';
import { photoBucks } from './deer.js';
import { openViewer } from './viewer.js';
import { spotBoxes, fitOverlay, placeLine, boxAt, boxToggle, showBoxes } from './spots.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const byTime = (a, b) => (`${a.date} ${a.time || ''}` < `${b.date} ${b.time || ''}` ? 1 : -1);

/**
 * a, b: buck ids. reason/confidence: the AI's note, if any.
 * onMerge(fromId, intoId) and onNotSame(aId, bId) do the work; the dialog closes after either.
 * The first buck is the one that would be merged into the second.
 */
export function openBuckCompare(a, b, { reason = '', confidence = '', onMerge, onNotSame } = {}) {
  const sides = [a, b].map((id) => {
    const buck = db.get('bucks', id);
    // Reference photos first (the clearest), then the rest, newest first.
    const photos = db.all('photos').filter((p) => photoBucks(p).includes(id)).sort(byTime).map((p) => p.id);
    const refs = (buck?.refs || []).filter((x) => photos.includes(x));
    return { id, buck, ids: [...refs, ...photos.filter((x) => !refs.includes(x))], at: 0 };
  });
  if (sides.some((x) => !x.buck)) return;
  const dlg = document.createElement('dialog');
  dlg.className = 'bcmp';
  document.body.appendChild(dlg);
  const cam = (p) => db.get('devices', p?.device)?.name || '';

  const pane = (s, k) => {
    const p = db.get('photos', s.ids[s.at]);
    return `<section class="bcmp-pane" data-pane="${k}">
      <div class="bcmp-label"><b>${esc(s.buck.name)}</b>${s.buck.auto ? ' <span class="bcmp-auto">🤖</span>' : ''}
        <small>${s.ids.length ? `${s.at + 1} / ${s.ids.length}` : 'no photos'}</small></div>
      <div class="bcmp-photo" data-swipe="${k}">
        <img data-main="${k}" alt="${esc(s.buck.name)}"><div class="spots" data-ov="${k}">${p ? spotBoxes(p, { only: s.id }) : ''}</div>
        ${s.ids.length > 1 ? `<button type="button" class="bcmp-nav prev" data-step="${k}:-1" ${s.at === 0 ? 'disabled' : ''} aria-label="Previous">‹</button>
          <button type="button" class="bcmp-nav next" data-step="${k}:1" ${s.at === s.ids.length - 1 ? 'disabled' : ''} aria-label="Next">›</button>` : ''}
        <button type="button" class="bcmp-zoom" data-zoom="${k}" aria-label="Zoom">🔍</button>
        ${p && photoBucks(p).length > 1 ? `<button type="button" class="bcmp-fix ${fixing === k ? 'on' : ''}" data-fix-box="${k}">${fixing === k ? `Tap ${esc(s.buck.name)}…` : '📍 Box off?'}</button>` : ''}
        ${boxToggle(p, { only: s.id, extra: 'bcmp-boxes' })}
        ${p ? `<span class="bcmp-when">${esc([p.date, p.time, cam(p)].filter(Boolean).join(' · '))}</span>` : ''}
        ${p && photoBucks(p).length > 1 ? `<span class="bcmp-which">${esc(placeLine(p, s.id) || `${s.buck.name} is one of ${photoBucks(p).length} bucks here`)}</span>` : ''}
      </div>
      ${s.ids.length > 1 ? `<div class="bcmp-strip">${s.ids.map((id, i) => `<button type="button" class="bcmp-thumb ${i === s.at ? 'on' : ''}" data-pick="${k}:${i}"><img data-pid="${esc(id)}" alt=""></button>`).join('')}</div>` : ''}
    </section>`;
  };

  const render = () => {
    dlg.innerHTML = `<header class="bcmp-head">
        <button type="button" class="bcmp-x" data-x aria-label="Close">✕</button>
        <div class="bcmp-title"><b>Same buck?</b>${reason ? `<small>${confidence ? `${esc(confidence)} · ` : ''}${esc(reason)}</small>` : '<small>Compare the racks, not the lighting.</small>'}</div>
      </header>
      <div class="bcmp-panes">${pane(sides[0], 0)}${pane(sides[1], 1)}</div>
      <footer class="bcmp-foot">
        ${onNotSame ? '<button type="button" class="btn" data-not>Not the same</button>' : ''}
        ${onMerge ? `<button type="button" class="btn primary" data-merge>Merge as one buck</button>` : ''}
      </footer>`;
    sides.forEach((s, k) => {
      const id = s.ids[s.at];
      const im = dlg.querySelector(`[data-main="${k}"]`);
      fitOverlay(im, dlg.querySelector(`[data-ov="${k}"]`));
      if (id) photoURL(id).then((u) => { if (im) im.src = u || ''; });
    });
    dlg.querySelectorAll('.bcmp-thumb img[data-pid]').forEach(async (im) => { im.src = (await photoURL(im.dataset.pid)) || ''; });
    // Keep the chosen thumbnail in view.
    dlg.querySelectorAll('.bcmp-thumb.on').forEach((t) => t.scrollIntoView({ block: 'nearest', inline: 'center' }));
  };
  let fixing = null; // pane whose box you're placing by tapping
  const step = (k, d) => { const s = sides[k]; s.at = Math.max(0, Math.min(s.ids.length - 1, s.at + d)); render(); };
  const close = () => { dlg.close(); dlg.remove(); };

  dlg.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.hasAttribute('data-x')) return close();
    if (t.dataset.step) { const [k, d] = t.dataset.step.split(':').map(Number); return step(k, d); }
    if (t.dataset.pick) { const [k, i] = t.dataset.pick.split(':').map(Number); sides[k].at = i; return render(); }
    if (t.dataset.fixBox != null) { const k = Number(t.dataset.fixBox); fixing = fixing === k ? null : k; if (fixing != null) await showBoxes(); return render(); }
    if (t.dataset.zoom != null) { const s = sides[Number(t.dataset.zoom)]; return openViewer(s.ids, s.at); }
    if (t.hasAttribute('data-merge')) {
      if (!confirm(`Merge ${sides[0].buck.name} into ${sides[1].buck.name}? All of ${sides[0].buck.name}'s photos move to ${sides[1].buck.name}.`)) return;
      await onMerge(sides[0].id, sides[1].id); return close();
    }
    if (t.hasAttribute('data-not')) { await onNotSame(sides[0].id, sides[1].id); return close(); }
  });
  // Swipe a photo left/right to page through that buck's photos.
  let sx = null, sk = null;
  dlg.addEventListener('pointerdown', (e) => { const el = e.target.closest('[data-swipe]'); if (el) { sx = e.clientX; sk = Number(el.dataset.swipe); } });
  dlg.addEventListener('pointerup', async (e) => {
    if (sx == null) return;
    const dx = e.clientX - sx; sx = null;
    if (Math.abs(dx) > 50) return step(sk, dx < 0 ? 1 : -1);
    if (fixing !== sk) return;
    // Tapping the photo while fixing: the box goes where you tapped.
    const im = dlg.querySelector(`[data-main="${sk}"]`), r = im?.getBoundingClientRect();
    const s = sides[sk], ph = db.get('photos', s.ids[s.at]);
    fixing = null;
    if (r && ph) {
      const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
      if (fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1) await db.put('photos', { ...ph, buckSpots: { ...(ph.buckSpots || {}), [s.id]: boxAt(fx, fy, ph.buckSpots?.[s.id]) } });
    }
    render();
  });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  render();
  dlg.showModal();
}
