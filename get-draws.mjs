/**
 * Lucky TT — Get Draws API
 * GET /api/get-draws
 *
 * Returns all stored draw data as JSON.
 * The app calls this on load to get real data instead of simulated data.
 *
 * Optional query params:
 *   ?game=pw|cp|lotto   — filter to one game
 *   ?days=30            — limit to last N days
 */

import { getStore } from "@netlify/blobs";

export default async function handler(req) {
  const store = getStore("lottery-data");
  const url   = new URL(req.url);
  const game  = url.searchParams.get("game");   // pw | cp | lotto | null
  const days  = parseInt(url.searchParams.get("days")) || 365;

  // CORS — allow your frontend domain
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=300", // cache 5 mins
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const data = await store.get("draws", { type: "json" });

    if (!data) {
      return new Response(JSON.stringify({
        ok: false,
        error: "No data yet. Run the scraper first.",
        pw: [], cp: [], lotto: [],
      }), { headers: corsHeaders });
    }

    // Cut off by days
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const months = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};

    function filterByDays(draws) {
      return draws.filter(d => {
        const parts = d.date.split(" ");
        if (parts.length < 3) return true;
        const dt = new Date(parseInt(parts[2]), months[parts[1]]||0, parseInt(parts[0]));
        return dt >= cutoff;
      });
    }

    const result = {
      ok:        true,
      updatedAt: data.updatedAt,
      pw:        game && game !== "pw"    ? [] : filterByDays(data.pw    || []),
      cp:        game && game !== "cp"    ? [] : filterByDays(data.cp    || []),
      lotto:     game && game !== "lotto" ? [] : filterByDays(data.lotto || []),
    };

    return new Response(JSON.stringify(result), { headers: corsHeaders });

  } catch (err) {
    console.error("[get-draws] Error:", err);
    return new Response(JSON.stringify({
      ok: false,
      error: err.message,
      pw: [], cp: [], lotto: [],
    }), { status: 500, headers: corsHeaders });
  }
}

export const config = {
  path: "/api/get-draws",
};
