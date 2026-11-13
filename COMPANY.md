# NEAR Connect Screen

Track: AI Security & Defense (security). Trust, but verify.

Before an agent or app sends funds or calls a contract, NEAR Connect Screen checks the receiver and the transaction actions and returns block or warn, plus the reasons and an evidence link. A block throws `ScreenBlockedError` and the wallet is never contacted. A warn opens a popup that asks a human before the wallet signs. The check sits in the connector, so every sandboxed, injected and parent-frame wallet gets it with one option: `new NearConnector({ screen: {} })`.

## Signals scored

- OFAC SDN digital-currency addresses (bundled, versioned, refreshable via `listUrl`).
- Fake-airdrop token accounts from the Mimicwatch for NEAR list, with evidence links.
- Address-poisoning lookalikes of destinations this wallet sent to before.
- Receivers imitating `intents.near`, `wrap.near`, `v2.ref-finance.near`, `usdt.tether-token.near`.
- Receiver account or contract code newer than `contractFreshnessHours`.
- Full-access `AddKey`, and function-call keys with many methods or a large or missing allowance.
- Ref Finance swaps whose minimum output is far below input at DefiLlama prices.

## Proof

- `scripts/screen-test.sh` runs the cases, including negative ones (clean recipient passes, same address in another case is not a lookalike), against a freshly deployed testnet contract `screen-contract-20261113.testnet`, deploy tx `CtETQWtj7Sqc22PkrWzCvw1k4gF4d3DcgKm2puy9MJCF`.
- `scripts/screen-latency.sh mainnet` measures the sign-path cost: a median of 0.5 s on mainnet, under 1 ms for non-NEAR recipients.
- An optional `explain` callback adds a plain-language reason from NEAR AI Cloud on your server and never changes a verdict.

Screen ships as the `screen` option of NEAR Connect and is proposed upstream as azbang/near-connect#123.
