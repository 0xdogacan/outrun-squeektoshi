// Server-side reads of Squeekchain: the public API for configuration and live
// telemetry, and Sepolia JSON-RPC for each round's settled work (RoundRecorded).
// Files under api/_lib are helpers; Vercel does not turn them into endpoints.

import { median, circumferenceFromTelemetry } from "../../lib/core.js";
import { supabaseConfigured, sb } from "./supabase.js";

export const API_BASE = process.env.SQUEEKCHAIN_API || "https://api.squeekchain.com";

const RPC_ENDPOINTS = (process.env.SEPOLIA_RPC_URLS ||
  "https://ethereum-sepolia-rpc.publicnode.com,https://sepolia.drpc.org,https://1rpc.io/sepolia,https://ethereum-sepolia.public.blastapi.io")
  .split(",").map((s) => s.trim()).filter(Boolean);

// keccak256("RoundRecorded(uint64,uint64,uint64,uint96,uint32,bytes32)")
// roundId is indexed (topic 1); work, cumulativeWork, cumulativeBlockUnits,
// workPerThousandBlocks and dataHash are the five data words.
export const ROUND_RECORDED_TOPIC = "0x6f7efb5b00900843c192802a77e52da9f18fee1daa04089fc4bf159963c7968c";

const SEPOLIA_BLOCK_SECONDS = 12;

// Small in-memory cache that lives as long as a warm function instance.
const memo = new Map();
async function cached(key, ttlMs, fn) {
  const hit = memo.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = await fn();
  memo.set(key, { value, until: Date.now() + ttlMs });
  return value;
}

async function getJSON(url, timeoutMs = 8000) {
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "Mozilla/5.0 (compatible; HamsterRace/1.0; +https://hamsterrace.xyz)",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

// Fallback when the Squeekchain API refuses server requests: the same public
// values, set as environment variables. settledThroughRound is then unknown and
// settlement is inferred from the RoundRecorded events themselves.
// Defaults: the Sepolia SqueekCore deployment as published by /v1/core on 2026-11-06.
// If Squeekchain redeploys, set the SQUEEKCORE_* variables in Vercel to the new values.
const CORE_DEFAULTS = {
  SQUEEKCORE_ADDRESS: "0xfd6c166d4b8e2962e65746a13e5a0797cd4de0c4",
  SQUEEKCORE_DEPLOYMENT_BLOCK: "12057556",
  SQUEEKCORE_GENESIS_TIMESTAMP: "1793735400",
  SQUEEKCORE_ROUND_DURATION: "600",
};

function coreFromEnv() {
  const e = { ...CORE_DEFAULTS, ...Object.fromEntries(Object.keys(CORE_DEFAULTS).filter((k) => process.env[k]).map((k) => [k, process.env[k]])) };
  const genesisMs = Number(e.SQUEEKCORE_GENESIS_TIMESTAMP) * 1000;
  const durationMs = Number(e.SQUEEKCORE_ROUND_DURATION || 600) * 1000;
  const coreAddress = (e.SQUEEKCORE_ADDRESS || "").toLowerCase();
  const deploymentBlock = Number(e.SQUEEKCORE_DEPLOYMENT_BLOCK);
  if (!(genesisMs > 0) || !/^0x[0-9a-f]{40}$/.test(coreAddress) || !(deploymentBlock > 0)) return null;
  return { genesisMs, durationMs, coreAddress, deploymentBlock, settledThroughRound: -1, source: "env" };
}

export async function getCore() {
  return cached("core", 30_000, async () => {
    let j;
    try {
      j = await getJSON(`${API_BASE}/v1/core`);
    } catch (err) {
      const fallback = coreFromEnv();
      if (fallback) return fallback;
      throw err;
    }
    if (j.status !== "available") throw new Error(`core unavailable: ${j.reason || "unknown"}`);
    const cfg = j.configuration || {};
    const genesisMs = Number(cfg.genesisTimestamp) * 1000;
    const durationMs = Number(cfg.roundDuration || 600) * 1000;
    const coreAddress = j.identities?.core;
    const deploymentBlock = Number(j.chain?.deploymentBlock);
    if (!Number.isFinite(genesisMs) || !coreAddress || !Number.isFinite(deploymentBlock)) {
      throw new Error("core response is missing genesis, address or deployment block");
    }
    return {
      genesisMs,
      durationMs,
      coreAddress: coreAddress.toLowerCase(),
      deploymentBlock,
      settledThroughRound: Number(j.core?.settledThroughRound ?? -1),
    };
  });
}

export async function getStatus() {
  return cached("status", 5_000, () => getJSON(`${API_BASE}/v1/status`));
}

export function liveFromStatus(status) {
  const m = status?.measurement;
  if (!m) return { available: false };
  const fresh = m.freshness === "online";
  return {
    available: true,
    fresh,
    running: fresh && m.coreStatus === "ACTIVE" && Number(m.rpmMilli) > 0,
    coreStatus: m.coreStatus,
    provenance: m.provenance,
    rpm: Number(m.rpmMilli) / 1000,
    speedMmPerSecond: Number(m.speedMmPerSecond),
    observedAt: m.observedAt,
  };
}

let preferredRpc = null;
async function rpc(method, params) {
  const order = preferredRpc ? [preferredRpc, ...RPC_ENDPOINTS.filter((u) => u !== preferredRpc)] : RPC_ENDPOINTS;
  let lastError;
  for (const url of order) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(10_000),
      });
      const j = await res.json();
      if (j.error) throw new Error(j.error.message || "rpc error");
      preferredRpc = url;
      return j.result;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`every Sepolia RPC failed: ${lastError?.message}`);
}

