/**
 * Lucky TT — Historical Backfill Script
 *
 * Run this ONCE locally to populate 12 months of real data.
 * It fetches draw-by-draw from nlcbplaywhelotto.com using
 * the draw number search form, then uploads to Netlify Blobs.
 *
 * Usage:
 *   node scripts/backfill.mjs
 *
 * Prerequisites:
 *   npm install node-fetch @netlify/blobs
 *   Set env: NETLIFY_TOKEN and NETLIFY_SITE_ID
 *
 * The script:
 *   1. Determines today's draw number from the live page
 *   2. Works backwards ~1460 draws (365 days × 4 draws/day)
 *   3. Fetches each draw page (rate limited to be polite)
 *   4. Saves to luckytt-data.json locally as a checkpoint
 *   5. Uploads final JSON to Netlify Blobs
 *
 * Takes about 30-40 minutes to run (rate limited to avoid IP ban).
 * You can stop and restart — it resumes from checkpoint.
 */

import fs   from "fs";
import path from "path";

// ── CONFIG ──────────────────────────────────────────────────
const CHECKPOINT_FILE = "./luckytt-data.json";
const DELAY_MS        = 1500;  // 1.5s between requests — be polite
const BASE_URL        = "https://www.nlcbplaywhelotto.com/nlcb-play-whe-results/";
const CP_BASE_URL     = "https://www.nlcbplaywhelotto.com/nlcb-cashpot-results/";
const LOTTO_BASE_URL  = "https://www.nlcbplaywhelotto.com/nlcb-lotto-plus-results/";
const MONTHS_BACK     = 13;    // fetch 13 months for safety

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  "Referer": "https://www.nlcbplaywhelotto.com/",
};

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MONTH_NUMS  = {Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12};

// ── HELPERS ─────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatDate(dt) {
  const d = dt.getDate().toString().padStart(2, "0");
  const m = MONTH_NAMES[dt.getMonth()];
  const y = dt.getFullYear();
  return `${d} ${m} ${y}`;
}

function loadCheckpoint() {
  if (fs.existsSync(CHECKPOINT_FILE)) {
    console.log(`[Checkpoint] Loading existing data from ${CHECKPOINT_FILE}`);
    return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf-8"));
  }
  return { pw: [], cp: [], lotto: [], lastPWDraw: null, lastCPDraw: null };
}

function saveCheckpoint(data) {
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(data, null, 2));
}

// ── FETCH HELPERS ────────────────────────────────────────────

/**
 * Fetch a specific month/year page for Play Whe.
 * The site has a form: ?date=DD&month=MM&year=YYYY
 * But it uses POST not GET. We use the draw number approach instead —
 * fetch by sequential draw numbers using ?draw=NNNNN
 */
async function fetchByDrawNumber(drawNum, baseUrl) {
  const url = `${baseUrl}?draw=${drawNum}`;
  try {
    const res  = await fetch(url, { headers: HEADERS });
    const html = await res.text();
    return html;
  } catch (err) {
    console.error(`  Error fetching draw ${drawNum}:`, err.message);
    return null;
  }
}

/**
 * Fetch a month page using the search form via POST
 */
