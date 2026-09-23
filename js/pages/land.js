/* Land & water: water points, brush management, fences & gates, ranch map. */
import * as db from '../db.js';
import * as C from '../calc.js';
import { S } from '../model.js';
import { esc, n0, n1, usd, stat, pill, listPanel, dateLabel, daysLabel, toast, openForm } from '../ui.js';

/* --------------------------------- water --------------------------------- */
export function water() {
  const t = C.today();
  const s = S();
  const checks = db.all('waterchecks');
  const pts = db.all('waterpoints').sort((a, b) => a.name.localeCompare(b.name));
  return `
    <section class="panel">
      <div class="panel-head"><h2>Water points</h2></div>
      ${pts.length ? `<div class="cards">${pts.map((w) => {
        const mine = checks.filter((c) => c.point === w.id).sort((a, b) => (a.date < b.date ? 1 : -1));
        const last = mine[0];
        const age = last ? C.daysBetween(last.date, t) : null;
        const lvl = last?.level;
        const tone = !last ? 'warn' : last.working === 'no' || (lvl !== '' && lvl != null && lvl < 25) ? 'bad' : age > s.waterStaleDays ? 'warn' : 'good';
        return `<div class="card ${tone}">
          <div class="card-head"><b>${esc(w.name)}</b><small>${esc(w.type)}${w.sensor ? ' · 📡 sensor' : ''}</small></div>
          <div class="card-body">
            ${lvl !== '' && lvl != null ? `<div class="gauge"><span style="width:${Math.max(0, Math.min(100, lvl))}%"></span></div><div class="small">${n0(lvl)}% full</div>` : ''}
            <div class="small">${last ? `Checked ${dateLabel(last.date)} (${age} d ago, ${esc(last.source)})${last.working === 'no' ? ' — <b class="bad-t">needs work</b>' : ''}` : 'Never checked'}</div>
          </div>
          <div class="card-foot"><button class="btn sm" data-check="${esc(w.id)}">Log check</button><button class="btn sm link" data-edit="waterpoints:${esc(w.id)}">Edit</button></div>
        </div>`;
      }).join('')}</div>` : '<p class="empty">Add tanks, troughs, wells and windmills.</p>'}
      <div class="form-grid"><label class="field">Flag a point if not checked in (days)<input type="number" data-set="waterStaleDays" value="${s.waterStaleDays}"></label></div>
      <p class="note">Remote level sensors (LoRa/cellular tank monitors, or a trail camera aimed at a trough float) save a 3-hour drive from Houston. Most can export a CSV. Map its columns to <i>point, date, level</i> and use <b>⋯ → Import CSV</b> on the checks table, with <i>source</i> = sensor.</p>
    </section>
    ${listPanel('waterpoints')}
    ${listPanel('waterchecks', { title: 'Level & trough checks' })}
    ${listPanel('waterwork', { title: 'Well / windmill maintenance', note: 'Tick “counts as supplemental water for wildlife” on guzzlers, wildlife troughs and similar work. It feeds the 1-d-1 wildlife practice tracker.' })}`;
}
export function bindWater(el) {
  el.querySelectorAll('[data-check]').forEach((b) => b.addEventListener('click', () => openForm('waterchecks', null, { point: b.dataset.check })));
}

