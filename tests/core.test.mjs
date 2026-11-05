import { test } from "node:test";
import assert from "node:assert/strict";
import {
  roundIndexAt, roundStartMs, nextRoundStart, hamsterMeters, circumferenceFromTelemetry,
  median, difficultyOf, strideMeters, StepCounter, plausibility, verdict, commentary,
} from "../lib/core.js";

const G = 1_700_000_000_000;
const D = 600_000;

test("round boundaries follow genesis + r * duration", () => {
  assert.equal(roundIndexAt(G, G, D), 0);
  assert.equal(roundIndexAt(G + D - 1, G, D), 0);
  assert.equal(roundIndexAt(G + D, G, D), 1);
  assert.equal(roundIndexAt(G - 1, G, D), null);
  assert.equal(roundStartMs(5, G, D), G + 5 * D);
  assert.deepEqual(nextRoundStart(G + 2.5 * D, G, D), { round: 3, startsAt: G + 3 * D });
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
