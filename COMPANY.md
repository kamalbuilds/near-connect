# NEAR Connect Screen

Track: AI Security & Defense (security). Trust, but verify.

Before an agent or app sends funds or calls a contract, NEAR Connect Screen checks the receiver and the transaction actions and returns block or warn, plus the reasons and an evidence link. A block throws `ScreenBlockedError` and the wallet is never contacted. A warn opens a dialog that asks a human before the wallet signs. The check sits in the connector, so every sandboxed, injected and parent-frame wallet gets it with one option: `new NearConnector({ screen: {} })`.

## Who uses

- dApp teams that integrate NEAR Connect and want every wallet behind it to refuse sanctioned, impostor and poisoned recipients without writing a check per wallet.
- Agent builders whose agent signs transfers on its own and needs a deterministic stop before the key is used.
- Wallet users who paste an address from a chat and need one clear reason when it is wrong.

## How it works

- `src/screen/index.ts` runs inside the connector. `screenTransaction` reads the receiver and every action, `approveScreen` throws on block or asks a human on warn, and `screenAndSend` wraps the wallet call so a blocked transaction never reaches it.
- Signals: OFAC SDN digital-currency addresses (bundled, versioned, refreshable via `listUrl`); fake-airdrop token accounts from the Mimicwatch for NEAR list; address-poisoning lookalikes of destinations this wallet sent to before; receivers imitating `intents.near`, `wrap.near`, `v2.ref-finance.near`, `usdt.tether-token.near`; receiver accounts or contract code newer than `contractFreshnessHours`; full-access `AddKey` and wide function-call keys; Ref Finance swaps whose minimum output is far below input at DefiLlama prices.
- The hosted demo (`web/`, `worker/`) runs the same module in the browser. A Cloudflare Worker relays testnet reads and holds a sponsored judge account that signs real testnet transfers, so a visitor needs no wallet and no funds. The page puts two lanes side by side: the connector as it ships today and the connector with Screen.
- An optional `explain` callback adds a plain-language reason from NEAR AI Cloud on your server and never changes a verdict.

## Evidence

| Fact | Evidence |
| --- | --- |
| Screening suite deployed a fresh testnet contract and asserts block, warn and pass cases | [CtETQWtj7Sqc22PkrWzCvw1k4gF4d3DcgKm2puy9MJCF](https://testnet.nearblocks.io/txns/CtETQWtj7Sqc22PkrWzCvw1k4gF4d3DcgKm2puy9MJCF), `scripts/screen-test.sh` |
| Without Screen, 0.01 testnet NEAR reaches an OFAC-listed address; with Screen the wallet is never asked | [ESjrFydusjWtGKSjmT2zkN2ZbPsfGVxSYMZG1qMpvTTY](https://testnet.nearblocks.io/txns/ESjrFydusjWtGKSjmT2zkN2ZbPsfGVxSYMZG1qMpvTTY), recipient `0x252a8bd2319d8a555b872990601221b3a2053bce` |
| A contract deployed minutes earlier makes Screen warn; after Continue the wallet signs | deploy [C6xgMHPMbWsTKdfVZT8kfEiZzKiu5vygQ2Yp8MYtAJhD](https://testnet.nearblocks.io/txns/C6xgMHPMbWsTKdfVZT8kfEiZzKiu5vygQ2Yp8MYtAJhD), send [BNM8tQ3wBLpdssF1v9MW7nQUMPxzZtkasSuDYkHbXkTK](https://testnet.nearblocks.io/txns/BNM8tQ3wBLpdssF1v9MW7nQUMPxzZtkasSuDYkHbXkTK) |
| An established account is cleared and the transfer lands | [7cVe5oQac11pLKAMuLc4VqZDgQLUEugtGRhHsLmz99ka](https://testnet.nearblocks.io/txns/7cVe5oQac11pLKAMuLc4VqZDgQLUEugtGRhHsLmz99ka) |
| One command proves the live demo end to end, including a finalized send read back from a second RPC | `node scripts/judge.mjs` and the `judge` workflow |
| Freshness block found in a few reads: a 30-day freshness window on testnet dropped from 62 s to 2.8 s | commit 44b3290, `scripts/screen-test.sh` fails when the lookup is broken |
| Median 0.5 s added to the sign path on mainnet, under 1 ms for non-NEAR recipients | `scripts/screen-latency.sh mainnet` |
| Proposed upstream | [azbang/near-connect#123](https://github.com/azbang/near-connect/pull/123) |

## Try it in 60 seconds

Open https://near-screen.nearlive.workers.dev. The With Screen lane already shows Block for the sanctioned address. Press Send 0.01 NEAR and watch the request travel down both lanes: the unscreened lane delivers the funds with a testnet transaction link, the screened lane stops at the Screen gate and keeps the wallet at zero requests. The provenance strip shows the list dates, address counts and the testnet block read. Pick the other two recipients for the warn and clear paths.

## Why NEAR

NEAR Connect is where wallets plug into apps, so one option there covers every wallet at once. Implicit accounts accept Ethereum-format addresses, which puts 137 sanctioned addresses directly on NEAR's account space. Sponsored testnet accounts and one-second finality let the demo prove each verdict with a real transaction inside a minute.

## Team and build window

Built 2026-11-13 to 2026-11-14 by kamalbuilds on the near-hackathon branch, on top of NEAR Connect by HOT Labs. First commit of the screen module 2026-11-13, hosted demo and judge command 2026-11-14.
