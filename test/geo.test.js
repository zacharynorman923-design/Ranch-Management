import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import * as G from '../js/geo.js';

// A ~250-acre square near Mason: 1006 m on a side ≈ 250.1 ac.
const lat0 = 30.75, lon0 = -99.23;
const dLat = 1006 / 111320, dLon = 1006 / (111320 * Math.cos((lat0 * Math.PI) / 180));
const SQUARE = [[lon0, lat0], [lon0 + dLon, lat0], [lon0 + dLon, lat0 + dLat], [lon0, lat0 + dLat]];
const near = (a, b, eps) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('acres of a ranch-sized square', () => {
  near(G.ringAcres(SQUARE), 250, 1.5);
  near(G.distance(SQUARE[0], SQUARE[1]), 1006, 3);
  assert.equal(G.ringAcres(SQUARE.slice(0, 2)), 0);
});

const kml = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>Ranch</name>
  <Polygon><outerBoundaryIs><LinearRing><coordinates>
    ${SQUARE.map(([x, y]) => `${x},${y},0`).join(' ')} ${SQUARE[0][0]},${SQUARE[0][1]},0
  </coordinates></LinearRing></outerBoundaryIs><innerBoundaryIs><LinearRing><coordinates>1,1 2,2 3,1</coordinates></LinearRing></innerBoundaryIs></Polygon>
</Placemark></Document></kml>`;

test('KML polygon (outer ring only, closing point dropped)', async () => {
  const rings = await G.parseMapFile('ranch.kml', new TextEncoder().encode(kml));
  assert.equal(rings.length, 1);
  assert.equal(rings[0].length, 4);
  near(G.ringAcres(rings[0]), 250, 1.5);
});

test('KML with only a line (a drawn fence path) still works', async () => {
  const line = `<kml><Placemark><LineString><coordinates>${SQUARE.map(([x, y]) => `${x},${y}`).join('\n')}</coordinates></LineString></Placemark></kml>`;
  const rings = await G.parseMapFile('fence.kml', new TextEncoder().encode(line));
  assert.equal(rings[0].length, 4);
});

/** Build a real zip (deflate) in memory. */
function zip(files) {
  const enc = new TextEncoder();
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = typeof content === 'string' ? enc.encode(content) : content;
    const data = new Uint8Array(deflateRawSync(raw));
    const n = enc.encode(name);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(8, 8, true); lh.setUint32(18, data.length, true); lh.setUint32(22, raw.length, true); lh.setUint16(26, n.length, true);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(10, 8, true); ch.setUint32(20, data.length, true); ch.setUint32(24, raw.length, true); ch.setUint16(28, n.length, true); ch.setUint32(42, offset, true);
    locals.push(new Uint8Array(lh.buffer), n, data);
    centrals.push(new Uint8Array(ch.buffer), n);
    offset += 30 + n.length + data.length;
  }
  const cdSize = centrals.reduce((s, x) => s + x.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, Object.keys(files).length, true); e.setUint16(10, Object.keys(files).length, true); e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, new Uint8Array(e.buffer)];
  const out = new Uint8Array(parts.reduce((s, x) => s + x.length, 0));
  let o = 0; for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
}

test('KMZ (zipped KML, as Google Earth and My Maps export)', async () => {
  const rings = await G.parseMapFile('ranch.kmz', zip({ 'doc.kml': kml, 'files/icon.png': 'x' }));
  near(G.ringAcres(rings[0]), 250, 1.5);
});

test('GPX track from driving the fence', async () => {
  const gpx = `<gpx><trk><trkseg>${SQUARE.map(([x, y]) => `<trkpt lat="${y}" lon="${x}"><ele>500</ele></trkpt>`).join('')}</trkseg></trk></gpx>`;
  const rings = await G.parseMapFile('track.gpx', new TextEncoder().encode(gpx));
  near(G.ringAcres(rings[0]), 250, 1.5);
});

test('GeoJSON, with a BOM, round-trips through toGeoJSON', async () => {
  const gj = G.toGeoJSON([SQUARE], { name: 'Ranch' });
  assert.deepEqual(gj.features[0].geometry.coordinates[0].at(-1), SQUARE[0]);
  const rings = await G.parseMapFile('b.geojson', new TextEncoder().encode('﻿' + JSON.stringify(gj)));
  assert.deepEqual(rings[0], SQUARE);
});

function shp(rings) {
  const nPts = rings.reduce((s, r) => s + r.length, 0);
  const recLen = 44 + rings.length * 4 + nPts * 16;
  const b = new DataView(new ArrayBuffer(100 + 8 + recLen));
  b.setInt32(0, 9994, false); b.setInt32(24, (100 + 8 + recLen) / 2, false); b.setInt32(28, 1000, true); b.setInt32(32, 5, true);
  b.setInt32(100, 1, false); b.setInt32(104, recLen / 2, false);
  const r = 108;
  b.setInt32(r, 5, true); b.setInt32(r + 36, rings.length, true); b.setInt32(r + 40, nPts, true);
  let k = 0;
  rings.forEach((ring, i) => { b.setInt32(r + 44 + i * 4, k, true); k += ring.length; });
  let p = r + 44 + rings.length * 4;
  for (const ring of rings) for (const [x, y] of ring) { b.setFloat64(p, x, true); b.setFloat64(p + 8, y, true); p += 16; }
  return new Uint8Array(b.buffer);
}

test('zipped shapefile in lat/lon; projected ones get a clear message', async () => {
  const rings = await G.parseMapFile('parcel.zip', zip({ 'parcel.shp': shp([[...SQUARE, SQUARE[0]]]), 'parcel.dbf': 'x', 'parcel.prj': 'GEOGCS["WGS 84"]' }));
  near(G.ringAcres(rings[0]), 250, 1.5);
  await assert.rejects(G.parseMapFile('sp.zip', zip({ 'p.shp': shp([[[2000000, 10000000], [2001000, 10000000], [2001000, 10001000]]]) })), /projected coordinates/);
});

test('bad files fail with a readable reason', async () => {
  await assert.rejects(G.parseMapFile('x.txt', new TextEncoder().encode('hello')), /unrecognized file/);
  await assert.rejects(G.parseMapFile('x.kml', new TextEncoder().encode('<kml></kml>')), /no boundary shape/);
});
