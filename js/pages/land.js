/* Land & water: water points, brush management, fences & gates, ranch map. */
import * as db from '../db.js';
import * as C from '../calc.js';
import { S } from '../model.js';
import { esc, n0, n1, usd, stat, pill, listPanel, dateLabel, daysLabel, toast, openForm } from '../ui.js';
import { parseMapFile, ringsOf, ringAcres, distance, toGeoJSON } from '../geo.js';
import { BASEMAPS, MASON, loadLeaflet, boundaryRings } from '../mapcore.js';
import { addPhotoFile, photoURL, deletePhoto } from '../photos.js';
import { relayConfigured, analyzeScan } from '../relay.js';
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
    ${bentonitePanel()}
    ${listPanel('waterpoints')}
    ${listPanel('waterchecks', { title: 'Level & trough checks' })}
    ${listPanel('waterwork', { title: 'Well / windmill maintenance', note: 'Tick “counts as supplemental water for wildlife” on guzzlers, wildlife troughs and similar work. It feeds the 1-d-1 wildlife practice tracker.' })}`;
}
export function bindWater(el) {
  el.querySelectorAll('[data-check]').forEach((b) => b.addEventListener('click', () => openForm('waterchecks', null, { point: b.dataset.check })));
  el.querySelector('[data-bent-log]')?.addEventListener('click', () => {
    const b = bentoniteState();
    const r = bentoniteResult(b);
    if (!r?.need) return;
    openForm('waterwork', null, {
      point: b.point || '',
      work: `Sealed with sodium bentonite: ${n0(r.need.lbs)} lb (${r.need.bags} × ${b.bagLb} lb bags), ${b.method === 'sprinkle' ? 'sprinkled on water' : 'mixed blanket'}, ${n0(r.need.area)} ft² at ${r.need.rateAdj.toFixed(2)} lb/ft²`,
      cost: r.need.costBags ?? (r.need.costBulk != null ? Math.round(r.need.costBulk) : ''),
    });
  });
}

/* ------------------------ bentonite tank sealing ------------------------- */
const BENT_DEFAULTS = { point: '', shape: 'round', diameter: '', length: '', width: '', surfaceAcres: '', depth: 8, slope: 3, soil: 'loam', method: 'mixed', rate: '', scope: 'whole', partialSqft: '', margin: 25, bagLb: 50, bagPrice: '', tonPrice: '' };
const bentoniteState = () => ({ ...BENT_DEFAULTS, ...(db.settings().bentonite || {}) });
function bentoniteResult(b) {
  const geo = C.tankGeometry({ shape: b.shape, diameter: b.diameter, length: b.length, width: b.width, surfaceSqft: Number(b.surfaceAcres) * 43560, depth: b.depth, slope: b.slope });
  const soil = C.BENTONITE_SOILS.find((x) => x.key === b.soil) || C.BENTONITE_SOILS[1];
  const tableRate = b.method === 'sprinkle' ? soil.sprinkle : soil.mixed;
  const rate = b.rate !== '' && b.rate != null && Number(b.rate) > 0 ? Number(b.rate) : tableRate;
  const area = b.scope === 'partial' ? Number(b.partialSqft) : geo?.wetted;
  const need = C.bentoniteNeed({ area, rate, depth: geo?.depth ?? b.depth, margin: Number(b.margin) / 100, bagLb: b.bagLb, bagPrice: b.bagPrice, tonPrice: b.tonPrice });
  return { geo, soil, tableRate, rate, need };
}
function bentonitePanel() {
  const b = bentoniteState();
  const { geo, soil, tableRate, need } = bentoniteResult(b);
  const tanks = db.all('waterpoints').filter((w) => ['tank', 'guzzler', 'storage'].includes(w.type) || !w.type);
  const inp = (k, label, extra = '', help = '') => `<label class="field">${label}<input type="number" inputmode="decimal" step="any" data-set="bentonite.${k}" value="${esc(b[k] ?? '')}" ${extra}>${help ? `<small class="help">${help}</small>` : ''}</label>`;
  const sel = (k, label, opts) => `<label class="field">${label}<select data-set="bentonite.${k}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(b[k]) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
  const f = (x) => n0(x);
  return `
    <section class="panel" id="bentonite">
      <div class="panel-head"><h2>Seal a leaking tank with bentonite</h2>${need ? pill(`${f(need.lbs)} lb`, 'good') : ''}</div>
      <p class="note">Sodium bentonite swells to many times its dry size when wet and plugs the pores in a tank bottom. How much you need depends on the soil, the method and how much of the tank you treat.</p>
      <div class="form-grid">
        ${tanks.length ? sel('point', 'Tank', [['', '(not saved to a tank)'], ...tanks.map((w) => [w.id, w.name])]) : ''}
        ${sel('shape', 'Shape at the full-water line', [['round', 'Round'], ['rect', 'Rectangular'], ['area', 'I know the surface area']])}
        ${b.shape === 'round' ? inp('diameter', 'Diameter (ft)') : ''}
        ${b.shape === 'rect' ? inp('length', 'Length (ft)') + inp('width', 'Width (ft)') : ''}
        ${b.shape === 'area' ? inp('surfaceAcres', 'Surface area (acres)', '', 'Tip: outline the tank on the Map to measure it.') : ''}
        ${inp('depth', 'Deepest point when full (ft)')}
        ${inp('slope', 'Side slope (ft across per 1 ft down)', '', '3 is typical for a dozer-built tank (3:1).')}
        ${sel('soil', 'Soil in the tank bottom', C.BENTONITE_SOILS.map((x) => [x.key, `${x.label} (${x.range} lb/ft²)`]))}
        ${sel('method', 'Method', [['mixed', 'Mixed in (tank dry), best'], ['sprinkle', 'Sprinkled on water (tank full)']])}
        ${sel('scope', 'Area to treat', [['whole', 'Whole tank: bottom + sides to the full line'], ['partial', 'Just the leaking area']])}
        ${b.scope === 'partial' ? inp('partialSqft', 'Leaking area (ft²)', '', 'e.g. a 40 × 60 ft strip on the dam face = 2,400.') : ''}
        ${inp('rate', 'Rate (lb/ft²)', `placeholder="${tableRate} from the table"`, 'Leave blank to use the table rate for your soil.')}
        ${inp('margin', 'Extra for uneven spreading (%)', '', 'Texas A&M suggests 25–50%.')}
        ${inp('bagLb', 'Bag size (lb)')}
        ${inp('bagPrice', 'Price per bag ($)')}
        ${inp('tonPrice', 'Bulk price per ton ($)')}
      </div>
      ${geo ? `<div class="stats" style="margin-top:14px">
        ${stat('Water surface', `${f(geo.surface)} ft²`, `${(geo.surface / 43560).toFixed(2)} ac`)}
        ${stat('Bottom + sides', `${f(geo.wetted)} ft²`, `${f(geo.bottom)} bottom · ${f(geo.sides)} sides`)}
        ${stat('Holds when full', `${f(geo.gallons)} gal`, `${geo.acreFeet.toFixed(2)} acre-ft${geo.depth < Number(b.depth) - 0.01 ? ` · sides meet at ${geo.depth.toFixed(1)} ft` : ''}`)}
      </div>` : '<p class="empty">Enter the tank size to calculate.</p>'}
      ${need ? `<div class="stats" style="margin-top:10px">
        ${stat('Bentonite', `${f(need.lbs)} lb`, `${need.tons.toFixed(1)} tons`, 'accent')}
        ${stat(`${b.bagLb}-lb bags`, f(need.bags), `or ${need.sacks} one-ton bulk sacks`)}
        ${stat('Rate used', `${need.rateAdj.toFixed(2)} lb/ft²`, `${need.baseRate} base${need.depthAdd ? ` + ${need.depthAdd.toFixed(2)} for depth` : ''} + ${b.margin}%`)}
        ${need.costBags != null || need.costBulk != null ? stat('Cost', need.costBags != null ? usd(need.costBags) : usd(need.costBulk), need.costBags != null && need.costBulk != null ? `bulk: ${usd(need.costBulk)}` : need.costBags != null ? 'in bags' : 'bulk') : ''}
      </div>
      <h3>How to spread it</h3>
      ${b.method === 'sprinkle' ? `<ol class="steps">
        <li>Use <b>granular</b> bentonite (not powder) so it sinks before it swells.</li>
        <li>Broadcast it evenly over the water above the leak, from a boat or the bank. That's about <b>${f(need.perSquare)} lb (${need.bagsPerSquare.toFixed(1)} bags) per 10 × 10 ft</b> of water surface.</li>
        <li>Concentrate on the leak zone (often the dam face, or rock outcrops). Uniform coverage is hard, so expect to repeat.</li>
        <li>This is the least reliable method. If the tank goes dry in a drought, reseal it by the mixed-blanket method.</li>
      </ol>` : `<ol class="steps">
        <li>Drain the tank, or wait for a dry spell, and let the bottom dry. Clear brush and roots, and fill cracks, holes and crawfish burrows.</li>
        <li>Stake out 10 × 10 ft squares with flags or string. Spread <b>${f(need.perSquare)} lb (${need.bagsPerSquare.toFixed(1)} bags) per square</b>.</li>
        <li>Disk or till it into the top 4–6 inches. Blend it in; don't leave it sitting on top.</li>
        <li>Wet it lightly and compact with several passes of a sheepsfoot roller or loaded tractor tires. A seal is only as good as its compaction.</li>
        <li>Let it fill slowly, and keep cattle off the treated slopes until it's full. Hoof punctures break the seal, so a trough fed from the tank helps.</li>
      </ol>`}
      <div class="head-actions"><button class="btn primary" data-bent-log>Log this job under maintenance</button></div>` : ''}
      <details class="lines"><summary>About these numbers</summary>
        <ul class="plain small" style="margin-top:8px">
          <li>• The rates are starting points from commonly cited ranges (${C.BENTONITE_SOILS.map((x) => `${x.label.split(' /')[0].toLowerCase()} ${x.range}`).join(', ')} lb/ft², mixed method). Suppliers add about 1 lb/ft² for every 8 ft of water beyond 8 ft, and the calculator does too.</li>
          <li>• Before buying tons of it, the Texas A&M method is to try a trial rate (for example ½ lb/ft²) on a test plot. Increase until it holds, then add 25–50%.</li>
          <li>• Leaks through <b>fractured limestone</b>, common in the Hill Country, may be too large for bentonite. Ask NRCS (practice 521) or a pond contractor about a compacted clay liner or a synthetic liner. NRCS can cost-share it through EQIP.</li>
          <li>• Area includes the side slopes up to the full-water line, which is usually 20–40% more than the water surface.</li>
        </ul>
      </details>
    </section>`;
}

