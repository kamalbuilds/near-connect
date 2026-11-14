import { DurableObject } from "cloudflare:workers";
import { createHash, createPrivateKey, sign as signBytes } from "node:crypto";

const RPCS = ["https://near-testnet.drpc.org", "https://rpc.testnet.near.org", "https://test.rpc.fastnear.com"];
const ARCHIVAL = ["https://archival-rpc.testnet.fastnear.com", "https://archival-rpc.testnet.near.org"];
const RPC_METHODS = new Set(["query", "block", "status", "tx", "EXPERIMENTAL_tx_status", "gas_price"]);
const AMOUNT_YOCTO = 10n ** 22n; // 0.01 NEAR per send
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const enc = new TextEncoder();

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

const decodeBase58 = (text) => {
  let n = 0n;
  for (const c of text) { const i = B58.indexOf(c); if (i < 0) throw new Error("bad base58"); n = n * 58n + BigInt(i); }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of text) { if (c !== "1") break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
};
const encodeBase58 = (bytes) => {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = "1" + out; }
  return out;
};

const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
const u128 = (n) => concat(u64(BigInt(n) & ((1n << 64n) - 1n)), u64(BigInt(n) >> 64n));
const str = (s) => { const e = enc.encode(s); return concat(u32(e.length), e); };

const rpc = async (method, params, urls = RPCS) => {
  let last;
  for (const url of urls) {
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "screen", method, params }), signal: AbortSignal.timeout(20000) });
      const body = await response.json();
      const definitive = !body.error || body.error.cause || body.error.name === "HANDLER_ERROR" || body.error.data?.TxExecutionError;
      if (!definitive) { last = new Error("RPC unavailable"); continue; }
      return body;
    } catch (error) { last = error; }
  }
  throw last ?? new Error("No testnet RPC answered");
};

const receiverOk = (id) => typeof id === "string" && id.length >= 2 && id.length <= 64 && /^(?:[a-z0-9]+[._-])*[a-z0-9]+$/.test(id);

export class ScreenState extends DurableObject {
  chain = Promise.resolve();

  async limit(browser, caps) {
    const now = Date.now();
    const day = Math.floor(now / 86_400_000);
    const keys = [[`b:${browser}:${day}`, caps.browser], [`g:${day}`, caps.global]];
    const counts = await Promise.all(keys.map(([key]) => this.ctx.storage.get(key)));
    const seen = await this.ctx.storage.get(`seen:${browser}`);
    for (const [i, [key, cap]] of keys.entries()) {
      // A browser's first send is never refused by its own cap; the global cap still protects the sponsor balance.
      if ((counts[i] ?? 0) >= cap && !(i === 0 && !seen)) return { ok: false, scope: i === 0 ? "browser" : "global", retryAfter: Math.ceil(((day + 1) * 86_400_000 - now) / 1000) };
    }
    await Promise.all([...keys.map(([key], i) => this.ctx.storage.put(key, (counts[i] ?? 0) + 1)), this.ctx.storage.put(`seen:${browser}`, now)]);
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(now + 2 * 86_400_000);
    return { ok: true, today: (counts[1] ?? 0) + 1 };
  }

  async alarm() {
    const day = Math.floor(Date.now() / 86_400_000);
    const rows = await this.ctx.storage.list();
    const dead = [...rows.keys()].filter((key) => /^[bg]:/.test(key) && Number(key.split(":").pop()) < day);
    if (dead.length) await this.ctx.storage.delete(dead);
  }

  // Signing is serialized here so two sends from one key never share a nonce.
  send(receiverId) {
    const run = this.chain.then(() => this.signAndSend(receiverId).catch((error) => ({ ok: false, status: error.status ?? 502, error: error instanceof HttpError ? error.message : "The testnet did not answer. Try again.", ...(error.extra ?? {}) })));
    this.chain = run.catch(() => {});
    return run;
  }

