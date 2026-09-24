/* Pick a spot on the aerial map. It opens full-screen over whatever is open,
   including a record form, and resolves to { lat, lon }, or null if cancelled. */
import { loadLeaflet, baseLayer, boundaryRings, MASON } from './mapcore.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let lastView = null;

export function pickOnMap({ initial = null, title = 'Tap the spot' } = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'sheet map-sheet';
    dlg.innerHTML = `
      <div class="sheet-form">
        <header class="sheet-head"><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-x aria-label="Close">✕</button></header>
        <div class="map-pick" data-map></div>
        <footer class="sheet-foot">
          <button type="button" class="btn" data-me>📍 Me</button>
          <span class="grow small muted" data-coords>Tap the map to drop the pin.</span>
          <button type="button" class="btn" data-x>Cancel</button>
          <button type="button" class="btn primary" data-ok disabled>Use this spot</button>
        </footer>
      </div>`;
    document.body.appendChild(dlg);
    let map = null, pin = null, spot = initial?.lat ? { lat: initial.lat, lon: initial.lon } : null;
    const close = (val) => { map?.remove(); dlg.close(); dlg.remove(); resolve(val); };
    const place = (L) => {
      if (!spot) return;
      const ll = [spot.lat, spot.lon];
      if (pin) pin.setLatLng(ll);
      else pin = L.circleMarker(ll, { radius: 10, color: '#fff', weight: 3, fillColor: '#EF4444', fillOpacity: 1 }).addTo(map);
      dlg.querySelector('[data-coords]').textContent = `${spot.lat.toFixed(5)}, ${spot.lon.toFixed(5)}`;
      dlg.querySelector('[data-ok]').disabled = false;
    };
    dlg.addEventListener('click', (e) => {
      if (e.target.closest('[data-x]')) close(null);
      if (e.target.closest('[data-ok]') && spot) close(spot);
    });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    dlg.showModal();

    loadLeaflet().then((L) => {
      map = L.map(dlg.querySelector('[data-map]'));
      baseLayer(L).addTo(map);
      const b = boundaryRings().flat().map(([x, y]) => [y, x]);
      for (const ring of boundaryRings()) L.polygon(ring.map(([x, y]) => [y, x]), { color: '#F59E0B', weight: 3, fillOpacity: 0.04, interactive: false }).addTo(map);
      if (spot) map.setView([spot.lat, spot.lon], 17);
      else if (lastView) map.setView(lastView.center, lastView.zoom);
      else if (b.length) map.fitBounds(b, { padding: [20, 20] });
      else map.setView(MASON, 13);
      map.on('moveend', () => { lastView = { center: map.getCenter(), zoom: map.getZoom() }; });
      map.on('click', (e) => { spot = { lat: +e.latlng.lat.toFixed(6), lon: +e.latlng.lng.toFixed(6) }; place(L); });
      place(L);
      // The dialog finishes laying out after showModal; let Leaflet measure it.
      setTimeout(() => map.invalidateSize(), 60);
      dlg.querySelector('[data-me]').addEventListener('click', () => {
        navigator.geolocation?.getCurrentPosition(
          (p) => map.setView([p.coords.latitude, p.coords.longitude], Math.max(map.getZoom(), 17)),
          () => {}, { enableHighAccuracy: true, timeout: 15000 });
      });
    }).catch((err) => {
      dlg.querySelector('[data-map]').innerHTML = `<p class="empty" style="padding:16px">${esc(err.message)}. Open the app once with signal.</p>`;
    });
  });
}
