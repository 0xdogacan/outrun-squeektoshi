import { test } from "node:test";
import assert from "node:assert/strict";

let stored = [];
globalThis.fetch = async (url, opts = {}) => {
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  if (opts.method === "POST") { stored.unshift(...JSON.parse(opts.body)); return json(null, 201); }
  return json(stored.slice(0, 200));
};
process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
delete process.env.WHEEL_CIRCUMFERENCE_MM;

const { default: calibrate } = await import("../api/calibrate.js");
const call = (body) => new Promise((resolve) => {
  const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
  calibrate({ method: "POST", body }, res);
});

test("stores a plausible reading from the browser", async () => {
  const r = await call({ speedMmPerSecond: 700, rpmMilli: 60000 });
  assert.equal(r.code, 201);
  assert.equal(stored[0].circumference_mm, 700);
});

test("rejects nonsense and slow-wheel readings", async () => {
  assert.equal((await call({ speedMmPerSecond: 50, rpmMilli: 60000 })).code, 422);
  assert.equal((await call({ speedMmPerSecond: 70, rpmMilli: 6000 })).code, 422);
});

test("rejects outliers once a few samples exist", async () => {
  stored = Array.from({ length: 6 }, () => ({ circumference_mm: 700 }));
  // 1100 mm is in the plausible range but 57% away from the median.
  assert.equal((await call({ speedMmPerSecond: 1100, rpmMilli: 60000 })).code, 422);
});
