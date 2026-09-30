/* =========================================================================
   Hunting outlook: how conditions from the weather station line up for dove,
   white-tailed deer, turkey, feral hogs, coyotes and bobcats, plus whether
   the season is open in Mason County and today's legal shooting hours.
   Pure functions (no DOM, no storage) so they can be unit-tested.

   Season dates are TPWD's 2026–27 Outdoor Annual for Mason County (North
   Zone for deer and turkey, Central Zone for dove). Check the county page
   for antlerless days, bag limits and any changes.
   ========================================================================= */
import { ymd, sunElevation, sunTimes, moonAge } from './calc.js';

export const TPWD_COUNTY_URL = 'https://tpwd.texas.gov/regulations/outdoor-annual/regs/counties/mason';
export const SEASON_YEAR = '2026–27';

// [start, end, label]; inclusive dates.
export const SEASONS = {
  dove: [['2026-09-01', '2026-10-25', 'Central Zone, first split'], ['2026-12-11', '2027-01-14', 'Central Zone, second split']],
  deer: [
    ['2026-10-03', '2026-11-06', 'Archery only'],
    ['2026-10-24', '2026-10-25', 'Youth only'],
    ['2026-11-07', '2027-01-03', 'General season (North Zone)'],
    ['2027-01-04', '2027-01-17', 'Special late & youth late season'],
  ],
  turkey: [
    ['2026-11-07', '2027-01-03', 'Fall season (North Zone)'],
    ['2027-03-27', '2027-03-28', 'Spring youth only'],
    ['2027-04-03', '2027-05-16', 'Spring season (North Zone)'],
    ['2027-05-22', '2027-05-23', 'Spring youth only'],
  ],
};

export const GAME = [
  { key: 'dove', label: 'Dove', icon: '🕊', season: 'dove', hours: 'sunset' },
  { key: 'deer', label: 'Whitetail', icon: '🦌', season: 'deer', hours: 'game' },
  { key: 'turkey', label: 'Turkey', icon: '🦃', season: 'turkey', hours: 'game' },
  { key: 'hog', label: 'Feral hogs', icon: '🐗', season: null, hours: 'any' },
  { key: 'coyote', label: 'Coyotes', icon: '🐺', season: null, hours: 'any' },
  { key: 'bobcat', label: 'Bobcats', icon: '🐈', season: null, hours: 'any' },
];

/** Is `key`'s season open on `date` (YYYY-MM-DD)? Returns the open segment(s) and the next opening. */
export function seasonStatus(key, date) {
  const segs = SEASONS[key];
  if (!segs) return { open: true, always: true, label: 'No closed season on private land' };
  const now = segs.filter(([a, b]) => date >= a && date <= b);
  const next = segs.filter(([a]) => a > date).sort((x, y) => (x[0] < y[0] ? -1 : 1))[0] || null;
  const last = segs.reduce((m, s) => (s[1] > m ? s[1] : m), '');
  return {
    open: now.length > 0,
    label: now.map((s) => s[2]).join(' + ') || (next ? `Closed. Next: ${next[2]}` : 'Closed'),
    until: now.length ? now.map((s) => s[1]).sort().pop() : null,
    next: next ? { start: next[0], end: next[1], label: next[2] } : null,
    expired: date > last, // past the last date we know: new season dates needed
  };
}

/** Legal shooting hours for a day: game birds and deer 30 min before sunrise to 30 min after sunset; dove until sunset. */
export function legalHours(kind, lat, lon, ms) {
  if (kind === 'any') return { any: true };
  const { rise, set } = sunTimes(lat, lon, ms);
  if (rise == null || set == null) return { any: true };
  return { start: rise - 30 * 60000, end: kind === 'sunset' ? set : set + 30 * 60000, rise, set };
}

const n1 = (x) => (Math.round(Number(x) * 10) / 10).toString();

/**
 * Score one species 0–100 for right now. Inputs:
 *   data          current station reading (Ambient field names)
 *   pressTrend    3-hour pressure change, inHg (null if unknown)
 *   dailyAvgTemps daily average temps, newest first (today, yesterday, …)
 *   rainToday     inches so far today
 */
