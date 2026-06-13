/**
 * Lucky TT — Draw Scraper
 * Netlify Scheduled Function
 *
 * Runs automatically after each Play Whe draw:
 *   10:45 AM, 1:15 PM, 4:15 PM, 7:15 PM (TT time = UTC-4)
 *   Cron: "45 14,17,20,23 * * 1-6" in UTC
 *
 * What it does:
 *   1. Fetches today's results from nlcbplaywhelotto.com
 *   2. Parses the draw number, time slot, and winning number
 *   3. Loads existing data from Netlify Blobs
 *   4. Merges new draws (no duplicates)
 *   5. Saves back to Blobs
 *
 * Data is served to the app via the get-draws function.
 */

import { getStore } from "@netlify/blobs";

// ── CONFIG ──────────────────────────────────────────────────
const PW_URL   = "https://www.nlcbplaywhelotto.com/nlcb-play-whe-results/";
const CP_URL   = "https://www.nlcbplaywhelotto.com/nlcb-cashpot-results/";
const LOTTO_URL= "https://www.nlcbplaywhelotto.com/nlcb-lotto-plus-results/";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  "Referer": "https://www.google.com/",
};

// ── PARSERS ─────────────────────────────────────────────────

/**
 * Parse Play Whe results from HTML.
 * The page structure for each draw is:
 *   Morning/Midday/Afternoon/Evening
 *   Draw #NNNNN
 *   [NUMBER MarkName]   ← linked text like "9 Cattle"
 */
function parsePlayWhe(html, dateStr) {
  const draws = [];

  // Match each draw block: time slot + draw number + winning number
  // Pattern: (Morning|Midday|Afternoon|Evening)\s+Draw #(\d+)\s+(\d+)\s+\w+
  const timeMap = {
    "Morning":   "10:30 AM",
    "Midday":    "1:00 PM",
    "Afternoon": "4:00 PM",
    "Evening":   "7:00 PM",
  };

  // Split on hr tags or draw separators
  const sections = html.split(/---|\<hr\>/gi);

  // Look for draw blocks
  const drawPattern = /(Morning|Midday|Afternoon|Evening)[^]*?Draw\s*#(\d+)[^]*?additional-marks\/#(\d+)/gi;
  let match;

  while ((match = drawPattern.exec(html)) !== null) {
    const slot   = match[1];
    const drawNo = parseInt(match[2]);
    const number = parseInt(match[3]);

    if (number >= 1 && number <= 36) {
      draws.push({
        date:   dateStr,
        time:   timeMap[slot] || slot,
        draw:   drawNo,
        number: number,
        game:   "pw",
      });
    }
  }

  return draws;
}

/**
 * Parse Cash Pot results.
 * Cash Pot picks 5 numbers from 1-36 (jackpot) or a single winning number.
 * We capture the main winning number from the draw.
 */
function parseCashPot(html, dateStr) {
  const draws = [];

  const timeMap = {
    "Morning":   "10:00 AM",
    "Midday":    "1:00 PM",
    "Evening":   "7:00 PM",
  };

  const drawPattern = /(Morning|Midday|Evening)[^]*?Draw\s*#(\d+)[^]*?additional-marks\/#(\d+)/gi;
  let match;

  while ((match = drawPattern.exec(html)) !== null) {
    const slot   = match[1];
    const drawNo = parseInt(match[2]);
    const number = parseInt(match[3]);

    if (number >= 1 && number <= 36) {
      draws.push({
        date:   dateStr,
        time:   timeMap[slot] || slot,
        draw:   drawNo,
        number: number,
        game:   "cp",
      });
    }
  }

  return draws;
}

/**
 * Parse Lotto Plus results.
 * Lotto Plus is 5 numbers + powerball from 1-35.
 */
function parseLotto(html, dateStr) {
  const draws = [];

  // Lotto draws on Wed and Sat
  // Pattern: Draw #NNNNN followed by 5 winning numbers and a powerball
  // The page shows something like: 3 7 12 19 28 | PB: 15
  const drawPattern = /Draw\s*#(\d+)[^]*?(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})[^]*?Powerball[^]*?(\d{1,2})/gi;
  let match;

  while ((match = drawPattern.exec(html)) !== null) {
    const drawNo = parseInt(match[1]);
    const nums = [
      parseInt(match[2]),
      parseInt(match[3]),
      parseInt(match[4]),
      parseInt(match[5]),
      parseInt(match[6]),
    ].filter(n => n >= 1 && n <= 35);
    const pb = parseInt(match[7]);

    if (nums.length === 5) {
      draws.push({
        date:    dateStr,
        time:    "8:30 PM",
        draw:    drawNo,
        numbers: nums,
        power:   pb,
        game:    "lotto",
      });
    }
  }

  return draws;
}

