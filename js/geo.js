/* =========================================================================
   Map geometry: read boundary files (KML, KMZ, GPX, GeoJSON, zipped
   shapefile) into plain rings of [lon, lat], and measure acres.
   No DOM — runs in Node for tests (test/geo.test.js).
   ========================================================================= */

const R = 6378137; // WGS84 radius, meters
const M2_PER_ACRE = 4046.8564224;
const rad = (d) => (d * Math.PI) / 180;

/** Acres inside a ring of [lon, lat] (spherical excess; ~0.1% at ranch scale). */
export function ringAcres(ring) {
  if (!ring || ring.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    s += rad(x2 - x1) * (2 + Math.sin(rad(y1)) + Math.sin(rad(y2)));
  }
  return Math.abs((s * R * R) / 2) / M2_PER_ACRE;
}

/** Meters between two [lon, lat] points. */
export function distance([x1, y1], [x2, y2]) {
  const dφ = rad(y2 - y1), dλ = rad(x2 - x1);
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(rad(y1)) * Math.cos(rad(y2)) * Math.sin(dλ / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Drop a repeated closing point and consecutive duplicates. */
export function cleanRing(ring) {
  const out = [];
  for (const p of ring) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const q = [Number(p[0]), Number(p[1])];
    const last = out[out.length - 1];
    if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push(q);
  }
  if (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  return out;
}

/** GeoJSON with one Polygon feature per ring (closed, as GeoJSON requires). */
export function toGeoJSON(rings, props = {}) {
  return {
    type: 'FeatureCollection',
    features: rings.filter((r) => r.length >= 3).map((r) => ({
      type: 'Feature', properties: { ...props },
      geometry: { type: 'Polygon', coordinates: [[...r, r[0]]] },
    })),
  };
}

/** Outer rings of every Polygon/MultiPolygon/LineString in a GeoJSON object. */
export function ringsOf(gj) {
  if (!gj) return [];
  if (gj.type === 'FeatureCollection') return gj.features.flatMap(ringsOf);
  if (gj.type === 'Feature') return ringsOf(gj.geometry);
  if (gj.type === 'Polygon') return [gj.coordinates[0]];
  if (gj.type === 'MultiPolygon') return gj.coordinates.map((p) => p[0]);
  if (gj.type === 'LineString') return [gj.coordinates];
  if (gj.type === 'MultiLineString') return gj.coordinates;
  if (gj.type === 'GeometryCollection') return gj.geometries.flatMap(ringsOf);
  return [];
}

/* ------------------------------- formats --------------------------------- */
const coordsText = (t) => t.trim().split(/\s+/).map((c) => c.split(',').map(Number)).filter((c) => c.length >= 2 && c.every(Number.isFinite)).map(([x, y]) => [x, y]);

/** KML (Google Earth, Google My Maps, onX exports): polygons, else lines. */
export function parseKML(text) {
  const polys = [...text.matchAll(/<Polygon[\s>][\s\S]*?<\/Polygon>/gi)].map((m) => {
    const outer = m[0].match(/<outerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/i)
      || m[0].match(/<coordinates>([\s\S]*?)<\/coordinates>/i);
    return outer ? coordsText(outer[1]) : [];
  });
  if (polys.some((r) => r.length >= 3)) return polys;
  return [...text.matchAll(/<LineString[\s>][\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/gi)].map((m) => coordsText(m[1]));
}

/** GPX (onX, Gaia, Garmin): each track or route becomes a ring; else all waypoints. */
export function parseGPX(text) {
  const pts = (block, tag) => [...block.matchAll(new RegExp(`<${tag}\\b([^>]*)`, 'gi'))].map((m) => {
    const lat = m[1].match(/lat\s*=\s*["']([-\d.]+)/i), lon = m[1].match(/lon\s*=\s*["']([-\d.]+)/i);
    return lat && lon ? [Number(lon[1]), Number(lat[1])] : null;
  }).filter(Boolean);
  const tracks = [...text.matchAll(/<trk[\s>][\s\S]*?<\/trk>/gi)].map((m) => pts(m[0], 'trkpt'));
  const routes = [...text.matchAll(/<rte[\s>][\s\S]*?<\/rte>/gi)].map((m) => pts(m[0], 'rtept'));
  const rings = [...tracks, ...routes].filter((r) => r.length >= 3);
  if (rings.length) return rings;
  const wpts = pts(text, 'wpt');
  return wpts.length >= 3 ? [wpts] : [];
}

/* --------------------------------- zip ----------------------------------- */
/** Entries of a .zip/.kmz: [{ name, method, data (compressed bytes) }]. */
export function zipEntries(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const v = new DataView(u.buffer, u.byteOffset, u.byteLength);
  let eocd = -1;
  for (let i = u.length - 22; i >= Math.max(0, u.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out = [];
  for (let n = 0; n < count && v.getUint32(p, true) === 0x02014b50; n++) {
    const method = v.getUint16(p + 10, true), size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u.subarray(p + 46, p + 46 + nameLen));
    const dataStart = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    out.push({ name, method, data: u.subarray(dataStart, dataStart + size) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
export async function unzipEntry(entry) {
  if (entry.method === 0) return entry.data;
  if (entry.method !== 8) throw new Error(`unsupported zip compression (${entry.method})`);
  const stream = new Blob([entry.data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ------------------------------ shapefile -------------------------------- */
/** Polygon/polyline rings from a .shp (types 3, 5, 13, 15, 23, 25). */
export function parseSHP(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const v = new DataView(u.buffer, u.byteOffset, u.byteLength);
  if (v.getInt32(0, false) !== 9994) throw new Error('not a shapefile');
  const rings = [];
  let p = 100;
  while (p + 8 <= u.length) {
    const len = v.getInt32(p + 4, false) * 2;
    const r = p + 8;
    const type = v.getInt32(r, true);
    if ([3, 5, 13, 15, 23, 25].includes(type)) {
      const nParts = v.getInt32(r + 36, true), nPts = v.getInt32(r + 40, true);
      const parts = Array.from({ length: nParts }, (_, i) => v.getInt32(r + 44 + i * 4, true));
      const base = r + 44 + nParts * 4;
      for (let i = 0; i < nParts; i++) {
        const end = i + 1 < nParts ? parts[i + 1] : nPts;
        const ring = [];
        for (let k = parts[i]; k < end; k++) ring.push([v.getFloat64(base + k * 16, true), v.getFloat64(base + k * 16 + 8, true)]);
        rings.push(ring);
      }
    }
    p = r + len;
  }
  return rings;
}

/* ------------------------------ entry point ------------------------------ */
const looksLonLat = (rings) => rings.flat().every(([x, y]) => Math.abs(x) <= 180 && Math.abs(y) <= 90);

/**
 * Read any supported boundary file into rings of [lon, lat].
 * Throws with a plain-English message when it can't.
 */
export async function parseMapFile(name, bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const lower = String(name || '').toLowerCase();
  let rings;
  if (u[0] === 0x50 && u[1] === 0x4b) { // "PK": a zip — KMZ or zipped shapefile
    const entries = zipEntries(u);
    const kml = entries.find((e) => /\.kml$/i.test(e.name));
    const shp = entries.find((e) => /\.shp$/i.test(e.name));
    if (kml) rings = parseKML(new TextDecoder().decode(await unzipEntry(kml)));
    else if (shp) {
      rings = parseSHP(await unzipEntry(shp));
      if (rings.length && !looksLonLat(rings)) throw new Error('this shapefile uses projected coordinates (e.g. State Plane). Re-export it as KML or GeoJSON in WGS84 (mapshaper.org can convert it).');
    } else throw new Error('the zip has no .kml or .shp inside');
  } else if (lower.endsWith('.shp') || (u.length > 4 && new DataView(u.buffer, u.byteOffset).getInt32(0, false) === 9994)) {
    rings = parseSHP(u);
    if (rings.length && !looksLonLat(rings)) throw new Error('this shapefile uses projected coordinates. Re-export it as KML or GeoJSON in WGS84.');
  } else {
    const text = new TextDecoder().decode(u).replace(/^﻿/, '');
    const head = text.trimStart().slice(0, 400).toLowerCase();
    if (head.startsWith('{')) rings = ringsOf(JSON.parse(text));
    else if (head.includes('<kml') || lower.endsWith('.kml')) rings = parseKML(text);
    else if (head.includes('<gpx') || lower.endsWith('.gpx')) rings = parseGPX(text);
    else throw new Error('unrecognized file. Use KML, KMZ, GPX, GeoJSON or a zipped shapefile.');
  }
  rings = rings.map(cleanRing).filter((r) => r.length >= 3);
  if (!rings.length) throw new Error('no boundary shape found in that file');
  if (!looksLonLat(rings)) throw new Error('coordinates are not latitude/longitude');
  return rings;
}
