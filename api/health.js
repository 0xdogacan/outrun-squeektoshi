// GET /api/health — checks each Sepolia RPC endpoint and the SqueekCore event log.
import { RPC_ENDPOINTS, rpcAt, getCore, ROUND_RECORDED_TOPIC } from "./_lib/chain.js";

export default async function handler(req, res) {
  const core = await getCore().catch((e) => ({ error: e.message }));
  const results = await Promise.all(RPC_ENDPOINTS.slice(0, 1).map(async (url) => {
    const host = new URL(url).host;
    try {
      const head = Number.parseInt(await rpcAt(url, "eth_blockNumber", [], 8000), 16);
      let logs = null;
      if (core.coreAddress) {
        try {
          const l = await rpcAt(url, "eth_getLogs", [{
            address: core.coreAddress, fromBlock: `0x${(head - 2000).toString(16)}`, toBlock: `0x${head.toString(16)}`,
            topics: [ROUND_RECORDED_TOPIC],
          }], 8000);
          logs = `${l.length} RoundRecorded in last 2000 blocks`;
          // Every event SqueekCore emitted recently, by topic, to check the RoundRecorded signature.
          const topics = {};
          for (let i = 0; i < 5; i++) {
            const to = head - i * 2000, from = to - 1999;
            const all = await rpcAt(url, "eth_getLogs", [{ address: core.coreAddress, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }], 8000);
            for (const e of all) {
              const t = e.topics[0];
              topics[t] ??= { count: 0, topicCount: e.topics.length, dataWords: (e.data.length - 2) / 64, lastBlock: 0 };
              topics[t].count += 1;
              topics[t].lastBlock = Math.max(topics[t].lastBlock, Number.parseInt(e.blockNumber, 16));
            }
          }
          logs += ` · all events in last 10000 blocks: ${JSON.stringify(topics)}`;
        } catch (e) { logs = `getLogs failed: ${e.message}`; }
      }
      return { host, ok: true, head, logs };
    } catch (e) {
      return { host, ok: false, error: e.message };
    }
  }));
  res.setHeader("cache-control", "no-store");
  res.status(200).json({ core: core.error ? core : { address: core.coreAddress, source: core.source || "api" }, rpc: results });
}
