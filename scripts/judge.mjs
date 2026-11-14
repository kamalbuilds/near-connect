#!/usr/bin/env node
// One command that proves the hosted demo on a clean machine: live page, configured judge account, chain relay,
// a real testnet send read back from an independent RPC, and the evidence transactions in COMPANY.md.
const BASE = process.env.SCREEN_URL ?? "https://near-screen.nearbuild.workers.dev";
const RPCS = ["https://near-testnet.drpc.org", "https://archival-rpc.testnet.fastnear.com"];
const checks = [];
const check = async (name, run) => {
  try {
    const detail = await run();
    checks.push([name, true, detail]);
  } catch (error) {
    checks.push([name, false, error.message]);
  }
};
const rpc = async (method, params) => {
  let last;
  for (const url of RPCS) {
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20000) });
      const body = await response.json();
      if (body.result) return body.result;
      last = new Error(JSON.stringify(body.error).slice(0, 160));
    } catch (error) {
      last = error;
    }
  }
  throw last;
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const post = (path, body) => fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

let config;
await check("page serves the Screen demo", async () => {
  const html = await (await fetch(BASE + "/")).text();
  assert(html.includes("<title>Screen for NEAR Connect</title>"), "title missing");
  assert(html.includes('src="/app.js"'), "bundle missing");
  return BASE;
});
await check("bundle includes the connector screen code", async () => {
  const js = await (await fetch(BASE + "/app.js")).text();
  assert(js.includes("ScreenBlockedError") && js.includes("Transaction warning"), "screen code missing from bundle");
  return `${js.length} bytes`;
});
await check("judge account is configured", async () => {
  config = await (await fetch(BASE + "/api/config")).json();
  assert(config.configured && config.network === "testnet", JSON.stringify(config));
  return config.signer;
});
await check("same-origin relay reads testnet", async () => {
  const response = await post("/api/rpc", { method: "status", params: [] });
  const body = await response.json();
  assert(body.result?.chain_id === "testnet", "relay did not reach testnet");
  return `chain ${body.result.chain_id}`;
});
await check("unrelayed RPC methods are refused", async () => {
  const response = await post("/api/rpc", { method: "send_tx", params: {} });
  assert(response.status === 400, `expected 400, got ${response.status}`);
  return "send_tx refused";
});
await check("a real testnet send finalizes with the sponsored account", async () => {
  const response = await post("/api/send", { receiverId: "guest-book.testnet", browser: `judge${Date.now().toString(36)}abcd` });
  const sent = await response.json();
  assert(response.ok && sent.txHash, sent.error ?? "send failed");
  const outcome = await rpc("tx", { tx_hash: sent.txHash, sender_account_id: sent.from, wait_until: "FINAL" });
  assert("SuccessValue" in outcome.status, "transaction did not succeed on chain");
  assert(outcome.transaction.receiver_id === "guest-book.testnet", "wrong receiver on chain");
  return `${sent.txHash} in ${(sent.elapsedMs / 1000).toFixed(1)} s`;
});
await check("a bad receiver id is refused before any signing", async () => {
  const response = await post("/api/send", { receiverId: "Not An Account", browser: "judgebrowser0001" });
  assert(response.status === 400, `expected 400, got ${response.status}`);
  return "400";
});
await check("deploy transaction of the screening suite contract resolves", async () => {
  const outcome = await rpc("tx", { tx_hash: "CtETQWtj7Sqc22PkrWzCvw1k4gF4d3DcgKm2puy9MJCF", sender_account_id: "screen-contract-20261113.testnet", wait_until: "FINAL" });
  assert("SuccessValue" in outcome.status, "deploy tx not successful");
  return "CtETQW…MJCF";
});

for (const [name, ok, detail] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`);
const failed = checks.filter(([, ok]) => !ok).length;
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
