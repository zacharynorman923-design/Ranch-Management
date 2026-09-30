/* =========================================================================
   Planning ahead: an hourly forecast (Open-Meteo, free, no key) scored for
   every dawn and dusk sit over the next few days, plus solunar times from
   the moon's position. Pure functions; fetching lives in the page.
   ========================================================================= */
import { ymd, sunTimes, moonAge } from './calc.js';
import { huntingOutlook } from './hunting.js';

const RAD = Math.PI / 180;

/** Open-Meteo hourly forecast for the ranch: 3 past days (for fronts and trends) + 5 ahead. */
export function forecastUrl(lat, lon) {
  const vars = 'temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl';
  return `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=${vars}&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timeformat=unixtime&past_days=3&forecast_days=6`;
}
/** Open-Meteo JSON → [{ t (ms), tempf, humidity, windspeedmph, windgustmph, winddir, precip, precipProb, cloud, pressInHg }]. */
export function forecastHours(json) {
  const h = json?.hourly;
  if (!h?.time) return [];
  return h.time.map((t, i) => ({
    t: t * 1000, tempf: h.temperature_2m?.[i], humidity: h.relative_humidity_2m?.[i],
    windspeedmph: h.wind_speed_10m?.[i], windgustmph: h.wind_gusts_10m?.[i], winddir: h.wind_direction_10m?.[i],
    precip: h.precipitation?.[i], precipProb: h.precipitation_probability?.[i], cloud: h.cloud_cover?.[i],
    pressInHg: h.pressure_msl?.[i] != null ? Math.round(h.pressure_msl[i] * 0.0295300 * 100) / 100 : null,
  })).filter((x) => x.tempf != null);
}
const nearest = (hours, t) => hours.reduce((b, x) => (!b || Math.abs(x.t - t) < Math.abs(b.t - t) ? x : b), null);

/** Everything huntingOutlook needs for the forecast at time t. */
export function conditionsAt(hours, t) {
  const h = nearest(hours, t);
  if (!h || Math.abs(h.t - t) > 2 * 3600e3) return null;
  const h3 = nearest(hours, t - 3 * 3600e3), h24 = nearest(hours, t - 24 * 3600e3);
  const day = (ms) => ymd(new Date(ms));
  const avg = {};
  for (const x of hours) { const d = day(x.t); (avg[d] ||= []).push(x.tempf); }
  const dailyAvgTemps = [0, 1, 2, 3].map((k) => { const a = avg[day(t - k * 86400e3)]; return a ? a.reduce((s, v) => s + v, 0) / a.length : null; });
  return {
    hour: h,
    data: { tempf: h.tempf, humidity: h.humidity, windspeedmph: h.windspeedmph, windgustmph: h.windgustmph, winddir: h.winddir, hourlyrainin: h.precip ?? 0, baromrelin: h.pressInHg },
    pressTrend: h3 && h.pressInHg != null && h3.pressInHg != null && Math.abs(h3.t - (t - 3 * 3600e3)) < 2 * 3600e3 ? Math.round((h.pressInHg - h3.pressInHg) * 100) / 100 : null,
    tempChange24h: h24 && Math.abs(h24.t - (t - 24 * 3600e3)) < 2 * 3600e3 ? h.tempf - h24.tempf : null,
    cloud: h.cloud ?? null, precipProb: h.precipProb ?? null, dailyAvgTemps,
  };
}

/* ------------------------------ moon & solunar ---------------------------- */
// Low-precision lunar position (about a degree), as in common almanac code.
function moonRaDec(d) {
  const L = RAD * (218.316 + 13.176396 * d), M = RAD * (134.963 + 13.064993 * d), F = RAD * (93.272 + 13.229350 * d);
  const l = L + RAD * 6.289 * Math.sin(M), b = RAD * 5.128 * Math.sin(F), e = RAD * 23.4397;
  return {
    ra: Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l)),
    dec: Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l)),
  };
}
/** Moon altitude (degrees) at a place and instant. */
export function moonAltitude(lat, lon, ms) {
  const d = ms / 86400000 - 10957.5;
  const { ra, dec } = moonRaDec(d);
  const H = RAD * (280.16 + 360.9856235 * d) + lon * RAD - ra;
  const phi = lat * RAD;
  return Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)) / RAD;
}
/**
 * Solunar day: moonrise, moonset, moon overhead (transit) and underfoot on the
 * local day containing ms. Major periods are 2 hours centered on overhead and
 * underfoot; minor periods 1 hour centered on rise and set.
 */
export function solunarDay(lat, lon, ms) {
  const start = new Date(ms); start.setHours(0, 0, 0, 0);
  const t0 = start.getTime(), step = 5 * 60000;
  let prev = moonAltitude(lat, lon, t0), rise = null, set = null, hi = { t: t0, a: prev }, lo = { t: t0, a: prev };
  for (let t = t0 + step; t <= t0 + 86400000; t += step) {
    const a = moonAltitude(lat, lon, t);
    if (prev < 0.125 && a >= 0.125 && rise == null) rise = t;
    if (prev >= 0.125 && a < 0.125 && set == null) set = t;
    if (a > hi.a) hi = { t, a };
    if (a < lo.a) lo = { t, a };
    prev = a;
  }
  const clock = (x) => new Date(x).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const periods = [
    { at: hi.t, major: true, label: `moon overhead ${clock(hi.t)}` },
    { at: lo.t, major: true, label: `moon underfoot ${clock(lo.t)}` },
    ...(rise ? [{ at: rise, major: false, label: `moonrise ${clock(rise)}` }] : []),
    ...(set ? [{ at: set, major: false, label: `moonset ${clock(set)}` }] : []),
  ].filter((p) => p.at > t0 && p.at < t0 + 86400000)
    .map((p) => ({ ...p, start: p.at - (p.major ? 60 : 30) * 60000, end: p.at + (p.major ? 60 : 30) * 60000 }))
    .sort((a, b) => a.at - b.at);
  const age = moonAge(ms);
  return { rise, set, transit: hi.t, underfoot: lo.t, periods, age, illumination: Math.round((1 - Math.cos((age / 29.530588853) * 2 * Math.PI)) / 2 * 100) };
}

/* --------------------------------- planner -------------------------------- */
/**
 * Score each dawn and dusk sit for the next `days` days for one species.
 * Morning sits are taken 1 hour after sunrise, evening sits 1 hour before sunset.
 * extras(t) can add camera activity, solunar periods, etc. for that time.
 */
export function planSits(key, hours, { lat, lon, now = Date.now(), days = 5, extras = () => ({}) } = {}) {
  const out = [];
  for (let k = 0; k < days; k++) {
    const dayMs = now + k * 86400000;
    const { rise, set } = sunTimes(lat, lon, dayMs);
    for (const [session, t] of [['AM', rise != null ? rise + 3600e3 : null], ['PM', set != null ? set - 3600e3 : null]]) {
      if (t == null || t < now - 3600e3) continue;
      const c = conditionsAt(hours, t);
      if (!c) continue;
      const o = huntingOutlook(key, { data: c.data, pressTrend: c.pressTrend, dailyAvgTemps: c.dailyAvgTemps, tempChange24h: c.tempChange24h, cloud: c.cloud, lat, lon, now: t, ...extras(t) });
      out.push({ date: ymd(new Date(t)), session, t, cond: c, outlook: o });
    }
  }
  return out;
}
