import { screenAndSend, screenTransaction, ScreenBlockedError, type ScreenCheck } from "../../src/screen/index";
import { NearConnector } from "../../src/NearConnector";
import type { ScreenOptions } from "../../src/types";
import ofacList from "../../src/screen/sanctioned-addresses-2026-11-09.json";
import nearList from "../../src/screen/near-account-addresses-2026-11-01.json";

// The connector reads testnet through the drpc endpoint. Route it through this site's relay so the page never
// makes a cross-origin chain read.
const nativeFetch = window.fetch.bind(window);
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return url.startsWith("https://near-testnet.drpc.org") ? nativeFetch("/api/rpc", init) : nativeFetch(input, init);
};

const PRESETS: Record<string, string> = {
  sanctioned: "0x252a8bd2319d8a555b872990601221b3a2053bce",
  clean: "guest-book.testnet",
};
// The judge account deploys a throwaway contract on testnet; Screen then sees code that is minutes old.
let fresh: { account: string; explorer: string } | null = null;
// A real unscreened send to the sanctioned address, made through this same page. Its block is read back from testnet on load.
const RECORDED = { tx: "ESjrFydusjWtGKSjmT2zkN2ZbPsfGVxSYMZG1qMpvTTY", from: "screen-sponsor-1114.testnet" };
// Read back from testnet on 2026-11-14 (block 3K5k7Xo2…38kK); the page refreshes it from the chain on load.
let recorded: { height: number; when: string } | null = { height: 277598109, when: "2026-11-14 02:51 UTC" };
let ran = false;
const AMOUNT_YOCTO = "10000000000000000000000";
const OPTIONS: ScreenOptions = {};
const NEARBLOCKS = "https://testnet.nearblocks.io/txns/";

type StepState = "idle" | "run" | "pass" | "block" | "warn" | "skip" | "bad";
interface Step { state: StepState; title: string; detail?: string; html?: string }
type Lane = "plain" | "screen";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const short = (id: string) => (id.length > 26 && !id.includes(".") ? `${id.slice(0, 10)}…${id.slice(-6)}` : id);
const mark: Record<StepState, string> = { idle: "", run: "", pass: "✓", block: "×", warn: "!", skip: "–", bad: "×" };

let signer = "screen-sponsor-1114.testnet";
let walletAccount: string | null = null;
let connector: NearConnector | null = null;
const counts: Record<Lane, number> = { plain: 0, screen: 0 };
let busy = false;
let checkToken = 0;
let latest: { recipient: string; checks: ScreenCheck[]; ms: number } | null = null;

const browserToken = (() => {
  const make = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(36).padStart(2, "0")).join("");
  try {
    const key = "screen.browser";
    return localStorage.getItem(key) ?? (localStorage.setItem(key, make()), localStorage.getItem(key) ?? make());
  } catch {
    return make();
  }
})();

const steps: Record<Lane, Step[]> = { plain: [], screen: [] };

