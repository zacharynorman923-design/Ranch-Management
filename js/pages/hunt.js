/* Hunting outlook: conditions from the weather station scored for dove,
   whitetail, turkey, hogs, coyotes and bobcats, with Mason County seasons
   and today's legal shooting hours. Logic lives in ../hunting.js. */
import * as db from '../db.js';
import * as H from '../hunting.js';
import { esc, stat, pill } from '../ui.js';
import { stationContext } from './weather.js';

const TONE = { excellent: 'good', good: 'good', fair: 'warn', poor: 'bad', closed: '', unsafe: 'bad' };
const clock = (ms) => (ms == null ? '—' : new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
const day = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
const open = new Set();

function outlooks() {
  const x = stationContext();
  const ctx = x ? { data: x.data, pressTrend: x.pressTrend, dailyAvgTemps: x.dailyAvgTemps, lat: x.lat, lon: x.lon } : { data: {} };
  const rank = (o) => (o.level === 'unsafe' ? 2 : o.season.open ? 1 : 0);
  return { station: !!x, list: H.GAME.map((g) => H.huntingOutlook(g.key, ctx)).sort((a, b) => rank(b) - rank(a) || b.score - a.score) };
}
const seasonLine = (o) => (o.season.always ? 'No closed season on private land'
  : o.season.open ? `Open · ${o.season.label}, through ${day(o.season.until)}`
    : o.season.next ? `Closed · opens ${day(o.season.next.start)}: ${o.season.next.label}` : 'Closed · check TPWD for next season');
const hoursLine = (o) => (o.hours.any ? 'Any hour on private land' : `Legal today ${clock(o.hours.start)}–${clock(o.hours.end)}${o.legalNow ? '' : ' · outside legal hours now'}`);

/** Dashboard tile: the best in-season game right now. */
export function huntingTile() {
  const { station, list } = outlooks();
  if (!station) return '';
  const game = list.filter((o) => o.season.open && !o.season.always);
  const best = game[0] || list.find((o) => o.season.always);
  if (!best) return '';
  const soon = list.filter((o) => !o.season.open && o.season.next).sort((a, b) => (a.season.next.start < b.season.next.start ? -1 : 1))[0];
  return `<a href="#/hunt">${stat(`Hunting: ${best.game.label}`, best.level, soon ? `${soon.game.label} opens ${day(soon.season.next.start)}` : `${best.score}/100`, TONE[best.level])}</a>`;
}

export function hunt() {
  const { station, list } = outlooks();
  const x = stationContext();
  const expired = list.some((o) => o.season.expired);
  return `
    <section class="panel">
      <div class="panel-head"><h2>Hunting outlook</h2>${station ? pill(`${Math.round(x.data.tempf ?? 0)}°F · wind ${Math.round(x.data.windspeedmph ?? 0)} mph`) : ''}</div>
      ${station ? '<p class="note">Scored from the ranch weather station right now: time of day, wind, temperature, cold fronts, pressure trend, rain and moon. Tap a card for the reasons.</p>'
        : '<p class="note warn">Connect the Ambient weather station (see <a href="#/weather">Weather station</a>) to score conditions. Seasons and legal hours are below.</p>'}
      ${expired ? `<p class="note warn">Some season dates in the app have run out (they cover ${H.SEASON_YEAR}). Check the <a href="${H.TPWD_COUNTY_URL}" target="_blank" rel="noopener">TPWD Mason County page</a> for the new dates.</p>` : ''}
      <div class="hunt-cards">${list.map((o) => `
        <details class="card hunt-card ${o.level}" data-hunt="${o.key}" ${open.has(o.key) ? 'open' : ''}>
          <summary>
            <div class="hunt-top"><span class="hunt-icon">${o.game.icon}</span><b>${esc(o.game.label)}</b>
              ${pill(o.level === 'unsafe' ? 'UNSAFE' : o.level === 'closed' ? `closed · ${o.cond}` : o.level, TONE[o.level])}
              ${station && o.level !== 'unsafe' ? `<span class="hunt-score">${o.score}</span>` : ''}</div>
            ${station ? `<div class="small">${esc(o.headline)}</div>` : ''}
            <div class="small muted">${esc(seasonLine(o))}<br>${esc(hoursLine(o))}</div>
          </summary>
          ${station ? `<ul class="plain fish-factors">${o.factors.map((f) => `<li><span class="fish-pts ${f.pts > 0 ? 'good-t' : f.pts < 0 ? 'bad-t' : 'muted'}">${f.pts > 0 ? '+' : ''}${f.pts}</span><div><b>${esc(f.label)}.</b> ${esc(f.note)}</div></li>`).join('')}</ul>` : ''}
        </details>`).join('')}
      </div>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Mason County seasons ${esc(H.SEASON_YEAR)}</h2></div>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Game</th><th>Season</th><th>Dates</th></tr></thead><tbody>
        ${H.GAME.filter((g) => g.season).flatMap((g) => H.SEASONS[g.season].map(([a, b, l], i) => `<tr><td>${i ? '' : `${g.icon} ${esc(g.label)}`}</td><td>${esc(l)}</td><td>${day(a)}${a === b ? '' : ` – ${day(b)}`}${b.slice(0, 4) !== a.slice(0, 4) ? `, ${b.slice(0, 4)}` : ''}</td></tr>`)).join('')}
        <tr><td>🐗🐺🐈 Hogs, coyotes, bobcats</td><td>No closed season or bag limit</td><td>Year-round</td></tr>
      </tbody></table></div>
      <ul class="plain small" style="margin-top:8px">
        <li>• Deer, turkey and dove: legal from 30 minutes before sunrise to 30 minutes after sunset. Dove ends at sunset.</li>
        <li>• Feral hogs and coyotes can be hunted day or night on private land with the landowner's permission. You need a hunting license, but a landowner or their agent doesn't need one to take hogs damaging the property. Bobcats are furbearers: a license is needed, with no closed season or bag limit.</li>
        <li>• Check the <a href="${H.TPWD_COUNTY_URL}" target="_blank" rel="noopener">TPWD Mason County page</a> for bag limits, antlerless days and any changes before you go. Dates here are from the ${esc(H.SEASON_YEAR)} Outdoor Annual.</li>
      </ul>
    </section>`;
}
export function bindHunt(el) {
  el.querySelectorAll('details[data-hunt]').forEach((d) => d.addEventListener('toggle', () => { if (d.open) open.add(d.dataset.hunt); else open.delete(d.dataset.hunt); }));
}