  async signAndSend(receiverId) {
    const env = this.env;
    if (!env.SPONSOR_KEY) throw new HttpError(503, "The judge account is not configured on this deployment.");
    const started = Date.now();
    const accountId = env.SPONSOR_ID;
    const publicKey = decodeBase58(env.SPONSOR_PUBLIC_KEY.slice("ed25519:".length));
    const seed = decodeBase58(env.SPONSOR_KEY.trim().slice("ed25519:".length)).subarray(0, 32);
    const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(seed)]), format: "der", type: "pkcs8" });

    for (let attempt = 0; attempt < 3; attempt++) {
      const [keyResult, blockResult] = await Promise.all([
        rpc("query", { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: env.SPONSOR_PUBLIC_KEY }),
        rpc("block", { finality: "final" }),
      ]);
      if (!keyResult.result) throw new HttpError(502, "Testnet could not read the judge account key. Try again in a few seconds.");
      const stored = (await this.ctx.storage.get("nonce")) ?? 0;
      const nonce = Math.max(Number(keyResult.result.nonce), stored) + 1;
      await this.ctx.storage.put("nonce", nonce);
      const body = concat(str(accountId), Uint8Array.of(0), publicKey, u64(nonce), str(receiverId), decodeBase58(blockResult.result.header.hash), u32(1), Uint8Array.of(3), u128(AMOUNT_YOCTO));
      const signature = signBytes(null, createHash("sha256").update(body).digest(), privateKey);
      const signed = concat(body, Uint8Array.of(0), signature);
      const result = await rpc("send_tx", { signed_tx_base64: Buffer.from(signed).toString("base64"), wait_until: "INCLUDED" });
      if (result.error) {
        if (/InvalidNonce/.test(JSON.stringify(result.error)) && attempt < 2) continue;
        throw new HttpError(502, "Testnet refused the transaction: " + (result.error.data?.TxExecutionError ? JSON.stringify(result.error.data.TxExecutionError) : result.error.message ?? "unknown"));
      }
      const txHash = encodeBase58(createHash("sha256").update(body).digest());
      let outcome;
      for (let poll = 0; poll < 30 && !outcome; poll++) {
        await new Promise((resolve) => setTimeout(resolve, poll ? 1000 : 600));
        const seen = await rpc("tx", { tx_hash: txHash, sender_account_id: accountId, wait_until: "FINAL" }).catch(() => null);
        if (seen?.result?.final_execution_status === "FINAL") outcome = seen.result;
      }
      if (!outcome) throw new HttpError(504, "The transaction was submitted but testnet has not finalized it yet.", { txHash });
      if (outcome.status && !("SuccessValue" in outcome.status)) throw new HttpError(502, "The transaction failed on chain.", { txHash });
      return { ok: true, txHash, from: accountId, to: receiverId, amount: "0.01", finality: outcome.final_execution_status, elapsedMs: Date.now() - started, explorer: `https://testnet.nearblocks.io/txns/${txHash}` };
    }
    throw new HttpError(502, "Testnet nonce kept changing. Try again.");
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/config") {
        return json(200, { network: "testnet", signer: env.SPONSOR_ID, amount: "0.01", configured: Boolean(env.SPONSOR_KEY) });
      }
      if (url.pathname === "/api/rpc") {
        if (request.method !== "POST") throw new HttpError(405, "POST only");
        const payload = await request.json();
        if (!RPC_METHODS.has(payload?.method)) throw new HttpError(400, "That RPC method is not relayed.");
        // Recent heights come from the fast endpoint; older ones fall back to an archival node.
        const historic = payload.params && !Array.isArray(payload.params) && "block_id" in payload.params;
        let answer = await rpc(payload.method, payload.params);
        if (historic && answer.error?.cause?.name === "UNKNOWN_BLOCK") answer = await rpc(payload.method, payload.params, ARCHIVAL);
        return json(200, { ...answer, id: payload.id ?? answer.id });
      }
      if (url.pathname === "/api/send") {
        if (request.method !== "POST") throw new HttpError(405, "POST only");
        const input = await request.json();
        if (!receiverOk(input.receiverId)) throw new HttpError(400, "Enter a testnet account id.");
        const browser = String(input.browser ?? "").slice(0, 64);
        if (!/^[A-Za-z0-9_-]{8,64}$/.test(browser)) throw new HttpError(400, "Reload the page and try again.");
        const stub = env.STATE.get(env.STATE.idFromName("screen"));
        const caps = { browser: Number(env.SENDS_PER_BROWSER_DAY), global: Number(env.SENDS_GLOBAL_DAY) };
        const allowed = await stub.limit(browser, caps);
        if (!allowed.ok) throw new HttpError(429, allowed.scope === "global" ? "The judge account has sent its quota for today. Connect your own testnet wallet to keep going." : "This browser has used its sends for today. Connect your own testnet wallet to keep going.", { retryAfter: allowed.retryAfter });
        const sent = await stub.send(input.receiverId);
        if (!sent.ok) throw new HttpError(sent.status, sent.error, sent.txHash ? { txHash: sent.txHash } : {});
        return json(200, sent);
      }
      if (url.pathname.startsWith("/api/")) throw new HttpError(404, "Not found");
      return env.ASSETS.fetch(request);
    } catch (error) {
      if (error instanceof HttpError) return json(error.status, { error: error.message, ...error.extra }, error.extra.retryAfter ? { "retry-after": String(error.extra.retryAfter) } : {});
      return json(502, { error: "The testnet did not answer. Try again." });
    }
  },
};
