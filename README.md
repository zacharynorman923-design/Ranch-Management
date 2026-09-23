# Ranch Management

Offline-first ranch records for an **absentee-owned 250-acre Mason County, Texas
place** running cattle, deer and dove. The app answers the questions that
matter from Houston: *am I overstocked for this rain, what needs doing next
trip, and can I prove use to the appraisal district?*

No build step, no dependencies, no server. It uses plain HTML, CSS and ES-module
JavaScript. It installs to a phone's home screen as a PWA and **works with no
signal**. Every record is stored on the device in IndexedDB.

```
npm test          # 24 unit tests for the ranch math (Node 18+)
npm start         # serve at http://localhost:8080 (any static server works)
```

To try it, open the app and tap **Load a sample ranch** on the dashboard. The
sample is built around today's date, so every screen has data. You can remove
it in one step under Settings.

## Modules

### 1. Grazing & stocking
- **Rain gauge log.** Monthly totals against normal, trailing 12 months and
  year to date. A month with no readings counts as *missing*, not zero, so a
  forgotten gauge isn't mistaken for drought. Log `0.00` for a dry month.
- **Carrying-capacity calculator.** `acres ÷ acres/AU × rain ratio`, floored to
  whole head. At 20 ac/AU, 250 ac is 12.5 AU, or **12 head**. At 60% of normal
  rain it is 7.5 AU, or **7 head**. The **destock-trigger ladder** (100/80/60/40%)
  shows the most you should hold at each rain level, compared with what is on
  the place today. A wet-year cap is included, and you can optionally charge the
  spotlight deer estimate against the grass (default 6 deer = 1 AU).
- **Pasture rotation.** Log each move in and out, with AU and forage condition
  (1–5) at move-out. The rotation shows days grazed, rest days and AU-days per
  acre. "Move cattle" offers to close out the pasture they left.
- **Herd records.** Tag, class, breed, birth or purchase, dam and sire. Events
  cover exposure (with calf-crop year), preg check, weaning weight,
  vaccinations and treatments, weights, sales ($/cwt, net proceeds, buyer,
  receipt photo) and deaths. "Work cattle" logs one event across many head.
  Calf-crop KPIs are exposed, preg rate, calving %, weaning %, average and
  205-day adjusted weaning weight, and **pounds weaned per exposed cow**.

### 2. Wildlife
- **Deer harvest log.** Age, weight, gross B&C score, points and spread,
  hunter, lease and stand. Each season shows does per buck harvested, average
  buck age, mature bucks, and weight and score by age class. Harvest is also
  checked against each lease's limits.
- **Spotlight survey tracker.** Deer per mile, and acres observed
  (`miles × 1,760 × visible width yd ÷ 4,840`) converted to **acres per deer**.
  From those come a herd estimate, does per buck, fawns per doe and a
  year-over-year trend. A **harvest quota** targets your density and sex ratio,
  taking surplus does first. The app warns until you have 3 runs.
- **Cameras & feeders.** Location, battery and refill intervals with due dates,
  and one-tap "Filled" / "Batteries" service logging. Trail-cam photos are
  tagged to the camera.
- **Dove field planner.** Works back from the opener (Sept 1 by default) to
  maturity date and staggered mow strips 21/14/7 days out. It flags late or
  early plantings and gives the latest plant date. A per-year **legal
  manipulation checklist** follows 50 CFR 20.21(i): planted not hauled,
  AgriLife-normal planting, manipulation where grown, no top-sowing, feeders off
  10 days, licenses/HIP/plugs. Hunts are logged by date with birds per hunter.

### 3. Land & water
- **Water points.** Tanks, troughs, wells, windmills and guzzlers, with level
  checks by visit, sensor, camera or neighbor. Points go stale after N days.
  Maintenance has next-due dates. Remote sensor data can come in by CSV import
  (`point, date, level`).
- **Brush management.** Cedar, mesquite and pear treatments by method, acres,
  cost, NRCS cost-share, $/acre, and retreatment due dates (rule of thumb:
  cedar 10 yr, mesquite 7, pear 5).
- **Fences & gates.** Segments, gates, water gaps and guards, with a condition
  log, miles of fence and repair spend.
- **Map.** An offline SVG map with no tiles. Import the property boundary
  GeoJSON once. Everything with a GPS pin shows by layer, and you tap a pin to
  open its record.

