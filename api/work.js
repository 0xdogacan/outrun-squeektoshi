// GET /api/work?from=<round>&to=<round>
// Total settled wheel turns between two rounds (inclusive), from SqueekCore's
// RoundRecorded events. Used to cross-check the wheel's size against distances
// shown on the official livestream.

import { recentRounds, getCore } from "./_lib/chain.js";
import { roundStartMs, roundEndMs } from "../lib/core.js";

export default async function handler(req, res) {
  const from = Number(req.query.from);
  const to = Number(req.query.to);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to - from > 2000) {
    res.status(400).json({ error: "Use ?from=<round>&to=<round>." });
    return;
  }
  try {
    const core = await getCore();
    const rounds = (await recentRounds(7)).filter((r) => r.round >= from && r.round <= to);
    const work = rounds.reduce((sum, r) => sum + r.work, 0);
    res.setHeader("cache-control", "public, s-maxage=300");
    res.status(200).json({
      from, to, work, roundsWithWork: rounds.length,
      startsAt: new Date(roundStartMs(from, core.genesisMs, core.durationMs)).toISOString(),
      endsAt: new Date(roundEndMs(to, core.genesisMs, core.durationMs)).toISOString(),
    });
  } catch (err) {
    res.status(503).json({ error: "Unavailable.", detail: String(err?.message || err) });
  }
}
