/* Where the ranch is, for sunrise/sunset, legal shooting hours and the
   outlooks. Best source first: the property boundary drawn on the map, the
   weather station's own coordinates, then RANCH_LAT / RANCH_LON on the relay.
   Coordinates are checked against the phone's time zone, so a longitude
   typed without its minus sign doesn't flip day and night. */
import * as db from './db.js';
import { fixCoords } from './calc.js';
import { boundaryRings } from './mapcore.js';

export const MASON_TOWN = { lat: 30.7488, lon: -99.2303 };

export function ranchPlace() {
  const pts = boundaryRings().flat();
  if (pts.length >= 3) {
    const f = fixCoords(pts.reduce((a, p) => a + p[1], 0) / pts.length, pts.reduce((a, p) => a + p[0], 0) / pts.length);
    if (f) return { ...f, source: 'property boundary on the map' };
  }
  const s = db.settings();
  const st = s.weatherNow?.coords;
  const fs = st && fixCoords(st.lat, st.lon);
  if (fs) return { ...fs, source: 'weather station' };
  const loc = s.relayInfo?.location;
  const fr = loc && fixCoords(loc.entered?.lat ?? loc.lat, loc.entered?.lon ?? loc.lon);
  if (fr) return { ...fr, source: 'relay (RANCH_LAT / RANCH_LON)', entered: loc.entered || { lat: loc.lat, lon: loc.lon } };
  return { ...MASON_TOWN, fixed: [], source: 'Mason town (default)' };
}

/** A warning when the relay's RANCH_LAT / RANCH_LON needed fixing, or ''. */
export function coordsWarning() {
  const loc = db.settings().relayInfo?.location;
  if (!loc) return '';
  const f = fixCoords(loc.entered?.lat ?? loc.lat, loc.entered?.lon ?? loc.lon);
  const why = [...new Set([...(loc.fixed || []), ...(f?.fixed || [])])];
  if (!f || !why.length) return '';
  const e = loc.entered || loc;
  return `The relay's ranch location was entered as ${e.lat}, ${e.lon}${why.includes('sign') ? ' (the longitude is missing its minus sign; west is negative)' : ''}${why.includes('swapped') ? ' (latitude and longitude are swapped)' : ''}. The app corrects it to ${f.lat}, ${f.lon}. Fix the GitHub variables so it's right everywhere.`;
}
