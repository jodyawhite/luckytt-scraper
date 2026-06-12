# Lucky TT — Scraper & API

Netlify serverless functions that scrape NLCB draw results and serve them to the Lucky TT app.

---

## Files

```
netlify/functions/
  scrape-draws.mjs   — Scheduled scraper (runs 4x daily automatically)
  get-draws.mjs      — API endpoint (serves data to your app)
scripts/
  backfill.mjs       — One-time historical data loader
netlify.toml         — Netlify config
package.json
```

---

## Step 1 — Set up Netlify (15 minutes)

1. Go to **app.netlify.com** and log in (or create a free account)
2. Click **"Add new site" → "Import an existing project"**
3. Connect your GitHub account and push this folder as a repo
   - Or use **Netlify CLI**: `npm install -g netlify-cli && netlify deploy`
4. Your site will be at something like `https://luckytt.netlify.app`

---

## Step 2 — Run the backfill (one time only)

This fetches 12 months of real historical data.

```bash
# Install dependencies
npm install

# Set your Netlify credentials (get these from Netlify dashboard → Site settings → API)
export NETLIFY_TOKEN=your_personal_access_token
export NETLIFY_SITE_ID=your_site_id

# Run the full backfill (takes 30-40 minutes, rate limited)
npm run backfill

# Or run each game separately:
npm run backfill:pw      # Play Whe only
npm run backfill:cp      # Cash Pot only
npm run backfill:lotto   # Lotto only
```

The script saves progress to `luckytt-data.json` locally.
If it stops, just run it again — it resumes from the checkpoint.

---

## Step 3 — Connect your app

In your Lucky TT HTML file, replace the simulated data section with:

```javascript
// At the top of your <script> section, replace PW_DRAWS/CP_DRAWS/LT_DRAWS with:

const DATA_URL = 'https://YOUR-SITE.netlify.app/api/get-draws?days=365';

async function loadRealData() {
  try {
    const res  = await fetch(DATA_URL);
    const data = await res.json();

    if (data.ok && data.pw.length > 0) {
      // Replace simulated draws with real ones
      window.REAL_PW_DRAWS    = data.pw;
      window.REAL_CP_DRAWS    = data.cp;
      window.REAL_LOTTO_DRAWS = data.lotto;
      window.DATA_UPDATED_AT  = data.updatedAt;
      console.log('Real data loaded:', data.pw.length, 'PW draws');
      // Re-run init with real data
      initApp();
    } else {
      console.warn('No real data yet, using simulated data');
      initApp();
    }
  } catch (err) {
    console.warn('Could not load real data, using simulated:', err.message);
    initApp();
  }
}

// Call this instead of calling init() directly
loadRealData();
```

---

## Step 4 — Verify automatic scraping

The `scrape-draws.mjs` function runs automatically 4 times a day:
- 10:45 AM Trinidad time (after morning draw)
- 1:15 PM (after midday draw)
- 4:15 PM (after afternoon draw)
- 7:15 PM (after evening draw)

To verify it's working:
1. Go to Netlify dashboard → **Functions** tab
2. Look for `scrape-draws` in the list
3. Check the logs after a draw time

---

## API Endpoint

```
GET https://YOUR-SITE.netlify.app/api/get-draws

Query params:
  ?days=365        — Last N days (default: 365)
  ?game=pw         — Filter to one game (pw, cp, lotto)

Response:
{
  "ok": true,
  "updatedAt": "2026-06-07T18:15:00Z",
  "pw": [
    { "date": "07 Jun 2026", "time": "1:00 PM", "draw": 27031, "number": 26, "game": "pw" },
    ...
  ],
  "cp": [ ... ],
  "lotto": [ ... ]
}
```

---

## Troubleshooting

**Scraper returns 0 draws:**
The source site may have changed its HTML structure. Check the regex patterns in `scrape-draws.mjs`. The key pattern is `additional-marks/#NUMBER`.

**Getting 403 errors:**
The site may be blocking the Netlify IP range. Solutions:
1. Add a longer delay in the scraper (change `DELAY_MS`)
2. Use a different User-Agent header
3. Route through a proxy

**Netlify Blobs not working:**
Make sure your Netlify site has Blobs enabled:
Netlify dashboard → Site settings → Storage → Enable Blobs

---

## Cost

Everything runs on Netlify free tier:
- Functions: 125,000 invocations/month free (you use ~120/month)
- Blobs: 1GB free (your data is ~1MB)
- **Total cost: $0**
