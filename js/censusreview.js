/* Census review: go through the camera-census photos one visit at a time
   (a visit = one camera's burst within the burst gap), check or fix how many
   bucks, does and fawns it shows, name the buck, and move on. Checked visits
   keep your counts; the census uses them instead of the AI's. */
import * as db from './db.js';
import * as C from './calc.js';
import * as D from './deer.js';
import { photoURL } from './photos.js';
import { openViewer } from './viewer.js';
import { spotBoxes, fitOverlay } from './spots.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KINDS = [['buck', 'Bucks', '🦌'], ['doe', 'Does', '🦌'], ['fawn', 'Fawns', '🦌']];
const one = { buck: 'buck', doe: 'doe', fawn: 'fawn' };
const said = (o) => KINDS.filter(([k]) => o[k]).map(([k, l]) => `${o[k]} ${o[k] === 1 ? one[k] : l.toLowerCase()}`).join(', ') || 'no deer';
const sum = (o) => (o.buck || 0) + (o.doe || 0) + (o.fawn || 0);

/** The census as currently set up: window, burst gap, photos, visits and the numbers. */
export function censusNow() {
  const s = db.settings();
  const cfg = s.camCensus || {};
  const end = cfg.end || C.today();
  const start = cfg.start || C.addDays(end, -13);
  const gap = Number(cfg.gap ?? 5);
  const days = C.daysBetween(start, end) + 1;
  const photos = db.all('photos').filter((p) => p.date >= start && p.date <= end && (p.source === 'reveal' || db.get('devices', p.device)?.type === 'camera'));
  const named = D.censusBuckIds(photos);
  const cams = new Set(photos.map((p) => p.device).filter(Boolean)).size;
  const acres = Number(s.acres) || 0;
  const c = D.cameraCensus({ photos, uniqueBucks: named.size, days, acres, gapMin: gap });
  const visits = D.censusVisits(photos, gap).sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  return { start, end, gap, days, photos, named, cams, acres, c, visits };
}

export const REVIEW_FILTERS = [
  ['todo', 'Not checked yet'], ['all', 'All visits with deer'], ['buck', 'Bucks'], ['doe', 'Does'], ['fawn', 'Fawns'],
  ['unidentified', 'Unidentified bucks'], ['nodeer', 'No deer counted'],
];
const hasDeer = (v) => sum(v.counts) > 0;
const matches = (v, f) => ({
  todo: !v.reviewed && hasDeer(v), all: hasDeer(v), buck: v.counts.buck > 0, doe: v.counts.doe > 0, fawn: v.counts.fawn > 0,
  unidentified: v.counts.buck > v.bucks.size, nodeer: !hasDeer(v),
}[f]);
/** How many visits each filter would show, for the census panel. */
export function reviewCounts(visits) {
  const out = {};
  for (const [f] of REVIEW_FILTERS) out[f] = visits.filter((v) => matches(v, f)).length;
  out.checked = visits.filter((v) => v.reviewed && hasDeer(v)).length;
  out.withDeer = visits.filter(hasDeer).length;
  return out;
}

