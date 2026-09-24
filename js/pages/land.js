/* Land & water: water points, brush management, fences & gates, ranch map. */
import * as db from '../db.js';
import * as C from '../calc.js';
import { S } from '../model.js';
import { esc, n0, n1, usd, stat, pill, listPanel, dateLabel, daysLabel, toast, openForm } from '../ui.js';
import { parseMapFile, ringsOf, ringAcres, distance, toGeoJSON } from '../geo.js';
export { ringsOf };


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
/* Aerial / topo map (Leaflet, bundled in vendor/ so it loads offline) with
   the property boundary, pasture outlines and every record with a GPS pin.
   Three ways to get a boundary on it: tap the corners, drive/walk the fence
   with GPS, or import a KML / KMZ / GPX / GeoJSON / zipped shapefile.
   Map tiles you've viewed are cached, so they show again without signal. */

const LAYERS = [
  { col: 'waterpoints', label: 'Water', color: '#3B82F6', name: (r) => r.name },
  { col: 'devices', label: 'Cameras & feeders', color: '#D97706', name: (r) => r.name },
  { col: 'fences', label: 'Gates & fences', color: '#9CA3AF', name: (r) => r.name },
  { col: 'brush', label: 'Brush work', color: '#16A34A', name: (r) => `${r.species} ${r.date}` },
  { col: 'dovefields', label: 'Dove fields', color: '#A855F7', name: (r) => r.name },
  { col: 'pastures', label: 'Pastures', color: '#65A30D', name: (r) => r.name },
  { col: 'photos', label: 'Photos', color: '#E11D48', name: (r) => r.caption || r.date },
];
const BASEMAPS = {
  aerial: { label: 'Aerial', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', opts: { maxNativeZoom: 19, maxZoom: 20, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' } },
  usgs: { label: 'Aerial (USGS)', url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}', opts: { maxNativeZoom: 16, maxZoom: 20, attribution: 'USGS The National Map' } },
  topo: { label: 'Topo', url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', opts: { maxNativeZoom: 16, maxZoom: 20, attribution: 'USGS The National Map' } },
  streets: { label: 'Roads', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', opts: { maxNativeZoom: 19, maxZoom: 20, attribution: '© OpenStreetMap contributors' } },
};
const MASON = [30.7488, -99.2303];

/* Survives re-renders (the page redraws whenever data syncs). */
const M = { hidden: new Set(['photos']), view: null, mode: null, target: 'boundary', pts: [], watch: null, wake: null, acc: null, map: null };

let leafletP = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  leafletP ||= new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = 'vendor/leaflet/leaflet.css';
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = 'vendor/leaflet/leaflet.js';
    js.onload = () => resolve(window.L);
    js.onerror = () => { leafletP = null; reject(new Error('map library failed to load')); };
    document.head.appendChild(js);
  });
  return leafletP;
}

const boundaryRings = () => ringsOf(db.settings().boundary).filter((r) => r.length >= 3);
const shapeRings = (p) => ringsOf(p.shape).filter((r) => r.length >= 3);
const targetName = (t) => (t === 'boundary' ? 'property boundary' : `${db.get('pastures', t)?.name || 'pasture'} outline`);
const lineMiles = (pts) => pts.slice(1).reduce((s, p, i) => s + distance(pts[i], p), 0) / 1609.344;

