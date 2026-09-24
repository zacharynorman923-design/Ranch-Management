/* =========================================================================
   Generic UI: the record form (a modal), record tables, CSV in/out, and the
   small formatting helpers every page uses. All of it is driven by schema.js.
   ========================================================================= */
import * as db from './db.js';
import { COLLECTIONS, titleOf } from './schema.js';
import { addPhotoFile, photoURL } from './photos.js';

/* ------------------------------ formatting ------------------------------- */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const n0 = (x) => (x == null || isNaN(x) ? '—' : Math.round(x).toLocaleString());
export const n1 = (x) => (x == null || isNaN(x) ? '—' : (Math.round(x * 10) / 10).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
export const n2 = (x) => (x == null || isNaN(x) ? '—' : Number(x).toFixed(2));
export const pct = (x) => (x == null || isNaN(x) ? '—' : `${Math.round(x * 100)}%`);
export const usd = (x) => (x == null || isNaN(x) ? '—' : `${x < 0 ? '−' : ''}$${Math.abs(Math.round(x)).toLocaleString()}`);
export const dateLabel = (iso) => {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};
export const daysLabel = (d) => (d == null ? '' : d === 0 ? 'today' : d > 0 ? `in ${d} d` : `${-d} d overdue`);

/* -------------------------------- toast ---------------------------------- */
export function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('out'), 2200);
  setTimeout(() => t.remove(), 2700);
}

/* ------------------------------ cell display ----------------------------- */
const fieldOf = (col, k) => COLLECTIONS[col].fields.find((f) => f.k === k);
export function cell(col, rec, k) {
  const f = fieldOf(col, k);
  const v = rec[k];
  if (!f) return esc(v);
  if (v === '' || v == null) return '<span class="muted">—</span>';
  switch (f.t) {
    case 'ref': return esc(titleOf(f.ref, db.get(f.ref, v)) || '?');
    case 'select': return esc(f.opts.find((x) => x.v === String(v))?.l ?? v);
    case 'bool': return v ? '✓' : '';
    case 'date': return `<span class="nowrap">${esc(v)}</span>`;
    case 'num': return `<span class="num">${esc(Number(v).toLocaleString(undefined, { maximumFractionDigits: 3 }))}</span>`;
    case 'photos': return v.length ? `📷 ${v.length}` : '';
    case 'loc': return v?.lat ? '📍' : '';
    default: return esc(v);
  }
}

/* ---------------------------------- form --------------------------------- */
/**
 * Open the edit form for a record (or a new one with `preset` values).
 * Resolves to the saved record, or null if cancelled/deleted.
 */
