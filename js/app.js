/* =========================================================================
   Mason County Ranch — router, navigation and the dashboard.
   ========================================================================= */
import * as db from './db.js';
import * as C from './calc.js';
import { S, stocking, alerts, practiceCoverage, latestCensus } from './model.js';
import { esc, n1, n0, pct, usd, stat, pill, installListHandlers, openForm, toast } from './ui.js';
import * as G from './pages/grazing.js';
import * as W from './pages/wildlife.js';
import * as L from './pages/land.js';
import * as K from './pages/compliance.js';
import * as M from './pages/money.js';
import * as O from './pages/ops.js';
import { APP_VERSION } from './version.js';

const ROUTES = {
  home: { title: 'Dashboard', group: '', render: dashboard, bind: bindDashboard },
  settings: { title: 'Settings & backup', group: '', render: O.settings, bind: O.bindSettings },
  stocking: { title: 'Stocking', group: 'Grazing', render: G.stockingPage },
  pastures: { title: 'Pastures', group: 'Grazing', render: G.pastures, bind: G.bindPastures },
  herd: { title: 'Herd', group: 'Grazing', render: G.herd, bind: G.bindHerd },
  harvest: { title: 'Deer harvest', group: 'Wildlife', render: W.harvest, bind: W.bindHarvest },
  census: { title: 'Spotlight census', group: 'Wildlife', render: W.census },
  devices: { title: 'Cams & feeders', group: 'Wildlife', render: W.devices, bind: W.bindDevices },
  dove: { title: 'Dove fields', group: 'Wildlife', render: W.dove, bind: W.bindDove },
  rain: { title: 'Rain gauge', group: 'Land & water', render: G.rain },
  water: { title: 'Water points', group: 'Land & water', render: L.water, bind: L.bindWater },
  brush: { title: 'Brush · cedar, mesquite, pear', group: 'Land & water', render: L.brush, bind: L.bindBrush },
  fences: { title: 'Fences & gates', group: 'Land & water', render: L.fences },
  map: { title: 'Map', group: 'Land & water', render: L.map, bind: L.bindMap },
  valuation: { title: 'Valuation binder', group: 'Compliance', render: K.valuation, bind: K.bindValuation },
  leases: { title: 'Hunting leases', group: 'Compliance', render: K.leases },
  nrcs: { title: 'EQIP / NRCS', group: 'Compliance', render: K.nrcs },
  pnl: { title: 'Enterprise P&L', group: 'Money', render: M.pnl, bind: M.bindPnl },
  scenarios: { title: 'Scenarios', group: 'Money', render: M.scenarios, bind: M.bindScenarios },
  tasks: { title: 'Tasks', group: 'Ops', render: O.tasks, bind: O.bindTasks },
  contacts: { title: 'Contacts', group: 'Ops', render: O.contacts },
  photos: { title: 'Photo log', group: 'Ops', render: O.photos, bind: O.bindPhotos },
  packet: { title: 'Year-end packet', group: 'hidden', render: K.packet, bind: K.bindPacket },
};

const main = document.getElementById('main');
const nav = document.getElementById('nav');

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '') || 'home';
  const [name, qs] = h.split('?');
  return { name: ROUTES[name] ? name : 'home', params: new URLSearchParams(qs || '') };
}

function renderNav(active) {
  const groups = {};
  for (const [k, r] of Object.entries(ROUTES)) if (r.group !== 'hidden') (groups[r.group] ||= []).push([k, r]);
  nav.innerHTML = Object.entries(groups).map(([g, items]) => `
    ${g ? `<div class="nav-group">${esc(g)}</div>` : ''}
    ${items.map(([k, r]) => `<a href="#/${k}" class="${k === active ? 'on' : ''}">${k === 'settings' ? '⚙︎ ' : ''}${esc(r.title)}</a>`).join('')}`).join('')
    + `<div class="nav-version">Version ${APP_VERSION}</div>`;
}

