// When the Squeekchain API refuses the server (HTTP 403), the env config and the
// RoundRecorded events alone must still drive ghosts and results.
import { test } from "node:test";
import assert from "node:assert/strict";

const TOPIC = "0x6f7efb5b00900843c192802a77e52da9f18fee1daa04089fc4bf159963c7968c";
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const log = (round, work) => ({
  topics: [TOPIC, `0x${word(round)}`],
  data: `0x${word(work)}${word(1)}${word(2)}${word(3)}${word(4)}`,
  blockNumber: "0x10", transactionHash: "0xabc",
});
const logs = [log(90, 820), log(95, 40)];

globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  if (url.includes("api.squeekchain.com")) return json({ error: "forbidden" }, 403);
  const body = JSON.parse(opts.body);
  if (body.method === "eth_blockNumber") return json({ result: "0x100" });
  const want = body.params[0].topics[1];
  return json({ result: want ? logs.filter((l) => l.topics[1] === want) : logs });
};

process.env.SQUEEKCORE_ADDRESS = "0x980b4424c007caf7a1f3670b48c8eaef7ebc3d44";
process.env.SQUEEKCORE_DEPLOYMENT_BLOCK = "1";
process.env.SQUEEKCORE_GENESIS_TIMESTAMP = "1762000000";
process.env.WHEEL_CIRCUMFERENCE_MM = "700";

const { lookupRound, getCore } = await import("../api/_lib/chain.js");
const { default: rounds } = await import("../api/rounds.js");

function call(handler, query = {}) {
  return new Promise((resolve) => {
    const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
    handler({ method: "GET", query }, res);
  });
}

test("core falls back to environment values", async () => {
  const core = await getCore();
  assert.equal(core.source, "env");
  assert.equal(core.genesisMs, 1762000000000);
});

test("ghosts still load without the Squeekchain API", async () => {
  const r = await call(rounds);
  assert.equal(r.code, 200);
  assert.equal(r.body.ghosts.length, 2);
  assert.equal(r.body.circumference.source, "configured");
  assert.equal(r.body.live.available, false);
});

test("zero-work rounds are inferred from later recorded rounds", async () => {
  assert.deepEqual(await lookupRound(92), { state: "settled", round: 92, work: 0, txHash: null });
  assert.equal((await lookupRound(96)).state, "pending");
  assert.equal((await lookupRound(95)).work, 40);
});