export function map() {
  const s = S();
  const rings = boundaryRings();
  const acres = rings.reduce((t, r) => t + ringAcres(r), 0);
  const pastures = db.all('pastures').sort((a, b) => a.name.localeCompare(b.name));
  const drawing = M.mode === 'draw' || M.mode === 'walk';
  return `
    <section class="panel map-panel">
      <div class="panel-head"><h2>Ranch map</h2>
        <div class="head-actions">
          <select data-map-base aria-label="Base map">${Object.entries(BASEMAPS).map(([k, b]) => `<option value="${k}" ${(s.mapBase || 'aerial') === k ? 'selected' : ''}>${b.label}</option>`).join('')}</select>
          <button class="btn" data-map-me>📍 Me</button>
        </div></div>
      ${rings.length ? `<p class="note">Boundary: <b>${n1(acres)} ac</b>${Math.abs(acres - s.acres) / s.acres > 0.05 ? ` (Settings says ${s.acres} ac. <button class="btn link" data-map-useacres="${Math.round(acres)}">use ${Math.round(acres)}</button>)` : ''}</p>` : ''}
      ${drawing ? `<div class="map-status" data-map-status></div>` : `
      <div class="map-tools">
        <label class="inline">Outline <select data-map-target>
          <option value="boundary" ${M.target === 'boundary' ? 'selected' : ''}>Property boundary</option>
          ${pastures.map((p) => `<option value="${esc(p.id)}" ${M.target === p.id ? 'selected' : ''}>Pasture: ${esc(p.name)}</option>`).join('')}
        </select></label>
        <button class="btn primary" data-map-draw>✏️ Tap corners</button>
        <button class="btn" data-map-walk>🚶 Drive / walk the fence</button>
        <label class="btn">📂 Import file<input type="file" data-map-file hidden></label>
        ${(M.target === 'boundary' ? rings.length : shapeRings(db.get('pastures', M.target) || {}).length) ? '<button class="btn danger" data-map-clear>Clear</button>' : ''}
      </div>`}
      <div id="ranch-map" class="leaflet-host"><p class="empty" style="padding:16px">Loading map…</p></div>
      <div class="layer-toggles">${LAYERS.map((L) => `<label><input type="checkbox" data-layer="${L.col}" ${M.hidden.has(L.col) ? '' : 'checked'}><span class="dot" style="background:${L.color}"></span>${L.label}</label>`).join('')}</div>
      <details class="lines"><summary>Where do I get a boundary file?</summary>
        <ul class="plain small" style="margin-top:8px">
          <li>• <b>Easiest:</b> tap <i>✏️ Tap corners</i> and tap each fence corner on the aerial photo. The acreage updates as you go.</li>
          <li>• <b>Most accurate:</b> <i>🚶 Drive / walk the fence</i> records your GPS track. Keep the app open and the screen on.</li>
          <li>• <b>Google Earth</b> (phone or web): draw a polygon, then Share/Export as KML or KMZ. <b>Google My Maps</b>: ⋮ → Export to KML/KMZ.</li>
          <li>• <b>onX Hunt, Gaia, Garmin:</b> export the property line as KML or GPX.</li>
          <li>• <b>Mason CAD / county GIS:</b> a parcel download as KML, GeoJSON or a zipped shapefile (lat/long).</li>
          <li>• On iPhone, save the file to <i>Files</i> first, then tap <i>📂 Import file</i> and pick it.</li>
        </ul>
      </details>
    </section>`;
}

