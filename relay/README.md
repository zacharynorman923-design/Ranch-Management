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

## One-time setup (about 20 minutes, all in a phone or computer browser)

The **API token** in part B is something you create yourself inside
Cloudflare. It's a password that lets GitHub install the relay into your
Cloudflare account.

### A. Merge the relay into `main`
The deploy button only exists once this code is on `main`. If it isn't yet,
open the pull request that adds `relay/` and tap **Merge pull request**, then
**Confirm merge**.

### B. Cloudflare: account, Account ID, API token
1. Sign up at <https://dash.cloudflare.com/sign-up> (free) and confirm your email.
2. In the left menu, open **Compute (Workers) → Workers & Pages** (older
   screens just say **Workers & Pages**). If it asks you to pick a
   `workers.dev` subdomain, accept the suggestion. The relay's web address
   will end in it.
3. **Account ID:** look at the address bar. It reads
   `dash.cloudflare.com/`**`a1b2c3…`**`/…`. That 32-character string is your
   Account ID. It's also shown as *Account ID* on the right of the Workers &
   Pages overview. Copy it into a note.
4. **API token:**
   1. Go to <https://dash.cloudflare.com/profile/api-tokens> (profile icon at
      top right → **My Profile** → **API Tokens**).
   2. Tap **Create Token**.
   3. Next to **Edit Cloudflare Workers**, tap **Use template**.
   4. Under **Permissions**, tap **+ Add more** and set the new row to
      **Account** · **D1** · **Edit**. The relay's database needs this, and
      the template leaves it out.
   5. **Account Resources**: *Include* → your account. **Zone Resources**:
      *Include* → **All zones** (you have none, which is fine).
   6. Tap **Continue to summary** → **Create Token**.
   7. **Copy the token now.** Cloudflare shows it only once. If you lose it,
      delete it and make another.

### C. Make your relay password
Make up a long random string, 30+ characters. Your phone's password generator
works well; on iPhone, use the Passwords app, **+**, and copy the suggested
password. This is your `RELAY_TOKEN`. Save it in a note; you'll paste it
twice.

### D. Put the secrets in GitHub
Open **Settings → Secrets and variables → Actions → New repository secret**
(<https://github.com/zacharynorman923-design/Ranch-Management/settings/secrets/actions/new>).
Add each secret below one at a time: type the **Name** exactly as shown, paste
the **Secret**, and tap **Add secret**.

| Name | Secret |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | token from B.4 |
| `CLOUDFLARE_ACCOUNT_ID` | ID from B.3 |
| `RELAY_TOKEN` | password from C |
| `TACTACAM_EMAIL` | the email you use for the Reveal app |
| `TACTACAM_PASSWORD` | your Reveal password |

Secrets are encrypted. They can't be read back, even by you, and never appear
in this public repo or its logs.

**Optional, recommended:** switch to the **Variables** tab → **New repository
variable** and add `RANCH_LAT` and `RANCH_LON` for the middle of your place.
In Apple or Google Maps, drop a pin there; the coordinates look like
`30.7488, -99.2303`. The first number is LAT, the second is LON, with its
minus sign. This puts the rain estimate on your pastures instead of Mason
town.

### E. Deploy
1. Open the repo's **Actions** tab → **Deploy relay** (left list) →
   **Run workflow** → **Run workflow**.
2. Wait about 1–2 minutes for a green check. Tap the run, then **deploy**, then
   expand the **Deploy the Worker** step. Near the bottom is an address like
   `https://ranch-relay.<your-subdomain>.workers.dev`. Copy it.
   - A red ❌ in the **Store secrets** step means the `RELAY_TOKEN` secret is
     missing.
   - A red ❌ that mentions *Authentication* means the Cloudflare token is
     wrong or missing **D1 · Edit**. Redo B.4, update the secret, and run
     again.

### F. Connect the app
In the installed app, go to **☰ → Settings → Automatic data (relay)**:
1. **Relay address:** paste the address from E.2.
2. **Relay token:** paste your password from C.
3. Tap **Check relay**. You should see `"ok": true` for rain and for cameras.
   - A camera error such as *Incorrect username or password* means the
     Tactacam secrets need fixing.
4. Tap **Sync now**. About a year of rain appears in the rain log, your
   cameras appear under **Cams & feeders**, and the last 3 days of photos
   appear in the **Photo log**.

After this you never touch it again. The relay runs by itself, and the app
syncs whenever it has signal.

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