export function openForm(col, rec = null, preset = {}) {
  const def = COLLECTIONS[col];
  const isNew = !rec;
  const state = { ...(rec || {}) };
  if (isNew) {
    for (const f of def.fields) {
      if (f.def === undefined) continue;
      state[f.k] = typeof f.def === 'function' ? f.def(state) : f.def;
    }
    Object.assign(state, preset);
  }
  state.photos = [...(state.photos || [])];

  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'sheet';
    document.body.appendChild(dlg);
    const close = (val) => { dlg.close(); dlg.remove(); resolve(val); };

    const render = () => {
      dlg.innerHTML = `
        <form method="dialog" class="sheet-form" novalidate>
          <header class="sheet-head">
            <h2>${isNew ? 'New' : 'Edit'} ${esc(def.label.toLowerCase())}</h2>
            <button type="button" class="icon-btn" data-x aria-label="Close">✕</button>
          </header>
          <div class="sheet-body">${def.fields.filter((f) => !f.show || f.show(state)).map((f) => fieldHTML(f, state)).join('')}</div>
          <footer class="sheet-foot">
            ${isNew ? '' : '<button type="button" class="btn danger" data-del>Delete</button>'}
            <span class="grow"></span>
            <button type="button" class="btn" data-x>Cancel</button>
            <button type="submit" class="btn primary">Save</button>
          </footer>
        </form>`;
      bindPhotos();
    };
    const read = () => {
      for (const f of def.fields) {
        const el = dlg.querySelector(`[name="${f.k}"]`);
        if (f.t === 'loc') {
          const lat = dlg.querySelector(`[name="${f.k}.lat"]`), lon = dlg.querySelector(`[name="${f.k}.lon"]`);
          if (lat) state[f.k] = lat.value && lon.value ? { lat: Number(lat.value), lon: Number(lon.value) } : null;
        } else if (!el) continue;
        else if (f.t === 'bool') state[f.k] = el.checked;
        else if (f.t === 'num') state[f.k] = el.value === '' ? '' : Number(el.value);
        else state[f.k] = el.value.trim();
      }
    };
    const bindPhotos = () => {
      dlg.querySelectorAll('.thumb[data-pid]').forEach(async (img) => { img.src = (await photoURL(img.dataset.pid)) || ''; });
    };

    dlg.addEventListener('change', (e) => {
      // Re-render so conditional fields (show: …) follow selects like "Event".
      if (e.target.matches('select, input[type=checkbox]')) {
        read();
        const f = def.fields.find((x) => x.k === e.target.name);
        if (f?.t === 'select' && col === 'brush' && f.k === 'species' && isNew) {
          const r = def.fields.find((x) => x.k === 'retreatYears');
          state.retreatYears = r.def(state);
        }
        render();
      }
      if (e.target.matches('input[type=file][data-photo]')) {
        const files = [...e.target.files];
        read();
        Promise.all(files.map((file) => addPhotoFile(file, { caption: `${def.label}${state.date ? ' ' + state.date : ''}` })))
          .then((ps) => { state.photos.push(...ps.map((p) => p.id)); render(); })
          .catch((err) => toast(`Photo failed: ${err.message}`));
      }
    });
    dlg.addEventListener('click', async (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.hasAttribute('data-x')) close(null);
      if (t.hasAttribute('data-gps')) {
        read();
        try {
          const p = await here();
          state[t.dataset.gps] = { lat: +p.coords.latitude.toFixed(6), lon: +p.coords.longitude.toFixed(6) };
          render();
        } catch (err) { toast(`No GPS fix: ${err.message}`); }
      }
      if (t.hasAttribute('data-pickmap')) {
        read();
        const { pickOnMap } = await import('./mappick.js');
        const spot = await pickOnMap({ initial: state[t.dataset.pickmap], title: `Where is this ${def.label.toLowerCase()}?` });
        if (spot) { state[t.dataset.pickmap] = spot; render(); }
      }
      if (t.hasAttribute('data-unlink')) { read(); state.photos = state.photos.filter((x) => x !== t.dataset.unlink); render(); }
      if (t.hasAttribute('data-del') && confirm(`Delete this ${def.label.toLowerCase()}?`)) {
        await db.del(col, rec.id);
        toast('Deleted');
        close(null);
      }
    });
    dlg.addEventListener('submit', async (e) => {
      e.preventDefault();
      read();
      const missing = def.fields.filter((f) => f.req && (!f.show || f.show(state)) && (state[f.k] === '' || state[f.k] == null));
      if (missing.length) { toast(`Needs: ${missing.map((f) => f.label).join(', ')}`); return; }
      const saved = await db.put(col, state);
      toast('Saved');
      close(saved);
    });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });

    render();
    dlg.showModal();
  });
}

export const here = () => new Promise((res, rej) => {
  if (!navigator.geolocation) return rej(new Error('GPS not available'));
  navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
});

