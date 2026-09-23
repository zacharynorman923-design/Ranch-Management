/* Ops layer: task calendar with seasonal templates, contacts, GPS photo log,
   settings and backup. */
import * as db from '../db.js';
import * as C from '../calc.js';
import { S, DEFAULTS } from '../model.js';
import { addPhotoFile, photoURL, deletePhoto } from '../photos.js';
import { loadSample, removeSample } from '../sample.js';
import { esc, stat, pill, listPanel, dateLabel, daysLabel, toast, download, openForm } from '../ui.js';

/* --------------------------------- tasks --------------------------------- */
let showDone = false;
export function tasks() {
  const t = C.today();
  const all = db.all('tasks');
  const open = all.filter((x) => !x.done).sort((a, b) => (a.date < b.date ? -1 : 1));
  const overdue = open.filter((x) => x.date < t);
  const soon = open.filter((x) => x.date >= t && C.daysBetween(t, x.date) <= 30);
  const later = open.filter((x) => C.daysBetween(t, x.date) > 30);
  const y = C.yearOf(t);
  const group = (title, rows, tone) => rows.length ? `<h3>${title}</h3><ul class="tasks">${rows.map((x) => `
    <li><label><input type="checkbox" data-done="${esc(x.id)}"> <span>${esc(x.title)}</span></label>
      <span class="task-meta">${pill(`${dateLabel(x.date)} · ${daysLabel(C.daysBetween(t, x.date))}`, tone)} <small>${esc(x.category || '')}${x.who ? ' · ' + esc(x.who) : ''}</small>
      <button class="btn sm link" data-edit="tasks:${esc(x.id)}">Edit</button></span></li>`).join('')}</ul>` : '';
  return `
    <section class="panel">
      <div class="panel-head"><h2>Task calendar</h2>
        <div class="head-actions">
          <select data-tpl-year>${[y, y + 1].map((v) => `<option>${v}</option>`).join('')}</select>
          <button class="btn" data-tpl>Add seasonal template</button>
          <button class="btn primary" data-add="tasks">＋ Task</button></div></div>
      <div class="stats">${stat('Overdue', overdue.length, '', overdue.length ? 'bad' : '')}${stat('Next 30 days', soon.length)}${stat('Later', later.length)}</div>
      ${group('Overdue', overdue, 'bad')}${group('Next 30 days', soon, 'warn')}${group('Later', later.slice(0, 40), '')}
      ${open.length ? '' : '<p class="empty">Nothing open. Add the seasonal template to get burn windows, planting, hunting seasons, preg check and paperwork dates.</p>'}
      <p class="note">The template covers burn windows, milo planting, the dove opener with feeder pull-back, archery and general deer openers, calving, working calves, bull in/out, preg check, weaning, the valuation report and lease renewals. Deer and dove dates follow TPWD's usual pattern, so confirm them in the Outdoor Annual each year.</p>
    </section>
    ${showDone ? listPanel('tasks', { rows: all.filter((x) => x.done), title: 'Done' }) : ''}
    <button class="btn link" data-showdone>${showDone ? 'Hide' : 'Show'} completed</button>`;
}
export function bindTasks(el, rerender) {
  el.querySelectorAll('[data-done]').forEach((c) => c.addEventListener('change', async () => {
    const r = db.get('tasks', c.dataset.done);
    await db.put('tasks', { ...r, done: c.checked });
  }));
  el.querySelector('[data-showdone]')?.addEventListener('click', () => { showDone = !showDone; rerender(); });
  el.querySelector('[data-tpl]')?.addEventListener('click', async () => {
    const y = Number(el.querySelector('[data-tpl-year]').value);
    const s = S();
    const have = new Set(db.all('tasks').map((x) => `${x.date}|${x.title}`));
    const add = C.seasonalTemplate(y, { doveOpener: s.opener, calving: s.calving }).filter((x) => !have.has(`${x.date}|${x.title}`));
    await db.putMany('tasks', add.map((x) => ({ ...x, done: false })));
    toast(`Added ${add.length} tasks for ${y}`);
  });
}

