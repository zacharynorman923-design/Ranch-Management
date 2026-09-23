/* =========================================================================
   Record types. Each collection lists its fields once; the generic form,
   table and CSV import/export in ui.js are driven entirely from here.

   Field: { k, label, t, opts?, req?, def?, step?, ref?, help?, show?(rec) }
   Types: text, textarea, num, date, select, bool, ref, loc, photos
   ========================================================================= */
import { today, WILDLIFE_PRACTICES, BRUSH_RETREAT_YEARS } from './calc.js';
import * as db from './db.js';

const o = (...xs) => xs.map((x) => (Array.isArray(x) ? { v: x[0], l: x[1] } : { v: x, l: x[0].toUpperCase() + x.slice(1) }));
const notes = { k: 'notes', label: 'Notes', t: 'textarea' };
const loc = { k: 'loc', label: 'Location', t: 'loc' };
const photos = { k: 'photos', label: 'Photos / receipts', t: 'photos' };

export const SCORE = o(['1', '1 — poor'], ['2', '2 — fair'], ['3', '3 — good'], ['4', '4 — very good'], ['5', '5 — excellent']);
export const EVENT_TYPES = o(
  ['expose', 'Exposed to bull'], ['preg', 'Preg check'], ['wean', 'Weaned (weigh)'], ['weigh', 'Weighed'],
  ['vaccinate', 'Vaccinated'], ['treat', 'Treated / wormed'], ['sale', 'Sold'], ['death', 'Died'],
);

