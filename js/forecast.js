/* Hourly forecast for the ranch from Open-Meteo (free, no key), fetched by
   the phone and kept in settings so the planner still works without signal. */
import * as db from './db.js';
import { forecastUrl } from './huntplan.js';
import { ranchPlace } from './place.js';

const STALE_MS = 2 * 3600e3;
let inflight = null;

export const cachedForecast = () => db.settings().huntForecast || null;

/** Fetch a fresh forecast when online and the cached one is over 2 hours old (or for another place). */
export function refreshForecast({ force = false } = {}) {
  const pl = ranchPlace();
  const fc = cachedForecast();
  const fresh = fc && Date.now() - Date.parse(fc.fetched) < STALE_MS && Math.abs(fc.lat - pl.lat) < 0.01 && Math.abs(fc.lon - pl.lon) < 0.01;
  if ((fresh && !force) || !navigator.onLine) return Promise.resolve(fc);
  inflight ||= fetch(forecastUrl(pl.lat.toFixed(4), pl.lon.toFixed(4)))
    .then((r) => { if (!r.ok) throw new Error(`Forecast HTTP ${r.status}`); return r.json(); })
    .then(async (json) => { const v = { fetched: new Date().toISOString(), lat: pl.lat, lon: pl.lon, hourly: json.hourly }; await db.saveSettings({ huntForecast: v }); return v; })
    .finally(() => { inflight = null; });
  return inflight;
}