export async function bindMap(el, rerender) {
  // Toggles and tools that don't need the map object.
  el.querySelectorAll('[data-layer]').forEach((c) => c.addEventListener('change', () => {
    c.checked ? M.hidden.delete(c.dataset.layer) : M.hidden.add(c.dataset.layer);
    rerender();
  }));
  el.querySelector('[data-map-base]')?.addEventListener('change', (e) => db.saveSettings({ mapBase: e.target.value }));
  el.querySelector('[data-map-target]')?.addEventListener('change', (e) => { M.target = e.target.value; rerender(); });
  el.querySelector('[data-map-useacres]')?.addEventListener('click', (e) => db.saveSettings({ acres: Number(e.target.dataset.mapUseacres) }));
  el.querySelector('[data-map-clear]')?.addEventListener('click', async () => {
    if (!confirm(`Remove the ${targetName(M.target)}?`)) return;
    if (M.target === 'boundary') await db.saveSettings({ boundary: null });
    else await db.put('pastures', { ...db.get('pastures', M.target), shape: null });
  });
  el.querySelector('[data-map-file]')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const rings = await parseMapFile(file.name, new Uint8Array(await file.arrayBuffer()));
      M.view = null; // fit to the new shape
      await saveShape(M.target === 'boundary' ? rings : [rings.sort((a, b) => ringAcres(b) - ringAcres(a))[0]], `Imported ${file.name}`);
    } catch (err) { toast(`Couldn't use that file: ${err.message}`); }
    e.target.value = '';
  });
  el.querySelector('[data-map-draw]')?.addEventListener('click', () => { M.mode = 'draw'; M.pts = []; rerender(); });
  el.querySelector('[data-map-walk]')?.addEventListener('click', () => startWalk(rerender));

  let L;
  try { L = await loadLeaflet(); } catch (err) {
    el.querySelector('#ranch-map').innerHTML = `<p class="empty" style="padding:16px">${esc(err.message)}. Open the app once with signal.</p>`;
    return;
  }
  const host = el.querySelector('#ranch-map');
  if (!host) return;
  host.innerHTML = '';
  if (M.map) { M.map.remove(); M.map = null; }
  const map = L.map(host, { zoomControl: true, tap: true });
  M.map = map;
  const base = BASEMAPS[db.settings().mapBase] || BASEMAPS.aerial;
  L.tileLayer(base.url, base.opts).addTo(map);

  const bounds = [];
  for (const ring of boundaryRings()) {
    const ll = ring.map(([x, y]) => [y, x]);
    L.polygon(ll, { color: '#F59E0B', weight: 3, fillOpacity: 0.06, interactive: false }).addTo(map);
    bounds.push(...ll);
  }
  for (const p of db.all('pastures')) {
    for (const ring of shapeRings(p)) {
      const ll = ring.map(([x, y]) => [y, x]);
      L.polygon(ll, { color: '#84CC16', weight: 2, dashArray: '6 5', fillOpacity: 0.05 })
        .bindTooltip(`${esc(p.name)} · ${n1(ringAcres(ring))} ac`, { permanent: true, direction: 'center', className: 'map-label' })
        .on('click', () => { if (!M.mode) openForm('pastures', db.get('pastures', p.id)); })
        .addTo(map);
      bounds.push(...ll);
    }
  }
  for (const Lr of LAYERS) {
    if (M.hidden.has(Lr.col)) continue;
    for (const r of db.all(Lr.col)) {
      if (!r.loc?.lat || !r.loc?.lon) continue;
      L.circleMarker([r.loc.lat, r.loc.lon], { radius: 8, color: '#fff', weight: 2, fillColor: Lr.color, fillOpacity: 1 })
        .bindTooltip(`${esc(Lr.label)}: ${esc(Lr.name(r))}`)
        .on('click', () => { if (!M.mode) openForm(Lr.col, db.get(Lr.col, r.id)); })
        .addTo(map);
      bounds.push([r.loc.lat, r.loc.lon]);
    }
  }
  if (M.view) map.setView(M.view.center, M.view.zoom);
  else if (bounds.length) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 17 });
  else map.setView(MASON, 13);
  map.on('moveend', () => { M.view = { center: map.getCenter(), zoom: map.getZoom() }; });

  // ---- drawing / walking ----
  const draft = L.layerGroup().addTo(map);
  const status = el.querySelector('[data-map-status]');
  const redraw = () => {
    draft.clearLayers();
    const ll = M.pts.map(([x, y]) => [y, x]);
    if (ll.length >= 2) L.polygon(ll, { color: '#EF4444', weight: 3, fillOpacity: 0.1, dashArray: M.mode === 'walk' ? null : '4 4', interactive: false }).addTo(draft);
    if (M.mode === 'draw') ll.forEach((p) => L.circleMarker(p, { radius: 5, color: '#EF4444', weight: 2, fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(draft));
    else if (ll.length) L.circleMarker(ll[ll.length - 1], { radius: 7, color: '#fff', weight: 2, fillColor: '#2563EB', fillOpacity: 1 }).addTo(draft);
    if (!status) return;
    const ac = M.pts.length >= 3 ? `${n1(ringAcres(M.pts))} ac` : '—';
    status.innerHTML = M.mode === 'walk'
      ? `<b>Recording ${esc(targetName(M.target))}</b> · ${M.pts.length} points · ${lineMiles(M.pts).toFixed(2)} mi · ${ac}${M.acc ? ` · GPS ±${Math.round(M.acc)} m` : ''}
         <div class="map-status-actions"><button class="btn" data-map-cancel>Cancel</button><button class="btn primary" data-map-stop>Stop &amp; review</button></div>
         <small class="help">Keep the app open and the screen on. Points are added every ~10 m.</small>`
      : `<b>Tap each corner of the ${esc(targetName(M.target))}</b> · ${M.pts.length} points · ${ac}
         <div class="map-status-actions"><button class="btn" data-map-cancel>Cancel</button><button class="btn" data-map-undo ${M.pts.length ? '' : 'disabled'}>Undo</button><button class="btn primary" data-map-save ${M.pts.length >= 3 ? '' : 'disabled'}>Save</button></div>`;
    status.querySelector('[data-map-cancel]')?.addEventListener('click', () => { stopWalk(); M.mode = null; M.pts = []; rerender(); });
    status.querySelector('[data-map-undo]')?.addEventListener('click', () => { M.pts.pop(); redraw(); });
    status.querySelector('[data-map-stop]')?.addEventListener('click', () => { stopWalk(); M.mode = 'draw'; rerender(); });
    status.querySelector('[data-map-save]')?.addEventListener('click', async () => {
      const pts = M.pts;
      M.mode = null; M.pts = [];
      await saveShape([pts], 'Saved');
    });
  };
  M.redraw = redraw;
  map.on('click', (e) => { if (M.mode === 'draw') { M.pts.push([+e.latlng.lng.toFixed(6), +e.latlng.lat.toFixed(6)]); redraw(); } });
  redraw();

  el.querySelector('[data-map-me]')?.addEventListener('click', () => {
    if (!navigator.geolocation) return toast('No GPS on this device');
    navigator.geolocation.getCurrentPosition((p) => {
      const ll = [p.coords.latitude, p.coords.longitude];
      L.circle(ll, { radius: p.coords.accuracy, color: '#2563EB', weight: 1, fillOpacity: 0.1, interactive: false }).addTo(map);
      L.circleMarker(ll, { radius: 7, color: '#fff', weight: 2, fillColor: '#2563EB', fillOpacity: 1, interactive: false }).addTo(map);
      map.setView(ll, Math.max(map.getZoom(), 16));
    }, (err) => toast(`No GPS fix: ${err.message}`), { enableHighAccuracy: true, timeout: 15000 });
  });
}

async function saveShape(rings, verb) {
  const acres = rings.reduce((t, r) => t + ringAcres(r), 0);
  if (M.target === 'boundary') {
    await db.saveSettings({ boundary: toGeoJSON(rings, { name: 'Property boundary' }) });
    toast(`${verb}: property boundary, ${n1(acres)} ac`);
  } else {
    const p = db.get('pastures', M.target);
    const patch = { shape: toGeoJSON(rings, { name: p.name }) };
    if (!p.acres || (Math.abs(acres - Number(p.acres)) / Number(p.acres) > 0.05 && confirm(`${p.name} measures ${n1(acres)} ac on the map. Update its acres (now ${p.acres})?`))) patch.acres = Math.round(acres * 10) / 10;
    await db.put('pastures', { ...p, ...patch });
    toast(`${verb}: ${p.name}, ${n1(acres)} ac`);
  }
}

function startWalk(rerender) {
  if (!navigator.geolocation) return toast('No GPS on this device');
  M.mode = 'walk'; M.pts = []; M.acc = null;
  M.watch = navigator.geolocation.watchPosition((pos) => {
    const { latitude, longitude, accuracy } = pos.coords;
    M.acc = accuracy;
    const p = [+longitude.toFixed(6), +latitude.toFixed(6)];
    const last = M.pts[M.pts.length - 1];
    if (accuracy <= 35 && (!last || distance(last, p) >= 10)) M.pts.push(p);
    M.redraw?.();
  }, (err) => {
    // Brief signal drops while driving are normal. Only a refused permission stops the recording.
    if (err.code === 1) { toast('Location permission is off. Allow it for this app in Settings → Privacy → Location.'); stopWalk(); M.mode = null; rerender(); }
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  navigator.wakeLock?.request('screen').then((w) => { M.wake = w; }).catch(() => {});
  rerender();
}
function stopWalk() {
  if (M.watch != null) navigator.geolocation.clearWatch(M.watch);
  M.watch = null;
  M.wake?.release?.().catch(() => {});
  M.wake = null;
}
