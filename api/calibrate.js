// POST /api/calibrate { distanceMm, cumulativeWorkUnits, speedMmPerSecond, rpmMilli }
// Visitors' browsers can read Squeekchain's live telemetry even when the server
// is refused, so they report readings here while the wheel spins. The server
// recomputes the circumference itself, rejects implausible values and, once a few
// samples exist, anything more than 15% away from the current median.

import { supabaseConfigured, sb } from "./_lib/supabase.js";
import { circumferenceFromTelemetry, circumferenceFromOdometer, median } from "../lib/core.js";

let lastAcceptedAt = 0;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    res.status(405).json({ error: "Method not allowed." });
    return;
  }
  if (!supabaseConfigured() || Number(process.env.WHEEL_CIRCUMFERENCE_MM) > 0) {
    res.status(200).json({ ok: true, stored: false });
    return;
  }
  try {
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const odometer = circumferenceFromOdometer(b.distanceMm, b.cumulativeWorkUnits);
    const live = Number(b.rpmMilli) >= 10000 ? circumferenceFromTelemetry(Number(b.speedMmPerSecond), Number(b.rpmMilli)) : null;
    const mm = odometer || live;
    if (!mm) {
      res.status(422).json({ error: "Not a usable reading." });
      return;
    }
    const rows = await sb("calibration_samples?select=circumference_mm&order=id.desc&limit=200");
    const current = median(rows.map((r) => Number(r.circumference_mm)));
    if (rows.length >= 5 && Math.abs(mm - current) / current > 0.15) {
      res.status(422).json({ error: "Reading is far from the calibrated value." });
      return;
    }
    // At most one stored sample every 20 s across all visitors on this instance.
    if (Date.now() - lastAcceptedAt < 20_000) {
      res.status(200).json({ ok: true, stored: false });
      return;
    }
    lastAcceptedAt = Date.now();
    await sb("calibration_samples", { method: "POST", body: [{ circumference_mm: mm }], prefer: "return=minimal" });
    res.status(201).json({ ok: true, stored: true, mm, samples: rows.length + 1 });
  } catch (err) {
    console.error(err);
    res.status(503).json({ error: "Calibration is unavailable right now." });
  }
}