const hex = (n) => `0x${Number(n).toString(16)}`;
const roundTopic = (r) => `0x${BigInt(r).toString(16).padStart(64, "0")}`;

export function decodeRoundRecorded(log) {
  const data = log.data.slice(2);
  const word = (i) => BigInt(`0x${data.slice(i * 64, (i + 1) * 64)}`);
  return {
    round: Number(BigInt(log.topics[1])),
    work: Number(word(0)),
    blockNumber: Number.parseInt(log.blockNumber, 16),
    txHash: log.transactionHash,
  };
}

function isRoundRecorded(log) {
  return Array.isArray(log?.topics) && log.topics.length === 2 &&
    String(log.topics[0]).toLowerCase() === ROUND_RECORDED_TOPIC &&
    /^0x[0-9a-fA-F]{320}$/.test(log.data || "");
}

async function getLogsChunked({ address, fromBlock, toBlock, topics }) {
  const out = [];
  let step = 5000;
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    const end = Math.min(cursor + step - 1, toBlock);
    let logs;
    try {
      logs = await rpc("eth_getLogs", [{ address, fromBlock: hex(cursor), toBlock: hex(end), topics }]);
    } catch (err) {
      if (step > 500) { step = Math.floor(step / 2); continue; }
      throw err;
    }
    for (const log of logs) if (isRoundRecorded(log)) out.push(decodeRoundRecorded(log));
    cursor = end + 1;
  }
  return out;
}

// Settled rounds with work from roughly the last `days` days.
export async function recentRounds(days = 7) {
  return cached(`rounds:${days}`, 60_000, async () => {
    const core = await getCore();
    const head = Number.parseInt(await rpc("eth_blockNumber", []), 16);
    const span = Math.ceil((days * 86400) / SEPOLIA_BLOCK_SECONDS);
    const fromBlock = Math.max(core.deploymentBlock, head - span);
    const rounds = await getLogsChunked({
      address: core.coreAddress, fromBlock, toBlock: head, topics: [ROUND_RECORDED_TOPIC],
    });
    const byRound = new Map();
    for (const r of rounds) byRound.set(r.round, r);
    return [...byRound.values()].filter((r) => r.work > 0).sort((a, b) => b.round - a.round);
  });
}

// One round's official work. Rounds with zero work emit no event, so a round at
// or below SqueekCore's settled frontier with no event settled at zero.
export async function lookupRound(round) {
  const core = await getCore();
  const recent = await recentRounds(7).catch(() => []);
  const hit = recent.find((r) => r.round === round);
  if (hit) return { state: "settled", round, work: hit.work, txHash: hit.txHash };

  const head = Number.parseInt(await rpc("eth_blockNumber", []), 16);
  const logs = await getLogsChunked({
    address: core.coreAddress,
    fromBlock: Math.max(core.deploymentBlock, head - 4000),
    toBlock: head,
    topics: [ROUND_RECORDED_TOPIC, roundTopic(round)],
  });
  if (logs.length) return { state: "settled", round, work: logs[0].work, txHash: logs[0].txHash };
  if (core.settledThroughRound >= round) return { state: "settled", round, work: 0, txHash: null };
  // Batches settle rounds in order, so a later recorded round means this one settled with zero work.
  if (recent.some((r) => r.round > round)) return { state: "settled", round, work: 0, txHash: null };
  return { state: "pending", round };
}

let lastSampleAt = 0;

// Wheel circumference in mm. An operator-set value wins; otherwise the median of
// samples taken from live telemetry (speed / RPM) while the wheel is spinning.
export async function circumference(status) {
  const fixed = Number(process.env.WHEEL_CIRCUMFERENCE_MM);
  if (fixed > 0) return { mm: fixed, source: "configured" };

  const sample = circumferenceFromTelemetry(
    Number(status?.measurement?.speedMmPerSecond),
    Number(status?.measurement?.rpmMilli),
  );
  const fresh = status?.measurement?.freshness === "online" && status?.measurement?.provenance === "hardware";

  if (supabaseConfigured()) {
    if (sample && fresh && Date.now() - lastSampleAt > 60_000) {
      lastSampleAt = Date.now();
      await sb("calibration_samples", { method: "POST", body: [{ circumference_mm: sample }] }).catch(() => {});
    }
    const rows = await cached("calib", 60_000, () =>
      sb("calibration_samples?select=circumference_mm&order=id.desc&limit=200").catch(() => []));
    const mm = median(rows.map((r) => Number(r.circumference_mm)));
    if (mm) return { mm, source: "telemetry", samples: rows.length };
  }
  if (sample && fresh) return { mm: sample, source: "telemetry", samples: 1 };
  return { mm: null, source: "calibrating" };
}