// The request travels down each lane. It rides the rail from the app step to wherever that lane's real state has reached:
// the end of the line (funds landed) or the Screen gate (stopped, wallet never contacted).
let launched = false;
const place = (lane: Lane) => {
  const items = Array.from($(`steps-${lane}`).children) as HTMLElement[];
  const pkt = $(`pkt-${lane}`);
  const gate = document.getElementById(`gate-${lane}`);
  const st = steps[lane];
  if (items.length < 4) return;
  const center = (i: number) => items[i].offsetTop + 22;
  const on = (s: Step | undefined, ...states: StepState[]) => !!s && states.includes(s.state);
  let idx = -1;
  let end = "";
  let atGate = false;
  if (lane === "plain") {
    if (on(st[3], "pass", "bad")) { idx = 3; end = st[3].state === "bad" ? "landed" : "ok"; }
    else if (on(st[2], "run", "pass", "bad")) idx = 2;
  } else if (on(st[1], "block")) {
    atGate = true; idx = 1; end = "stopped";
  } else if (launched) {
    if (on(st[3], "pass")) { idx = 3; end = "ok"; }
    else if (on(st[2], "run", "pass")) idx = 2;
    else if (on(st[1], "warn", "run")) idx = 1;
  }
  const visible = idx >= 0;
  pkt.dataset.on = visible ? "1" : "0";
  if (gate) gate.dataset.on = atGate ? "1" : "0";
  if (!visible) return;
  const size = end === "landed" ? 22 : 12;
  const y = atGate ? items[2].offsetTop - 6 : center(idx) - size / 2;
  pkt.style.setProperty("--y", `${y}px`);
  pkt.dataset.end = end;
  if (atGate && gate) gate.style.setProperty("--y", `${items[2].offsetTop - 2}px`);
};
const launch = () => {
  launched = true;
  (["plain", "screen"] as Lane[]).forEach((lane) => {
    const items = Array.from($(`steps-${lane}`).children) as HTMLElement[];
    if (items.length < 4) return;
    const pkt = $(`pkt-${lane}`);
    const gate = document.getElementById(`gate-${lane}`);
    pkt.dataset.snap = "1";
    if (gate) gate.dataset.snap = "1";
    pkt.dataset.end = "";
    pkt.dataset.on = "1";
    if (gate) gate.dataset.on = "0";
    pkt.style.setProperty("--y", `${items[0].offsetTop + 22 - 6}px`);
    void pkt.offsetWidth;
    delete pkt.dataset.snap;
    if (gate) delete gate.dataset.snap;
  });
};
window.addEventListener("resize", () => { place("plain"); place("screen"); });
void document.fonts?.ready.then(() => { place("plain"); place("screen"); });

