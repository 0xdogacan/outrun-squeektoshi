// Shared, dependency-free logic for Hamster Race.
// Imported by the browser (as /lib/core.js) and by the Vercel functions in /api.

export const ROUND_SECONDS_DEFAULT = 600;

// Squeekchain rounds are fixed windows counted from SqueekCore's genesisTimestamp.
// Round ids start at 1: round r covers [genesis + (r - 1) * duration, genesis + r * duration).
// (Checked against the official livestream overlay: round 304 ended at genesis + 304 * 600 s.)
export function roundIndexAt(nowMs, genesisMs, durationMs) {
  if (!(durationMs > 0) || nowMs < genesisMs) return null;
  return Math.floor((nowMs - genesisMs) / durationMs) + 1;
}

export function roundStartMs(round, genesisMs, durationMs) {
  return genesisMs + (round - 1) * durationMs;
}

export function roundEndMs(round, genesisMs, durationMs) {
  return genesisMs + round * durationMs;
}

export function nextRoundStart(nowMs, genesisMs, durationMs) {
  const r = roundIndexAt(nowMs, genesisMs, durationMs);
  if (r === null) return { round: 1, startsAt: genesisMs };
  return { round: r + 1, startsAt: roundStartMs(r + 1, genesisMs, durationMs) };
}

// One accepted magnet passage = one work unit = one wheel revolution.
export function hamsterMeters(work, circumferenceMm) {
  if (!(circumferenceMm > 0)) return null;
  return (Number(work) * circumferenceMm) / 1000;
}

// Circumference from one live telemetry reading: speed (mm/s) * 60 / RPM.
export function circumferenceFromTelemetry(speedMmPerSecond, rpmMilli) {
  if (!(rpmMilli > 0) || !(speedMmPerSecond > 0)) return null;
  const c = (speedMmPerSecond * 60000) / rpmMilli;
  // Hamster wheels are roughly 15-40 cm across; anything else is a bad reading.
  return c >= 400 && c <= 1300 ? c : null;
}

export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export function difficultyOf(work) {
  const w = Number(work);
  if (w <= 0) return "Nap";
  if (w < 150) return "Stroll";
  if (w < 500) return "Jog";
  return "Zoomies";
}

// Default stride from height, switched by cadence (steps per second).
export function strideMeters({ heightCm, customStrideCm, cadence }) {
  if (customStrideCm > 0) return customStrideCm / 100;
  const h = heightCm > 0 ? heightCm : 170;
  return (cadence >= 2.3 ? 0.65 : 0.415) * (h / 100);
}

// Step detection from accelerometer samples (m/s^2, gravity included).
// Low-pass gravity estimate, smoothed dynamic signal, hysteresis peak detection,
// and a minimum gap between steps so shaking faster than 4 steps/s is ignored.
export class StepCounter {
  constructor({ heightCm = 170, customStrideCm = 0, minIntervalMs = 250, gapMs = 30000 } = {}) {
    this.heightCm = heightCm;
    this.customStrideCm = customStrideCm;
    this.minIntervalMs = minIntervalMs;
    this.gapMs = gapMs;
    this.reset();
  }

  reset() {
    this.steps = 0;
    this.meters = 0;
    this.gravity = null;
    this.smooth = 0;
    this.armed = true;
    this.lastStepAt = -Infinity;
    this.lastSampleAt = null;
    this.stepTimes = [];
    this.peakAvg = 2.5;
    this.longestGapMs = 0;
    this.rejected = 0;
  }

  cadence(now) {
    const recent = this.stepTimes.filter((t) => now - t <= 4000);
    return recent.length / 4;
  }

  push(t, ax, ay, az) {
    if (![ax, ay, az].every(Number.isFinite)) return false;
    if (this.lastSampleAt !== null) {
      this.longestGapMs = Math.max(this.longestGapMs, t - this.lastSampleAt);
    }
    this.lastSampleAt = t;
    const mag = Math.sqrt(ax * ax + ay * ay + az * az);
    this.gravity = this.gravity === null ? mag : this.gravity * 0.9 + mag * 0.1;
    this.smooth = this.smooth * 0.6 + (mag - this.gravity) * 0.4;

    const high = Math.max(1.0, this.peakAvg * 0.45);
    const low = high * 0.3;
    if (!this.armed && this.smooth < low) this.armed = true;
    if (this.armed && this.smooth > high) {
      this.armed = false;
      if (t - this.lastStepAt < this.minIntervalMs) {
        this.rejected += 1;
        return false;
      }
      this.peakAvg = this.peakAvg * 0.8 + Math.min(this.smooth, 15) * 0.2;
      this.lastStepAt = t;
      this.stepTimes.push(t);
      if (this.stepTimes.length > 64) this.stepTimes.shift();
      this.steps += 1;
      this.meters += strideMeters({
        heightCm: this.heightCm,
        customStrideCm: this.customStrideCm,
        cadence: this.cadence(t),
      });
      return true;
    }
    return false;
  }

  incomplete() {
    return this.longestGapMs > this.gapMs;
  }
}

// About the 10 km world-record pace held for 10 minutes; faster is not a human run.
export const MAX_PLAUSIBLE_METERS = 3800;

export function plausibility({ meters, steps, durationSec }) {
  const reasons = [];
  if (meters > MAX_PLAUSIBLE_METERS) reasons.push("faster_than_world_record");
  if (durationSec > 0 && steps / durationSec > 4) reasons.push("cadence_over_4");
  return { ok: reasons.length === 0, reasons };
}

export function verdict(playerMeters, hamsterMetersValue) {
  const margin = playerMeters - hamsterMetersValue;
  if (hamsterMetersValue === 0) return { winner: "player", kind: "asleep", margin };
  if (Math.abs(margin) < 1) return { winner: "tie", kind: "tie", margin };
  return { winner: margin > 0 ? "player" : "hamster", kind: margin > 0 ? "win" : "loss", margin };
}

const LINES = {
  win: [
    "Squeektoshi has been notified. He is not taking it well.",
    "A hamster just lost to a human. Ethereum will remember this.",
    "You beat the only miner with whiskers.",
  ],
  loss: [
    "A hamster with legs the size of a matchstick did this.",
    "Squeektoshi mined blocks and still beat you.",
    "Proof of Work: his. Proof of Rest: yours.",
  ],
  close: [
    "Photo finish. Somewhere, a wheel is still spinning.",
    "One more round and it is yours. Or his.",
  ],
  asleep: ["You beat a sleeping hamster. It counts. Barely."],
  tie: ["A dead heat with a rodent. Respect."],
};

// Deterministic pick so a result always shows the same line.
export function commentary(v, seed = 0) {
  let pool = LINES[v.kind] || LINES.loss;
  if ((v.kind === "win" || v.kind === "loss") && Math.abs(v.margin) < 25) pool = LINES.close;
  return pool[Math.abs(Math.floor(seed)) % pool.length];
}

export function formatMeters(m) {
  if (!Number.isFinite(m)) return "—";
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}
