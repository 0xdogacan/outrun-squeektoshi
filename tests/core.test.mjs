import { test } from "node:test";
import assert from "node:assert/strict";
import {
  roundIndexAt, roundStartMs, nextRoundStart, hamsterMeters, circumferenceFromTelemetry,
  median, difficultyOf, strideMeters, StepCounter, plausibility, verdict, commentary,
} from "../lib/core.js";

const G = 1_700_000_000_000;
const D = 600_000;
const G2 = 1_793_735_400_000;

test("round boundaries follow genesis + r * duration", () => {
  assert.equal(roundIndexAt(G, G, D), 1);
  assert.equal(roundIndexAt(G + D - 1, G, D), 1);
  assert.equal(roundIndexAt(G + D, G, D), 2);
  assert.equal(roundIndexAt(G - 1, G, D), null);
  assert.equal(roundStartMs(5, G, D), G + 4 * D);
  assert.deepEqual(nextRoundStart(G + 2.5 * D, G, D), { round: 4, startsAt: G + 3 * D });
  // Livestream check: round 304 of the 2026-11-04 deployment ended at 01:30 Istanbul time.
  assert.equal(new Date(G2 + 304 * D).toISOString(), "2026-11-05T22:30:00.000Z");
  assert.equal(roundIndexAt(Date.parse("2026-11-05T22:21:12Z"), G2, D), 304);
});

test("hamster distance is work times circumference", () => {
  assert.equal(hamsterMeters(1000, 700), 700);
  assert.equal(hamsterMeters("250", 800), 200);
  assert.equal(hamsterMeters(10, null), null);
});

test("circumference from telemetry rejects nonsense", () => {
  // 60 RPM at 700 mm/s -> 700 mm
  assert.equal(circumferenceFromTelemetry(700, 60000), 700);
  assert.equal(circumferenceFromTelemetry(700, 0), null);
  assert.equal(circumferenceFromTelemetry(50, 60000), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
});

test("difficulty labels", () => {
  assert.equal(difficultyOf(0), "Nap");
  assert.equal(difficultyOf(80), "Stroll");
  assert.equal(difficultyOf(300), "Jog");
  assert.equal(difficultyOf(900), "Zoomies");
});

test("stride uses custom value, then height and cadence", () => {
  assert.equal(strideMeters({ customStrideCm: 80 }), 0.8);
  assert.ok(Math.abs(strideMeters({ heightCm: 200, cadence: 1.5 }) - 0.83) < 1e-9);
  assert.ok(Math.abs(strideMeters({ heightCm: 200, cadence: 3 }) - 1.3) < 1e-9);
});

function simulate(counter, { hz, seconds, amp = 6, rate = 60 }) {
  for (let i = 0; i < seconds * rate; i++) {
    const t = (i * 1000) / rate;
    const z = 9.81 + amp * Math.sin(2 * Math.PI * hz * (t / 1000));
    counter.push(t, 0.2, 0.1, z);
  }
}

test("step counter counts a steady running cadence", () => {
  const c = new StepCounter({ heightCm: 175 });
  simulate(c, { hz: 2.8, seconds: 60 });
  const expected = 2.8 * 60;
  assert.ok(Math.abs(c.steps - expected) <= expected * 0.08, `steps=${c.steps}`);
  assert.ok(c.meters > 0);
});

test("step counter ignores shaking faster than 4 steps per second", () => {
  const c = new StepCounter();
  simulate(c, { hz: 9, seconds: 20 });
  assert.ok(c.steps / 20 <= 4.05, `rate=${c.steps / 20}`);
});

test("step counter ignores a phone lying still", () => {
  const c = new StepCounter();
  simulate(c, { hz: 2, seconds: 30, amp: 0.05 });
  assert.equal(c.steps, 0);
});

test("sensor gaps longer than 30 s mark the run incomplete", () => {
  const c = new StepCounter();
  c.push(0, 0, 0, 9.8);
  c.push(31_000, 0, 0, 9.8);
  assert.equal(c.incomplete(), true);
});

test("plausibility and verdicts", () => {
  assert.equal(plausibility({ meters: 2000, steps: 1500, durationSec: 600 }).ok, true);
  assert.equal(plausibility({ meters: 5000, steps: 1500, durationSec: 600 }).ok, false);
  assert.equal(verdict(500, 0).kind, "asleep");
  assert.equal(verdict(500, 800).winner, "hamster");
  assert.equal(verdict(900, 800).winner, "player");
  assert.equal(verdict(800.5, 800).kind, "tie");
  assert.equal(typeof commentary(verdict(500, 800), 7), "string");
});

test("Supabase URL is normalized from common pastes", async () => {
  const { normalizeSupabaseUrl: n } = await import("../api/_lib/supabase.js");
  assert.equal(n("https://abc.supabase.co/"), "https://abc.supabase.co");
  assert.equal(n("https://abc.supabase.co/rest/v1/"), "https://abc.supabase.co");
  assert.equal(n(" abc.supabase.co "), "https://abc.supabase.co");
  assert.equal(n("https://supabase.com/dashboard/project/abc123/settings/api"), "https://abc123.supabase.co");
});

test("GPS tracker counts a straight run and ignores jitter", async () => {
  const { GpsTracker, haversineMeters } = await import("../lib/core.js");
  const g = new GpsTracker();
  const lat0 = 41.0, lon0 = 29.0, mPerDegLat = 111_195;
  // 300 s at 3 m/s heading north, one fix per second, accuracy 6 m.
  for (let i = 0; i <= 300; i++) g.push(i * 1000, lat0 + (i * 3) / mPerDegLat, lon0, 6);
  assert.ok(Math.abs(g.meters - 900) < 15, `meters=${g.meters}`);
  // Standing still with 5 m of jitter adds nothing meaningful.
  const still = new GpsTracker();
  for (let i = 0; i < 120; i++) still.push(i * 1000, lat0 + ((i % 2) * 4) / mPerDegLat, lon0, 8);
  assert.ok(still.meters < 5, `still=${still.meters}`);
  // A 500 m jump in one second is a glitch.
  const jump = new GpsTracker();
  jump.push(0, lat0, lon0, 5); jump.push(1000, lat0 + 500 / mPerDegLat, lon0, 5);
  assert.equal(jump.meters, 0);
  // Poor fixes are skipped.
  const poor = new GpsTracker();
  poor.push(0, lat0, lon0, 80); poor.push(5000, lat0 + 20 / mPerDegLat, lon0, 80);
  assert.equal(poor.meters, 0);
  assert.ok(Math.abs(haversineMeters({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }) - 111_195) < 10);
});

test("a catch ranks by projected pace; plausibility uses speed", async () => {
  const { rankingMargin, plausibility } = await import("../lib/core.js");
  assert.equal(rankingMargin({ meters: 530, durationSec: 300, hamsterM: 530 }), 530);
  assert.equal(rankingMargin({ meters: 400, durationSec: 600, hamsterM: 530 }), -130);
  assert.equal(plausibility({ meters: 300, steps: 0, durationSec: 30 }).ok, false);
  assert.equal(plausibility({ meters: 530, steps: 0, durationSec: 200 }).ok, true);
});