function fieldHTML(f, s) {
  const v = s[f.k] ?? '';
  const id = `f_${f.k}`;
  const help = f.help ? `<small class="help">${esc(f.help)}</small>` : '';
  const lab = `<label for="${id}">${esc(f.label)}${f.req ? ' <b class="req">*</b>' : ''}</label>`;
  switch (f.t) {
    case 'textarea':
      return `<div class="field wide">${lab}<textarea id="${id}" name="${f.k}" rows="2">${esc(v)}</textarea>${help}</div>`;
    case 'bool':
      return `<div class="field wide check"><label><input type="checkbox" name="${f.k}" ${v ? 'checked' : ''}> ${esc(f.label)}</label>${help}</div>`;
    case 'select':
      return `<div class="field">${lab}<select id="${id}" name="${f.k}"><option value=""></option>${f.opts.map((x) => `<option value="${esc(x.v)}" ${String(v) === x.v ? 'selected' : ''}>${esc(x.l)}</option>`).join('')}</select>${help}</div>`;
    case 'ref': {
      const rows = db.all(f.ref).filter((r) => !f.filter || f.filter(r) || r.id === v)
        .sort((a, b) => titleOf(f.ref, a).localeCompare(titleOf(f.ref, b), undefined, { numeric: true }));
      return `<div class="field">${lab}<select id="${id}" name="${f.k}"><option value=""></option>${rows.map((r) => `<option value="${esc(r.id)}" ${v === r.id ? 'selected' : ''}>${esc(titleOf(f.ref, r))}</option>`).join('')}</select>${rows.length ? '' : `<small class="help">None yet — add one under ${esc(COLLECTIONS[f.ref].label)}s first.</small>`}${help}</div>`;
    }
    case 'loc':
      return `<div class="field wide">${lab}<div class="loc-row">
        <input name="${f.k}.lat" inputmode="decimal" placeholder="Latitude" value="${esc(v?.lat ?? '')}">
        <input name="${f.k}.lon" inputmode="decimal" placeholder="Longitude" value="${esc(v?.lon ?? '')}">
        <button type="button" class="btn" data-gps="${f.k}">📍 Here</button>
        <button type="button" class="btn" data-pickmap="${f.k}">🗺 Map</button></div>${help}</div>`;
    case 'photos':
      return `<div class="field wide">${lab}<div class="thumbs">
        ${(s.photos || []).map((pid) => `<span class="thumb-wrap"><img class="thumb" data-pid="${esc(pid)}" alt=""><button type="button" class="icon-btn sm" data-unlink="${esc(pid)}" aria-label="Remove">✕</button></span>`).join('')}
        <label class="btn add-photo">＋ Photo<input type="file" accept="image/*" capture="environment" multiple data-photo hidden></label>
      </div>${help}</div>`;
    case 'num':
      return `<div class="field">${lab}<input id="${id}" name="${f.k}" type="number" inputmode="decimal" step="${f.step || 'any'}" value="${esc(v)}">${help}</div>`;
    case 'date':
      return `<div class="field">${lab}<input id="${id}" name="${f.k}" type="date" value="${esc(v)}">${help}</div>`;
    default: {
      const dl = f.list ? `<datalist id="${id}_l">${f.list.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>` : '';
      return `<div class="field">${lab}<input id="${id}" name="${f.k}" value="${esc(v)}" ${f.list ? `list="${id}_l"` : ''} autocomplete="off">${dl}${help}</div>`;
    }
  }
}

/* --------------------------------- tables -------------------------------- */
export function sortRows(col, rows, key = COLLECTIONS[col].sort) {
  const desc = key.startsWith('-');
  const k = key.replace(/^-/, '');
  return [...rows].sort((a, b) => {
    const x = a[k] ?? '', y = b[k] ?? '';
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
    return desc ? -c : c;
  });
}

/**
 * A panel with a record table plus Add / CSV buttons. Rows open the form.
 * opts: { title, rows, cols, preset, note, limit, extraCols: [{label, html(r)}], actions: html }
 */
