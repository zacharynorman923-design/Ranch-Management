# Ranch relay

A small service on Cloudflare's **free** plan that keeps working while your
phone is off:

- **Every 15 minutes** it pulls new photos from your **Tactacam Reveal**
  cameras, with each camera's battery, signal, GPS, temperature and moon phase.
- **Every hour** it pulls **rain**:
  - from an **Ambient Weather** station, once you have one;
  - otherwise from **Open-Meteo**'s free weather-model rainfall for the ranch's
    coordinates. On the first run it backfills about 13 months, so the stocking
    calculator works on day one.

The app pulls whatever is new whenever it has signal: on open, every 15
minutes while open, and when signal comes back. Rain goes into the rain log
marked *(auto)*. Photos go into the photo log, tied to the right camera.
Cameras show up under Cams & feeders on their own.

## One-time setup (about 15 minutes, all from a browser)

You'll set up three things: a Cloudflare account, a few GitHub secrets, then
one button press.

### 1. Cloudflare
1. Sign up at <https://dash.cloudflare.com/sign-up>. The free plan is enough.
2. Open **Workers & Pages** once, so Cloudflare creates your `workers.dev`
   subdomain. Accept the name it suggests or pick one.
3. Copy your **Account ID**. It's in the right-hand column of the Workers &
   Pages overview (or in the URL: `dash.cloudflare.com/<account id>/…`).
4. Create an **API token**: profile icon → *My Profile* → *API Tokens* →
   *Create Token* → template **"Edit Cloudflare Workers"**. Under
   *Permissions*, add **Account → D1 → Edit**. Create it and copy the token.

### 2. GitHub secrets
In this repo, go to **Settings → Secrets and variables → Actions → New
repository secret** and add:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | the token from step 1.4 |
| `CLOUDFLARE_ACCOUNT_ID` | the ID from step 1.3 |
| `RELAY_TOKEN` | a long random password you make up (e.g. from your phone's password generator). You'll paste the same value into the app. |
| `TACTACAM_EMAIL` | your Tactacam Reveal login email |
| `TACTACAM_PASSWORD` | your Tactacam Reveal password |

Secrets are encrypted. They aren't visible in this public repo or its logs,
and they're passed straight to Cloudflare.

**Optional:** on the *Variables* tab, set `RANCH_LAT` and `RANCH_LON` to the
middle of your place (long-press it in Google/Apple Maps). This makes the rain
estimate land on your pastures instead of Mason town.

### 3. Deploy
**Actions** tab → **Deploy relay** → **Run workflow**. When it finishes, open
the *Deploy the Worker* step and copy the address it printed, e.g.
`https://ranch-relay.<your-subdomain>.workers.dev`.

### 4. Connect the app
In the app: **Settings → Automatic data (relay)**. Paste the address and your
`RELAY_TOKEN`, then tap **Check relay**, then **Sync now**.

## Adding a rain gauge later
1. Get an **Ambient Weather** station that reports to AmbientWeather.net (see
   the recommendation below).
2. At <https://ambientweather.net/account/keys>, create an **API key** and an
   **Application key**.
3. Add them as repository secrets `AMBIENT_API_KEY` and
   `AMBIENT_APPLICATION_KEY`, then run **Deploy relay** again.

From then on, each day's gauge total replaces the model estimate for that day.

**Which gauge:** get an **Ambient Weather WS-2902-series** station, or an
Ambient tipping-bucket rain gauge that pairs with an Ambient Wi-Fi console.
Mount it within Wi-Fi range of your one connected building, typically a few
hundred feet line of sight from the console. Put the gauge in the open, well
clear of the roof and trees. A tipping bucket reads heavy Hill Country storms
better than the haptic sensors on some all-in-one stations.

## Things to know
- **Tactacam has no official API.** The relay signs in the same way the Reveal
  website (account.revealcellcam.com) does. If Tactacam changes their site,
  photo sync can stop until the relay is updated. The error shows in the app
  under Settings → Check relay, and rain keeps working.
- If you sign in to Tactacam with Google or Apple, first set a password with
  "Forgot password" on the Reveal site. Accounts with two-step codes aren't
  supported.
- **Free-plan limits** are far above what one ranch uses. The relay keeps the
  last 45 days of photos (`PHOTO_KEEP_DAYS` in `wrangler.toml`).
- On the phone, untagged camera photos are removed after 30 days (adjustable
  in Settings). Tap **buck / doe / hog…** under a photo to keep it.
- **Weather-model rainfall is an estimate** for a roughly 1–10 km grid cell.
  It's fine for the trailing-12-month stocking math, but a gauge is better for
  single storms.

## Endpoints
All endpoints require `Authorization: Bearer <RELAY_TOKEN>`.

| | |
| --- | --- |
| `GET /status` | last run of each source, counts, which sources are configured |
| `GET /rain?since=YYYY-MM-DD` | `[{date, gauge, est}]` |
| `GET /cameras` | `[{id, name, battery, signal, lat, lon, last_photo}]` |
| `GET /photos?after=SEQ` | up to 50 photo records after a cursor |
| `GET /photo/:id` | the JPEG |
| `POST /run` | poll every source now |

Local development: `cd relay && npm install && npx wrangler d1 execute
ranch-relay --local --file=schema.sql && npm run dev`, with `RELAY_TOKEN=…` in
`relay/.dev.vars`. Tests for the relay live in `test/relay.test.js` at the repo
root (`npm test`).
