/* Shared map plumbing: base layers, lazy-loading the bundled Leaflet, and
   the saved property boundary. Used by the Map page and the location picker. */
import * as db from './db.js';
import { ringsOf } from './geo.js';

export const BASEMAPS = {
  aerial: { label: 'Aerial', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', opts: { maxNativeZoom: 19, maxZoom: 20, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' } },
  usgs: { label: 'Aerial (USGS)', url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}', opts: { maxNativeZoom: 16, maxZoom: 20, attribution: 'USGS The National Map' } },
  topo: { label: 'Topo', url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', opts: { maxNativeZoom: 16, maxZoom: 20, attribution: 'USGS The National Map' } },
  streets: { label: 'Roads', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', opts: { maxNativeZoom: 19, maxZoom: 20, attribution: '© OpenStreetMap contributors' } },
};
export const MASON = [30.7488, -99.2303];

let leafletP = null;
export function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  leafletP ||= new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = 'vendor/leaflet/leaflet.css';
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = 'vendor/leaflet/leaflet.js';
    js.onload = () => resolve(window.L);
    js.onerror = () => { leafletP = null; reject(new Error('map library failed to load')); };
    document.head.appendChild(js);
  });
  return leafletP;
}

export const boundaryRings = () => ringsOf(db.settings().boundary).filter((r) => r.length >= 3);
export const baseLayer = (L) => { const b = BASEMAPS[db.settings().mapBase] || BASEMAPS.aerial; return L.tileLayer(b.url, b.opts); };
