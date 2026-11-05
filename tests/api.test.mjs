// API tests with a fake network: the Squeekchain API, Sepolia RPC and Supabase are mocked.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const GENESIS_S = 1_762_000_000;
const CORE = "0x980b4424c007caf7a1f3670b48c8eaef7ebc3d44";
const TOPIC = "0x6f7efb5b00900843c192802a77e52da9f18fee1daa04089fc4bf159963c7968c";
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const log = (round, work, tx) => ({
  topics: [TOPIC, `0x${word(round)}`],
  data: `0x${word(work)}${word(1)}${word(2)}${word(3)}${word(4)}`,
  blockNumber: "0x10",
  transactionHash: tx,
});

let settledThrough = 100;
let logs = [log(90, 820, "0xaaa"), log(95, 40, "0xbbb")];
let inserted = [];

globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  const json = (body, status = 200) => ({
    ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body),
  });
  if (url.endsWith("/v1/core")) {
    return json({
      status: "available",
      configuration: { genesisTimestamp: String(GENESIS_S), roundDuration: "600" },
      identities: { core: CORE },
      chain: { deploymentBlock: "1" },
      core: { settledThroughRound: String(settledThrough) },
    });
  }
  if (url.endsWith("/v1/status")) {
    return json({ measurement: { freshness: "online", provenance: "hardware", coreStatus: "ACTIVE", rpmMilli: 60000, speedMmPerSecond: 700 } });
  }
  if (url.includes("supabase.test")) {
    if (opts.method === "POST" && url.includes("/runs")) {
      inserted.push(JSON.parse(opts.body)[0]);
      return json(null, 201);
    }
    return json([]);
  }
  // Sepolia JSON-RPC
  const body = JSON.parse(opts.body);
  if (body.method === "eth_blockNumber") return json({ result: "0x100" });
  if (body.method === "eth_getLogs") {
    const want = body.params[0].topics[1];
    return json({ result: want ? logs.filter((l) => l.topics[1] === want) : logs });
  }
  throw new Error(`unexpected fetch ${url}`);
};

process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";

const { default: rounds } = await import("../api/rounds.js");
const { default: round } = await import("../api/round.js");
const { default: scores } = await import("../api/scores.js");

function call(handler, { method = "GET", query = {}, body } = {}) {
  return new Promise((resolve) => {
    const res = {
      headers: {}, code: 200,
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.code = c; return this; },
      json(b) { resolve({ code: this.code, body: b, headers: this.headers }); },
    };
    handler({ method, query, body }, res);
  });
}

beforeEach(() => { inserted = []; });

test("/api/rounds lists ghosts with distance from calibration", async () => {
  const r = await call(rounds);
  assert.equal(r.code, 200);
  assert.equal(r.body.circumference.mm, 700);
  assert.deepEqual(r.body.ghosts.map((g) => g.round), [95, 90]);
  assert.equal(r.body.ghosts[1].meters, 574);
  assert.equal(r.body.ghostOfTheWeek.round, 90);
  assert.equal(r.body.ghostOfTheWeek.difficulty, "Zoomies");
  assert.equal(r.body.ghosts[0].startsAt, (GENESIS_S + 94 * 600) * 1000);
});

test("/api/round: settled, zero-work and pending", async () => {
  assert.equal((await call(round, { query: { r: "90" } })).body.work, 820);
  const zero = await call(round, { query: { r: "99" } });
  assert.equal(zero.body.state, "settled");
  assert.equal(zero.body.work, 0);
  const pending = await call(round, { query: { r: "101" } });
  assert.equal(pending.body.state, "pending");
});

test("/api/scores recomputes the hamster side and flags impossible runs", async () => {
  const base = { mode: "ghost", round: 90, nickname: "Doğa", steps: 1500, durationSec: 600, deviceId: "d".repeat(24) };
  const ok = await call(scores, { method: "POST", body: { ...base, meters: 600 } });
  assert.equal(ok.code, 201);
  assert.equal(inserted[0].hamster_m, 574);
  assert.equal(inserted[0].margin_m, 26);
  assert.equal(inserted[0].flagged, false);

  const fake = await call(scores, { method: "POST", body: { ...base, round: 95, meters: 9000 } });
  assert.equal(fake.code, 201);
  assert.equal(inserted[1].flagged, true);

  const short = await call(scores, { method: "POST", body: { ...base, durationSec: 300, meters: 100 } });
  assert.equal(short.code, 422);

  const ghostZero = await call(scores, { method: "POST", body: { ...base, round: 99, meters: 100 } });
  assert.equal(ghostZero.code, 422);
});