export function listPanel(col, opts = {}) {
  const def = COLLECTIONS[col];
  const rows = sortRows(col, opts.rows ?? db.all(col));
  const cols = opts.cols || def.cols;
  const limit = opts.limit ?? 25;
  const key = `${col}-${Math.random().toString(36).slice(2, 7)}`;
  const heads = cols.map((k) => `<th>${esc(fieldOf(col, k)?.label || k)}</th>`).join('') + (opts.extraCols || []).map((c) => `<th>${esc(c.label)}</th>`).join('');
  const body = rows.map((r, i) => `<tr data-edit="${col}:${esc(r.id)}" class="${i >= limit ? 'more hidden' : ''}">${cols.map((k) => `<td>${cell(col, r, k)}</td>`).join('')}${(opts.extraCols || []).map((c) => `<td>${c.html(r)}</td>`).join('')}</tr>`).join('');
  return `
    <section class="panel" id="${key}">
      <div class="panel-head">
        <h2>${esc(opts.title || def.label + 's')}</h2>
        <div class="head-actions">
          ${opts.actions || ''}
          <button class="btn primary" data-add="${col}" ${opts.preset ? `data-preset='${esc(JSON.stringify(opts.preset))}'` : ''}>＋ Add</button>
          <details class="menu"><summary class="btn" aria-label="More">⋯</summary><div class="menu-pop">
            <button class="btn" data-csv-out="${col}">Export CSV</button>
            <label class="btn">Import CSV<input type="file" accept=".csv,text/csv" data-csv-in="${col}" hidden></label>
          </div></details>
        </div>
      </div>
      ${opts.note ? `<p class="note">${opts.note}</p>` : ''}
      ${rows.length ? `<div class="table-wrap"><table class="tbl"><thead><tr>${heads}</tr></thead><tbody>${body}</tbody></table></div>
        ${rows.length > limit ? `<button class="btn link" data-more="${key}">Show all ${rows.length}</button>` : ''}`
        : `<p class="empty">${esc(opts.empty || `No ${def.label.toLowerCase()}s yet.`)}</p>`}
    </section>`;
}

/* Delegated handlers for everything listPanel emits — installed once. */
export function installListHandlers(root) {
  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-edit],[data-add],[data-csv-out],[data-more]');
    if (!t) return;
    if (t.dataset.edit) {
      const [col, id] = t.dataset.edit.split(':');
      openForm(col, db.get(col, id));
    } else if (t.dataset.add) {
      openForm(t.dataset.add, null, t.dataset.preset ? JSON.parse(t.dataset.preset) : {});
    } else if (t.dataset.csvOut) {
      download(`${t.dataset.csvOut}.csv`, toCSV(t.dataset.csvOut), 'text/csv');
    } else if (t.dataset.more) {
      document.querySelectorAll(`#${t.dataset.more} tr.more`).forEach((r) => r.classList.remove('hidden'));
      t.remove();
    }
  });
  root.addEventListener('change', async (e) => {
    const inp = e.target.closest('[data-csv-in]');
    if (!inp || !inp.files[0]) return;
    try {
      const n = await fromCSV(inp.dataset.csvIn, await inp.files[0].text());
      toast(`Imported ${n} rows`);
    } catch (err) { toast(`Import failed: ${err.message}`); }
    inp.value = '';
  });
}

/* ----------------------------------- CSV --------------------------------- */
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function toCSV(col) {
  const fs = COLLECTIONS[col].fields.filter((f) => f.t !== 'photos');
  const head = ['id', ...fs.flatMap((f) => (f.t === 'loc' ? [`${f.k}_lat`, `${f.k}_lon`] : [f.k]))];
  const lines = sortRows(col, db.all(col)).map((r) => [r.id, ...fs.flatMap((f) => {
    if (f.t === 'loc') return [r[f.k]?.lat ?? '', r[f.k]?.lon ?? ''];
    if (f.t === 'ref') return [titleOf(f.ref, db.get(f.ref, r[f.k]))];
    return [r[f.k]];
  })].map(csvCell).join(','));
  return [head.join(','), ...lines].join('\n');
}
export function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}
/**
 * Import rows. Headers match field keys or labels (case-insensitive), so a
 * sale barn or sensor export can be loaded after renaming a column or two.
 * Reference columns match the linked record's name/tag.
 */
