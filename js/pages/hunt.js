/* Hunting outlook: right now and the next 5 days for dove, whitetail,
   turkey, hogs, coyotes and bobcats. Scores come from the weather station and
   an hourly forecast, adjusted by what your own cameras see, solunar periods
   and your stands' good winds. A hunt log records each sit with its
   conditions so the app can show what's worked on your place.
   Logic lives in ../hunting.js and ../huntplan.js. */
import * as db from '../db.js';
import * as H from '../hunting.js';
import * as P from '../huntplan.js';
import { esc, stat, pill, listPanel, openForm } from '../ui.js';
import { stationContext } from './weather.js';
import { ranchPlace, coordsWarning } from '../place.js';
import { sunTimes, ymd, addDays, today } from '../calc.js';
import { photoTags } from '../photos.js';
import { inDaylight, photoBucks } from '../deer.js';
import { cachedForecast, refreshForecast } from '../forecast.js';

const TONE = { excellent: 'good', good: 'good', fair: 'warn', poor: 'bad', closed: '', unsafe: 'bad' };
const clock = (ms) => (ms == null ? '—' : new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
const day = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
const dayName = (iso) => (iso === today() ? 'Today' : iso === addDays(today(), 1) ? 'Tomorrow' : new Date(`${iso}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }));
const mins = (m) => { const h = Math.floor(m / 60) % 24; return `${h % 12 || 12}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`; };
const moonIcon = (age) => ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'][Math.round((age / 29.53) * 8) % 8];
const ui = { open: new Set(), plan: null, jumped: false };

/* ------------------------------ shared context ---------------------------- */
function context() {
  const pl = ranchPlace();
  const x = stationContext();
  const fc = cachedForecast();
  const hours = fc?.hourly ? P.forecastHours({ hourly: fc.hourly }) : [];
  const camPhotos = db.all('photos').filter((p) => p.date && p.time).map((p) => ({ date: p.date, time: p.time, device: p.device, tags: photoTags(p) }));
  const act = new Map();
  const activity = (key) => {
    if (!act.has(key)) act.set(key, H.cameraActivity(camPhotos, key, { today: new Date(), cameraName: (id) => db.get('devices', id)?.name || 'Camera' }));
    return act.get(key);
  };
  const weekAgo = addDays(today(), -7);
  const buckDaylight = db.all('photos').filter((p) => photoBucks(p).length && p.date >= weekAgo && inDaylight(p, pl.lat, pl.lon)).length;
  const sol = new Map();
  const solunar = (t) => { const d = ymd(new Date(t)); if (!sol.has(d)) sol.set(d, P.solunarDay(pl.lat, pl.lon, t)); return sol.get(d); };
  const extras = (key) => (t) => ({ activity: activity(key), solunar: solunar(t), buckDaylight });
  return { pl, x, fc, hours, activity, solunar, stands: db.all('stands'), extras };
}

function nowOutlooks(ctx) {
  const t = Date.now();
  const fcNow = ctx.hours.length ? P.conditionsAt(ctx.hours, t) : null;
  const base = ctx.x
    ? { data: ctx.x.data, pressTrend: ctx.x.pressTrend ?? fcNow?.pressTrend ?? null, dailyAvgTemps: ctx.x.dailyAvgTemps, tempChange24h: fcNow?.tempChange24h ?? null }
    : fcNow ? { data: fcNow.data, pressTrend: fcNow.pressTrend, dailyAvgTemps: fcNow.dailyAvgTemps, tempChange24h: fcNow.tempChange24h, cloud: fcNow.cloud } : { data: {} };
  const rank = (o) => (o.level === 'unsafe' ? 2 : o.season.open ? 1 : 0);
  return {
    source: ctx.x ? 'station' : fcNow ? 'forecast' : null, base,
    list: H.GAME.map((g) => {
      const o = H.huntingOutlook(g.key, { ...base, lat: ctx.pl.lat, lon: ctx.pl.lon, ...ctx.extras(g.key)(t) });
      return { ...o, stands: H.recommendStands(ctx.stands, { key: g.key, winddir: base.data.winddir, activity: ctx.activity(g.key) }) };
    }).sort((a, b) => rank(b) - rank(a) || b.score - a.score),
  };
}

const factorList = (o) => `<ul class="plain fish-factors">${o.factors.map((f) => `<li><span class="fish-pts ${f.pts > 0 ? 'good-t' : f.pts < 0 ? 'bad-t' : 'muted'}">${f.pts > 0 ? '+' : ''}${f.pts}</span><div><b>${esc(f.label)}.</b> ${esc(f.note)}</div></li>`).join('')}</ul>`;
const standLine = (recs) => { const r = recs.find((x) => x.ok); return r ? `🪜 Sit <b>${esc(r.stand.name)}</b> <small>(${esc(r.why.join(', '))})</small>` : ''; };
const seasonLine = (o) => (o.season.always ? 'No closed season on private land'
  : o.season.open ? `Open · ${o.season.label}, through ${day(o.season.until)}`
    : o.season.next ? `Closed · opens ${day(o.season.next.start)}: ${o.season.next.label}` : 'Closed · check TPWD for next season');
const hoursLine = (o) => (o.hours.any ? 'Any hour on private land' : `Legal today ${clock(o.hours.start)}–${clock(o.hours.end)}${o.legalNow ? '' : ' · outside legal hours now'}`);
const condShort = (c) => `${Math.round(c.data.tempf)}° · ${H.compass8(c.data.winddir) || ''} ${Math.round(c.data.windspeedmph ?? 0)} mph${c.precipProb >= 30 ? ` · rain ${c.precipProb}%` : ''}${c.cloud != null ? ` · ${c.cloud >= 70 ? 'cloudy' : c.cloud >= 30 ? 'partly cloudy' : 'clear'}` : ''}`;
const hasFront = (o) => o.factors.some((f) => f.label === 'Cold front');

/** Conditions saved with a logged hunt, so the app can learn what worked. */
function condFor(o, data, pressTrend) {
  return {
    tempf: data.tempf != null ? Math.round(data.tempf) : null, wind: data.windspeedmph != null ? Math.round(data.windspeedmph) : null,
    dir: H.compass8(data.winddir), pressTrend: pressTrend ?? null, front: hasFront(o), score: o.score, level: o.cond,
  };
}

/* ---------------------------------- tile ---------------------------------- */
/** Dashboard tile: the best sit coming up for in-season game, or the best right now. */
export function huntingTile() {
  const ctx = context();
  if (!ctx.x && !ctx.hours.length) return '';
  const sits = ctx.hours.length ? H.GAME.filter((g) => g.season).flatMap((g) => P.planSits(g.key, ctx.hours, { lat: ctx.pl.lat, lon: ctx.pl.lon, days: 4, extras: ctx.extras(g.key) }))
    .filter((s) => s.outlook.season.open && s.outlook.level !== 'unsafe').sort((a, b) => b.outlook.score - a.outlook.score) : [];
  if (sits[0]) {
    const s = sits[0];
    return `<a href="#/hunt?at=plan">${stat('Best sit coming up', `${s.outlook.game.icon} ${s.outlook.score}`, `${s.outlook.game.label} · ${dayName(s.date)} ${s.session === 'AM' ? 'morning' : 'evening'}`, TONE[s.outlook.level])}</a>`;
  }
  const best = nowOutlooks(ctx).list.find((o) => o.season.open && !o.season.always);
  return best ? `<a href="#/hunt">${stat(`Hunting: ${best.game.label}`, best.level, `${best.score}/100`, TONE[best.level])}</a>` : '';
}

/* ---------------------------------- page ---------------------------------- */
function nowPanel(ctx) {
  const { source, list } = nowOutlooks(ctx);
  const sun = sunTimes(ctx.pl.lat, ctx.pl.lon, Date.now());
  const sol = ctx.solunar(Date.now());
  return `<section class="panel">
    <div class="panel-head"><h2>Right now</h2>${ctx.x ? pill(`${Math.round(ctx.x.data.tempf ?? 0)}°F · ${H.compass8(ctx.x.data.winddir) || ''} ${Math.round(ctx.x.data.windspeedmph ?? 0)} mph`) : ''}</div>
    ${source === 'station' ? '<p class="note">Scored from the ranch weather station, the forecast, your cameras, solunar times and your stands. Tap a card for the reasons.</p>'
      : source === 'forecast' ? '<p class="note">No weather station reading, so this uses the forecast for the ranch.</p>'
        : '<p class="note warn">No weather yet. Open this page with signal to load the forecast, or connect the weather station.</p>'}
    <p class="small muted">📍 ${ctx.pl.lat.toFixed(4)}, ${ctx.pl.lon.toFixed(4)} (${esc(ctx.pl.source)}) · sunrise ${clock(sun.rise)}, sunset ${clock(sun.set)} · ${moonIcon(sol.age)} moon ${sol.illumination}% · now ${clock(Date.now())}</p>
    ${coordsWarning() ? `<p class="note warn">📍 ${esc(coordsWarning())}</p>` : ''}
    <div class="hunt-cards">${list.map((o) => {
      const cam = o.factors.find((f) => f.label === 'Your cameras' && f.pts > 0);
      return `<details class="card hunt-card ${o.level}" data-hunt="${o.key}" ${ui.open.has(o.key) ? 'open' : ''}>
        <summary>
          <div class="hunt-top"><span class="hunt-icon">${o.game.icon}</span><b>${esc(o.game.label)}</b>
            ${pill(o.level === 'unsafe' ? 'UNSAFE' : o.level === 'closed' ? `closed · ${o.cond}` : o.level, TONE[o.level])}
            ${source && o.level !== 'unsafe' ? `<span class="hunt-score">${o.score}</span>` : ''}</div>
          ${source ? `<div class="small">${esc(o.headline)}</div>` : ''}
          ${cam ? `<div class="small">📷 ${esc(cam.note)}</div>` : ''}
          ${standLine(o.stands) ? `<div class="small">${standLine(o.stands)}</div>` : ''}
          <div class="small muted">${esc(seasonLine(o))}<br>${esc(hoursLine(o))}</div>
        </summary>
        ${source ? factorList(o) : ''}
        <div class="head-actions"><button class="btn sm" data-log-now="${o.key}">📝 Log a hunt</button></div>
      </details>`;
    }).join('')}</div>
  </section>`;
}

function planPanel(ctx) {
  const inSeason = H.GAME.filter((g) => g.season && H.seasonStatus(g.season, today()).open);
  const key = ui.plan || inSeason[0]?.key || 'deer';
  if (!ctx.hours.length) {
    return `<section class="panel" id="plan"><div class="panel-head"><h2>Next 5 days</h2></div>
      <p class="note">${navigator.onLine ? 'Loading the forecast…' : 'Open this page with signal once to load the forecast. It stays on the phone for use without signal.'}</p></section>`;
  }
  const sits = P.planSits(key, ctx.hours, { lat: ctx.pl.lat, lon: ctx.pl.lon, days: 5, extras: ctx.extras(key) });
  const top = new Set([...sits].filter((s) => s.outlook.season.open).sort((a, b) => b.outlook.score - a.outlook.score).slice(0, 3).map((s) => s.t));
  const allBest = H.GAME.flatMap((g) => P.planSits(g.key, ctx.hours, { lat: ctx.pl.lat, lon: ctx.pl.lon, days: 5, extras: ctx.extras(g.key) }))
    .filter((s) => s.outlook.season.open && s.outlook.level !== 'unsafe').sort((a, b) => b.outlook.score - a.outlook.score).slice(0, 5);
  const byDay = [...new Set(sits.map((s) => s.date))];
  return `<section class="panel" id="plan">
    <div class="panel-head"><h2>Next 5 days</h2>${pill(`forecast ${clock(Date.parse(ctx.fc.fetched))}`)}</div>
    ${allBest.length ? `<h3>Best sits this week</h3><ol class="best-sits">${allBest.map((s) => `<li>${s.outlook.game.icon} <b>${esc(s.outlook.game.label)}</b>, ${dayName(s.date)} ${s.session === 'AM' ? 'morning' : 'evening'} ${pill(String(s.outlook.score), TONE[s.outlook.level])}<br><small class="muted">${esc(condShort(s.cond))}${hasFront(s.outlook) ? ' · 🌡️ behind a front' : ''}</small></li>`).join('')}</ol>` : ''}
    <div class="seg">${H.GAME.map((g) => `<button class="${g.key === key ? 'on' : ''}" data-plan="${g.key}">${g.icon} ${esc(g.label)}</button>`).join('')}</div>
    ${byDay.map((d) => {
      const sol = ctx.solunar(Date.parse(`${d}T12:00:00`));
      return `<div class="plan-day">
        <div class="plan-date"><b>${esc(dayName(d))}</b> <small class="muted">${moonIcon(sol.age)} ${sol.illumination}% · ${sol.periods.map((p) => `${p.major ? '●' : '○'} ${clock(p.at)}`).join(' ')}</small></div>
        ${sits.filter((s) => s.date === d).map((s) => {
          const recs = H.recommendStands(ctx.stands, { key, winddir: s.cond.data.winddir, activity: ctx.activity(key) });
          return `<details class="plan-sit ${s.outlook.level}">
            <summary><span class="plan-session">${s.session === 'AM' ? '🌅 AM' : '🌇 PM'}</span>
              ${pill(s.outlook.level === 'closed' ? `closed · ${s.outlook.score}` : String(s.outlook.score), TONE[s.outlook.level])}${top.has(s.t) ? ' ⭐' : ''}
              <span class="small">${esc(condShort(s.cond))}${hasFront(s.outlook) ? ' · 🌡️ front' : ''}</span>
              ${standLine(recs) ? `<div class="small">${standLine(recs)}</div>` : ''}</summary>
            <p class="small">${esc(s.outlook.headline)}</p>
            ${factorList(s.outlook)}
          </details>`;
        }).join('')}
      </div>`;
    }).join('')}
    <p class="small muted">Morning sits are scored for 1 hour after sunrise, evening sits for 1 hour before sunset. ● major / ○ minor solunar periods (moon overhead or underfoot / moonrise or moonset). Forecast from Open-Meteo, refreshed every 2 hours when you have signal.</p>
  </section>`;
}

function camerasPanel(ctx) {
  const rows = H.GAME.map((g) => ({ g, a: ctx.activity(g.key) })).filter((x) => x.a.total > 0);
  return `<section class="panel">
    <div class="panel-head"><h2>What your cameras see</h2>${pill('last 14 days')}</div>
    ${rows.length ? rows.map(({ g, a }) => `<h3>${g.icon} ${esc(g.label)} <small class="muted">${a.total} photo${a.total === 1 ? '' : 's'}</small></h3>
      <ul class="plain cam-act">${a.cameras.map((c) => { const max = Math.max(1, ...c.hours); return `<li><div><b>${esc(c.name)}</b> ${c.window ? `· busiest ${mins(c.window.start)}–${mins(c.window.end)} <small class="muted">(${c.window.n} of ${c.n})</small>` : `<small class="muted">${c.n} photo${c.n === 1 ? '' : 's'}</small>`}</div>
        <div class="mini-hours">${c.hours.map((n, h) => `<span title="${h}:00 · ${n}" style="height:${Math.round((n / max) * 100)}%"></span>`).join('')}</div></li>`; }).join('')}</ul>`).join('')
      : '<p class="empty">No tagged game photos in the last 14 days. Camera photos labeled by the AI (or tagged by you) show up here.</p>'}
    <p class="small muted">Each bar is one hour of the day, midnight to midnight. A sit that overlaps a camera's busiest window gets points in the outlook.</p>
  </section>`;
}

function logPanel() {
  const key = ui.plan || 'deer';
  const standName = new Map(db.all('stands').map((s) => [s.id, s.name]));
  const hunts = db.all('hunts').map((h) => ({ ...h, standName: standName.get(h.stand) || '' }));
  const ins = H.huntInsights(hunts, key);
  const game = H.GAME.find((g) => g.key === key);
  return `${listPanel('stands', { title: 'Stands & blinds', note: 'Set each stand\'s good winds (the directions the wind can come FROM without blowing your scent toward where game approaches) and link the camera that watches it. The planner then suggests where to sit. Pin them on the map with 📍.' })}
    <section class="panel">
      <div class="panel-head"><h2>What's worked: ${game.icon} ${esc(game.label)}</h2><button class="btn primary" data-log-now="${key}">📝 Log a hunt</button></div>
      ${ins.n >= 5 ? `<p>${ins.n} logged hunts, ${ins.avg.toFixed(1)} seen per hunt on average.</p>
        ${ins.groups.map((g) => `<h3>${esc(g.label)}</h3><div class="table-wrap"><table class="tbl"><thead><tr><th></th><th>Hunts</th><th>Seen per hunt</th></tr></thead><tbody>
          ${g.rows.map((r, i) => `<tr${i === 0 && g.rows.length > 1 ? ' class="best-row"' : ''}><td>${esc(r.k)}</td><td class="num">${r.n}</td><td class="num">${r.avg.toFixed(1)}</td></tr>`).join('')}
        </tbody></table></div>`).join('')}
        <p class="small muted">Small numbers swing a lot. Trust a pattern once it holds over 10 or more hunts.</p>`
        : `<p class="note">Log each sit, even the ones where you saw nothing. The app saves the weather, wind and score with it. After ${5 - ins.n} more ${esc(game.label.toLowerCase())} hunt${5 - ins.n === 1 ? '' : 's'} it starts showing what's worked on your place: which winds, stands, temperatures and fronts.</p>`}
    </section>
    ${listPanel('hunts', { title: 'Hunt log' })}`;
}

function seasonsPanel() {
  return `<section class="panel">
    <div class="panel-head"><h2>Mason County seasons ${esc(H.SEASON_YEAR)}</h2></div>
    <div class="table-wrap"><table class="tbl"><thead><tr><th>Game</th><th>Season</th><th>Dates</th></tr></thead><tbody>
      ${H.GAME.filter((g) => g.season).flatMap((g) => H.SEASONS[g.season].map(([a, b, l], i) => `<tr><td>${i ? '' : `${g.icon} ${esc(g.label)}`}</td><td>${esc(l)}</td><td>${day(a)}${a === b ? '' : ` – ${day(b)}`}${b.slice(0, 4) !== a.slice(0, 4) ? `, ${b.slice(0, 4)}` : ''}</td></tr>`)).join('')}
      <tr><td>🐗🐺🐈 Hogs, coyotes, bobcats</td><td>No closed season or bag limit</td><td>Year-round</td></tr>
    </tbody></table></div>
    <ul class="plain small" style="margin-top:8px">
      <li>• Deer, turkey and dove: legal from 30 minutes before sunrise to 30 minutes after sunset. Dove ends at sunset.</li>
      <li>• Feral hogs and coyotes can be hunted day or night on private land with the landowner's permission. You need a hunting license, but a landowner or their agent doesn't need one to take hogs damaging the property. Bobcats are furbearers: a license is needed, with no closed season or bag limit.</li>
      <li>• Check the <a href="${H.TPWD_COUNTY_URL}" target="_blank" rel="noopener">TPWD Mason County page</a> for bag limits, antlerless days and any changes. Dates here are from the ${esc(H.SEASON_YEAR)} Outdoor Annual.</li>
    </ul>
  </section>`;
}

export function hunt() {
  const ctx = context();
  const expired = H.GAME.some((g) => g.season && H.seasonStatus(g.season, today()).expired);
  return `${expired ? `<p class="note warn">Some season dates in the app have run out (they cover ${H.SEASON_YEAR}). Check the <a href="${H.TPWD_COUNTY_URL}" target="_blank" rel="noopener">TPWD Mason County page</a>.</p>` : ''}
    ${nowPanel(ctx)}${planPanel(ctx)}${camerasPanel(ctx)}${logPanel()}${seasonsPanel()}`;
}

export function bindHunt(el, rerender, params) {
  refreshForecast().catch((err) => { if (navigator.onLine) console.warn(err); });
  if (params?.get('at') === 'plan' && !ui.jumped) { ui.jumped = true; requestAnimationFrame(() => el.querySelector('#plan')?.scrollIntoView()); }
  el.querySelectorAll('details[data-hunt]').forEach((d) => d.addEventListener('toggle', () => { if (d.open) ui.open.add(d.dataset.hunt); else ui.open.delete(d.dataset.hunt); }));
  el.querySelectorAll('[data-plan]').forEach((b) => b.addEventListener('click', () => { ui.plan = b.dataset.plan; rerender(); }));
  el.querySelectorAll('[data-log-now]').forEach((b) => b.addEventListener('click', () => {
    const key = b.dataset.logNow;
    const ctx = context();
    const { list, base } = nowOutlooks(ctx);
    const o = list.find((x) => x.key === key);
    const h = new Date().getHours();
    openForm('hunts', null, {
      species: key, session: h < 11 ? 'AM' : h < 15 ? 'midday' : h < 21 ? 'PM' : 'night',
      stand: o?.stands.find((r) => r.ok)?.stand.id || '',
      cond: o ? condFor(o, base.data, base.pressTrend) : null,
    });
  }));
}