let rendering = false;
function render() {
  if (rendering) return;
  rendering = true;
  const { name, params } = parseHash();
  const r = ROUTES[name];
  const y = window.scrollY;
  document.body.classList.toggle('print-mode', name === 'packet');
  document.getElementById('page-title').textContent = r.title;
  document.title = `${r.title} · ${S().ranchName}`;
  renderNav(name);
  document.getElementById('settings-btn')?.classList.toggle('on', name === 'settings');
  try {
    main.innerHTML = r.render(params);
    r.bind?.(main, render, params);
  } catch (err) {
    console.error(err);
    main.innerHTML = `<section class="panel"><h2>Something broke on this page</h2><pre class="small">${esc(err.stack || err.message)}</pre></section>`;
  }
  window.scrollTo(0, y);
  rendering = false;
}

/* Inline settings inputs: <input data-set="acres"> or data-set="scenario.adg". */
main.addEventListener('change', async (e) => {
  const el = e.target.closest('[data-set]');
  if (!el) return;
  const path = el.dataset.set.split('.');
  let v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? (el.value === '' ? '' : Number(el.value)) : el.value;
  const s = db.settings();
  if (path.length === 2) await db.saveSettings({ [path[0]]: { ...(s[path[0]] || {}), [path[1]]: v } });
  else await db.saveSettings({ [path[0]]: v });
});

/* ------------------------------- dashboard ------------------------------- */
function dashboard() {
  const t = C.today();
  const s = S();
  const st = stocking(t);
  const al = alerts(t);
  const census = latestCensus();
  const cov = practiceCoverage(C.yearOf(t));
  const kpiNow = C.calfCropKPIs(db.all('animals'), db.all('events'), C.yearOf(t));
  const kpi = kpiNow.weaned ? kpiNow : C.calfCropKPIs(db.all('animals'), db.all('events'), C.yearOf(t) - 1);
  const pl = C.enterprisePL(C.yearOf(t), { ledger: db.all('ledger'), sales: db.all('events').filter((e) => e.type === 'sale'), animals: db.all('animals'), leases: db.all('leases') });
  const lastRain = db.all('rain').filter((r) => Number(r.inches) > 0).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  const tone = st.status.state === 'over' ? 'bad' : st.status.state === 'full' ? 'warn' : 'good';
  const empty = !db.all('animals').length && !db.all('rain').length;
  return `
    ${empty ? `<section class="panel hero">
      <h2>Set up the place</h2>
      <p>This app keeps the records that protect your valuation and tell you when to destock. Everything is stored on this phone and works with no signal.</p>
      <ol><li>Log rain readings (they drive the stocking calculator).</li><li>Add your cows, bull and calves.</li><li>Log deer harvest and spotlight runs.</li><li>Export a backup under Settings after each trip.</li></ol>
      <div class="head-actions"><a class="btn primary" href="#/rain">Start with the rain gauge</a><button class="btn" data-sample>Load a sample ranch to explore</button></div>
    </section>` : ''}
    <section class="panel">
      <div class="panel-head"><h2>${esc(s.ranchName)}</h2><span class="muted small">${s.acres} ac · ${esc(s.county)} County</span></div>
      <div class="stats">
        <a href="#/stocking">${stat('Stocking', `${n1(st.herd.au)} / ${st.cap.head}`, st.status.msg, tone)}</a>
        <a href="#/rain">${stat('Rain, 12 mo', st.rain.ratio == null ? '—' : pct(st.rain.ratio), rainSub(lastRain), st.rain.ratio != null && st.rain.ratio < 0.75 ? 'warn' : '')}</a>
        <a href="#/herd">${stat('Lb weaned / exposed', kpi.lbsPerExposed == null ? '—' : n0(kpi.lbsPerExposed), `${kpi.crop} calf crop`)}</a>
        <a href="#/census">${stat('Acres per deer', census ? n1(census.acresPerDeer) : '—', census ? `~${n0(census.population)} deer (${census.year})` : 'no census')}</a>
        <a href="#/valuation">${stat('Wildlife practices', `${cov.met}/7`, s.valuation === 'wildlife' ? (cov.ok ? '3-of-7 met' : 'need 3') : 'ag valuation', s.valuation === 'wildlife' && !cov.ok ? 'bad' : '')}</a>
        <a href="#/pnl">${stat(`Net ${C.yearOf(t)} to date`, usd(pl.net), `${usd(pl.income)} in · ${usd(pl.expense)} out`)}</a>
      </div>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Needs attention</h2>${pill(`${al.length}`, al.some((a) => a.tone === 'bad') ? 'bad' : al.length ? 'warn' : 'good')}</div>
      ${al.length ? `<ul class="alerts">${al.slice(0, 20).map((a) => `<li class="${a.tone}"><a href="${a.href}">${esc(a.text)}</a></li>`).join('')}</ul>` : '<p class="empty">All clear.</p>'}
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Quick log</h2></div>
      <div class="quick">
        <button class="btn" data-q="rain">🌧 Rain</button>
        <button class="btn" data-q="waterchecks">💧 Water check</button>
        <button class="btn" data-q="events">🐄 Herd event</button>
        <button class="btn" data-q="harvests">🦌 Deer harvest</button>
        <button class="btn" data-q="surveys">🔦 Spotlight run</button>
        <button class="btn" data-q="fencelog">🧱 Fence check</button>
        <button class="btn" data-q="ledger">💵 Expense</button>
        <a class="btn" href="#/photos">📷 Photo</a>
        <a class="btn" href="#/settings">⚙︎ Settings</a>
      </div>
    </section>`;
}
function rainSub(lastRain) {
  const mix = C.rainSourceMix(db.all('rain'), C.today());
  const src = mix.sample.days ? 'includes SAMPLE data' : mix.estimate.days > mix.gauge.days + mix.manual.days ? 'estimated, not measured' : null;
  const last = lastRain ? `last: ${lastRain.inches}″ on ${lastRain.date}` : 'no readings';
  return src ? `${last} · ${src}` : last;
}
function bindDashboard(el) {
  el.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => openForm(b.dataset.q)));
  el.querySelector('[data-sample]')?.addEventListener('click', async () => {
    const { loadSample } = await import('./sample.js');
    await loadSample();
    toast('Sample ranch loaded — remove it any time under Settings');
  });
}