export async function fromCSV(col, text) {
  const [head, ...rows] = parseCSV(text);
  if (!head) throw new Error('empty file');
  const fs = COLLECTIONS[col].fields;
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const map = head.map((h) => {
    const n = norm(h);
    if (n === 'id') return { id: true };
    for (const f of fs) {
      if (f.t === 'loc' && (n === norm(f.k + 'lat') || n === 'lat' || n === 'latitude')) return { f, part: 'lat' };
      if (f.t === 'loc' && (n === norm(f.k + 'lon') || n === 'lon' || n === 'lng' || n === 'longitude')) return { f, part: 'lon' };
      if (n === norm(f.k) || n === norm(f.label)) return { f };
    }
    return null;
  });
  const recs = rows.map((cells) => {
    const r = {};
    cells.forEach((raw, i) => {
      const m = map[i]; const v = raw.trim();
      if (!m) return;
      if (m.id) { if (v) { r.id = v; Object.assign(r, db.get(col, v) || {}); } return; }
      const f = m.f;
      if (m.part) { r[f.k] = { ...(r[f.k] || {}), [m.part]: Number(v) }; return; }
      if (f.t === 'num') r[f.k] = v === '' ? '' : Number(v.replace(/[$,]/g, ''));
      else if (f.t === 'bool') r[f.k] = /^(1|y|yes|true|x|✓)$/i.test(v);
      else if (f.t === 'date') r[f.k] = normDate(v);
      else if (f.t === 'ref') {
        const hit = db.all(f.ref).find((x) => x.id === v || titleOf(f.ref, x) === v || x.tag === v || x.name === v);
        r[f.k] = hit ? hit.id : '';
      } else if (f.t === 'select') r[f.k] = f.opts.find((o) => norm(o.v) === norm(v) || norm(o.l) === norm(v))?.v ?? v;
      else r[f.k] = v;
    });
    return r;
  }).filter((r) => Object.keys(r).length);
  await db.putMany(col, recs);
  return recs.length;
}
/** Accept 2026-09-01, 9/1/2026 and 9/1/26. */
export function normDate(v) {
  if (!v) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  return v;
}

export function download(name, content, type = 'application/octet-stream') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

/* ------------------------------- widgets --------------------------------- */
export const stat = (label, value, sub = '', tone = '') =>
  `<div class="stat ${tone}"><div class="stat-label">${esc(label)}</div><div class="stat-value">${value}</div>${sub ? `<div class="stat-sub">${sub}</div>` : ''}</div>`;
export const pill = (text, tone = '') => `<span class="pill ${tone}">${esc(text)}</span>`;

/** Simple inline-SVG bar chart: bars = [{label, value, ref?}] (ref draws a tick). */
export function barChart(bars, { unit = '', height = 150 } = {}) {
  const max = Math.max(1e-9, ...bars.map((b) => Math.max(b.value || 0, b.ref || 0)));
  const w = 100 / bars.length;
  return `<svg class="bars" viewBox="0 0 100 ${height / 3}" preserveAspectRatio="none" role="img" aria-label="Bar chart">
    ${bars.map((b, i) => {
      const H = height / 3 - 6;
      const h = ((b.value || 0) / max) * H;
      const r = b.ref != null ? H - (b.ref / max) * H : null;
      return `<g><title>${esc(b.label)}: ${b.value == null ? 'no data' : n2(b.value) + unit}${b.ref != null ? ` (normal ${n2(b.ref)}${unit})` : ''}</title>
        ${b.value == null ? '' : `<rect x="${i * w + w * 0.18}" y="${H - h}" width="${w * 0.64}" height="${Math.max(h, 0.3)}" rx="0.6" class="bar ${b.tone || ''}"/>`}
        ${r != null ? `<rect x="${i * w + w * 0.08}" y="${r - 0.35}" width="${w * 0.84}" height="0.7" class="bar-ref"/>` : ''}</g>`;
    }).join('')}
  </svg>
  <div class="bar-labels">${bars.map((b) => `<span>${esc(b.label)}</span>`).join('')}</div>`;
}