### 4. Compliance & tax
- **Valuation binder.** Switches between 1-d-1 agricultural and 1-d-1 wildlife.
  For ag, it shows head count, average AU, realized acres per AU against the
  CAD's intensity standard, and sales missing receipts. For wildlife it tracks
  the **3-of-7 practices**. Evidence is pulled automatically: brush work counts
  as habitat control, spotlight runs as census, wildlife water work as
  supplemental water, and feeder refills and food plots as supplemental food.
  Anything else goes in the practice log.
- **Year-end packet.** A printable proof-of-use and annual report. It covers
  livestock inventory (Jan 1, Dec 31, monthly), sales with receipts, herd
  health, the rotation log, improvements, the 7 practices, census and harvest,
  rainfall, enterprise income and expenses, flagged photos, and a signature
  line. Save it as a PDF from the print dialog.
- **Hunting leases.** Lessees, fees and paid dates, liability insurance with
  expiry alerts, signed-lease status, and buck/doe limits.
- **EQIP / NRCS.** Contract milestones by practice code, with due dates,
  certification and payments.

### 5. Financials
- **Enterprise P&L.** Cattle, hunting, dove/milo and overhead. Cattle sales,
  cattle purchases and lease fees are pulled from their own records, so nothing
  is entered twice. It shows **cost per cow per year** (with a chosen share of
  overhead) and **breakeven $/cwt** of calf weaned.
- **Scenarios.** Cow-calf, stockers, lease-only and wildlife-only side by side,
  optionally with a hunting lease. The defaults reproduce the worked example:
  12 cows × 85% × 500 lb × $3.00 = **$15,300** gross, less 12 × $900 =
  $10,800, for **$4,500** net before land.

### 6. Ops layer
- **Task calendar.** One click adds a seasonal template: burn windows, milo
  planting, dove opener and feeder pull-back, archery and general deer openers
  (first Saturday of November), calving, working calves, bull in/out, preg
  check, weaning, the valuation report and lease renewals.
- **Contacts.** Tap-to-call and tap-to-text for the vet, sale barn, CAD, NRCS,
  TPWD biologist and neighbor.
- **GPS photo log.** Photos are shrunk on the phone to about 200 KB. GPS and
  date come from EXIF, falling back to the phone's GPS for a fresh shot or to
  the trail camera's location. Photos can be tagged and flagged for the
  valuation packet.
- **Dashboard.** A "needs attention" list covers stocking, stale water checks,
  feeders and batteries, lease insurance, NRCS deadlines, brush retreatment,
  tasks and wildlife practices, plus quick-log buttons.

## Data, offline and backup
- Records live in **IndexedDB on the device**, and photos live in a separate
  store. A service worker caches the app shell. It uses the network when there
  is signal (so updates land) and gives up after 4 seconds, falling back to the
  cache.
- **Settings → Export backup** writes one JSON file with every record and
  photo. Importing it on another device *merges*, and the newer copy of each
  record wins. Export after every trip.
- Every table has **CSV export and import**. Headers match field names or
  labels, and dates accept `9/1/2026`. You can load a herd spreadsheet, a
  sale-barn export or tank-sensor readings.
- There is no cloud sync yet. See "Next" below.

## Code map
| File | What's in it |
| --- | --- |
| `js/calc.js` | All ranch math as pure functions. Tested in `test/`. |
| `js/schema.js` | Every record type and field. Forms, tables and CSV are generated from it. |
| `js/db.js` | IndexedDB storage, in-memory cache, backup/restore. |
| `js/model.js` | Settings defaults, the stocking picture, dashboard alerts, practice coverage. |
| `js/ui.js` | Record form (bottom sheet), tables, CSV, formatting, bar chart. |
| `js/photos.js` | Downscaling and a minimal EXIF GPS/date reader. |
| `js/pages/*.js` | One module per section. |
| `js/sample.js` | Sample ranch generator. |

## Caveats
- Rain normals are approximate for Mason and can be edited in Settings.
  Stocking rates and AU equivalents are rules of thumb. Your NRCS ecological
  site description is the real number.
- Game-law dates, bag limits and the 1-d-1 rules change. The app says
  "verify" where it matters. Confirm with the TPWD Outdoor Annual, Mason CAD
  and your wildlife biologist.
- Harvest quotas are a starting point for that conversation, not a permit
  number.

## Next
- Sync between phones (a small backend or a shared-drive file).
- Direct sensor integrations (cellular tank monitors, rain gauges) in place of
  CSV import.
- Drawn polygons for brush treatments and pastures on the map.
