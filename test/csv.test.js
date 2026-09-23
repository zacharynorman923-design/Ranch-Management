import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, normDate } from '../js/ui.js';
import { ringsOf } from '../js/pages/land.js';

test('CSV parser handles quotes, commas and CRLF', () => {
  const rows = parseCSV('date,notes\r\n2026-09-01,"rain, then hail"\r\n2026-09-02,"said ""hi"""\n\n');
  assert.deepEqual(rows, [['date', 'notes'], ['2026-09-01', 'rain, then hail'], ['2026-09-02', 'said "hi"']]);
});

test('dates from spreadsheets and sale barns normalize to ISO', () => {
  assert.equal(normDate('9/1/2026'), '2026-09-01');
  assert.equal(normDate('12/15/25'), '2025-12-15');
  assert.equal(normDate('2026-09-01T10:00'), '2026-09-01');
});

test('boundary rings from GeoJSON shapes', () => {
  const poly = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
  assert.equal(ringsOf({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: poly }] }).length, 1);
  assert.equal(ringsOf({ type: 'MultiPolygon', coordinates: [poly.coordinates, poly.coordinates] }).length, 2);
});