/* --------------------------------- boot ---------------------------------- */
async function boot() {
  try {
    await db.init();
  } catch (err) {
    main.innerHTML = `<section class="panel"><h2>Storage unavailable</h2><p>This browser blocked local storage (private mode?). The app needs it to keep records offline.</p></section>`;
    return;
  }
  installListHandlers(main);
  let queued = false;
  db.onChange(() => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; render(); }); } });
  window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); document.body.classList.remove('nav-open'); });
  document.getElementById('menu-btn').addEventListener('click', () => document.body.classList.toggle('nav-open'));
  document.getElementById('scrim').addEventListener('click', () => document.body.classList.remove('nav-open'));
  const net = () => document.getElementById('net').classList.toggle('hidden', navigator.onLine);
  window.addEventListener('online', net); window.addEventListener('offline', net); net();
  render();
  // Automatic data from the relay: now, every 15 min while open, and when signal returns.
  const pull = () => import('./relay.js').then((m) => m.syncRelay()).then((r) => {
    if (r && (r.photos || r.rain)) toast(`New from the ranch: ${[r.photos && `${r.photos} photos`, r.rain && `${r.rain} rain days`].filter(Boolean).join(', ')}`);
  }).catch(() => {});
  setTimeout(pull, 1500);
  setInterval(pull, 15 * 60 * 1000);
  window.addEventListener('online', pull);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pull(); });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // A new version just took over: reload once so its HTML/CSS/JS are used.
      if (hadController && !reloaded && !document.querySelector('dialog[open]')) { reloaded = true; location.reload(); }
    });
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((reg) => {
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    }).catch(() => {});
  }
}
boot();