/* -------------------------------- contacts ------------------------------- */
export function contacts() {
  const cs = db.all('contacts').sort((a, b) => (a.role || '').localeCompare(b.role || '') || a.name.localeCompare(b.name));
  return `
    <section class="panel">
      <div class="panel-head"><h2>Vendors & contacts</h2><button class="btn primary" data-add="contacts">＋ Add</button></div>
      ${cs.length ? `<div class="cards">${cs.map((c) => `<div class="card">
        <div class="card-head"><b>${esc(c.name)}</b><small>${esc(c.role || '')}${c.company ? ' · ' + esc(c.company) : ''}</small></div>
        <div class="card-body">${c.phone ? `<a class="btn sm" href="tel:${esc(c.phone.replace(/[^\d+]/g, ''))}">📞 ${esc(c.phone)}</a> <a class="btn sm" href="sms:${esc(c.phone.replace(/[^\d+]/g, ''))}">💬</a>` : ''}
          ${c.email ? `<a class="btn sm" href="mailto:${esc(c.email)}">✉︎</a>` : ''}${c.notes ? `<p class="small muted">${esc(c.notes)}</p>` : ''}</div>
        <div class="card-foot"><button class="btn sm link" data-edit="contacts:${esc(c.id)}">Edit</button></div></div>`).join('')}</div>`
        : '<p class="empty">Vet, feed store, sale barn, Mason CAD, NRCS, TPWD biologist, neighbor, day hand, game warden…</p>'}
    </section>`;
}