/* --------------------------------- brush --------------------------------- */
export function brush() {
  const t = C.today();
  const planned = db.all('brush').filter((b) => b.status === 'planned').sort((a, b) => (a.date < b.date ? -1 : 1));
  const rows = db.all('brush').filter((b) => b.status !== 'planned').map((b) => C.brushRow(b, t));
  const mapped = db.all('brush').filter((b) => ringsOf(b.shape).length);
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
      ${planned.length ? `<h3>Planned</h3><ul class="plain">${planned.map((r) => `<li data-edit="brush:${esc(r.id)}">${pill(dateLabel(r.date), 'warn')} ${esc(r.species)} (${esc(r.method || '')}) in ${esc(r.area || 'unnamed area')}, ${n1(r.acres)} ac</li>`).join('')}</ul>` : ''}
      <p class="note">Brush work counts as “habitat control” under wildlife valuation. <b>${mapped.length} of ${db.all('brush').length}</b> treatments are outlined on the <a href="#/map?outline=newbrush">ranch map</a>: cleared areas show solid and planned ones dashed. Outline a new area there, or tap <i>outline</i> next to a treatment below.</p>
    </section>
    ${brushScanPanel()}
    ${brushPlanner()}
    ${listPanel('brush', { title: 'Treatments', extraCols: [
      { label: 'Map', html: (r) => (ringsOf(r.shape).length ? `<a href="#/map?outline=${esc(r.id)}" onclick="event.stopPropagation()">▰ ${n1(ringAcres(ringsOf(r.shape)[0]))} ac</a>` : `<a href="#/map?outline=${esc(r.id)}" onclick="event.stopPropagation()">outline</a>`) },
      { label: '$/ac', html: (r) => { const x = C.brushRow(r, t); return x.costPerAcre == null ? '' : usd(x.costPerAcre); } },
      { label: 'Retreat', html: (r) => { const x = C.brushRow(r, t); return x.due ? `<span class="${x.overdue ? 'bad-t' : ''}">${x.due.slice(0, 7)}</span>` : ''; } },
    ] })}`;
}

/* ---------------------- brush density from a photo ----------------------- */
const SCAN_VIEWS = { ground: 'Ground level', elevated: 'Raised spot (truck bed, hill, stand)', overhead: 'Drone, straight down' };
const METHOD_SHORT = (target, key) => C.brushPlan(target, key)?.label.replace(/ \(.*\)$/, '') || '';
function scanCard(sc) {
  const res = sc.result;
  const status = sc.status === 'done' ? '' : sc.status === 'pending'
    ? pill(!navigator.onLine ? 'Waiting for signal' : sc.error ? 'Queued, retries on next sync' : 'Analyzing…', 'warn')
    : pill('Failed', 'bad');
  const rows = res ? res.species.map((sp, i) => ({ sp, i, d: C.scanDensity(sp, res.area_visible_sqft) })) : [];
  return `<div class="card scan-card">
    <div class="scan-top">
      <img class="scan-thumb" data-pid="${esc(sc.photo)}" alt="Brush photo">
      <div class="grow">
        <b>${esc(sc.area || 'Brush photo')}</b> ${status} ${res ? pill(`${res.confidence} confidence`, res.confidence === 'high' ? 'good' : res.confidence === 'low' ? 'bad' : '') : ''}
        <div class="small muted">${dateLabel(sc.date)} · ${esc(SCAN_VIEWS[sc.view] || '')}${sc.loc?.lat ? ' · 📍' : ''}${res ? ` · ~${n0(res.area_visible_sqft)} sq ft (${(res.area_visible_sqft / 43560).toFixed(2)} ac) in view` : ''}</div>
        ${sc.status === 'error' || (sc.status === 'pending' && sc.error) ? `<div class="small bad-t">${esc(sc.error || '')}</div>` : ''}
      </div>
    </div>
    ${res ? (rows.length ? `<ul class="scan-species">${rows.map(({ sp, i, d }) => `<li>
        <div><b>${esc(sp.species)}</b>${sp.cedar_type && !['n/a', 'unknown'].includes(sp.cedar_type) ? ` (${esc(sp.cedar_type)})` : ''}: <b>${d.perAcre != null ? n0(d.perAcre) : '?'}</b> per acre · ${n0(d.cover)}% cover (${d.coverClass}) · ${esc(sp.size_class)}, ~${n0(sp.typical_height_ft)} ft tall
          <br><small class="muted">${n0(sp.plants_counted)} counted${d.method ? ` · suggested: ${esc(METHOD_SHORT(d.target, d.method))}` : ''}</small></div>
        ${d.target ? `<button class="btn scan-use" data-scan-use="${esc(sc.id)}:${i}">Use in planner</button>` : ''}</li>`).join('')}</ul>` : '<p class="small">No cedar, mesquite or prickly pear found in this photo.</p>') : ''}
    ${res?.notes ? `<p class="small">🤖 ${esc(res.notes)}</p>` : ''}
    <div class="head-actions">
      ${sc.status !== 'done' || !res ? `<button class="btn" data-scan-retry="${esc(sc.id)}">Retry</button>` : ''}
      <button class="btn" data-scan-del="${esc(sc.id)}">Delete</button>
    </div>
  </div>`;
}
function brushScanPanel() {
  const S0 = db.settings();
  const cfg = S0.brushScan || {};
  const src = S0.relayInfo?.sources || {};
  const scans = db.all('brushscans').sort((a, b) => String(b.date + b.updated).localeCompare(String(a.date + a.updated)));
  const ready = relayConfigured();
  return `
  <section class="panel" id="brush-scan">
    <div class="panel-head"><h2>📷 Estimate density from a photo</h2>${pill('AI')}</div>
    <p class="note">Take a picture across a pasture. Claude counts the cedar, mesquite and prickly pear it can see, estimates canopy cover and plant size, and works out plants per acre. Tap <b>Use in planner</b> to carry those numbers into the chemical calculator below.</p>
    ${!ready ? '<p class="note warn">This needs the ranch relay. Add its address and token under <a href="#/settings">Settings</a>, and set <code>ANTHROPIC_API_KEY</code> on the relay.</p>'
      : src.brushScan === false ? '<p class="note warn">The relay has no <code>ANTHROPIC_API_KEY</code>, so photos can\'t be analyzed yet. Add the key as a GitHub secret and re-run <b>Deploy relay</b>.</p>' : ''}
    <div class="form-grid">
      <label class="field">Taken from<select data-set="brushScan.view">${Object.entries(SCAN_VIEWS).map(([k, l]) => `<option value="${k}" ${(cfg.view || 'elevated') === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      <label class="field">Area / pasture<input data-set="brushScan.area" value="${esc(cfg.area || '')}" placeholder="e.g. North trap"></label>
      <label class="field">Note for the AI (optional)<input data-set="brushScan.notes" value="${esc(cfg.notes || '')}" placeholder="e.g. fence posts are 12 ft apart"></label>
    </div>
    <div class="head-actions">
      <label class="btn primary">📷 Take photo<input type="file" accept="image/*" capture="environment" data-scan-file hidden></label>
      <label class="btn">🖼 Choose from library<input type="file" accept="image/*" data-scan-file hidden></label>
    </div>
    <details class="lines"><summary>Tips for a good estimate</summary>
      <ul class="plain small" style="margin-top:8px">
        <li>• <b>Get up high.</b> Stand in the truck bed or on a rise. From ground level the near brush hides everything behind it. A drone shot straight down is best.</li>
        <li>• <b>Include something of known size</b>, like a fence line, a T-post, the truck or a cow, so distances can be judged.</li>
        <li>• <b>One typical spot per pasture</b>, in daylight with the sun behind you. Skip the densest or thinnest corner.</li>
        <li>• <b>It's an estimate.</b> Check it once: count the plants in a 66 × 66 ft square (1/10 acre) and multiply by 10. If they differ, trust your count.</li>
        <li>• Each photo is one Claude request, roughly 2–5¢. The relay stops at 40 a day unless you raise <code>BRUSH_SCAN_DAILY_LIMIT</code>. Without signal the photo is saved and sent on the next sync.</li>
      </ul>
    </details>
    ${scans.length ? `<div class="scan-list">${scans.slice(0, 8).map(scanCard).join('')}</div>` : ''}
    ${scans.length > 8 ? `<p class="small muted">${scans.length - 8} older photo estimates are kept. They show as green-dot pins on the map.</p>` : ''}
  </section>`;
}
function bindBrushScan(el) {
  el.querySelectorAll('img.scan-thumb[data-pid]').forEach(async (img) => { img.src = (await photoURL(img.dataset.pid)) || ''; });
  el.querySelectorAll('[data-scan-file]').forEach((inp) => inp.addEventListener('change', async () => {
    const file = inp.files?.[0];
    if (!file) return;
    const cfg = db.settings().brushScan || {};
    try {
      // 1600 px keeps the brush countable and the upload ~300 KB.
      const ph = await addPhotoFile(file, { caption: `Brush photo${cfg.area ? ` · ${cfg.area}` : ''}`, tags: 'brush', source: 'brushscan' });
      const sc = await db.put('brushscans', { date: ph.date || C.today(), area: cfg.area || '', view: cfg.view || 'elevated', notes: cfg.notes || '', photo: ph.id, loc: ph.loc || null, status: 'pending' });
      if (!relayConfigured()) return toast('Photo saved. Set up the relay to analyze it.');
      if (!navigator.onLine) return toast('Saved. It will be analyzed when you have signal.');
      toast('Analyzing the photo… (up to a minute)');
      const done = await analyzeScan(sc.id);
      toast(done?.status === 'done' ? 'Brush estimate ready' : `Couldn't analyze: ${done?.error || 'unknown error'}`);
    } catch (err) { toast(`Couldn't read that photo: ${err.message}`); }
  }));
  el.querySelectorAll('[data-scan-retry]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    b.textContent = 'Analyzing…';
    const done = await analyzeScan(b.dataset.scanRetry);
    toast(done?.status === 'done' ? 'Brush estimate ready' : `Couldn't analyze: ${done?.error || 'unknown error'}`);
  }));
  el.querySelectorAll('[data-scan-del]').forEach((b) => b.addEventListener('click', async () => {
    const sc = db.get('brushscans', b.dataset.scanDel);
    if (!sc || !confirm('Delete this brush photo and its estimate?')) return;
    if (sc.photo) await deletePhoto(sc.photo);
    await db.del('brushscans', sc.id);
  }));
  el.querySelectorAll('[data-scan-use]').forEach((b) => b.addEventListener('click', async () => {
    const [id, i] = b.dataset.scanUse.split(':');
    const sc = db.get('brushscans', id);
    const sp = sc?.result?.species?.[Number(i)];
    if (!sp) return;
    const d = C.scanDensity(sp, sc.result.area_visible_sqft);
    const t = d.target;
    await db.saveSettings({ brushPlan: { ...planState(), target: t, method: d.method || TARGETS[t].first,
      density: d.perAcre ?? '', plants: '', height: d.height ?? planState().height, canopy: d.canopy ?? planState().canopy, pearSize: d.pearSize,
      perGal: '', pct: '', price: '', ptPerAcre: t === 'mesquite' ? 1.75 : 4, carrier: t === 'mesquite' ? 5 : 20 } });
    toast(`Planner set to ${TARGETS[t].label.toLowerCase()} at ${d.perAcre ?? '?'} plants/acre. Enter the acres.`);
    requestAnimationFrame(() => document.getElementById('brush-plan')?.scrollIntoView({ behavior: 'smooth' }));
  }));
}