async function fetchMonthPage(month, year, baseUrl) {
  try {
    const body = new URLSearchParams({
      month: month.toString(),
      year:  year.toString(),
    });
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: {
        ...HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    const html = await res.text();
    return html;
  } catch (err) {
    console.error(`  Error fetching ${month}/${year}:`, err.message);
    return null;
  }
}

// ── PARSERS ─────────────────────────────────────────────────

function parsePlayWhePage(html) {
  const results = [];

  // Match all draw blocks on the page
  // Each block: "Morning/Midday/Afternoon/Evening  Draw #NNNNN  [N MarkName]"
  const timeMap = {
    "Morning":   "10:30 AM",
    "Midday":    "1:00 PM",
    "Afternoon": "4:00 PM",
    "Evening":   "7:00 PM",
  };

  // Extract date from page: "Play Whe Results for today: DD-Mon-YY" or from draw context
  let pageDate = null;
  const dateMatch = html.match(/Play Whe Results for[^:]*:\s*(\d{2}-\w{3}-\d{2,4})/i);
  if (dateMatch) {
    const parts = dateMatch[1].split("-");
    const day   = parts[0];
    const mon   = parts[1];
    const yr    = parts[2].length === 2 ? "20" + parts[2] : parts[2];
    pageDate    = `${day} ${mon} ${yr}`;
  }

  // Parse individual draw result blocks
  // Look for pattern: draw title + draw number + winning number link
  const drawPattern = /(Morning|Midday|Afternoon|Evening)\s+Draw\s*#(\d+)\s+<a[^>]*additional-marks\/#(\d+)[^>]*>(\d+)\s+(\w+)/gi;
  let match;

  while ((match = drawPattern.exec(html)) !== null) {
    const slot   = match[1];
    const drawNo = parseInt(match[2]);
    const number = parseInt(match[3]);

    if (number >= 1 && number <= 36 && pageDate) {
      results.push({
        date:   pageDate,
        time:   timeMap[slot] || slot,
        draw:   drawNo,
        number: number,
        game:   "pw",
      });
    }
  }

  // Simpler fallback: just look for the anchor pattern
  if (results.length === 0) {
    const simplePattern = /additional-marks\/#(\d+)/gi;
    const drawNums = [];
    let sm;
    while ((sm = simplePattern.exec(html)) !== null) {
      drawNums.push(parseInt(sm[1]));
    }
    // Match with time slots
    const slotPattern = /(Morning|Midday|Afternoon|Evening)/gi;
    const slots = [];
    let slm;
    while ((slm = slotPattern.exec(html)) !== null) {
      slots.push(slm[1]);
    }
    const drawNumPattern = /Draw\s*#(\d+)/gi;
    const drawNumbers = [];
    let dnm;
    while ((dnm = drawNumPattern.exec(html)) !== null) {
      drawNumbers.push(parseInt(dnm[1]));
    }

    for (let i = 0; i < Math.min(slots.length, drawNums.length, drawNumbers.length); i++) {
      if (drawNums[i] >= 1 && drawNums[i] <= 36 && pageDate) {
        results.push({
          date:   pageDate,
          time:   timeMap[slots[i]] || slots[i],
          draw:   drawNumbers[i],
          number: drawNums[i],
          game:   "pw",
        });
      }
    }
  }

  return results;
}

function parseCashPotPage(html) {
  const results = [];

  const timeMap = {
    "Morning": "10:00 AM",
    "Midday":  "1:00 PM",
    "Evening": "7:00 PM",
  };

  let pageDate = null;
  const dateMatch = html.match(/Cash Pot Results for[^:]*:\s*(\d{2}-\w{3}-\d{2,4})/i)
    || html.match(/Results for[^:]*:\s*(\d{2}-\w{3}-\d{2,4})/i);
  if (dateMatch) {
    const parts = dateMatch[1].split("-");
    pageDate = `${parts[0]} ${parts[1]} ${parts[2].length===2?"20"+parts[2]:parts[2]}`;
  }

  const drawPattern = /(Morning|Midday|Evening)\s+Draw\s*#(\d+)[^]*?additional-marks\/#(\d+)/gi;
  let match;
  while ((match = drawPattern.exec(html)) !== null) {
    const number = parseInt(match[3]);
    if (number >= 1 && number <= 36 && pageDate) {
      results.push({
        date:   pageDate,
        time:   timeMap[match[1]] || match[1],
        draw:   parseInt(match[2]),
        number: number,
        game:   "cp",
      });
    }
  }

  return results;
}

function parseLottoPage(html) {
  const results = [];

  let pageDate = null;
  const dateMatch = html.match(/Lotto[^:]*Results for[^:]*:\s*(\d{2}-\w{3}-\d{2,4})/i)
    || html.match(/Results for[^:]*:\s*(\d{2}-\w{3}-\d{2,4})/i);
  if (dateMatch) {
    const parts = dateMatch[1].split("-");
    pageDate = `${parts[0]} ${parts[1]} ${parts[2].length===2?"20"+parts[2]:parts[2]}`;
  }

  // Lotto: 5 numbers + powerball
  const drawPattern = /Draw\s*#(\d+)[^]*?(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})[^]*?Powerball[^\d]*(\d{1,2})/gi;
  let match;
  while ((match = drawPattern.exec(html)) !== null) {
    const nums = [2,3,4,5,6].map(i => parseInt(match[i])).filter(n => n >= 1 && n <= 35);
    const pb   = parseInt(match[7]);
    if (nums.length === 5 && pageDate) {
      results.push({
        date:    pageDate,
        time:    "8:30 PM",
        draw:    parseInt(match[1]),
        numbers: nums,
        power:   pb,
        game:    "lotto",
      });
    }
  }

  return results;
}

// ── MAIN BACKFILL ────────────────────────────────────────────
async function getCurrentDrawNumber() {
  console.log("Fetching current draw number...");
  const html = await fetchMonthPage(0, 0, BASE_URL); // fetch current page
  const match = html?.match(/Draw\s*#(\d+)/i);
  if (match) {
    return parseInt(match[1]);
  }
  // Fallback: Draw #27031 was seen on 7 Jun 2026
  // Estimate: 4 draws/day
  const baseDrawNum = 27031;
  const baseDate    = new Date("2026-06-07");
  const today       = new Date();
  const daysDiff    = Math.floor((today - baseDate) / (1000 * 60 * 60 * 24));
  return baseDrawNum + (daysDiff * 4);
}

async function backfillPlayWhe(data) {
  console.log("\n=== BACKFILL: Play Whe ===");

  // Get current draw number
  const currentDraw = await getCurrentDrawNumber();
  console.log(`Current draw: #${currentDraw}`);

  // Calculate how many draws back to go (13 months × 26 days/month × 4 draws/day)
  const drawsBack = MONTHS_BACK * 26 * 4;
  const startDraw = currentDraw - drawsBack;
  console.log(`Fetching draws #${startDraw} to #${currentDraw} (${drawsBack} draws)`);

  // Find already-fetched draw numbers
  const fetched = new Set(data.pw.map(d => d.draw));
  console.log(`Already have ${fetched.size} draws in checkpoint`);

  let fetched_count = 0;
  let error_count   = 0;

  for (let drawNum = currentDraw; drawNum >= startDraw; drawNum--) {
    if (fetched.has(drawNum)) continue;

    const html = await fetchByDrawNumber(drawNum, BASE_URL);
    if (html) {
      const results = parsePlayWhePage(html);
      if (results.length > 0) {
        data.pw.push(...results);
        results.forEach(r => fetched.add(r.draw));
        fetched_count++;
        if (fetched_count % 50 === 0) {
          console.log(`  Progress: ${fetched_count} draws fetched (draw #${drawNum})`);
          saveCheckpoint(data);
        }
      } else {
        // Draw might not exist (holidays, no draw)
        error_count++;
      }
    } else {
      error_count++;
    }

    await sleep(DELAY_MS);

    // Save checkpoint every 100 draws
    if ((fetched_count + error_count) % 100 === 0) {
      saveCheckpoint(data);
    }
  }

  console.log(`Play Whe backfill done: ${fetched_count} draws fetched, ${error_count} errors/gaps`);
  saveCheckpoint(data);
}

async function backfillByMonth(data, game) {
  const baseUrl = game === "cp" ? CP_BASE_URL : LOTTO_BASE_URL;
  const label   = game === "cp" ? "Cash Pot" : "Lotto Plus";
  const parser  = game === "cp" ? parseCashPotPage : parseLottoPage;
  const key     = game === "cp" ? "cp" : "lotto";

  console.log(`\n=== BACKFILL: ${label} ===`);

  const today   = new Date();
  const fetched = new Set(data[key].map(d => `${d.date}-${d.draw}`));

  for (let m = 0; m <= MONTHS_BACK; m++) {
    const dt    = new Date(today.getFullYear(), today.getMonth() - m, 1);
    const month = dt.getMonth() + 1;
    const year  = dt.getFullYear();
    const label2 = `${MONTH_NAMES[dt.getMonth()]} ${year}`;

    console.log(`  Fetching ${label2}...`);

    const html    = await fetchMonthPage(month, year, baseUrl);
    if (html) {
      const results = parser(html);
      const newOnes = results.filter(r => !fetched.has(`${r.date}-${r.draw}`));
      data[key].push(...newOnes);
      newOnes.forEach(r => fetched.add(`${r.date}-${r.draw}`));
      console.log(`    Got ${newOnes.length} new draws`);
    }

    await sleep(DELAY_MS * 2);
  }

  console.log(`${label} backfill done: ${data[key].length} total draws`);
  saveCheckpoint(data);
}

async function uploadToNetlify(data) {
  const token  = process.env.NETLIFY_TOKEN;
  const siteId = process.env.NETLIFY_SITE_ID;

  if (!token || !siteId) {
    console.log("\n[Upload] NETLIFY_TOKEN or NETLIFY_SITE_ID not set.");
    console.log("  Data saved locally to:", CHECKPOINT_FILE);
    console.log("  To upload manually, run:");
    console.log("  NETLIFY_TOKEN=xxx NETLIFY_SITE_ID=xxx node scripts/backfill.mjs --upload-only");
    return;
  }

  console.log("\n[Upload] Uploading to Netlify Blobs...");

  try {
    const { getStore } = await import("@netlify/blobs");
    const store = getStore({
      name:      "lottery-data",
      siteID:    siteId,
      token:     token,
    });

    await store.setJSON("draws", {
      ...data,
      updatedAt: new Date().toISOString(),
    });

    console.log("[Upload] Done! Data is live.");
  } catch (err) {
    console.error("[Upload] Error:", err.message);
    console.log("  Data is saved locally. Try uploading again with --upload-only");
  }
}

// ── ENTRY POINT ─────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  let data = loadCheckpoint();

  if (args.includes("--upload-only")) {
    // Just upload the checkpoint
    await uploadToNetlify(data);
    return;
  }

  if (args.includes("--pw-only")) {
    await backfillPlayWhe(data);
  } else if (args.includes("--cp-only")) {
    await backfillByMonth(data, "cp");
  } else if (args.includes("--lotto-only")) {
    await backfillByMonth(data, "lotto");
  } else {
    // Full backfill
    await backfillPlayWhe(data);
    await backfillByMonth(data, "cp");
    await backfillByMonth(data, "lotto");
  }

  // Sort all draws newest first
  const months = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
  function parseDt(d) {
    const p = d.date.split(" ");
    return new Date(parseInt(p[2]), months[p[1]]||0, parseInt(p[0]));
  }

  data.pw.sort((a,b) => parseDt(b) - parseDt(a) || b.draw - a.draw);
  data.cp.sort((a,b) => parseDt(b) - parseDt(a) || b.draw - a.draw);
  data.lotto.sort((a,b) => parseDt(b) - parseDt(a) || b.draw - a.draw);

  saveCheckpoint(data);

  console.log("\n=== BACKFILL COMPLETE ===");
  console.log(`Play Whe:  ${data.pw.length} draws`);
  console.log(`Cash Pot:  ${data.cp.length} draws`);
  console.log(`Lotto:     ${data.lotto.length} draws`);
  console.log(`Saved to:  ${CHECKPOINT_FILE}`);

  await uploadToNetlify(data);
}

main().catch(console.error);