/* --------------------------------- photos -------------------------------- */
let tagFilter = '';
export function photos(params) {
  const device = params.get('device') || '';
  let ps = db.all('photos').sort((a, b) => (a.date < b.date ? 1 : -1));
  if (device) ps = ps.filter((p) => p.device === device);
  const tags = [...new Set(db.all('photos').flatMap((p) => String(p.tags || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)))].sort();
  if (tagFilter) ps = ps.filter((p) => String(p.tags || '').toLowerCase().split(',').map((x) => x.trim()).includes(tagFilter));
  const dev = device ? db.get('devices', device) : null;
  return `
    <section class="panel">
      <div class="panel-head"><h2>Photo log${dev ? ` · ${esc(dev.name)}` : ''}</h2>
        <label class="btn primary">📷 Add photos<input type="file" accept="image/*" multiple data-upload hidden></label></div>
      <p class="note">Photos keep their GPS and date from the camera. A photo you just took gets the phone's GPS instead. Trail-cam dumps usually have no GPS, so pick the camera and they inherit its location. Tag them <i>buck, doe, hog, predator</i> to build a picture of what's moving where.</p>
      ${dev ? '' : `<div class="form-grid"><label class="field">Trail camera for this upload<select data-updev><option value="">—</option>${db.all('devices').filter((d) => d.type === 'camera').map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}</select></label>
        <label class="field">Tags for this upload<input data-uptags placeholder="buck, feeder 2"></label></div>`}
      ${tags.length ? `<div class="chips"><button class="chip ${tagFilter ? '' : 'on'}" data-tag="">all</button>${tags.map((t) => `<button class="chip ${t === tagFilter ? 'on' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}</div>` : ''}
      ${ps.length ? `<div class="gallery">${ps.slice(0, 120).map((p) => `
        <figure data-photo="${esc(p.id)}"><img data-pid="${esc(p.id)}" alt="${esc(p.caption || '')}" loading="lazy">
          <figcaption>${esc(p.caption || '')}<br><small>${esc(p.date || '')}${p.loc?.lat ? ' · 📍' : ''}${p.packet ? ' · 📁' : ''}${p.tags ? ' · ' + esc(p.tags) : ''}</small></figcaption></figure>`).join('')}</div>`
        : '<p class="empty">No photos yet.</p>'}
    </section>`;
}
export function bindPhotos(el, rerender, params) {
  el.querySelectorAll('img[data-pid]').forEach(async (img) => { img.src = (await photoURL(img.dataset.pid)) || ''; });
  el.querySelectorAll('[data-tag]').forEach((b) => b.addEventListener('click', () => { tagFilter = b.dataset.tag; rerender(); }));
  el.querySelectorAll('figure[data-photo]').forEach((f) => f.addEventListener('click', async () => {
    const p = db.get('photos', f.dataset.photo);
    const r = await openForm('photos', p);
    if (!r && !db.get('photos', p.id)) await deletePhoto(p.id);
  }));
  el.querySelector('[data-upload]')?.addEventListener('change', async (e) => {
    const files = [...e.target.files];
    const device = params.get('device') || el.querySelector('[data-updev]')?.value || '';
    const tags = el.querySelector('[data-uptags]')?.value || '';
    const devLoc = device ? db.get('devices', device)?.loc : null;
    let n = 0;
    for (const file of files) {
      try {
        const rec = await addPhotoFile(file, { device, tags });
        if (!rec.loc && devLoc) await db.put('photos', { ...rec, loc: devLoc });
        n++;
      } catch (err) { toast(`${file.name}: ${err.message}`); }
    }
    toast(`Added ${n} photo${n === 1 ? '' : 's'}`);
  });
}

/* -------------------------------- settings ------------------------------- */
export function settings() {
  const s = S();
  const counts = ['animals', 'events', 'rain', 'harvests', 'surveys', 'ledger', 'photos'].map((c) => `${db.all(c).length} ${c}`).join(' · ');
  return `
    <section class="panel">
      <div class="panel-head"><h2>Place</h2></div>
      <div class="form-grid">
        <label class="field">Place name<input data-set="ranchName" value="${esc(s.ranchName)}"></label>
        <label class="field">Owner<input data-set="owner" value="${esc(s.owner)}"></label>
        <label class="field">County<input data-set="county" value="${esc(s.county)}"></label>
        <label class="field">Acres<input type="number" data-set="acres" value="${s.acres}"></label>
        <label class="field">Acres per AU (normal year)<input type="number" step="0.5" data-set="acresPerAU" value="${s.acresPerAU}"></label>
        <label class="field">Calving season<select data-set="calving"><option value="spring" ${s.calving === 'spring' ? 'selected' : ''}>Spring</option><option value="fall" ${s.calving === 'fall' ? 'selected' : ''}>Fall</option></select></label>
        <label class="field">Dove opener (MM-DD)<input data-set="opener" value="${esc(s.opener)}" pattern="\\d{2}-\\d{2}"></label>
        <label class="field">Default rain gauge<input data-set="defaultGauge" value="${esc(s.defaultGauge || 'Headquarters')}"></label>
      </div>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Monthly rain normals (inches)</h2><button class="btn sm" data-reset-normals>Reset to Mason defaults</button></div>
      <div class="normals">${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((m, i) => `<label>${m}<input type="number" step="0.01" data-normal="${i}" value="${s.normals[i]}"></label>`).join('')}</div>
      <p class="note">Defaults are approximate normals for Mason, TX (about ${s.normals.reduce((a, b) => a + Number(b), 0).toFixed(1)}″/yr). For exact figures, use NOAA's 1991–2020 normals for the nearest station, or your own gauge's long-term average.</p>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Backup & devices</h2></div>
      <p class="note">Everything is stored <b>on this device only</b> (${counts}). Export a backup after each trip and keep it in iCloud/Drive. Import it on another phone or computer to carry records over. Records are merged, and the newer copy wins.</p>
      <div class="head-actions">
        <button class="btn primary" data-export>Export backup</button>
        <label class="btn">Import backup<input type="file" accept=".json,application/json" data-import hidden></label>
        ${db.all('animals').some((a) => a.sample) ? '<button class="btn" data-unsample>Remove sample data</button>' : '<button class="btn" data-sample>Load sample ranch</button>'}
        <button class="btn danger" data-wipe>Erase everything</button>
      </div>
      <p class="note small">Last backup: ${s.lastBackup ? dateLabel(s.lastBackup.slice(0, 10)) : 'never'}</p>
    </section>`;
}
export function bindSettings(el) {
  el.querySelectorAll('[data-normal]').forEach((inp) => inp.addEventListener('change', async () => {
    const n = [...S().normals];
    n[Number(inp.dataset.normal)] = Number(inp.value) || 0;
    await db.saveSettings({ normals: n });
  }));
  el.querySelector('[data-reset-normals]')?.addEventListener('click', () => db.saveSettings({ normals: DEFAULTS.normals }));
  el.querySelector('[data-export]')?.addEventListener('click', async () => {
    const data = await db.exportAll();
    download(`mason-ranch-backup-${C.today()}.json`, JSON.stringify(data), 'application/json');
    await db.saveSettings({ lastBackup: new Date().toISOString() });
  });
  el.querySelector('[data-import]')?.addEventListener('change', async (e) => {
    try {
      const r = await db.importAll(JSON.parse(await e.target.files[0].text()));
      toast(`Imported ${r.records} records, ${r.blobs} photos`);
    } catch (err) { toast(`Import failed: ${err.message}`); }
  });
  el.querySelector('[data-sample]')?.addEventListener('click', async () => {
    if (db.all('animals').length && !confirm('Add sample records alongside your own data?')) return;
    await loadSample();
    toast('Sample ranch loaded');
  });
  el.querySelector('[data-unsample]')?.addEventListener('click', async () => {
    toast(`Removed ${await removeSample()} sample records`);
  });
  el.querySelector('[data-wipe]')?.addEventListener('click', async () => {
    if (prompt('This deletes every record and photo on this device. Type ERASE to confirm.') !== 'ERASE') return;
    await db.importAll({ app: 'mason-ranch', records: [], blobs: [] }, { replace: true });
    toast('Erased');
  });
}