/* --------------------------------- brush --------------------------------- */
export function brush() {
  const t = C.today();
  const rows = db.all('brush').map((b) => C.brushRow(b, t));
  const years = {};
  for (const r of rows) {
    const y = C.yearOf(r.date);
    const k = `${y}|${r.species}`;
    (years[k] ||= { y, species: r.species, acres: 0, cost: 0, share: 0 });
    years[k].acres += Number(r.acres) || 0;
    years[k].cost += Number(r.cost) || 0;
    years[k].share += Number(r.costShare) || 0;
  }
  const summary = Object.values(years).sort((a, b) => b.y - a.y || a.species.localeCompare(b.species));
  const totalAc = rows.reduce((s, r) => s + (Number(r.acres) || 0), 0);
  const totalCost = rows.reduce((s, r) => s + (Number(r.cost) || 0) - (Number(r.costShare) || 0), 0);
  const due = rows.filter((r) => r.daysLeft != null && r.daysLeft <= 365).sort((a, b) => a.daysLeft - b.daysLeft);
  return `
    <section class="panel">
      <div class="panel-head"><h2>Brush management</h2></div>
      <div class="stats">
        ${stat('Acres treated (all years)', n0(totalAc))}
        ${stat('Net cost', usd(totalCost), 'after NRCS cost-share')}
        ${stat('Net $/acre', totalAc ? usd(totalCost / totalAc) : '—')}
        ${stat('Retreatment due ≤ 1 yr', due.length, '', due.some((d) => d.overdue) ? 'warn' : '')}
      </div>
      ${summary.length ? `<h3>By year</h3><div class="table-wrap"><table class="tbl"><thead><tr><th>Year</th><th>Target</th><th>Acres</th><th>Cost</th><th>$/ac</th><th>Cost-share</th></tr></thead><tbody>
        ${summary.map((r) => `<tr><td>${r.y}</td><td>${esc(r.species)}</td><td class="num">${n1(r.acres)}</td><td class="num">${usd(r.cost)}</td><td class="num">${r.acres ? usd(r.cost / r.acres) : '—'}</td><td class="num">${r.share ? usd(r.share) : '—'}</td></tr>`).join('')}
      </tbody></table></div>` : ''}
      ${due.length ? `<h3>Retreatment schedule</h3><ul class="plain">${due.map((r) => `<li>${pill(daysLabel(r.daysLeft), r.overdue ? 'bad' : 'warn')} ${esc(r.species)} — ${esc(r.area || 'unnamed area')}, ${n1(r.acres)} ac treated ${dateLabel(r.date)} (${esc(r.method || '')})</li>`).join('')}</ul>` : ''}
      <p class="note">Brush work counts as “habitat control” under wildlife valuation. Drop a GPS pin on each treatment to see it on the <a href="#/map">ranch map</a>.</p>
    </section>
    ${listPanel('brush', { title: 'Treatments', extraCols: [
      { label: '$/ac', html: (r) => { const x = C.brushRow(r, t); return x.costPerAcre == null ? '' : usd(x.costPerAcre); } },
      { label: 'Retreat', html: (r) => { const x = C.brushRow(r, t); return x.due ? `<span class="${x.overdue ? 'bad-t' : ''}">${x.due.slice(0, 7)}</span>` : ''; } },
    ] })}`;
}

/* --------------------------------- fences -------------------------------- */
export function fences() {
  const log = db.all('fencelog');
  const fs = db.all('fences');
  const latest = (id) => log.filter((l) => l.fence === id).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  const len = fs.filter((f) => f.kind === 'segment').reduce((s, f) => s + (Number(f.length) || 0), 0);
  const poor = fs.filter((f) => { const l = latest(f.id); return l && Number(l.condition) <= 2; });
  const spend = log.filter((l) => C.yearOf(l.date) === C.yearOf(C.today())).reduce((s, l) => s + (Number(l.cost) || 0), 0);
  return `
    <section class="panel">
      <div class="panel-head"><h2>Fences & gates</h2></div>
      <div class="stats">
        ${stat('Fence', `${n1(len / 5280)} mi`, `${fs.filter((f) => f.kind === 'segment').length} segments`)}
        ${stat('Gates / gaps / guards', fs.filter((f) => f.kind !== 'segment').length)}
        ${stat('Poor condition', poor.length, poor.map((p) => p.name).slice(0, 3).join(', '), poor.length ? 'bad' : '')}
        ${stat(`Repairs ${C.yearOf(C.today())}`, usd(spend))}
      </div>
    </section>
    ${listPanel('fences', { title: 'Segments & gates', extraCols: [
      { label: 'Condition', html: (f) => { const l = latest(f.id); return l ? pill(`${l.condition}/5 · ${l.date}`, Number(l.condition) <= 2 ? 'bad' : Number(l.condition) >= 4 ? 'good' : '') : '<span class="muted">not checked</span>'; } },
    ] })}
    ${listPanel('fencelog', { title: 'Condition log', note: 'Walk or drive each segment after big rains. Water gaps wash out first.' })}`;
}

/* ---------------------------------- map ---------------------------------- */
/* An offline SVG map: the property boundary (GeoJSON you import once) plus
   every record with a GPS pin. No tiles, so it works with zero bars. */
