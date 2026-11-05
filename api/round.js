// GET /api/round?r=<round>
// The official (settled) result of one round, or { state: "pending" }.

import { lookupRound, getCore, getStatus, circumference } from "./_lib/chain.js";
import { hamsterMeters } from "../lib/core.js";

export default async function handler(req, res) {
  const round = Number(req.query.r);
  if (!Number.isInteger(round) || round < 0) {
    res.status(400).json({ error: "Missing or invalid round." });
    return;
  }
  try {
    const core = await getCore();
    const endsAt = core.genesisMs + (round + 1) * core.durationMs;
    if (Date.now() < endsAt) {
      res.setHeader("cache-control", "no-store");
      res.status(200).json({ state: "running", round, endsAt });
      return;
    }
    const result = await lookupRound(round);
    if (result.state === "pending") {
      res.setHeader("cache-control", "no-store");
      res.status(200).json({ ...result, endsAt });
      return;
    }
    const calib = await circumference(await getStatus().catch(() => null));
    res.setHeader("cache-control", "public, s-maxage=3600");
    res.status(200).json({ ...result, endsAt, meters: hamsterMeters(result.work, calib.mm), circumference: calib });
  } catch (err) {
    console.error(err);
    res.setHeader("cache-control", "no-store");
    res.status(503).json({ error: "Could not reach Squeekchain. Try again shortly." });
  }
}