const fmtInt = (n: number) => n.toLocaleString("en-US");
const showLists = () => {
  const eth = (ofacList as any).addresses.filter((a: any) => a.address.startsWith("0x")).length;
  $("p-ofac").textContent = `OFAC sanctions list of ${(ofacList as any).updatedAt}`;
  $("p-ofac-d").textContent = `${fmtInt((ofacList as any).addresses.length)} addresses, ${eth} in the Ethereum format NEAR accepts`;
  $("p-near").textContent = `NEAR lookalike list of ${(nearList as any).version}`;
  $("p-near-d").textContent = `${fmtInt((nearList as any).addresses.length)} flagged token accounts, each with an evidence link`;
};
const readBlock = async () => {
  try {
    const response = await fetch("/api/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "block", params: { finality: "final" } }) });
    const header = (await response.json()).result.header;
    const when = new Date(Number(header.timestamp_nanosec) / 1e6).toISOString().slice(11, 19);
    const b = $("p-block");
    b.removeAttribute("data-skeleton");
    b.textContent = `Chain read at testnet block ${fmtInt(Number(header.height))}`;
    $("p-block-d").textContent = `${when} UTC. Account age, contract code and keys are read live on every check.`;
  } catch {
    $("p-block-d").textContent = "The block read will retry on the next check.";
  }
};
showLists();
$("p-block").setAttribute("data-skeleton", "");
const render = (lane: Lane, verdictHtml = "") => {
  const list = $<HTMLOListElement>(`steps-${lane}`);
  list.innerHTML = steps[lane]
    .map((s, i) => `<li data-s="${s.state}"><span class="dot" aria-hidden="true">${mark[s.state]}</span><div><div class="t">${esc(s.title)}</div>${s.detail || s.html ? `<div class="d">${s.html ?? esc(s.detail!)}</div>` : ""}${i === 1 && lane === "screen" ? verdictHtml : ""}</div></li>`)
    .join("");
  $(`n-${lane}`).textContent = String(counts[lane]);
  const verdict = latest ? verdictOf(latest.checks) : "clear";
  $(`n-${lane}`).className = lane === "plain" ? (counts.plain > 0 && verdict === "block" ? "hit" : "") : (counts.screen === 0 && verdict === "block" ? "held" : "");
  $("s-plain").textContent = String(counts.plain);
  $("s-screen").textContent = String(counts.screen);
  $("s-plain").className = $("n-plain").className;
  $("s-screen").className = $("n-screen").className;
  $("cap-plain").textContent = !ran && counts.plain > 0 ? "Wallet signing requests, recorded run" : "Wallet signing requests";
  place(lane);
};

const recipientNow = () => {
  const pick = (document.querySelector<HTMLInputElement>('input[name="pick"]:checked')?.value ?? "sanctioned") as string;
  return pick === "own" ? $<HTMLInputElement>("own").value.trim().toLowerCase() : pick === "fresh" ? (fresh?.account ?? "") : PRESETS[pick];
};

const verdictOf = (checks: ScreenCheck[]) => (checks.some((c) => c.level === "block") ? "block" : checks.some((c) => c.level === "warn") ? "warn" : "clear");
const verdictHtml = (checks: ScreenCheck[], ms: number) => {
  const v = verdictOf(checks);
  const label = v === "block" ? "Block" : v === "warn" ? "Warn" : "Clear";
  const items = checks.map((c) => `<li>${esc(c.reason)} <a href="${esc(c.evidence_url)}" target="_blank" rel="noreferrer">Evidence</a></li>`).join("");
  return `<div class="verdict" data-v="${v}"><div class="head"><span class="chip">${label}</span><span>decided in ${fmtMs(ms)}</span></div><ul>${items}</ul></div>`;
};

const toLine = (recipient: string): Pick<Step, "detail" | "html"> =>
  fresh && recipient === fresh.account ? { html: `to ${esc(short(recipient))}, deployed minutes ago in <a href="${esc(fresh.explorer)}" target="_blank" rel="noreferrer">this transaction</a>` } : { detail: `to ${short(recipient)}` };

const idleSteps = (recipient: string): Record<Lane, Step[]> => ({
  plain: [
    { state: "pass", title: "App sends 0.01 NEAR", ...toLine(recipient) },
    { state: "skip", title: "Screening", detail: "Not installed. Nothing reads the recipient." },
    { state: "idle", title: "Wallet asked to sign", detail: "Waiting for your send." },
    { state: "idle", title: "Testnet transaction", detail: "Not sent yet." },
  ],
  screen: [
    { state: "pass", title: "App sends 0.01 NEAR", ...toLine(recipient) },
    { state: "run", title: "Screen checks the recipient", detail: "Reading OFAC and NEAR account lists, contract history." },
    { state: "idle", title: "Wallet asked to sign", detail: "Waiting for Screen." },
    { state: "idle", title: "Testnet transaction", detail: "Not sent yet." },
  ],
});

const recordedSteps = (recipient: string): Step[] => [
  { state: "pass", title: "App sends 0.01 NEAR", ...toLine(recipient) },
  { state: "skip", title: "Screening", detail: "Not installed. Nothing reads the recipient." },
  { state: "pass", title: "Wallet signs without a question", detail: `Recorded run, signed by ${RECORDED.from}.` },
  { state: "bad", title: "Funds reached the flagged recipient", html: `<a href="${NEARBLOCKS + RECORDED.tx}" target="_blank" rel="noreferrer">${esc(short(RECORDED.tx))}</a> finalized on testnet${recorded ? ` at block ${recorded.height.toLocaleString("en-US")}, ${esc(recorded.when)}` : ""}` },
];

const fmtMs = (ms: number) => (ms < 1 ? "under 1 ms" : ms < 10 ? `${ms.toFixed(1)} ms` : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

const applyCheck = (recipient: string, checks: ScreenCheck[], ms: number) => {
  const v = verdictOf(checks);
  const s = steps.screen;
  s[1] = { state: v === "block" ? "block" : v === "warn" ? "warn" : "pass", title: v === "block" ? "Screen blocks the transaction" : v === "warn" ? "Screen asks a human first" : "Screen clears the recipient" };
  s[2] = v === "block" ? { state: "skip", title: "Wallet asked to sign", detail: "Never contacted." } : { state: "idle", title: "Wallet asked to sign", detail: v === "warn" ? "After you confirm the warning." : "Waiting for your send." };
  s[3] = v === "block" ? { state: "skip", title: "Testnet transaction", detail: "Nothing is sent." } : { state: "idle", title: "Testnet transaction", detail: "Not sent yet." };
  render("screen", verdictHtml(checks, ms));
  latest = { recipient, checks, ms };
};

const ensureFresh = async (token: number) => {
  if (fresh) return true;
  steps.plain = idleSteps("…").plain;
  steps.screen = idleSteps("…").screen;
  steps.screen[0] = { state: "run", title: "Deploying a contract on testnet", detail: "The judge account is publishing a new contract so Screen has something recent to see." };
  steps.screen[1] = { state: "idle", title: "Screen checks the recipient", detail: "Waiting for the contract." };
  render("plain");
  render("screen");
  try {
    const response = await fetch("/api/fresh");
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    if (token !== checkToken) return false;
    fresh = { account: body.account, explorer: body.explorer };
    const label = document.querySelector<HTMLElement>('input[value="fresh"] + span i');
    if (label) label.textContent = short(body.account);
    return true;
  } catch (error) {
    if (token !== checkToken) return false;
    steps.screen[0] = { state: "bad", title: "Could not deploy the contract", detail: (error as Error).message + " Pick it again to retry." };
    render("screen");
    return false;
  }
};

const runCheck = async () => {
  const token = ++checkToken;
  if (document.querySelector<HTMLInputElement>('input[name="pick"]:checked')?.value === "fresh" && !(await ensureFresh(token))) return;
  const recipient = recipientNow();
  latest = null;
  launched = false;
  $<HTMLAnchorElement>("share").hidden = true;
  const base = idleSteps(recipient || "…");
  steps.plain = base.plain;
  steps.screen = base.screen;
  counts.plain = 0;
  counts.screen = 0;
  if (!ran && document.querySelector<HTMLInputElement>('input[name="pick"]:checked')?.value === "sanctioned") {
    counts.plain = 1;
    steps.plain = recordedSteps(recipient);
  }
  $("summary").textContent = "";
  render("plain");
  render("screen");
  if (!recipient) {
    steps.screen[1] = { state: "idle", title: "Screen checks the recipient", detail: "Enter an account to check." };
    render("screen");
    return;
  }
  const started = performance.now();
  try {
    const checks = await screenTransaction({ receiverId: recipient, actions: [{ type: "Transfer", params: { deposit: AMOUNT_YOCTO } }] }, "testnet", walletAccount ?? signer, OPTIONS);
    if (token !== checkToken) return;
    applyCheck(recipient, checks, performance.now() - started);
    void readBlock();
  } catch (error) {
    if (token !== checkToken) return;
    steps.screen[1] = { state: "bad", title: "Screen could not read the chain", detail: "Testnet did not answer. Pick the recipient again to retry." };
    render("screen");
  }
};

interface SendResult { txHash: string; elapsedMs: number }
const postSend = async (recipient: string): Promise<SendResult> => {
  const response = await fetch("/api/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ receiverId: recipient, browser: browserToken }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error ?? "The judge account could not send."), { status: response.status });
  return body;
};

const sendLink = (r: SendResult) => `<a href="${NEARBLOCKS + r.txHash}" target="_blank" rel="noreferrer">${esc(short(r.txHash))}</a> finalized on testnet in ${fmtMs(r.elapsedMs)}`;

const runPlain = async (recipient: string) => {
  steps.plain[2] = { state: "run", title: "Wallet asked to sign", detail: "Signing on testnet." };
  steps.plain[3] = { state: "idle", title: "Testnet transaction", detail: "Waiting for the wallet." };
  counts.plain++;
  render("plain");
  const started = performance.now();
  try {
    const result = await postSend(recipient);
    steps.plain[2] = { state: "pass", title: "Wallet signs without a question", detail: `Signed and broadcast by ${signer}.` };
    steps.plain[3] = { state: latest && verdictOf(latest.checks) === "block" ? "bad" : "pass", title: latest && verdictOf(latest.checks) === "block" ? "Funds reached the flagged recipient" : "Testnet transaction", html: sendLink(result) };
    render("plain");
    return { ok: true as const, result, ms: performance.now() - started };
  } catch (error) {
    steps.plain[2] = { state: "bad", title: "Wallet asked to sign", detail: (error as Error).message };
    steps.plain[3] = { state: "skip", title: "Testnet transaction", detail: "Not sent." };
    render("plain");
    return { ok: false as const, error: error as Error };
  }
};

const runScreen = async (recipient: string) => {
  const started = performance.now();
  steps.screen[1] = { state: "run", title: "Screen checks the recipient", detail: "Reading OFAC and NEAR account lists, contract history." };
  steps.screen[2] = { state: "idle", title: "Wallet asked to sign", detail: "Waiting for Screen." };
  steps.screen[3] = { state: "idle", title: "Testnet transaction", detail: "Waiting for the wallet." };
  render("screen");
  let sent: SendResult | undefined;
  try {
    const tx = { receiverId: recipient, actions: [{ type: "Transfer" as const, params: { deposit: AMOUNT_YOCTO } }] };
    await screenAndSend(OPTIONS, [tx], "testnet", walletAccount ?? signer, async () => {
      const checks = latest?.recipient === recipient ? latest.checks : [];
      if (checks.length) applyCheck(recipient, checks, latest!.ms);
      steps.screen[2] = { state: "run", title: "Wallet asked to sign", detail: walletAccount ? `Waiting for ${short(walletAccount)} to sign.` : "Signing on testnet." };
      counts.screen++;
      render("screen", latest ? verdictHtml(latest.checks, latest.ms) : "");
      if (walletAccount && connector) {
        const wallet = await connector.wallet();
        const outcome: any = await wallet.signAndSendTransaction({ receiverId: recipient, actions: tx.actions });
        const hash = outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id ?? outcome?.txHash ?? "";
        sent = { txHash: hash, elapsedMs: performance.now() - started };
        return outcome;
      }
      sent = await postSend(recipient);
      return sent;
    });
    steps.screen[2] = { state: "pass", title: "Wallet signs after Screen", detail: walletAccount ? `Signed by ${short(walletAccount)}.` : `Signed and broadcast by ${signer}.` };
    steps.screen[3] = { state: "pass", title: "Testnet transaction", html: sent!.txHash ? sendLink(sent!) : "Submitted by your wallet." };
    render("screen", latest ? verdictHtml(latest.checks, latest.ms) : "");
    return { ok: true as const };
  } catch (error) {
    if (error instanceof ScreenBlockedError) {
      const ms = performance.now() - started;
      applyCheck(recipient, error.checks, latest?.recipient === recipient ? latest.ms : ms);
      return { ok: false as const, blocked: true as const };
    }
    const cancelled = !(error as any).status && counts.screen === 0;
    steps.screen[2] = cancelled ? { state: "skip", title: "Wallet asked to sign", detail: "Never contacted. You cancelled the warning." } : { state: "bad", title: "Wallet asked to sign", detail: (error as Error).message };
    steps.screen[3] = { state: "skip", title: "Testnet transaction", detail: "Nothing is sent." };
    render("screen", latest ? verdictHtml(latest.checks, latest.ms) : "");
    return { ok: false as const, blocked: false as const, error: error as Error };
  }
};

const summarize = (recipient: string, plain: Awaited<ReturnType<typeof runPlain>>, screen: Awaited<ReturnType<typeof runScreen>>) => {
  const el = $("summary");
  const verdict = latest ? verdictOf(latest.checks) : "clear";
  const took = latest ? fmtMs(latest.ms) : "a moment";
  if (screen.ok && plain.ok) {
    el.textContent = verdict === "warn"
      ? `Screen paused for a human before the wallet signed, you continued, and 0.01 NEAR reached ${short(recipient)}. Without Screen the wallet signed with no warning at all.`
      : `Both lanes sent 0.01 NEAR to ${short(recipient)}. Screen cleared the recipient in ${took} and the wallet was asked once, with nothing to warn about.`;
  } else if (!screen.ok && "blocked" in screen && screen.blocked && plain.ok) {
    el.innerHTML = `Without Screen, 0.01 NEAR reached ${esc(short(recipient))} in <a href="${NEARBLOCKS + plain.result.txHash}" target="_blank" rel="noreferrer">${esc(short(plain.result.txHash))}</a>. With Screen it stopped in ${took} and the wallet was asked ${counts.screen} times.`;
  } else if (!screen.ok && "blocked" in screen && !screen.blocked && !("status" in (screen.error ?? {})) && plain.ok) {
    el.textContent = `You cancelled Screen's warning, so the wallet was never asked. The unscreened lane sent the same 0.01 NEAR without a pause.`;
  } else {
    const err = (!plain.ok && plain.error) || (!screen.ok && "error" in screen && screen.error) || null;
    el.textContent = err ? err.message : "Cancelled. Screen kept the wallet out of it.";
  }
};

const setShare = (recipient: string, plain: Awaited<ReturnType<typeof runPlain>>) => {
  if (!plain.ok || !latest) return;
  const verdict = verdictOf(latest.checks);
  const took = fmtMs(latest.ms);
  const proof = NEARBLOCKS + plain.result.txHash;
  const text = verdict === "block"
    ? `Screen blocked a NEAR send to ${short(recipient)} in ${took}. The wallet was asked ${counts.screen} times. The same send without Screen landed on testnet: ${proof}`
    : verdict === "warn"
      ? `Screen stopped a NEAR send to ${short(recipient)} for a human to confirm before the wallet signed. Without Screen the wallet signed with no warning: ${proof}`
      : `Screen cleared a NEAR send to ${short(recipient)} in ${took}, no slowdown, no extra prompt: ${proof}`;
  const link = $<HTMLAnchorElement>("share");
  link.href = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(location.origin + "/")}`;
  link.hidden = false;
};

$("try").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  let recipient = recipientNow();
  if (!recipient && document.querySelector<HTMLInputElement>('input[name="pick"]:checked')?.value === "fresh") {
    await runCheck();
    recipient = recipientNow();
  }
  if (!recipient) { $<HTMLInputElement>("own").focus(); return; }
  busy = true;
  ran = true;
  counts.plain = 0;
  counts.screen = 0;
  const button = $<HTMLButtonElement>("send");
  button.disabled = true;
  button.textContent = "Sending";
  $("summary").textContent = "";
  $<HTMLAnchorElement>("share").hidden = true;
  try {
    if (!latest || latest.recipient !== recipient) await runCheck();
    launch();
    const [plain, screen] = await Promise.all([runPlain(recipient), runScreen(recipient)]);
    summarize(recipient, plain, screen);
    setShare(recipient, plain);
  } finally {
    busy = false;
    button.disabled = false;
    button.textContent = "Send 0.01 NEAR";
  }
});

document.querySelectorAll<HTMLInputElement>('input[name="pick"]').forEach((input) => input.addEventListener("change", () => { if (!busy) void runCheck(); }));
let typing: number | undefined;
$<HTMLInputElement>("own").addEventListener("input", () => {
  const own = document.querySelector<HTMLInputElement>('input[name="pick"][value="own"]')!;
  own.checked = true;
  window.clearTimeout(typing);
  typing = window.setTimeout(() => { if (!busy) void runCheck(); }, 450);
});
$<HTMLInputElement>("own").addEventListener("focus", () => { document.querySelector<HTMLInputElement>('input[name="pick"][value="own"]')!.checked = true; });

const walletState = $("walletstate");
const connect = $<HTMLButtonElement>("connect");
connect.addEventListener("click", async () => {
  try {
    if (!connector) {
      connector = new NearConnector({ network: "testnet", screen: OPTIONS });
      connector.on("wallet:signIn", (e: any) => { walletAccount = e.accounts?.[0]?.accountId ?? null; setWallet(); });
      connector.on("wallet:signOut", () => { walletAccount = null; setWallet(); });
    }
    if (walletAccount) { await connector.disconnect(); return; }
    await connector.connect();
  } catch (error) {
    walletState.textContent = "The wallet did not connect. Try again or pick another wallet.";
  }
});
const setWallet = () => {
  connect.textContent = walletAccount ? "Disconnect" : "Connect a testnet wallet";
  walletState.textContent = walletAccount ? `Connected as ${walletAccount}. The With Screen lane signs with your wallet.` : "";
  void runCheck();
};

fetch("/api/config").then((r) => r.json()).then((c) => { if (c.signer) signer = c.signer; }).catch(() => {}).finally(() => void runCheck());

fetch("/api/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "tx", params: { tx_hash: RECORDED.tx, sender_account_id: RECORDED.from, wait_until: "FINAL" } }) })
  .then((r) => r.json())
  .then((body) => fetch("/api/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "block", params: { block_id: body.result.transaction_outcome.block_hash } }) }))
  .then((r) => r.json())
  .then((body) => {
    recorded = { height: Number(body.result.header.height), when: new Date(Number(body.result.header.timestamp_nanosec) / 1e6).toISOString().replace("T", " ").slice(0, 16) + " UTC" };
    if (!ran && !busy && document.querySelector<HTMLInputElement>('input[name="pick"]:checked')?.value === "sanctioned" && latest) { steps.plain = recordedSteps(latest.recipient); render("plain"); }
  })
  .catch(() => {});
