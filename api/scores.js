// GET  /api/scores?mode=ghost|live&period=day|week|all  -> leaderboard
// POST /api/scores  { mode, round, nickname, meters, steps, durationSec, deviceId, incomplete }
// The server re-reads the hamster's settled work itself; it never trusts the client's hamster numbers.

import { lookupRound, getCore, getStatus, circumference } from "./_lib/chain.js";
import { supabaseConfigured, sb } from "./_lib/supabase.js";
import { hamsterMeters, plausibility, roundEndMs, rankingMargin } from "../lib/core.js";

const PERIODS = { day: 86400e3, week: 7 * 86400e3 };
const COLUMNS = "nickname,mode,round,player_m,hamster_m,margin_m,duration_s,created_at";

function cleanNickname(s) {
  const t = String(s || "").normalize("NFKC").replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 20);
  return t.length >= 2 ? t : null;
}

export default async function handler(req, res) {
  if (!supabaseConfigured()) {
    res.status(503).json({ error: "The leaderboard is not set up yet." });
    return;
  }
  try {
    if (req.method === "GET") return await list(req, res);
    if (req.method === "POST") return await submit(req, res);
    res.setHeader("allow", "GET, POST");
    res.status(405).json({ error: "Method not allowed." });
  } catch (err) {
    console.error(err);
    res.status(503).json({ error: "The leaderboard is unavailable right now.", detail: String(err?.message || err) });
  }
}

async function list(req, res) {
  const mode = req.query.mode === "live" ? "live" : "ghost";
  const period = PERIODS[req.query.period] ? req.query.period : req.query.period === "all" ? "all" : "week";
  let q = `runs?select=${COLUMNS}&mode=eq.${mode}&flagged=is.false&asleep=is.false&order=margin_m.desc&limit=50`;
  if (period !== "all") q += `&created_at=gte.${new Date(Date.now() - PERIODS[period]).toISOString()}`;
  const rows = await sb(q);
  const beaten = await sb(`runs?select=id&flagged=is.false&asleep=is.false&margin_m=gt.0&limit=10000`);
  res.setHeader("cache-control", "public, s-maxage=20, stale-while-revalidate=60");
  res.status(200).json({ mode, period, rows, humansWhoWon: beaten.length });
}

async function submit(req, res) {
  const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const mode = b.mode === "live" ? "live" : b.mode === "ghost" ? "ghost" : null;
  const round = Number(b.round);
  const nickname = cleanNickname(b.nickname);
  const meters = Number(b.meters);
  const steps = Math.round(Number(b.steps));
  const durationSec = Math.round(Number(b.durationSec));
  const deviceId = String(b.deviceId || "").slice(0, 64);

  if (!mode || !Number.isInteger(round) || !nickname || !(meters >= 0) || !(steps >= 0) ||
      !(durationSec > 0) || deviceId.length < 16) {
    res.status(400).json({ error: "Invalid submission." });
    return;
  }
  if (b.incomplete || durationSec > 605 || (mode === "live" && durationSec < 590)) {
    res.status(422).json({ error: "Only complete runs go on the leaderboard." });
    return;
  }

  const core = await getCore();
  const endsAt = roundEndMs(round, core.genesisMs, core.durationMs);
  if (mode === "live" && (Date.now() < endsAt || Date.now() - endsAt > 6 * 3600e3)) {
    res.status(422).json({ error: "Live results must be sent within 6 hours of the round." });
    return;
  }

  const official = await lookupRound(round);
  if (official.state !== "settled") {
    res.status(409).json({ error: "The hamster's result is not settled yet." });
    return;
  }
  if (mode === "ghost" && official.work === 0) {
    res.status(422).json({ error: "That round has no work to race." });
    return;
  }
  const calib = await circumference(await getStatus().catch(() => null));
  if (!calib.mm) {
    res.status(503).json({ error: "The wheel is still being calibrated." });
    return;
  }

  const hamsterM = hamsterMeters(official.work, calib.mm);
  // A ghost race shorter than 10 minutes must have ended by reaching his distance.
  const caught = mode === "ghost" && durationSec < 590;
  if (caught && meters < hamsterM * 0.98) {
    res.status(422).json({ error: "A ghost race ends at 10 minutes or when you reach his distance." });
    return;
  }
  const check = plausibility({ meters, steps, durationSec });
  const margin = rankingMargin({ meters, durationSec, hamsterM, roundSec: 600 });
  const row = {
    mode, round, nickname, device_id: deviceId,
    player_m: meters, steps, duration_s: durationSec,
    hamster_work: official.work, hamster_m: hamsterM, margin_m: margin,
    circumference_mm: calib.mm,
    flagged: !check.ok, flag_reasons: check.reasons, asleep: official.work === 0,
  };
  try {
    await sb("runs", { method: "POST", body: [row], prefer: "return=minimal" });
  } catch (err) {
    if (err.status === 409) {
      res.status(409).json({ error: "This device already has a result for this round." });
      return;
    }
    throw err;
  }
  res.status(201).json({ ok: true, flagged: row.flagged, reasons: check.reasons, hamsterM, marginM: row.margin_m });
}