const LAYERS = [
  { col: 'waterpoints', label: 'Water', color: '#3B82F6', name: (r) => r.name },
  { col: 'devices', label: 'Cameras & feeders', color: '#D97706', name: (r) => r.name },
  { col: 'fences', label: 'Gates & fences', color: '#6B7280', name: (r) => r.name },
  { col: 'brush', label: 'Brush work', color: '#16A34A', name: (r) => `${r.species} ${r.date}` },
  { col: 'dovefields', label: 'Dove fields', color: '#A855F7', name: (r) => r.name },
  { col: 'pastures', label: 'Pastures', color: '#65A30D', name: (r) => r.name },
  { col: 'photos', label: 'Photos', color: '#E11D48', name: (r) => r.caption || r.date },
];
let hidden = new Set(['photos']);
export function map() {
  const boundary = db.settings().boundary || null;
  const rings = boundary ? ringsOf(boundary) : [];
  const pins = [];
  for (const L of LAYERS) {
    if (hidden.has(L.col)) continue;
    for (const r of db.all(L.col)) if (r.loc?.lat && r.loc?.lon) pins.push({ L, r, lat: r.loc.lat, lon: r.loc.lon });
  }
  const pts = [...rings.flat(), ...pins.map((p) => [p.lon, p.lat])];
  let svg = '<p class="empty">Import a boundary or add GPS pins (📍 Here on any form) to see the map.</p>';
  if (pts.length) {
    const lons = pts.map((p) => p[0]), lats = pts.map((p) => p[1]);
    const minX = Math.min(...lons), maxX = Math.max(...lons), minY = Math.min(...lats), maxY = Math.max(...lats);
    const k = Math.cos(((minY + maxY) / 2) * Math.PI / 180);
    const w = Math.max((maxX - minX) * k, 0.002), h = Math.max(maxY - minY, 0.002);
    const W = 1000, H = Math.round(W * (h / w)) || 600;
    const pad = 0.06;
    const X = (lon) => (pad + (1 - 2 * pad) * (((lon - minX) * k) / w)) * W;
    const Y = (lat) => (pad + (1 - 2 * pad) * ((maxY - lat) / h)) * H;
    svg = `<svg class="ranch-map" viewBox="0 0 ${W} ${H}" role="img" aria-label="Ranch map">
      ${rings.map((ring) => `<path class="boundary" d="${ring.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('')}Z"/>`).join('')}
      ${pins.map((p) => `<g class="pin" data-edit="${p.L.col}:${esc(p.r.id)}"><title>${esc(p.L.label)}: ${esc(p.L.name(p.r))}</title>
        <circle cx="${X(p.lon).toFixed(1)}" cy="${Y(p.lat).toFixed(1)}" r="13" fill="${p.L.color}"/>
        <text x="${(X(p.lon) + 18).toFixed(1)}" y="${(Y(p.lat) + 9).toFixed(1)}">${esc(p.L.name(p.r))}</text></g>`).join('')}
    </svg>`;
  }
  return `
    <section class="panel">
      <div class="panel-head"><h2>Ranch map</h2>
        <div class="head-actions"><label class="btn">Import boundary (GeoJSON)<input type="file" accept=".geojson,.json,application/geo+json" data-boundary hidden></label>
        ${boundary ? '<button class="btn" data-clear-boundary>Clear boundary</button>' : ''}</div></div>
      <div class="layer-toggles">${LAYERS.map((L) => `<label><input type="checkbox" data-layer="${L.col}" ${hidden.has(L.col) ? '' : 'checked'}><span class="dot" style="background:${L.color}"></span>${L.label}</label>`).join('')}</div>
      ${svg}
      <p class="note">Get a boundary GeoJSON from the Mason CAD parcel map, or draw one at geojson.io, and import it once. Tap a pin to open its record. North is up.</p>
    </section>`;
}
export function bindMap(el, rerender) {
  el.querySelectorAll('[data-layer]').forEach((c) => c.addEventListener('change', () => {
    c.checked ? hidden.delete(c.dataset.layer) : hidden.add(c.dataset.layer);
    rerender();
  }));
  el.querySelector('[data-boundary]')?.addEventListener('change', async (e) => {
    try {
      const gj = JSON.parse(await e.target.files[0].text());
      if (!ringsOf(gj).length) throw new Error('no polygon found');
      await db.saveSettings({ boundary: gj });
      toast('Boundary saved');
    } catch (err) { toast(`Couldn't read that file: ${err.message}`); }
  });
  el.querySelector('[data-clear-boundary]')?.addEventListener('click', async () => {
    if (confirm('Remove the boundary?')) await db.saveSettings({ boundary: null });
  });
}
/** Outer rings of every Polygon/MultiPolygon/LineString in a GeoJSON object. */
export function ringsOf(gj) {
  if (!gj) return [];
  if (gj.type === 'FeatureCollection') return gj.features.flatMap(ringsOf);
  if (gj.type === 'Feature') return ringsOf(gj.geometry);
  if (gj.type === 'Polygon') return [gj.coordinates[0]];
  if (gj.type === 'MultiPolygon') return gj.coordinates.map((p) => p[0]);
  if (gj.type === 'LineString') return [gj.coordinates];
  if (gj.type === 'GeometryCollection') return gj.geometries.flatMap(ringsOf);
  return [];
}