export function openCensusReview({ filter = 'todo' } = {}) {
  let state = censusNow();
  // The list is fixed when you open it, so checking a visit doesn't reshuffle it.
  let keys = state.visits.filter((v) => matches(v, filter)).map((v) => v.key);
  let pos = 0, photoIdx = 0, draft = null;
  const dlg = document.createElement('dialog');
  dlg.className = 'creview';
  document.body.appendChild(dlg);

  const visit = () => state.visits.find((v) => v.key === keys[pos]) || null;
  const t = (ms) => (ms == null ? '' : new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  const loadDraft = () => {
    const v = visit();
    draft = v ? { counts: { buck: v.counts.buck, doe: v.counts.doe, fawn: v.counts.fawn }, bucks: [...v.bucks] } : null;
    photoIdx = 0;
  };

  const render = () => {
    const v = visit();
    const rc = reviewCounts(state.visits);
    const pct = rc.withDeer ? Math.round((rc.checked / rc.withDeer) * 100) : 0;
    const head = `<header class="cr-head">
        <button type="button" class="cr-x" data-x aria-label="Close">✕</button>
        <div class="cr-title">${v ? `<b>Visit ${pos + 1} of ${keys.length}</b>` : '<b>Census review</b>'}
          ${v ? `<small>${esc(db.get('devices', v.device)?.name || 'Camera')} · ${esc(new Date(v.start ?? Date.parse(db.get('photos', v.ids[0])?.date)).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }))}${v.start != null ? ` · ${t(v.start)}${v.last !== v.start ? `–${t(v.last)}` : ''}` : ''} · ${v.ids.length} photo${v.ids.length === 1 ? '' : 's'}</small>` : ''}</div>
        <select data-filter aria-label="Which visits">${REVIEW_FILTERS.map(([k, l]) => `<option value="${k}" ${k === filter ? 'selected' : ''}>${esc(l)} (${rc[k]})</option>`).join('')}</select>
      </header>
      <div class="cr-progress" title="${rc.checked} of ${rc.withDeer} visits checked"><span style="width:${pct}%"></span></div>
      <div class="cr-progress-label">${rc.checked} of ${rc.withDeer} visits with deer checked</div>`;
    if (!v) {
      dlg.innerHTML = `${head}<div class="cr-done"><div class="cr-done-icon">✓</div>
        <p><b>${keys.length ? 'All done with this list.' : 'Nothing in this list.'}</b></p>
        <p class="small">${rc.todo ? `${rc.todo} visit${rc.todo === 1 ? '' : 's'} still not checked.` : 'Every visit with deer has been checked.'}</p>
        <div class="cr-foot">${rc.todo && filter !== 'todo' ? '<button type="button" class="btn" data-go-todo>Check the rest</button>' : ''}<button type="button" class="btn primary" data-x>Close</button></div></div>`;
      return;
    }
    const p = db.get('photos', v.ids[photoIdx]) || db.get('photos', v.ids[0]);
    const ai = v.ids.reduce((m, id) => { const c = D.photoDeer(db.get('photos', id)); for (const [k] of KINDS) m[k] = Math.max(m[k], c[k] || 0); return m; }, { buck: 0, doe: 0, fawn: 0 });
    const bucks = db.all('bucks').filter((b) => (b.status || 'active') === 'active' || draft.bucks.includes(b.id)).sort((a, b) => String(a.name).localeCompare(b.name));
    const aiBuck = v.ids.map((id) => db.get('photos', id)?.buckAI).find((x) => x && db.get('bucks', x.match));
    dlg.innerHTML = `${head}
      <div class="cr-photo" data-swipe>
        <img data-img alt="Camera photo"><div class="spots" data-ov>${spotBoxes(p)}</div>
        <button type="button" class="cr-zoom" data-zoom aria-label="Zoom">🔍 Zoom</button>
        ${v.reviewed ? '<span class="cr-badge ok">✓ checked</span>' : `<span class="cr-badge">AI: ${esc(said(ai))}</span>`}
      </div>
      ${v.ids.length > 1 ? `<div class="cr-strip">${v.ids.map((id, i) => `<button type="button" class="cr-thumb ${i === photoIdx ? 'on' : ''}" data-ph="${i}"><img data-pid="${esc(id)}" alt=""><small>${esc(db.get('photos', id)?.time || '')}</small></button>`).join('')}</div>` : ''}
      <div class="cr-panel">
        <div class="cr-q">How many in this visit? <small>(the most you can see in any one photo)</small></div>
        <div class="cr-counters">${KINDS.map(([k, l]) => `<div class="cr-counter ${draft.counts[k] ? 'has' : ''}">
          <div class="cr-counter-label">${l}</div>
          <div class="cr-counter-row"><button type="button" data-cnt="${k}:-1" aria-label="fewer ${l}">−</button><b>${draft.counts[k]}</b><button type="button" data-cnt="${k}:1" aria-label="more ${l}">+</button></div>
        </div>`).join('')}</div>
        <div class="cr-quick">
          <button type="button" data-preset="0,0,0">No deer</button>
          <button type="button" data-preset="0,1,0">1 doe</button>
          <button type="button" data-preset="0,1,1">Doe + fawn</button>
          <button type="button" data-preset="0,1,2">Doe + 2 fawns</button>
          <button type="button" data-preset="1,0,0">1 buck</button>
          <button type="button" data-preset="${ai.buck},${ai.doe},${ai.fawn}">Same as AI</button>
        </div>
        ${draft.counts.buck ? `<div class="cr-bucks"><div class="cr-q">Which buck${draft.counts.buck > 1 ? 's' : ''}? <small>Tap every buck in the visit${draft.bucks.length ? ` · ${draft.bucks.length} of ${draft.counts.buck} named` : ''}</small></div>
          <div class="cr-chips">${aiBuck && !draft.bucks.includes(aiBuck.match) ? `<button type="button" class="cr-chip ai" data-buck="${esc(aiBuck.match)}">🤖 ${esc(db.get('bucks', aiBuck.match).name)}?</button>` : ''}
            ${bucks.map((b) => `<button type="button" class="cr-chip ${draft.bucks.includes(b.id) ? 'on' : ''}" data-buck="${esc(b.id)}">${draft.bucks.includes(b.id) ? '✓ ' : ''}${esc(b.name)}${draft.bucks.includes(b.id) && draft.bucks.length > 1 && D.buckWhere(p, b.id) ? ` · ${esc(D.buckWhere(p, b.id))}` : ''}</button>`).join('')}
            <button type="button" class="cr-chip" data-newbuck>＋ New buck</button>
            <button type="button" class="cr-chip ${draft.bucks.length ? '' : 'on'}" data-nobuck>${draft.bucks.length ? 'Clear' : "Can't tell"}</button></div></div>` : ''}
      </div>
      <footer class="cr-foot">
        <button type="button" class="btn" data-prev ${pos === 0 ? 'disabled' : ''} aria-label="Previous visit">‹</button>
        <button type="button" class="btn" data-skip>Skip</button>
        <button type="button" class="btn primary cr-ok" data-ok>✓ ${esc(said(draft.counts))} · next</button>
      </footer>`;
    fitOverlay(dlg.querySelector('[data-img]'), dlg.querySelector('[data-ov]'));
    photoURL(p.id).then((u) => { const img = dlg.querySelector('[data-img]'); if (img) img.src = u || ''; });
    dlg.querySelectorAll('.cr-thumb img[data-pid]').forEach(async (img) => { img.src = (await photoURL(img.dataset.pid)) || ''; });
  };

  const go = (d) => { pos = Math.max(0, Math.min(keys.length, pos + d)); loadDraft(); render(); };
  const save = async () => {
    const v = visit();
    if (!v) return;
    const rec = { ids: [...v.ids], counts: { ...draft.counts }, bucks: [...draft.bucks], at: new Date().toISOString() };
    // The named bucks go on the visit's buck photos (all of them if none were labeled buck).
    const anyBuckPhoto = v.ids.some((x) => D.photoDeer(db.get('photos', x)).buck > 0);
    await db.putMany('photos', v.ids.map((id) => {
      const p = db.get('photos', id);
      const showsBuck = D.photoDeer(p).buck > 0 || !anyBuckPhoto;
      const keep = D.photoBucks(p).filter((x) => draft.bucks.includes(x));
      return { ...D.withBucks(p, draft.counts.buck && showsBuck ? draft.bucks : keep), review: rec, buckAuto: false };
    }));
    state = censusNow();
    go(1);
  };
  const close = () => { dlg.close(); dlg.remove(); };

  dlg.addEventListener('click', async (e) => {
    const b = e.target.closest('button, [data-x]');
    if (!b) return;
    if (b.hasAttribute('data-x')) return close();
    if (b.hasAttribute('data-go-todo')) { filter = 'todo'; state = censusNow(); keys = state.visits.filter((v) => matches(v, 'todo')).map((v) => v.key); pos = 0; loadDraft(); return render(); }
    if (b.hasAttribute('data-prev')) return go(-1);
    if (b.hasAttribute('data-skip')) return go(1);
    if (b.hasAttribute('data-ok')) return save();
    if (b.hasAttribute('data-zoom')) { const v = visit(); return openViewer(v.ids, photoIdx); }
    if (b.dataset.ph != null) { photoIdx = Number(b.dataset.ph); return render(); }
    if (b.dataset.cnt) { const [k, d] = b.dataset.cnt.split(':'); draft.counts[k] = Math.max(0, draft.counts[k] + Number(d)); draft.bucks = draft.bucks.slice(0, draft.counts.buck); return render(); }
    if (b.dataset.preset) { const [bk, doe, fawn] = b.dataset.preset.split(',').map(Number); draft.counts = { buck: bk, doe, fawn }; if (!bk) draft.bucks = []; return render(); }
    if (b.dataset.buck) {
      const id = b.dataset.buck;
      draft.bucks = draft.bucks.includes(id) ? draft.bucks.filter((x) => x !== id) : [...draft.bucks, id];
      draft.counts.buck = Math.max(draft.counts.buck, draft.bucks.length); // two bucks picked = at least two bucks
      return render();
    }
    if (b.hasAttribute('data-nobuck')) { draft.bucks = []; return render(); }
    if (b.hasAttribute('data-newbuck')) {
      const name = (prompt('Name this buck (e.g. Big 8, Drop Tine):') || '').trim();
      if (!name) return;
      const v = visit();
      const nb = await db.put('bucks', { name, status: 'active', refs: [v.ids[photoIdx]] });
      draft.bucks = [...draft.bucks, nb.id];
      draft.counts.buck = Math.max(draft.counts.buck, draft.bucks.length);
      return render();
    }
  });
  dlg.addEventListener('change', (e) => {
    if (!e.target.matches('[data-filter]')) return;
    filter = e.target.value; state = censusNow();
    keys = state.visits.filter((v) => matches(v, filter)).map((v) => v.key);
    pos = 0; loadDraft(); render();
  });
  // Swipe the photo: left = skip to the next visit, right = back.
  let sx = null, sy = null;
  dlg.addEventListener('pointerdown', (e) => { if (e.target.closest('[data-swipe]')) { sx = e.clientX; sy = e.clientY; } });
  dlg.addEventListener('pointerup', (e) => {
    if (sx == null) return;
    const dx = e.clientX - sx, dy = e.clientY - sy; sx = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
  });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  loadDraft();
  render();
  dlg.showModal();
}