export function huntingOutlook(key, { data = {}, pressTrend = null, dailyAvgTemps = [], lat = 30.7488, lon = -99.2303, now = Date.now() } = {}) {
  const game = GAME.find((g) => g.key === key);
  if (!game) throw new Error(`unknown game ${key}`);
  const f = [];
  const add = (label, pts, note) => f.push({ label, pts, note });
  const v = (k) => (data[k] == null || data[k] === '' ? null : Number(data[k]));
  const date = ymd(new Date(now));
  const season = seasonStatus(game.season, date);
  const hours = legalHours(game.hours, lat, lon, now);
  const legalNow = hours.any || (now >= hours.start && now <= hours.end);

  // Lightning within 10 miles in the last 30 minutes.
  const lt = v('lightning_time'), ld = v('lightning_distance');
  if (lt != null && ld != null && ld <= 10 && now - lt < 30 * 60000) {
    return { key, game, score: 0, level: 'unsafe', season, hours, legalNow, headline: `Lightning ${n1(ld)} mi away. Stay out of stands and off high ground.`,
      factors: [{ label: 'Lightning', pts: -100, note: `Strike ${Math.round((now - lt) / 60000)} min ago. Wait 30 minutes after the last one.` }] };
  }

  const temp = v('tempf');
  const wind = v('windspdmph_avg10m') ?? v('windspeedmph');
  const gust = v('windgustmph');
  const rate = v('hourlyrainin') ?? 0;
  const rainDay = v('dailyrainin') ?? 0;
  const el = sunElevation(lat, lon, now);
  const { rise, set } = sunTimes(lat, lon, now);
  const morning = rise != null && now >= rise - 45 * 60000 && now <= rise + 2.5 * 3600e3;
  const evening = set != null && now >= set - 3 * 3600e3 && now <= set + 45 * 60000;
  const night = el < -6;
  const midday = !morning && !evening && !night;
  const age = moonAge(now);
  const fullMoon = Math.abs(age - 14.77) <= 2;
  const temps = dailyAvgTemps.map(Number);
  const cooling = Number.isFinite(temps[1]) && Number.isFinite(temps[3]) ? temps[3] - temps[1] : null; // yesterday vs 3 days ago
  const front = cooling != null && cooling >= 8;
  const cloudy = el > 15 && v('solarradiation') != null && v('solarradiation') < 0.45 * 1000 * Math.sin(el * Math.PI / 180);
  const month = Number(date.slice(5, 7)), md = date.slice(5);
  const windNote = (w) => `${Math.round(w)} mph${gust != null && gust > w + 8 ? `, gusting ${Math.round(gust)}` : ''}`;

  if (key === 'dove') {
    if (morning) add('Time of day', 15, 'First couple of hours after sunrise, when birds leave the roost for the fields.');
    else if (evening) add('Time of day', 15, 'Last hours before sunset: birds feed, then head to water. Watch the stock tanks.');
    else if (night) add('Time of day', -30, 'Dark. Birds are roosted.');
    else add('Time of day', (temp ?? 80) >= 90 ? -10 : -5, 'Midday. Birds loaf in shade; a few trickle to water.');
    if (wind != null) {
      if (wind <= 10) add('Wind', 10, `Light (${windNote(wind)}). Birds fly steady lines.`);
      else if (wind <= 18) add('Wind', 0, `Breezy (${windNote(wind)}). Birds fly low and fast into it. Set up on the downwind side of the field.`);
      else add('Wind', -15, `Strong (${windNote(wind)}). Birds hunker down and flights are erratic.`);
    }
    if (rate > 0.05) add('Rain', -15, 'Raining. Doves sit tight until it passes.');
    else if (rainDay > 0.25) add('Rain', 0, 'Rain today. Birds scatter to puddles instead of the tank.');
    if (front && month <= 10) add('Cold front', 10, `About ${Math.round(cooling)}°F cooler than a few days ago. A north front pushes fresh birds down from the north.`);
    if ((temp ?? 0) >= 95 && evening) add('Heat', 5, 'Hot and dry, so water holes will draw birds this evening.');
  }

  if (key === 'deer') {
    if (night) add('Time of day', -30, 'Dark. Deer hunting is only legal from 30 minutes before sunrise to 30 minutes after sunset.');
    else if (morning || evening) add('Time of day', 20, 'Dawn or dusk, when deer move between bedding and feed.');
    else if (md >= '11-05' && md <= '12-05') add('Time of day', 5, 'Midday, but it\'s the rut: bucks cruise at all hours, so an all-day sit can pay.');
    else add('Time of day', -10, 'Midday. Deer are mostly bedded.');
    if (front) add('Cold front', 15, `About ${Math.round(cooling)}°F cooler than a few days ago. The first cool days after a front get deer on their feet.`);
    if (temp != null) {
      if (temp <= 50) add('Temperature', 5, `Cool (${Math.round(temp)}°F). Deer move more.`);
      else if (temp >= 75) add('Temperature', -15, `Warm (${Math.round(temp)}°F). Deer bed in shade and move only at last light.`);
    }
    if (pressTrend != null) {
      if (pressTrend >= 0.02 && pressTrend <= 0.1) add('Pressure', 10, 'Rising behind a front. Clear, cold mornings after a front are prime.');
      else if (pressTrend <= -0.06) add('Pressure', 5, 'Falling fast. A storm is coming, and deer often feed hard just ahead of it.');
    }
    if (wind != null) {
      if (wind <= 10) add('Wind', 5, `Light (${windNote(wind)}). Play the wind: stay downwind of where deer come from.`);
      else if (wind > 20) add('Wind', -15, `Strong (${windNote(wind)}). Deer hold tight in cover and are jumpy.`);
      else add('Wind', 0, `Moderate (${windNote(wind)}). Hunt protected draws and the lee side of hills.`);
    }
    if (rate >= 0.3) add('Rain', -10, 'Heavy rain. Deer bed down; hunt the first hour after it stops.');
    else if (rate > 0) add('Rain', 0, 'Light rain doesn\'t stop deer. It covers your noise and scent.');
    if (md >= '11-08' && md <= '12-01') add('Rut', 10, 'Hill Country rut (peak about mid-November): bucks are chasing. Rattle and grunt.');
    else if (md >= '10-25' && md < '11-08') add('Rut', 5, 'Pre-rut: scrapes and rubs are showing up. A good time to rattle.');
    if (fullMoon && morning) add('Moon', -5, 'Full moon: deer feed at night, so mornings can be slow. Evening and midday sits help.');
  }

  if (key === 'turkey') {
    const spring = month >= 3 && month <= 5;
    if (night) add('Time of day', -30, 'Dark. Birds are on the roost.');
    else if (morning) add('Time of day', 20, spring ? 'Daybreak. Gobblers sound off on the roost and right after fly-down.' : 'Morning. Flocks leave the roost for feeding areas.');
    else if (spring && new Date(now).getHours() >= 9 && new Date(now).getHours() < 12) add('Time of day', 5, 'Late morning: hens head to nest and lonely gobblers come looking.');
    else if (evening) add('Time of day', spring ? 0 : 10, spring ? 'Evening. Birds drift toward the roost. Listen for gobbles to set up tomorrow.' : 'Evening. Flocks work back toward the roost.');
    else add('Time of day', -5, 'Midday. Birds loaf and dust in shade.');
    if (wind != null) {
      if (wind < 8) add('Wind', 15, `Calm (${windNote(wind)}). Gobbles carry and birds hear your calls.`);
      else if (wind <= 15) add('Wind', 0, `Breezy (${windNote(wind)}). Birds head for sheltered draws and open fields.`);
      else add('Wind', -15, `Windy (${windNote(wind)}). Birds can't hear well and get nervous; they gobble less.`);
    }
    if (rate > 0) add('Rain', -5, 'Rain: turkeys move to open pastures and field edges, so hunt there.');
    if (pressTrend != null && pressTrend <= -0.06) add('Pressure', -5, 'Falling fast ahead of weather. Gobbling usually drops off.');
    else if (pressTrend != null && pressTrend >= -0.02 && !cloudy) add('Pressure', 5, 'Steady or rising with clear skies: classic gobbling weather.');
    if (temp != null && temp < 35) add('Temperature', -5, `Cold (${Math.round(temp)}°F). Gobbling starts later.`);
  }

  if (key === 'hog') {
    const hot = (temp ?? 70) >= 80;
    if (night) add('Time of day', hot ? 15 : 10, hot ? 'Night. In the heat, hogs are nocturnal: sit over feeders, wallows and water with a light or thermal.' : 'Night. Hogs travel to feed after dark.');
    else if (morning || evening) add('Time of day', 15, 'Dawn or dusk: hogs move between bedding thickets and feed.');
    else add('Time of day', (temp ?? 70) < 60 ? 5 : -10, (temp ?? 70) < 60 ? 'Cool day: hogs move and root in daylight.' : 'Midday. Hogs bed in thick, shady cover and mud.');
    if (wind != null) {
      if (wind <= 15) add('Wind', 5, `${windNote(wind)}. Keep it in your face: a hog's nose is its best defense.`);
      else add('Wind', -10, `Strong (${windNote(wind)}). Swirling wind carries your scent and covers their sounds.`);
    }
    if (rainDay >= 0.25 || rate > 0) add('Rain', 10, 'Wet ground: hogs root hard in soft soil after rain.');
    if (night && fullMoon) add('Moon', 5, 'Full moon: enough light to see hogs in the open without a thermal.');
    else if (night && (age < 3 || age > 26.5)) add('Moon', 0, 'New moon: very dark, so use a thermal or a hog light.');
  }

  if (key === 'coyote') {
    if (morning || evening) add('Time of day', 15, 'Dawn or dusk: coyotes are on the move and come to calls.');
    else if (night) add('Time of day', 10, 'Night: coyotes are active; calling with a red light or thermal works.');
    else add('Time of day', (temp ?? 70) < 50 || cloudy ? 5 : -5, (temp ?? 70) < 50 || cloudy ? 'Cool or overcast day: coyotes hunt in daylight too.' : 'Midday: slower, but a good caller can still pull one.');
    if (wind != null) {
      if (wind < 8) add('Wind', 15, `Calm (${windNote(wind)}). Calls carry and coyotes commit.`);
      else if (wind <= 15) add('Wind', 0, `${windNote(wind)}. Coyotes circle downwind, so set up with a view of your downwind side.`);
      else add('Wind', -15, `Windy (${windNote(wind)}). Calls don't carry and coyotes hold up.`);
    }
    if (temp != null) {
      if (temp < 45) add('Temperature', 10, `Cold (${Math.round(temp)}°F). Hungry coyotes respond to distress calls.`);
      else if (temp > 85) add('Temperature', -10, `Hot (${Math.round(temp)}°F). Coyotes lay up; call near water early and late.`);
    }
    if (front) add('Cold front', 10, 'Just behind a front: predators hunt hard.');
    if (rate > 0) add('Rain', -10, 'Rain muffles calls and coyotes hole up.');
    if (month === 1 || month === 2) add('Season', 5, 'Breeding season: howls and challenge barks work.');
    else if (month >= 10 && month <= 12) add('Season', 5, 'Fall: young coyotes are dispersing and easier to call.');
    if (night && fullMoon) add('Moon', 5, 'Full moon: good visibility for night calling.');
  }

  if (key === 'bobcat') {
    if (morning || evening) add('Time of day', 15, 'Early morning and the last hour of light are best for cats.');
    else if (night) add('Time of day', 5, 'Night: cats hunt, but they come to calls slowly.');
    else add('Time of day', cloudy ? 5 : -5, cloudy ? 'Overcast: cats hunt later into the morning.' : 'Midday: cats rest.');
    if (wind != null) {
      if (wind < 10) add('Wind', 10, `Light (${windNote(wind)}). Cats hear the call and come in slow.`);
      else if (wind > 15) add('Wind', -15, `Windy (${windNote(wind)}). Cats stay put.`);
      else add('Wind', 0, `${windNote(wind)}. Workable.`);
    }
    if (temp != null && temp < 50) add('Temperature', 10, `Cool (${Math.round(temp)}°F). Cats are hungrier and move more.`);
    else if (temp != null && temp > 85) add('Temperature', -10, `Hot (${Math.round(temp)}°F). Cats lay up in shade.`);
    if (month === 12 || month <= 2) add('Season', 5, 'Winter: prime fur and the best calling. Stay on a stand 30–45 minutes; cats are slow.');
    if (rate > 0) add('Rain', -5, 'Rain: cats hole up.');
  }

  const score = Math.max(0, Math.min(100, 50 + f.reduce((a, x) => a + x.pts, 0)));
  const cond = score >= 75 ? 'excellent' : score >= 60 ? 'good' : score >= 40 ? 'fair' : 'poor';
  const level = season.open ? cond : 'closed';
  const best = [...f].sort((a, b) => b.pts - a.pts)[0];
  const worst = [...f].sort((a, b) => a.pts - b.pts)[0];
  const lead = { excellent: 'Great conditions.', good: 'Good conditions.', fair: 'Fair. Expect to work for it.', poor: 'Slow conditions.' }[cond];
  const why = (cond === 'poor' || cond === 'fair') ? (worst?.pts < 0 ? worst : null) : (best?.pts > 0 ? best : null);
  const t = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const headline = !season.open ? `Season closed. Conditions right now would be ${cond}.`
    : !legalNow ? `Outside legal shooting hours. Legal ${now < hours.start ? 'from' : 'again tomorrow from'} ${t(now < hours.start ? hours.start : hours.start + 86400000)}.`
      : `${lead}${why ? ` ${why.label}: ${why.note.split(/\.\s/)[0].replace(/\.$/, '')}.` : ''}`;
  return { key, game, score, level, cond, season, hours, legalNow, headline, factors: f };
}
