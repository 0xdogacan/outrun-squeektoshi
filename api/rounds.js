// GET /api/rounds
// Round clock, live wheel state, wheel calibration and the list of ghost rounds.

import { getCore, getStatus, liveFromStatus, recentRounds, circumference } from "./_lib/chain.js";
import { hamsterMeters, difficultyOf } from "../lib/core.js";

export default async function handler(req, res) {
  try {
    const core = await getCore();
    const status = await getStatus().catch(() => null);
    const calib = await circumference(status);
    let rounds = [];
    let roundsError = null;
    try {
      rounds = await recentRounds(7);
    } catch (err) {
      roundsError = `Round history is unavailable right now. (${err?.message || err})`;
      console.error(err);
    }

    const ghosts = rounds.slice(0, 60).map((r) => ({
      round: r.round,
      work: r.work,
      meters: hamsterMeters(r.work, calib.mm),
      difficulty: difficultyOf(r.work),
      startsAt: core.genesisMs + r.round * core.durationMs,
      txHash: r.txHash,
    }));
    const weekBest = rounds.reduce((best, r) => (!best || r.work > best.work ? r : best), null);

    res.setHeader("cache-control", "public, s-maxage=60, stale-while-revalidate=300");
    res.status(200).json({
      now: Date.now(),
      clock: { genesisMs: core.genesisMs, durationMs: core.durationMs },
      coreAddress: core.coreAddress,
      settledThroughRound: core.settledThroughRound,
      live: liveFromStatus(status),
      circumference: calib,
      ghosts,
      ghostOfTheWeek: weekBest && {
        round: weekBest.round,
        work: weekBest.work,
        meters: hamsterMeters(weekBest.work, calib.mm),
        difficulty: difficultyOf(weekBest.work),
        startsAt: core.genesisMs + weekBest.round * core.durationMs,
        txHash: weekBest.txHash,
      },
      roundsError,
    });
  } catch (err) {
    console.error(err);
    res.setHeader("cache-control", "no-store");
    res.status(503).json({ error: "Squeekchain is unavailable right now.", detail: String(err?.message || err) });
  }
}