// ── DATE HELPER ─────────────────────────────────────────────
function todayTT() {
  // Trinidad is UTC-4 year-round (no DST)
  const now = new Date();
  const tt  = new Date(now.getTime() - (4 * 60 * 60 * 1000));
  const d   = tt.getUTCDate().toString().padStart(2, "0");
  const m   = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][tt.getUTCMonth()];
  const y   = tt.getUTCFullYear();
  return `${d} ${m} ${y}`;   // e.g. "07 Jun 2026"
}

// ── MERGE HELPER ────────────────────────────────────────────
function mergeDraws(existing, fresh) {
  const seen = new Set(existing.map(d =>
    d.game === "lotto"
      ? `${d.date}-lotto-${d.draw}`
      : `${d.date}-${d.time}-${d.game}-${d.draw}`
  ));

  const newOnes = fresh.filter(d => {
    const key = d.game === "lotto"
      ? `${d.date}-lotto-${d.draw}`
      : `${d.date}-${d.time}-${d.game}-${d.draw}`;
    return !seen.has(key);
  });

  // Prepend new draws (most recent first)
  return [...newOnes, ...existing];
}

// ── MAIN HANDLER ────────────────────────────────────────────
export default async function handler(req, context) {
  const store   = getStore("lottery-data");
  const dateStr = todayTT();

  console.log(`[Lucky TT Scraper] Running for ${dateStr}`);

  let pwDraws    = [];
  let cpDraws    = [];
  let lottoDraws = [];

  // ── Fetch Play Whe ──
  try {
    const res  = await fetch(PW_URL, { headers: HEADERS });
    const html = await res.text();
    pwDraws    = parsePlayWhe(html, dateStr);
    console.log(`[PW] Found ${pwDraws.length} draws`);
  } catch (err) {
    console.error("[PW] Fetch error:", err.message);
  }

  // ── Fetch Cash Pot ──
  try {
    const res  = await fetch(CP_URL, { headers: HEADERS });
    const html = await res.text();
    cpDraws    = parseCashPot(html, dateStr);
    console.log(`[CP] Found ${cpDraws.length} draws`);
  } catch (err) {
    console.error("[CP] Fetch error:", err.message);
  }

  // ── Fetch Lotto ──
  try {
    const res  = await fetch(LOTTO_URL, { headers: HEADERS });
    const html = await res.text();
    lottoDraws = parseLotto(html, dateStr);
    console.log(`[Lotto] Found ${lottoDraws.length} draws`);
  } catch (err) {
    console.error("[Lotto] Fetch error:", err.message);
  }

  // ── Load existing stored data ──
  let existing = { pw: [], cp: [], lotto: [] };
  try {
    const raw = await store.get("draws", { type: "json" });
    if (raw) existing = raw;
  } catch (err) {
    console.log("[Store] No existing data yet, starting fresh");
  }

  // ── Merge ──
  const merged = {
    pw:        mergeDraws(existing.pw    || [], pwDraws),
    cp:        mergeDraws(existing.cp    || [], cpDraws),
    lotto:     mergeDraws(existing.lotto || [], lottoDraws),
    updatedAt: new Date().toISOString(),
  };

  // ── Keep only last 18 months of data (to control size) ──
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 18);

  function trimOld(draws) {
    return draws.filter(d => {
      const parts = d.date.split(" ");
      if (parts.length < 3) return true;
      const months = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
      const dt = new Date(parseInt(parts[2]), months[parts[1]] || 0, parseInt(parts[0]));
      return dt >= cutoff;
    });
  }

  merged.pw    = trimOld(merged.pw);
  merged.cp    = trimOld(merged.cp);
  merged.lotto = trimOld(merged.lotto);

  // ── Save ──
  await store.setJSON("draws", merged);

  console.log(`[Lucky TT Scraper] Saved — PW: ${merged.pw.length}, CP: ${merged.cp.length}, Lotto: ${merged.lotto.length}`);

  return new Response(JSON.stringify({
    ok: true,
    date: dateStr,
    newPW: pwDraws.length,
    newCP: cpDraws.length,
    newLotto: lottoDraws.length,
  }), {
    headers: { "Content-Type": "application/json" },
  });
}

// Netlify cron schedule — runs at 14:45, 17:15, 20:15, 23:15 UTC
// = 10:45 AM, 1:15 PM, 4:15 PM, 7:15 PM Trinidad time
export const config = {
  schedule: "*/30 * * * *",
};
