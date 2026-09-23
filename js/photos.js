/* =========================================================================
   Photos: downscale on the phone (a 12 MP shot becomes ~200 KB), keep the
   GPS fix and capture time from the JPEG's EXIF, and fall back to the phone's
   own location when the picture was just taken.
   ========================================================================= */
import * as db from './db.js';
import { ymd } from './calc.js';

const MAX_EDGE = 1600;
const urlCache = new Map();

export async function photoURL(id) {
  if (urlCache.has(id)) return urlCache.get(id);
  const data = await db.getBlob(id);
  if (data) urlCache.set(id, data);
  return data;
}

/** Store a picked/captured image file as a 'photos' record + blob. */
export async function addPhotoFile(file, meta = {}) {
  const buf = await file.arrayBuffer();
  const exif = readExif(buf);
  let loc = exif.lat != null ? { lat: exif.lat, lon: exif.lon } : null;
  const fresh = Date.now() - (file.lastModified || 0) < 5 * 60 * 1000;
  if (!loc && fresh && navigator.geolocation) {
    loc = await new Promise((res) => navigator.geolocation.getCurrentPosition(
      (p) => res({ lat: +p.coords.latitude.toFixed(6), lon: +p.coords.longitude.toFixed(6) }),
      () => res(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 120000 }));
  }
  const data = await downscale(file);
  const rec = await db.put('photos', {
    date: exif.date || ymd(new Date(file.lastModified || Date.now())),
    caption: meta.caption || file.name.replace(/\.[^.]+$/, ''),
    tags: meta.tags || '', device: meta.device || '', loc, packet: !!meta.packet,
    file: file.name,
  });
  await db.putBlob(rec.id, data);
  urlCache.set(rec.id, data);
  return rec;
}
export async function deletePhoto(id) {
  await db.del('photos', id);
  await db.delBlob(id);
  urlCache.delete(id);
}

async function downscale(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
  const img = bmp || await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('not an image'));
    i.src = URL.createObjectURL(file);
  });
  const w = img.width, h = img.height;
  const k = Math.min(1, MAX_EDGE / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.78);
}

/**
 * Minimal EXIF reader: GPS lat/lon and DateTimeOriginal from a JPEG.
 * Returns {} for anything it doesn't understand — never throws.
 */
export function readExif(buf) {
  try {
    const v = new DataView(buf);
    if (v.getUint16(0) !== 0xffd8) return {};
    let off = 2;
    while (off + 4 < v.byteLength) {
      const marker = v.getUint16(off);
      const size = v.getUint16(off + 2);
      if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) return parseTiff(v, off + 10);
      if ((marker & 0xff00) !== 0xff00) break;
      off += 2 + size;
    }
  } catch (e) { /* fall through */ }
  return {};
}
function parseTiff(v, t) {
  const le = v.getUint16(t) === 0x4949;
  const u16 = (o) => v.getUint16(t + o, le);
  const u32 = (o) => v.getUint32(t + o, le);
  const ifd = (o) => {
    const n = u16(o); const tags = {};
    for (let i = 0; i < n; i++) {
      const e = o + 2 + i * 12;
      tags[u16(e)] = { type: u16(e + 2), count: u32(e + 4), valOff: e + 8 };
    }
    return tags;
  };
  const str = (tag) => {
    const off = tag.count > 4 ? u32(tag.valOff) : tag.valOff;
    let s = '';
    for (let i = 0; i < tag.count - 1; i++) s += String.fromCharCode(v.getUint8(t + off + i));
    return s;
  };
  const rats = (tag) => {
    const off = u32(tag.valOff);
    return Array.from({ length: tag.count }, (_, i) => u32(off + i * 8) / (u32(off + i * 8 + 4) || 1));
  };
  const out = {};
  const ifd0 = ifd(u32(4));
  if (ifd0[0x8769]) {
    const ex = ifd(u32(ifd0[0x8769].valOff));
    if (ex[0x9003]) {
      const m = str(ex[0x9003]).match(/^(\d{4}):(\d{2}):(\d{2})/);
      if (m) out.date = `${m[1]}-${m[2]}-${m[3]}`;
    }
  }
  if (ifd0[0x8825]) {
    const g = ifd(u32(ifd0[0x8825].valOff));
    if (g[2] && g[4]) {
      const dms = (a) => a[0] + a[1] / 60 + a[2] / 3600;
      const ref = (tag) => String.fromCharCode(v.getUint8(t + tag.valOff));
      let lat = dms(rats(g[2])), lon = dms(rats(g[4]));
      if (g[1] && ref(g[1]) === 'S') lat = -lat;
      if (g[3] && ref(g[3]) === 'W') lon = -lon;
      if (isFinite(lat) && isFinite(lon) && (lat || lon)) { out.lat = +lat.toFixed(6); out.lon = +lon.toFixed(6); }
    }
  }
  return out;
}
