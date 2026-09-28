/* Weather station: everything the Ambient station reports, via the relay —
   current conditions, every sensor, cattle heat stress, and daily history. */
import * as db from '../db.js';
import * as C from '../calc.js';
import { esc, n0, n1, n2, stat, pill } from '../ui.js';

const THI_TONE = { normal: 'good', alert: 'warn', danger: 'bad', emergency: 'bad' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} hr ago` : `${Math.round(m / 1440)} days ago`;
};
const hist = { all: false };
const deg = (x) => (x == null ? '—' : `${n0(x)}°`);

/** Dashboard tile, or '' when no station is connected. */
export function weatherTile() {
  const w = db.settings().weatherNow;
  const d = w?.data;
  if (!d || d.tempf == null) return '';
  const wind = d.windspeedmph != null ? `${C.compass(d.winddir)} ${n0(d.windspeedmph)} mph` : '';
  const rain = Number(d.dailyrainin) > 0 ? `${n2(d.dailyrainin)}″ today` : '';
  return `<a href="#/weather">${stat('At the ranch now', `${n0(d.tempf)}°F`, [wind, rain, d.dateutc ? ago(d.dateutc) : ''].filter(Boolean).join(' · '))}</a>`;
}

export function weather() {
  const s = db.settings();
  const w = s.weatherNow;
  const d = w?.data || {};
  const days = db.all('wxdays').sort((a, b) => (a.date < b.date ? 1 : -1));
  if (!w) {
    return `<section class="panel">
      <div class="panel-head"><h2>Weather station</h2></div>
      <p>${s.relayInfo?.sources?.ambient
        ? 'The relay has your Ambient keys. Tap <b>Sync now</b> under Settings, or wait for the next sync, and your station\'s readings will show here.'
        : 'Connect an Ambient Weather station and everything it measures shows up here: temperature, humidity, wind, rain, pressure, sun and UV, and any soil or extra sensors. It also keeps a daily history.'}</p>
      <ol class="steps">
        <li>Get the station online and showing on <a href="https://ambientweather.net" target="_blank" rel="noopener">ambientweather.net</a>.</li>
        <li>At <a href="https://ambientweather.net/account" target="_blank" rel="noopener">ambientweather.net/account</a>, scroll to <b>API Keys</b>. Create an API key, then use the small “Developers… click here” link to create an Application Key.</li>
        <li>Add them as GitHub secrets <code>AMBIENT_API_KEY</code> and <code>AMBIENT_APPLICATION_KEY</code> (<a href="https://github.com/zacharynorman923-design/Ranch-Management/settings/secrets/actions/new" target="_blank" rel="noopener">add a secret</a>), then re-run <a href="https://github.com/zacharynorman923-design/Ranch-Management/actions/workflows/deploy-relay.yml" target="_blank" rel="noopener">Deploy relay</a>.</li>
        <li>In <a href="#/settings">Settings</a>, tap <b>Check relay</b>, then <b>Sync now</b>.</li>
      </ol>
    </section>`;
  }
  const obs = Number(d.dateutc) || Date.parse(w.fetched);
  const stale = Date.now() - obs > 60 * 60 * 1000;
  const heat = C.cattleTHI(d.tempf, d.humidity);
  const low = C.wxLowBatteries(d);
  const leaks = Object.entries(d).filter(([k, v]) => C.wxField(k).unit === 'leak' && Number(v) === 1).map(([k]) => C.wxField(k).label);
  const groups = C.wxGroups(d);
  const shown = hist.all ? days : days.slice(0, 30);
  const soilKeys = [...new Set(days.slice(0, 30).flatMap((x) => Object.keys(x.f || {}).filter((k) => /^soilhum\d+$/.test(k))))].sort();
  const months = C.wxMonths(days);
  const cell = (x, i, f = n0) => (x?.f && x.f[i[0]] ? f(x.f[i[0]][i[1]]) : '—');
  return `
    <section class="panel">
      <div class="panel-head"><h2>${esc(w.name || 'Weather station')}</h2>${pill(`updated ${ago(obs)}`, stale ? 'warn' : 'good')}</div>
      ${stale ? '<p class="note warn">No new reading for over an hour. The station may have lost WiFi or power. The relay checks every 15 minutes.</p>' : ''}
      <div class="stats">
        ${d.tempf != null ? stat('Temperature', `${n1(d.tempf)}°F`, d.feelsLike != null ? `feels like ${n0(d.feelsLike)}°` : '', 'accent') : ''}
        ${d.humidity != null ? stat('Humidity', `${n0(d.humidity)}%`, d.dewPoint != null ? `dew point ${n0(d.dewPoint)}°` : '') : ''}
        ${d.windspeedmph != null ? stat('Wind', `${C.compass(d.winddir)} ${n0(d.windspeedmph)} mph`, `gust ${n0(d.windgustmph)}${d.maxdailygust != null ? `, top today ${n0(d.maxdailygust)}` : ''} mph`) : ''}
        ${d.dailyrainin != null ? stat('Rain today', `${n2(d.dailyrainin)}″`, [Number(d.hourlyrainin) > 0 ? `${n2(d.hourlyrainin)}″/hr now` : '', d.eventrainin != null ? `storm ${n2(d.eventrainin)}″` : '', d.monthlyrainin != null ? `month ${n2(d.monthlyrainin)}″` : ''].filter(Boolean).join(' · ')) : ''}
        ${d.baromrelin != null ? stat('Pressure', `${n2(d.baromrelin)} inHg`) : ''}
        ${d.solarradiation != null || d.uv != null ? stat('Sun', d.uv != null ? `UV ${n0(d.uv)}` : '—', d.solarradiation != null ? `${n0(d.solarradiation)} W/m²` : '') : ''}
        ${heat ? stat('Cattle heat stress', heat.level, `THI ${n1(heat.thi)}`, THI_TONE[heat.level]) : ''}
      </div>
      ${heat && heat.level !== 'normal' ? `<p class="note ${THI_TONE[heat.level]}">🐄 ${esc(heat.advice)}</p>` : ''}
      ${low.length ? `<p class="note warn">🔋 Low battery: ${esc(low.join(', '))}.</p>` : ''}
      ${leaks.length ? `<p class="note bad">💧 ${esc(leaks.join(', '))} reports water.</p>` : ''}
      <details class="lines"><summary>Every sensor (${groups.reduce((a, g) => a + g.rows.length, 0)} readings)</summary>
        ${groups.map((g) => `<h3>${esc(g.group)}</h3><div class="table-wrap"><table class="tbl"><tbody>
          ${g.rows.map((r) => `<tr><td>${esc(r.label)}</td><td class="num">${esc(r.text)}</td></tr>`).join('')}
        </tbody></table></div>`).join('')}
      </details>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Daily history</h2>${pill(`${days.length} days`)}</div>
      ${days.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Day</th><th>High</th><th>Low</th><th>Rain</th><th>Humidity</th><th>Top gust</th><th>UV</th>${soilKeys.map((k) => `<th>${esc(C.wxField(k).label)}</th>`).join('')}</tr></thead><tbody>
        ${shown.map((x) => `<tr><td>${esc(x.date.slice(5).replace('-', '/'))}</td><td class="num">${cell(x, ['tempf', 1], deg)}</td><td class="num">${cell(x, ['tempf', 0], deg)}</td>
          <td class="num">${x.f?.dailyrainin ? (x.f.dailyrainin[1] > 0 ? `${n2(x.f.dailyrainin[1])}″` : '0') : '—'}</td><td class="num">${cell(x, ['humidity', 2])}%</td>
          <td class="num">${x.f?.maxdailygust ? n0(x.f.maxdailygust[1]) : cell(x, ['windgustmph', 1])}</td><td class="num">${cell(x, ['uv', 1])}</td>
          ${soilKeys.map((k) => `<td class="num">${cell(x, [k, 2])}%</td>`).join('')}</tr>`).join('')}
      </tbody></table></div>
      ${days.length > 30 ? `<button class="btn" data-wx-all>${hist.all ? 'Show last 30 days' : `Show all ${days.length} days`}</button>` : ''}
      <h3>By month</h3>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Month</th><th>Rain</th><th>Hottest</th><th>Avg high</th><th>Coldest</th><th>100° days</th><th>Freezes</th></tr></thead><tbody>
        ${months.map((m) => `<tr><td>${MONTHS[Number(m.month.slice(5)) - 1]} ${m.month.slice(0, 4)}${m.days < 28 ? ` <small class="muted">(${m.days} d)</small>` : ''}</td><td class="num">${m.rainDays ? `${n2(m.rain)}″` : '—'}</td><td class="num">${deg(m.hi)}</td><td class="num">${deg(m.avgHi)}</td><td class="num">${deg(m.lo)}</td><td class="num">${m.over100}</td><td class="num">${m.freezes}</td></tr>`).join('')}
      </tbody></table></div>`
      : '<p class="empty">History fills in on the hourly relay runs. It also works back through up to a year of your station\'s past records, a few days each hour.</p>'}
      <p class="note">Daily rain from the station also feeds the <a href="#/rain">rain log</a> and the stocking calculator as “Rain gauge (auto)”.</p>
    </section>`;
}
export function bindWeather(el, rerender) {
  el.querySelector('[data-wx-all]')?.addEventListener('click', () => { hist.all = !hist.all; rerender(); });
}