export const COLLECTIONS = {
  rain: {
    label: 'Rain reading', sort: '-date',
    fields: [
      { k: 'date', label: 'Date', t: 'date', req: 1, def: today },
      { k: 'inches', label: 'Inches', t: 'num', step: 0.01, req: 1, help: 'Log 0.00 for a dry month so it isn’t counted as missing.' },
      { k: 'gauge', label: 'Gauge', t: 'text', def: () => db.settings().defaultGauge || 'Headquarters' },
      notes,
    ],
    cols: ['date', 'inches', 'gauge', 'notes'],
  },

  pastures: {
    label: 'Pasture', sort: 'name',
    fields: [
      { k: 'name', label: 'Name', t: 'text', req: 1 },
      { k: 'acres', label: 'Acres', t: 'num', req: 1 },
      { k: 'water', label: 'Water source', t: 'text' },
      loc, notes,
    ],
    cols: ['name', 'acres', 'water'],
  },
  grazings: {
    label: 'Grazing period', sort: '-dateIn',
    fields: [
      { k: 'pasture', label: 'Pasture', t: 'ref', ref: 'pastures', req: 1 },
      { k: 'dateIn', label: 'Moved in', t: 'date', req: 1, def: today },
      { k: 'dateOut', label: 'Moved out', t: 'date', help: 'Leave blank while cattle are still in it.' },
      { k: 'head', label: 'Head', t: 'num' },
      { k: 'au', label: 'Animal units', t: 'num', step: 0.1, req: 1 },
      { k: 'score', label: 'Forage condition at move-out', t: 'select', opts: SCORE },
      notes,
    ],
    cols: ['pasture', 'dateIn', 'dateOut', 'au', 'score'],
  },

  animals: {
    label: 'Animal', sort: 'tag',
    fields: [
      { k: 'tag', label: 'Tag ID', t: 'text', req: 1 },
      { k: 'cls', label: 'Class', t: 'select', req: 1, def: 'cow', opts: o('cow', ['bred heifer', 'Bred heifer'], 'heifer', 'bull', 'steer', 'calf', 'horse', 'goat', 'sheep') },
      { k: 'breed', label: 'Breed', t: 'text' },
      { k: 'birthDate', label: 'Birth date', t: 'date' },
      { k: 'birthWeight', label: 'Birth weight (lb)', t: 'num', show: (r) => r.cls === 'calf' },
      { k: 'dam', label: 'Dam', t: 'ref', ref: 'animals', filter: (a) => ['cow', 'bred heifer', 'heifer'].includes(a.cls) },
      { k: 'sire', label: 'Sire', t: 'text' },
      { k: 'purchaseDate', label: 'Purchase date', t: 'date', help: 'Blank if raised here.' },
      { k: 'purchasePrice', label: 'Purchase price ($)', t: 'num' },
      { k: 'seller', label: 'Bought from', t: 'text' },
      { k: 'au', label: 'AU override', t: 'num', step: 0.05, help: 'Blank uses the class default (cow 1.0, bull 1.35, weaned calf 0.5…).' },
      notes,
    ],
    cols: ['tag', 'cls', 'breed', 'birthDate', 'dam'],
  },
  events: {
    label: 'Herd event', sort: '-date',
    fields: [
      { k: 'animal', label: 'Animal', t: 'ref', ref: 'animals', req: 1 },
      { k: 'date', label: 'Date', t: 'date', req: 1, def: today },
      { k: 'type', label: 'Event', t: 'select', opts: EVENT_TYPES, req: 1, def: 'vaccinate' },
      { k: 'crop', label: 'Calf crop year', t: 'num', help: 'The year the resulting calf will be born.', show: (r) => ['expose', 'preg'].includes(r.type), def: () => new Date().getFullYear() + 1 },
      { k: 'result', label: 'Result', t: 'select', opts: o('bred', 'open'), show: (r) => r.type === 'preg' },
      { k: 'weight', label: 'Weight (lb)', t: 'num', show: (r) => ['wean', 'weigh', 'sale'].includes(r.type) },
      { k: 'product', label: 'Product / dose', t: 'text', show: (r) => ['vaccinate', 'treat'].includes(r.type) },
      { k: 'price', label: 'Price ($/cwt)', t: 'num', step: 0.01, show: (r) => r.type === 'sale' },
      { k: 'amount', label: 'Net proceeds ($)', t: 'num', step: 0.01, help: 'From the sale barn receipt. Blank = weight × $/cwt.', show: (r) => r.type === 'sale' },
      { k: 'buyer', label: 'Buyer / barn', t: 'text', show: (r) => r.type === 'sale' },
      notes,
      { ...photos, show: (r) => ['sale', 'death'].includes(r.type) },
    ],
    cols: ['date', 'animal', 'type', 'weight', 'product', 'notes'],
  },

  harvests: {
    label: 'Deer harvest', sort: '-date',
    fields: [
      { k: 'date', label: 'Date', t: 'date', req: 1, def: today },
      { k: 'sex', label: 'Sex', t: 'select', opts: o('buck', 'doe'), req: 1, def: 'buck' },
      { k: 'age', label: 'Age (yrs, jawbone)', t: 'select', opts: o(['0.5', '0.5 (fawn)'], ['1.5', '1.5'], ['2.5', '2.5'], ['3.5', '3.5'], ['4.5', '4.5'], ['5.5', '5.5'], ['6.5', '6.5+']) },
      { k: 'weight', label: 'Weight (lb)', t: 'num' },
      { k: 'weightType', label: 'Weighed', t: 'select', opts: o(['field-dressed', 'Field dressed'], 'live'), def: 'field-dressed' },
      { k: 'score', label: 'Gross B&C score', t: 'num', step: 0.125, show: (r) => r.sex === 'buck' },
      { k: 'points', label: 'Points', t: 'num', show: (r) => r.sex === 'buck' },
      { k: 'spread', label: 'Inside spread (in)', t: 'num', step: 0.125, show: (r) => r.sex === 'buck' },
      { k: 'hunter', label: 'Hunter', t: 'text' },
      { k: 'lease', label: 'Lease', t: 'ref', ref: 'leases' },
      { k: 'stand', label: 'Stand / area', t: 'text' },
      notes, photos,
    ],
    cols: ['date', 'sex', 'age', 'weight', 'score', 'hunter'],
  },
  surveys: {
    label: 'Spotlight run', sort: '-date',
    fields: [
      { k: 'date', label: 'Date', t: 'date', req: 1, def: today },
      { k: 'route', label: 'Route / transect', t: 'text', def: 'Main route' },
      { k: 'miles', label: 'Miles driven', t: 'num', step: 0.1, req: 1 },
      { k: 'width', label: 'Visible width (yards, both sides)', t: 'num', req: 1, help: 'Average visibility measured along the route. Re-measure when brush changes.' },
      { k: 'bucks', label: 'Bucks', t: 'num', def: 0 },
      { k: 'does', label: 'Does', t: 'num', def: 0 },
      { k: 'fawns', label: 'Fawns', t: 'num', def: 0 },
      { k: 'unknown', label: 'Unidentified', t: 'num', def: 0 },
      notes,
    ],
    cols: ['date', 'route', 'miles', 'bucks', 'does', 'fawns', 'unknown'],
  },
  devices: {
    label: 'Camera / feeder', sort: 'name',
    fields: [
      { k: 'name', label: 'Name', t: 'text', req: 1 },
      { k: 'type', label: 'Type', t: 'select', opts: o(['camera', 'Trail camera'], ['feeder', 'Feeder'], ['protein', 'Protein feeder'], ['sensor', 'Remote sensor'], ['blind', 'Blind / stand']), def: 'camera' },
      loc,
      { k: 'batteryDate', label: 'Batteries last changed', t: 'date' },
      { k: 'batteryDays', label: 'Battery life (days)', t: 'num', def: 90 },
      { k: 'refillDate', label: 'Last filled', t: 'date', show: (r) => ['feeder', 'protein'].includes(r.type) },
      { k: 'refillDays', label: 'Refill every (days)', t: 'num', def: 21, show: (r) => ['feeder', 'protein'].includes(r.type) },
      { k: 'feed', label: 'Feed', t: 'text', show: (r) => ['feeder', 'protein'].includes(r.type) },
      notes,
    ],
    cols: ['name', 'type', 'batteryDate', 'refillDate'],
  },
  devicelog: {
    label: 'Service visit', sort: '-date',
    fields: [
      { k: 'device', label: 'Camera / feeder', t: 'ref', ref: 'devices', req: 1 },
      { k: 'date', label: 'Date', t: 'date', req: 1, def: today },
      { k: 'action', label: 'Work', t: 'select', opts: o(['refill', 'Filled feed'], ['battery', 'Changed batteries'], ['card', 'Pulled SD card'], ['repair', 'Repair / moved']), def: 'refill' },
      { k: 'qty', label: 'Lbs of feed', t: 'num', show: (r) => r.action === 'refill' },
      notes,
    ],
    cols: ['date', 'device', 'action', 'qty', 'notes'],
  },
  dovefields: {
    label: 'Dove field', sort: '-plantDate',
    fields: [
      { k: 'name', label: 'Field', t: 'text', req: 1 },
      { k: 'acres', label: 'Acres', t: 'num' },
      { k: 'crop', label: 'Crop', t: 'select', opts: o('milo', 'sunflower', ['wheat', 'Wheat'], ['millet', 'Proso millet'], ['native', 'Native (croton/sunflower)']), def: 'milo' },
      { k: 'hybrid', label: 'Hybrid / variety', t: 'text' },
      { k: 'plantDate', label: 'Planting date', t: 'date' },
      { k: 'daysToMaturity', label: 'Days to maturity', t: 'num', def: 100 },
      { k: 'seedRate', label: 'Seeding rate (lb/ac)', t: 'num', help: 'Keep within Texas A&M AgriLife recommendations — that is what makes it “normal agricultural planting”.' },
      loc, notes,
    ],
    cols: ['name', 'acres', 'crop', 'plantDate'],
  },
  dovehunts: {
    label: 'Dove hunt', sort: '-date',
    fields: [
      { k: 'date', label: 'Date', t: 'date', req: 1, def: today },
      { k: 'field', label: 'Field', t: 'ref', ref: 'dovefields' },
      { k: 'hunters', label: 'Hunters', t: 'num', req: 1 },
      { k: 'birds', label: 'Birds taken', t: 'num', req: 1 },
      notes,
    ],
    cols: ['date', 'field', 'hunters', 'birds'],
  },

  waterpoints: {
    label: 'Water point', sort: 'name',
    fields: [
      { k: 'name', label: 'Name', t: 'text', req: 1 },
      { k: 'type', label: 'Type', t: 'select', opts: o(['tank', 'Stock tank / pond'], 'trough', 'well', 'windmill', ['solar', 'Solar well'], ['guzzler', 'Wildlife guzzler'], ['storage', 'Storage tank']), def: 'trough' },
      { k: 'pasture', label: 'Pasture', t: 'ref', ref: 'pastures' },
      { k: 'sensor', label: 'Has a remote level sensor', t: 'bool' },
      loc, notes,
    ],
    cols: ['name', 'type', 'pasture', 'sensor'],
  },
  waterchecks: {
    label: 'Water check', sort: '-date',
    fields: [
      { k: 'point', label: 'Water point', t: 'ref', ref: 'waterpoints', req: 1 },
      { k: 'date', label: 'Date', t: 'date', req: 1, def: today },
      { k: 'level', label: 'Level (% full)', t: 'num' },
      { k: 'working', label: 'Flowing / float OK', t: 'select', opts: o(['yes', 'Yes'], ['no', 'No — needs work']), def: 'yes' },
      { k: 'source', label: 'Checked by', t: 'select', opts: o(['visit', 'Visit'], ['sensor', 'Sensor'], ['camera', 'Camera'], ['neighbor', 'Neighbor / hand']), def: 'visit' },
      notes,
    ],
    cols: ['date', 'point', 'level', 'working', 'source'],
  },
  waterwork: {
    label: 'Water maintenance', sort: '-date',
    fields: [
      { k: 'point', label: 'Water point', t: 'ref', ref: 'waterpoints', req: 1 },
      { k: 'date', label: 'Date', t: 'date', req: 1, def: today },
      { k: 'work', label: 'Work done', t: 'text', req: 1 },
      { k: 'cost', label: 'Cost ($)', t: 'num' },
      { k: 'nextDue', label: 'Next service due', t: 'date' },
      { k: 'wildlife', label: 'Counts as supplemental water for wildlife', t: 'bool' },
      notes, photos,
    ],
    cols: ['date', 'point', 'work', 'cost', 'nextDue'],
  },
  brush: {
    label: 'Brush treatment', sort: '-date',
    fields: [
      { k: 'date', label: 'Date', t: 'date', req: 1, def: today },
      { k: 'area', label: 'Area / pasture', t: 'text' },
      { k: 'species', label: 'Target', t: 'select', opts: o('cedar', 'mesquite', ['prickly pear', 'Prickly pear'], 'other'), def: 'cedar' },
      { k: 'method', label: 'Method', t: 'select', opts: o(['mechanical', 'Mechanical (dozer/skid steer)'], ['hand', 'Hand cut / lopping'], ['ipt', 'Individual plant treatment (herbicide)'], ['aerial', 'Aerial herbicide'], ['fire', 'Prescribed fire'], ['grubbing', 'Grubbing']), def: 'mechanical' },
      { k: 'acres', label: 'Acres', t: 'num', req: 1 },
      { k: 'cost', label: 'Total cost ($)', t: 'num' },
      { k: 'costShare', label: 'NRCS cost-share received ($)', t: 'num' },
      { k: 'retreatYears', label: 'Retreat after (years)', t: 'num', def: (r) => BRUSH_RETREAT_YEARS[r?.species] ?? 10, help: 'Rule of thumb: cedar ~10, mesquite ~7, prickly pear ~5.' },
      loc, notes, photos,
    ],
    cols: ['date', 'area', 'species', 'method', 'acres', 'cost'],
  },
  fences: {
    label: 'Fence / gate', sort: 'name',
    fields: [
      { k: 'name', label: 'Name', t: 'text', req: 1, help: 'e.g. “North boundary — county road”.' },
      { k: 'kind', label: 'Kind', t: 'select', opts: o(['segment', 'Fence segment'], 'gate', ['watergap', 'Water gap'], ['guard', 'Cattle guard']), def: 'segment' },
      { k: 'length', label: 'Length (ft)', t: 'num', show: (r) => r.kind === 'segment' },
      { k: 'material', label: 'Construction', t: 'text', help: 'e.g. 5-strand barbed, net wire, high fence.' },
      { k: 'boundary', label: 'Boundary fence (shared with a neighbor)', t: 'bool' },
      { k: 'lock', label: 'Lock / combination', t: 'text', show: (r) => r.kind === 'gate' },
      loc, notes,
    ],
    cols: ['name', 'kind', 'length', 'material'],
  },
  fencelog: {
    label: 'Fence check', sort: '-date',
    fields: [
      { k: 'fence', label: 'Fence / gate', t: 'ref', ref: 'fences', req: 1 },
      { k: 'date', label: 'Date', t: 'date', req: 1, def: today },
      { k: 'condition', label: 'Condition', t: 'select', opts: SCORE, req: 1, def: '3' },
      { k: 'work', label: 'Work done', t: 'text' },
      { k: 'cost', label: 'Cost ($)', t: 'num' },
      notes, photos,
    ],
    cols: ['date', 'fence', 'condition', 'work', 'cost'],
  },

  practices: {
    label: 'Wildlife practice', sort: '-date',
    fields: [
      { k: 'date', label: 'Date', t: 'date', req: 1, def: today },
      { k: 'practice', label: 'Practice', t: 'select', req: 1, opts: WILDLIFE_PRACTICES.map((p) => ({ v: p.key, l: p.label })) },
      { k: 'activity', label: 'What was done', t: 'text', req: 1, help: 'e.g. “Trapped 6 feral hogs”, “Installed 2 brush piles for quail cover”.' },
      { k: 'qty', label: 'Quantity / extent', t: 'text' },
      { k: 'cost', label: 'Cost ($)', t: 'num' },
      notes, photos,
    ],
    cols: ['date', 'practice', 'activity', 'qty'],
  },
  leases: {
    label: 'Hunting lease', sort: '-season',
    fields: [
      { k: 'lessee', label: 'Lessee', t: 'text', req: 1 },
      { k: 'season', label: 'Season', t: 'text', req: 1, def: () => { const y = new Date().getFullYear(); return `${y}-${String((y + 1) % 100).padStart(2, '0')}`; } },
      { k: 'enterprise', label: 'Lease type', t: 'select', opts: o(['hunting', 'Deer / year-round'], ['dove', 'Dove only']), def: 'hunting' },
      { k: 'phone', label: 'Phone', t: 'text' },
      { k: 'email', label: 'Email', t: 'text' },
      { k: 'hunters', label: 'Hunters on lease', t: 'num' },
      { k: 'fee', label: 'Lease fee ($)', t: 'num' },
      { k: 'paidDate', label: 'Paid on', t: 'date' },
      { k: 'insurer', label: 'Liability insurer', t: 'text' },
      { k: 'policy', label: 'Policy #', t: 'text' },
      { k: 'coverage', label: 'Coverage ($)', t: 'num', help: '$1M+ per occurrence naming you as additional insured is typical.' },
      { k: 'insExpires', label: 'Insurance expires', t: 'date' },
      { k: 'bucks', label: 'Buck limit', t: 'num' },
      { k: 'does', label: 'Doe limit', t: 'num' },
      { k: 'signed', label: 'Signed lease + release on file', t: 'bool' },
      { k: 'terms', label: 'Other terms', t: 'textarea' },
      photos,
    ],
    cols: ['season', 'lessee', 'fee', 'paidDate', 'insExpires'],
  },
  nrcs: {
    label: 'NRCS milestone', sort: 'due',
    fields: [
      { k: 'contract', label: 'Contract #', t: 'text', req: 1 },
      { k: 'program', label: 'Program', t: 'select', opts: o('EQIP', 'CSP', ['RCPP', 'RCPP'], 'other'), def: 'EQIP' },
      { k: 'code', label: 'Practice code', t: 'text', help: 'e.g. 314 Brush Management, 614 Watering Facility, 528 Prescribed Grazing.' },
      { k: 'description', label: 'Milestone', t: 'text', req: 1 },
      { k: 'units', label: 'Units (ac, ft, ea)', t: 'text' },
      { k: 'due', label: 'Due', t: 'date', req: 1 },
      { k: 'done', label: 'Completed / certified', t: 'date' },
      { k: 'payment', label: 'Payment ($)', t: 'num' },
      { k: 'paidDate', label: 'Paid on', t: 'date' },
      notes, photos,
    ],
    cols: ['due', 'contract', 'code', 'description', 'payment', 'done'],
  },

  ledger: {
    label: 'Transaction', sort: '-date',
    fields: [
      { k: 'date', label: 'Date', t: 'date', req: 1, def: today },
      { k: 'kind', label: 'Type', t: 'select', opts: o('expense', 'income'), def: 'expense', req: 1 },
      { k: 'enterprise', label: 'Enterprise', t: 'select', opts: o('cattle', ['hunting', 'Hunting / deer'], ['dove', 'Dove / milo'], ['overhead', 'Overhead (shared)']), def: 'cattle', req: 1 },
      { k: 'category', label: 'Category', t: 'text', req: 1, list: ['Hay', 'Feed / cubes', 'Mineral', 'Vet & medicine', 'Bull', 'Fuel', 'Fence repair', 'Water', 'Brush control', 'Seed', 'Fertilizer', 'Equipment', 'Labor', 'Deer feed', 'Protein', 'Game cameras', 'Insurance', 'Property tax', 'Trucking', 'Commission', 'NRCS payment', 'Hay sales', 'Other'] },
      { k: 'description', label: 'Description', t: 'text' },
      { k: 'vendor', label: 'Vendor', t: 'text' },
      { k: 'amount', label: 'Amount ($)', t: 'num', step: 0.01, req: 1 },
      photos,
    ],
    cols: ['date', 'enterprise', 'kind', 'category', 'description', 'amount'],
  },

  tasks: {
    label: 'Task', sort: 'date',
    fields: [
      { k: 'date', label: 'Due', t: 'date', req: 1, def: today },
      { k: 'title', label: 'Task', t: 'text', req: 1 },
      { k: 'category', label: 'Category', t: 'select', opts: o('cattle', 'wildlife', 'dove', 'land', 'water', 'compliance', 'other'), def: 'other' },
      { k: 'who', label: 'Who', t: 'text', help: 'You, the neighbor, the day hand…' },
      { k: 'done', label: 'Done', t: 'bool' },
      notes,
    ],
    cols: ['date', 'title', 'category', 'who', 'done'],
  },
  contacts: {
    label: 'Contact', sort: 'name',
    fields: [
      { k: 'name', label: 'Name', t: 'text', req: 1 },
      { k: 'role', label: 'Role', t: 'text', list: ['Veterinarian', 'Feed store', 'Sale barn', 'Mason CAD', 'NRCS', 'TPWD biologist', 'County extension agent', 'Game warden', 'Neighbor', 'Day hand', 'Fence contractor', 'Dozer / brush contractor', 'Well service', 'Hunting lessee', 'Insurance agent', 'Other'] },
      { k: 'company', label: 'Company', t: 'text' },
      { k: 'phone', label: 'Phone', t: 'text' },
      { k: 'email', label: 'Email', t: 'text' },
      notes,
    ],
    cols: ['name', 'role', 'company', 'phone'],
  },
  photos: {
    label: 'Photo', sort: '-date',
    fields: [
      { k: 'date', label: 'Date', t: 'date', def: today },
      { k: 'caption', label: 'Caption', t: 'text' },
      { k: 'tags', label: 'Tags', t: 'text', help: 'Comma separated — buck, doe, hog, predator, fence, water, cattle…' },
      { k: 'device', label: 'Trail camera', t: 'ref', ref: 'devices', filter: (d) => d.type === 'camera' },
      loc,
      { k: 'packet', label: 'Include in valuation packet', t: 'bool' },
    ],
    cols: ['date', 'caption', 'tags'],
  },
};

/** What a record looks like in a dropdown or a table cell pointing at it. */
export function titleOf(col, r) {
  if (!r) return '';
  switch (col) {
    case 'animals': return `${r.tag}${r.cls ? ' · ' + r.cls : ''}`;
    case 'leases': return `${r.lessee} (${r.season})`;
    default: return r.name || r.title || r.lessee || r.tag || r.caption || r.date || r.id;
  }
}