/* ---------------------- cedar & prickly pear planner ---------------------- */
const TARGETS = {
  cedar: { label: 'Cedar', species: 'cedar', retreat: 10, first: 'pellet' },
  mesquite: { label: 'Mesquite', species: 'mesquite', retreat: 7, first: 'leaf' },
  pear: { label: 'Prickly pear', species: 'prickly pear', retreat: 5, first: 'padgu' },
};
const PEAR_SIZES = { small: ['Small clumps (under 2 ft)', 20], medium: ['Medium (2–4 ft)', 8], large: ['Large (over 4 ft / 6 ft wide)', 3] };
const PLAN_DEFAULTS = { target: 'cedar', method: 'pellet', perUnit: 2, plants: '', density: '', acres: '', height: 4, canopy: 4, pearSize: 'medium', perGal: '', pct: '', tank: 4, price: '', carrier: 20, ptPerAcre: 4 };
const planState = () => ({ ...PLAN_DEFAULTS, ...(db.settings().brushPlan || {}) });
function planResult(P) {
  const m = C.brushPlan(P.target, P.method) || C.BRUSH_PLANS[P.target][0];
  const plants = Number(P.plants) > 0 ? Number(P.plants) : Number(P.density) * Number(P.acres) || 0;
  let r = null;
  if (m.kind === 'mix') {
    const perGal = Number(P.perGal) > 0 ? Number(P.perGal) : (m.key === 'pad' ? PEAR_SIZES[P.pearSize]?.[1] : m.perGal);
    const pct = Number(P.pct) > 0 ? Number(P.pct) : m.pct;
    r = C.herbicideMix({ plants, perGal, pct, surfPct: m.surfPct ?? 0.25 });
    if (r) Object.assign(r, { perGal, pct, cost: Number(P.price) > 0 ? r.herbGal * Number(P.price) : null });
  } else if (m.kind === 'pellet') {
    r = C.pelletNeed({ plants, height: P.height, canopy: P.canopy, perUnit: Number(P.perUnit) || m.perUnit, perAcre: Number(P.plants) > 0 ? null : P.density });
  } else if (m.kind === 'soil') {
    r = C.velparSoilSpot({ plants, height: P.height, canopy: P.canopy });
    if (r) r.cost = Number(P.price) > 0 ? r.totalGal * Number(P.price) : null;
  } else if (m.kind === 'broadcast') {
    r = C.broadcastNeed({ acres: P.acres, ptPerAcre: P.ptPerAcre, carrier: P.carrier });
    if (r) r.cost = Number(P.price) > 0 ? r.productGal * Number(P.price) : null;
  }
  return { m, plants, r };
}
const floz = (x) => (x >= 128 ? `${(x / 128).toFixed(2)} gal` : x >= 32 ? `${(x / 32).toFixed(2)} qt (${n0(x)} fl oz)` : `${x.toFixed(1)} fl oz`);
function brushPlanner() {
  const P = planState();
  const { m, plants, r } = planResult(P);
  const methods = C.BRUSH_PLANS[P.target];
  const inp = (k, label, extra = '', help = '') => `<label class="field">${label}<input type="number" inputmode="decimal" step="any" data-set="brushPlan.${k}" value="${esc(P[k] ?? '')}" ${extra}>${help ? `<small class="help">${help}</small>` : ''}</label>`;
  const sel = (k, label, opts) => `<label class="field">${label}<select data-set="brushPlan.${k}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(P[k]) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
  const alternatives = methods.filter((x) => x.kind === 'none' && x.key !== m.key);
  let out = '';
  if (m.kind === 'mix' && r) {
    out = `<div class="stats">
      ${stat('Spray mix', `${r.mixGal.toFixed(1)} gal`, `${n0(plants)} plants at ~${r.perGal}/gal`, 'accent')}
      ${stat(m.product.split(' (')[0], floz(r.herbFlOz), `${r.pct}% of the mix`)}
      ${m.carrier ? stat('Carrier', `${(r.mixGal - r.herbGal).toFixed(1)} gal`, esc(m.carrier)) : stat('Surfactant', floz(r.surfFlOz), `${m.surfPct ?? 0.25}% non-ionic (80–90% AI)`)}
      ${r.cost != null ? stat('Herbicide cost', usd(r.cost)) : ''}
    </div>
    <p class="note">Per <b>${esc(P.tank)}-gal</b> tank: <b>${floz(r.perTank(P.tank).herbFlOz)}</b> herbicide${m.carrier ? `, then fill with ${esc(m.carrier)}.` : ` + <b>${floz(r.perTank(P.tank).surfFlOz)}</b> surfactant, then top up with water.`} ${(() => { const n = Math.ceil(r.mixGal / Number(P.tank || 1)); return `${n} tank fill${n === 1 ? '' : 's'}.`; })()}</p>`;
  } else if (m.kind === 'pellet' && r) {
    out = `<div class="stats">
      ${stat('Per tree', `${r.perPlant} pellets`, `${Number(P.perUnit) || m.perUnit} per 3 ft of height or canopy`, 'accent')}
      ${stat('Pellets total', n0(r.pellets), `for ${n0(plants)} trees`)}
      ${r.perAcreUsed != null ? stat('Per acre', n0(r.perAcreUsed), 'label max 600 per season', r.overLimit ? 'bad' : '') : ''}
    </div>
    ${r.overLimit ? '<p class="note warn">That is over the 600-pellets-per-acre label limit. Treat the biggest trees another way (cut them), or split the job across seasons.</p>' : ''}`;
  } else if (m.kind === 'soil' && r) {
    out = `<div class="stats">
      ${stat('Per tree', `${r.mlPerPlant} ml`, `${r.pulls} pull${r.pulls > 1 ? 's' : ''} of a 2-ml gun`, 'accent')}
      ${stat('Velpar L total', r.totalFlOz >= 128 ? `${r.totalGal.toFixed(2)} gal` : `${r.totalFlOz.toFixed(1)} fl oz`, `${n0(r.totalMl)} ml for ${n0(plants)} trees`)}
      ${r.cost != null ? stat('Herbicide cost', usd(r.cost)) : ''}
    </div>`;
  } else if (m.kind === 'broadcast' && r) {
    out = `<div class="stats">
      ${stat(m.product, `${r.productGal.toFixed(1)} gal`, `${n1(r.productPt)} pt at ${P.ptPerAcre} pt/ac`, 'accent')}
      ${stat('Spray volume', `${n0(r.carrierGal)} gal`, `${P.carrier} gal/ac`)}
      ${r.cost != null ? stat('Herbicide cost', usd(r.cost)) : ''}
    </div>`;
  } else if (m.kind === 'none') {
    out = `<p class="big">No chemical needed.</p>`;
  } else out = '<p class="empty">Enter how many plants (or plants per acre and acres) to calculate.</p>';
  return `
  <section class="panel" id="brush-plan">
    <div class="panel-head"><h2>Plan cedar, mesquite &amp; prickly pear work</h2>${pill('Texas A&M Brush Busters')}</div>
    <div class="seg">${Object.entries(TARGETS).map(([k, { label: l }]) => `<button class="${P.target === k ? 'on' : ''}" data-plan-target="${k}">${l}</button>`).join('')}</div>
    <div class="form-grid">
      ${sel('method', 'Method', methods.map((x) => [x.key, `${x.label}${x.kind === 'none' ? ' · no chemical' : x.rup ? ' · license needed' : ' · no license needed'}`]))}
      ${m.kind === 'broadcast' ? inp('acres', 'Acres to spray') + inp('ptPerAcre', 'Rate (pints/acre)') + inp('carrier', 'Spray volume (gal/acre)', '', '20–25 by ground, 4+ by air.')
        : m.kind === 'none' ? '' : `${inp('plants', m.key === 'cutstump' ? 'Stumps to treat' : 'Plants to treat')}
          ${inp('density', '…or plants per acre', '', 'Count one typical 1/10 acre (66 × 66 ft) and multiply by 10.')}${inp('acres', 'Acres')}`}
      ${m.kind === 'soil' || m.kind === 'pellet' ? inp('height', 'Average height (ft)') + inp('canopy', 'Average canopy width (ft)') : ''}
      ${m.kind === 'pellet' ? sel('perUnit', 'Pellets per 3 ft', [['2', '2 (94% rootkill, redberry)'], ['1', '1 (84% rootkill)']]) : ''}
      ${m.key === 'pad' ? sel('pearSize', 'Typical plant size', Object.entries(PEAR_SIZES).map(([k, v]) => [k, v[0]])) : ''}
      ${m.kind === 'mix' ? inp('perGal', 'Plants per gallon of mix', `placeholder="${m.key === 'pad' ? PEAR_SIZES[P.pearSize]?.[1] : m.perGal} (estimate)"`, 'Spray one full tank, count the plants it covered, and put that here.')
        + inp('pct', 'Herbicide % in the mix', `placeholder="${m.pct}"`, `Brush Busters: ${m.pctRange}.`) + inp('tank', 'Sprayer tank (gal)') : ''}
      ${m.kind !== 'none' && m.kind !== 'pellet' ? inp('price', `${m.kind === 'broadcast' ? m.product : m.product.split(' (')[0]} price ($/gal)`) : ''}
    </div>
    ${m.kind === 'none' ? '' : m.rup
      ? `<p class="note warn">🔒 <b>Restricted use.</b> ${esc(m.product.split(' (')[0])} needs a Texas Department of Agriculture private applicator license to buy and apply, or a licensed applicator. No license? Try ${P.target === 'pear' ? '<b>Pad / stem spray (PastureGard HL)</b>' : P.target === 'mesquite' ? '<b>Leaf spray (Sendero)</b>' : '<b>Pellets</b> or <b>Soil spot (Velpar L)</b>'}.</p>`
      : `<p class="note">✅ <b>General use.</b> No applicator license needed. You can buy it at the feed store. Still read and follow the label.</p>`}
    ${out}
    <h3>How to do it</h3>
    <ol class="steps">
      ${m.kind === 'mix' ? (m.carrier
        ? `<li>Mix: <b>${esc(m.product)}</b> at ${esc(m.pctRange)} in ${esc(m.carrier)}${m.altProducts ? ` (or ${esc(m.altProducts)})` : ''}. No water and no surfactant. Add an oil-soluble dye so you can see which stems are done.</li>`
        : `<li>Mix: fill the tank half full of water, add <b>${esc(m.product)}</b> at ${esc(m.pctRange)}${m.altProducts ? ` (or ${esc(m.altProducts)})` : ''}, then ${m.surfPct ?? 0.25}% surfactant. Add spray dye so you can see what's done, and top up.</li>`) : ''}
      ${m.kind === 'soil' ? '<li>Set an exact-delivery handgun or syringe to 2 ml and attach it to the Velpar L jug. It is used undiluted.</li>' : ''}
      ${m.kind === 'pellet' ? '<li>Pronone Power Pellets come in jars and pails from ranch-supply stores. Carry them in a pouch and count as you go. Marking treated trees with flagging tape helps.</li>' : ''}
      <li>${esc(m.note)}</li>
      <li><b>When:</b> ${esc(m.when)}</li>
      <li>Outline the area on the <a href="#/map?outline=newbrush">map</a> and log the job below, so it counts as habitat control in the valuation packet and shows up for retreatment in ~${TARGETS[P.target]?.retreat ?? 7} years.</li>
    </ol>
    <div class="head-actions">
      <button class="btn" data-plan-log="planned">Save as planned</button>
      <button class="btn primary" data-plan-log="done">Log as done</button>
    </div>
    <details class="lines" ${m.kind === 'none' ? 'open' : ''}><summary>Non-chemical alternatives for ${esc((TARGETS[P.target]?.label || '').toLowerCase())}</summary>
      <ul class="plain small" style="margin-top:8px">${alternatives.map((x) => `<li>• <b>${esc(x.label)}.</b> ${esc(x.note)} <i>${esc(x.when)}</i></li>`).join('')}
        ${P.target === 'mesquite' ? '<li>• <b>Don’t shred or chain it.</b> Taking the top off without killing the root crown turns one trunk into a thicket of resprouts.</li><li>• <b>Leave some.</b> Mesquite beans feed deer, and the shade is loafing cover for cattle. Clear dense stands and leave scattered big trees, especially along draws.</li><li>• <b>Hire it out.</b> Grubbing or root-plowing by a dozer or skid-steer contractor, cost-shared through NRCS EQIP practice 314 (Brush Management).</li>'
          : P.target === 'cedar' ? '<li>• <b>Goats.</b> They browse cedar seedlings and resprouts and help keep a cleared area clean, but they won’t clear an established stand.</li><li>• <b>Hire it out.</b> A skid steer with tree shears or a mulcher clears 1–3 ac/day in moderate cedar. NRCS EQIP practice 314 (Brush Management) can cost-share it.</li>'
          : '<li>• <b>Pear burner (propane).</b> Singeing off the spines turns pear into emergency cattle feed in a drought. It uses the pear rather than removing it.</li><li>• <b>Leave some.</b> Scattered pear clumps are food and cover for deer, quail and javelina. Clear the dense stands and keep 5–10% cover.</li>'}
      </ul>
    </details>
    <details class="lines"><summary>Safety &amp; label notes</summary>
      <ul class="plain small" style="margin-top:8px">
        <li>• Always read and follow the label. It is the law, and it overrides these notes.</li>
        <li>• <b>Restricted use (license needed):</b> Tordon 22K, Surmount and MezaVue, which all contain picloram. Buying and applying them needs a Texas Department of Agriculture private applicator license, or hire a licensed applicator.</li>
        <li>• <b>General use (no license):</b> Pronone Power Pellets and Velpar L (hexazinone) for cedar; Sendero, Remedy Ultra and Reclaim for mesquite; and PastureGard HL (triclopyr + fluroxypyr) for prickly pear. Product status can change, so check the label on the container you buy.</li>
        <li>• Picloram and hexazinone move through the soil. Keep them away from the root zones of live oaks and other trees you want to keep (roots reach well past the drip line), and away from wells, tanks and creeks.</li>
        <li>• Don't spray in wind or when drift could reach neighbors' crops or gardens. Wear gloves and eye protection, and follow the label's grazing and haying restrictions.</li>
        <li>• Mature cedar–oak woodland can be habitat for the endangered golden-cheeked warbler. Talk to TPWD or USFWS before clearing big, old stands.</li>
      </ul>
    </details>
  </section>`;
}
export function bindBrush(el) {
  bindBrushScan(el);
  el.querySelectorAll('[data-plan-target]').forEach((b) => b.addEventListener('click', () => {
    const t = b.dataset.planTarget;
    db.saveSettings({ brushPlan: { ...planState(), target: t, method: TARGETS[t].first, perGal: '', pct: '', price: '', ptPerAcre: t === 'mesquite' ? 1.75 : 4, carrier: t === 'mesquite' ? 5 : 20 } });
  }));
  el.querySelectorAll('[data-plan-log]').forEach((b) => b.addEventListener('click', () => {
    const P = planState();
    const { m, plants, r } = planResult(P);
    const chem = m.kind === 'mix' && r ? `${r.mixGal.toFixed(1)} gal of ${r.pct}% ${m.product} + 0.25% surfactant (${floz(r.herbFlOz)} herbicide) on ${n0(plants)} plants`
      : m.kind === 'pellet' && r ? `Pronone Power Pellets, ${r.perPlant} per tree × ${n0(plants)} trees (${n0(r.pellets)} pellets)`
      : m.kind === 'soil' && r ? `Velpar L soil spot, ${r.mlPerPlant} ml/tree × ${n0(plants)} trees (${r.totalFlOz.toFixed(1)} fl oz)`
      : m.kind === 'broadcast' && r ? `${m.product} ${P.ptPerAcre} pt/ac broadcast, ${r.productGal.toFixed(1)} gal product in ${n0(r.carrierGal)} gal spray`
      : 'No chemical';
    openForm('brush', null, {
      status: b.dataset.planLog,
      species: TARGETS[P.target]?.species || 'other',
      method: m.method,
      acres: Number(P.acres) || '',
      cost: r?.cost != null ? Math.round(r.cost) : '',
      retreatYears: TARGETS[P.target]?.retreat ?? 7,
      notes: `${m.label}. ${chem}.`,
    });
  }));
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
  { col: 'brushscans', label: 'Brush photos', color: '#15803D', name: (r) => `${r.area || 'brush photo'} ${r.date}${r.result ? ` · ${r.result.species.filter((x) => x.species !== 'other brush').map((x) => `${x.species} ${Math.round(x.canopy_cover_pct)}%`).join(', ') || 'no target brush'}` : ''}` },
  { col: 'photos', label: 'Photos', color: '#E11D48', name: (r) => r.caption || r.date },
];

/* Survives re-renders (the page redraws whenever data syncs). */
const M = { hidden: new Set(['photos']), view: null, mode: null, target: 'boundary', pts: [], watch: null, wake: null, acc: null, map: null };

const shapeRings = (p) => ringsOf(p.shape).filter((r) => r.length >= 3);
/* Outline targets: the boundary, a pasture, a brush treatment, or a new brush area. */
const targetCol = (t) => (t === 'boundary' || t === 'newbrush' ? t : db.get('pastures', t) ? 'pastures' : db.get('brush', t) ? 'brush' : 'boundary');
const brushName = (b) => `${b.species || 'brush'} ${b.status === 'planned' ? 'planned' : 'cleared'}${b.area ? `, ${b.area}` : ''} (${b.date || '?'})`;
const targetName = (t) => {
  const c = targetCol(t);
  if (c === 'boundary') return 'property boundary';
  if (c === 'newbrush') return 'cleared (or planned) brush area';
  if (c === 'brush') return `${brushName(db.get('brush', t))} area`;
  return `${db.get('pastures', t)?.name || 'pasture'} outline`;
};
const BRUSH_COLORS = { cedar: '#15803D', 'prickly pear': '#0891B2', mesquite: '#CA8A04', other: '#6B7280' };
let lastOutlineParam = null;
const lineMiles = (pts) => pts.slice(1).reduce((s, p, i) => s + distance(pts[i], p), 0) / 1609.344;

export function map(params) {
  const op = params?.get?.('outline') || null;
  if (op !== lastOutlineParam) { if (op && (op === 'newbrush' || db.get('brush', op) || db.get('pastures', op))) { M.target = op; M.view = null; } lastOutlineParam = op; }
  const s = S();
  const rings = boundaryRings();
  const acres = rings.reduce((t, r) => t + ringAcres(r), 0);
  const pastures = db.all('pastures').sort((a, b) => a.name.localeCompare(b.name));
  const drawing = M.mode === 'draw' || M.mode === 'walk' || M.mode === 'pin';
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
          <option value="newbrush" ${M.target === 'newbrush' ? 'selected' : ''}>＋ New cleared brush area</option>
          ${db.all('brush').sort((a, b) => (a.date < b.date ? 1 : -1)).map((b) => `<option value="${esc(b.id)}" ${M.target === b.id ? 'selected' : ''}>Brush: ${esc(brushName(b))}${ringsOf(b.shape).length ? ' ▰' : ''}</option>`).join('')}
        </select></label>
        <button class="btn primary" data-map-pin>📌 Drop pin</button>
        <button class="btn" data-map-draw>✏️ Tap corners</button>
        <button class="btn" data-map-walk>🚶 Drive / walk the fence</button>
        <label class="btn">📂 Import file<input type="file" data-map-file hidden></label>
        ${(targetCol(M.target) === 'boundary' ? rings.length : targetCol(M.target) === 'newbrush' ? 0 : shapeRings(db.get(targetCol(M.target), M.target) || {}).length) ? '<button class="btn danger" data-map-clear>Clear</button>' : ''}
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
    const col = targetCol(M.target);
    if (col === 'boundary') await db.saveSettings({ boundary: null });
    else await db.put(col, { ...db.get(col, M.target), shape: null });
  });
  el.querySelector('[data-map-file]')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const rings = await parseMapFile(file.name, new Uint8Array(await file.arrayBuffer()));
      M.view = null; // fit to the new shape
      await saveShape(targetCol(M.target) === 'boundary' ? rings : [rings.sort((a, b) => ringAcres(b) - ringAcres(a))[0]], `Imported ${file.name}`);
    } catch (err) { toast(`Couldn't use that file: ${err.message}`); }
    e.target.value = '';
  });
  el.querySelector('[data-map-draw]')?.addEventListener('click', () => { M.mode = 'draw'; M.pts = []; rerender(); });
  el.querySelector('[data-map-pin]')?.addEventListener('click', () => { M.mode = 'pin'; rerender(); });
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
  if (!M.hidden.has('brush')) {
    for (const b of db.all('brush')) {
      for (const ring of shapeRings(b)) {
        const ll = ring.map(([x, y]) => [y, x]);
        const color = BRUSH_COLORS[b.species] || BRUSH_COLORS.other;
        const planned = b.status === 'planned';
        L.polygon(ll, { color, weight: 2, dashArray: planned ? '6 6' : null, fillColor: color, fillOpacity: planned ? 0.08 : 0.3 })
          .bindTooltip(`${esc(b.species || 'Brush')} ${planned ? 'planned' : 'cleared'} ${esc((b.date || '').slice(0, 7))} · ${n1(ringAcres(ring))} ac${b.method ? ` · ${esc(b.method)}` : ''}`)
          .on('click', () => { if (!M.mode) openForm('brush', db.get('brush', b.id)); })
          .addTo(map);
        bounds.push(...ll);
      }
    }
  }
  for (const Lr of LAYERS) {
    if (M.hidden.has(Lr.col)) continue;
    for (const r of db.all(Lr.col)) {
      if (!r.loc?.lat || !r.loc?.lon) continue;
      if (Lr.col === 'brush' && ringsOf(r.shape).length) continue; // drawn as an area
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
    if (M.mode === 'pin') {
      status.innerHTML = `<b>📌 Tap the map where it goes.</b> Zoom in for a precise spot. You'll then pick what to add, or move an existing record there.
        <div class="map-status-actions"><button class="btn" data-map-cancel>Done</button></div>`;
      status.querySelector('[data-map-cancel]').addEventListener('click', () => { M.mode = null; rerender(); });
      return;
    }
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
  map.on('click', (e) => { if (M.mode === 'pin') { pinChooser(+e.latlng.lat.toFixed(6), +e.latlng.lng.toFixed(6)); return; } if (M.mode === 'draw') { M.pts.push([+e.latlng.lng.toFixed(6), +e.latlng.lat.toFixed(6)]); redraw(); } });
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
  } else if (targetCol(M.target) === 'newbrush') {
    const all = rings.flat();
    const loc = { lat: +(all.reduce((t, p) => t + p[1], 0) / all.length).toFixed(6), lon: +(all.reduce((t, p) => t + p[0], 0) / all.length).toFixed(6) };
    const plan = db.settings().brushPlan;
    const saved = await openForm('brush', null, { shape: toGeoJSON(rings, { name: 'Brush treatment' }), acres: Math.round(acres * 10) / 10, loc, status: 'done', species: TARGETS[plan?.target]?.species || 'cedar' });
    if (saved) { M.target = saved.id; toast(`${verb}: ${saved.species} area, ${n1(acres)} ac`); }
  } else if (targetCol(M.target) === 'brush') {
    const b = db.get('brush', M.target);
    const patch = { shape: toGeoJSON(rings, { name: 'Brush treatment' }) };
    if (!(Number(b.acres) > 0) || (Math.abs(acres - Number(b.acres)) / Number(b.acres) > 0.05 && confirm(`The outline measures ${n1(acres)} ac. Update the treatment's acres (now ${b.acres})?`))) patch.acres = Math.round(acres * 10) / 10;
    await db.put('brush', { ...b, ...patch });
    toast(`${verb}: ${brushName(b)}, ${n1(acres)} ac`);
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

/* ---------------------------- drop a pin ---------------------------------- */
const PIN_TYPES = [
  ['waterpoints', '💧 Water point'], ['devices', '📷 Camera / feeder'], ['fences', '🚪 Gate / fence'],
  ['brush', '🌳 Brush treatment'], ['dovefields', '🕊 Dove field'], ['pastures', '🌾 Pasture'],
];
function pinChooser(lat, lon) {
  const loc = { lat, lon };
  const existing = PIN_TYPES.map(([col, label]) => ({ col, label, rows: db.all(col).sort((a, b) => String(LAYERS.find((x) => x.col === col).name(a)).localeCompare(String(LAYERS.find((x) => x.col === col).name(b)))) }))
    .filter((g) => g.rows.length);
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet';
  dlg.innerHTML = `<div class="sheet-form">
    <header class="sheet-head"><h2>What's here?</h2><button type="button" class="icon-btn" data-x aria-label="Close">✕</button></header>
    <div class="sheet-body pin-body">
      <p class="small muted wide">${lat.toFixed(5)}, ${lon.toFixed(5)}</p>
      <div class="pin-grid wide">${PIN_TYPES.map(([col, label]) => `<button type="button" class="btn" data-new="${col}">＋ ${label}</button>`).join('')}</div>
      ${existing.length ? `<label class="field wide">…or move an existing record here
        <select data-move><option value="">Choose…</option>${existing.map((g) => `<optgroup label="${esc(g.label.replace(/^\S+ /, ''))}">${g.rows.map((r) => `<option value="${g.col}:${esc(r.id)}">${esc(LAYERS.find((x) => x.col === g.col).name(r))}${r.loc?.lat ? ' (has a pin)' : ''}</option>`).join('')}</optgroup>`).join('')}</select></label>` : ''}
    </div>
    <footer class="sheet-foot"><span class="grow"></span><button type="button" class="btn" data-x>Cancel</button></footer>
  </div>`;
  document.body.appendChild(dlg);
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dlg.addEventListener('click', (e) => {
    if (e.target.closest('[data-x]')) close();
    const b = e.target.closest('[data-new]');
    if (b) { close(); openForm(b.dataset.new, null, { loc }); }
  });
  dlg.querySelector('[data-move]')?.addEventListener('change', async (e) => {
    const [col, id] = e.target.value.split(':');
    const rec = db.get(col, id);
    if (!rec) return;
    close();
    await db.put(col, { ...rec, loc });
    toast(`Moved ${LAYERS.find((x) => x.col === col).name(rec)} here`);
  });
  dlg.showModal();
}
