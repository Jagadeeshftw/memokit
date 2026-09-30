---
title: "Networks and limits"
description: "Coston2, XRPL Testnet, the public RPC and DA Layer limits."
---

memokit runs on **Coston2**, Flare's testnet, against **XRPL Testnet**.
There is no mainnet deployment and no mainnet transaction.

## Networks

| | Coston2 | XRPL Testnet |
|---|---|---|
| Chain id | 114 | |
| RPC | `https://coston2-api.flare.network/ext/C/rpc` | JSON-RPC `https://s.altnet.rippletest.net:51234/`, WebSocket `wss://s.altnet.rippletest.net:51233` |
| Explorer | https://coston2-explorer.flare.network | https://testnet.xrpl.org |
| Faucet | https://faucet.flare.network/coston2 | https://faucet.altnet.rippletest.net/accounts |
| FDC source id | | `testXRP` |
| DA Layer | `https://ctn2-data-availability.flare.network` | |

The SDK's `COSTON2` constant holds all of these.

## The current deployment

| | |
|---|---|
| memokit diamond | {{deployment.diamond}} |
| XRPL receiving address | {{deployment.receivingAddress}} |
| Account beacon | {{deployment.personalAccountBeacon}} |
| Diamond owner | {{deployment.owner}} |

Every address in the deployment is on [Contracts and addresses](/docs/reference/addresses). Read the
current values from the chain:

```bash
export DIAMOND=$(node -p "require('./fixtures/deployment.json').diamond")
cast call $DIAMOND "receivingAddresses()(string[])" --rpc-url https://coston2-api.flare.network/ext/C/rpc
cast call $DIAMOND "validityDurationSeconds()(uint64)" --rpc-url https://coston2-api.flare.network/ext/C/rpc
```

The second returns `86400`: a proof must be delivered within 24 hours of its XRPL payment's ledger close.

## Costs on Coston2

| | |
|---|---|
| FDC attestation request | 1000 wei, plus gas |
| Gas price | 650 gwei |
| One instruction, through the deployed executor | 0.25 to 0.28 C2FLR, attestation and execute |
| Carrier payment on XRPL | 1 XRP in memokit's runs |

On Flare mainnet an attestation request costs 20 FLR plus about 0.054 FLR of gas. See
[FDC attestation request fees](/docs/reference/fdc-fees).

## Limits of the public infrastructure

| Limit | Value | What it means |
|---|---|---|
| DA Layer rate limit | about 20 requests a minute | measured; no rate-limit headers; recovers in 48 to 58 s |
| `eth_getLogs` range on the public Coston2 RPC | 30 blocks | a 31-block range is refused; every backward search is bounded by it |
| History on the public Coston2 RPC | pruned | historical `balanceOf` returns `missing trie node`; use an archive endpoint such as `https://rpc.ankr.com/flare_coston2` |
| XRPL memo | about 1,019 bytes | bounds an inline instruction |

## Timing

| | |
|---|---|
| FDC voting round | 90 s between round boundaries |
| XRPL ledger close to execute | about two and a half minutes; every run is in [Latency across all live runs](/docs/evidence/latency) |
| Proof validity window | 24 hours on the current deployment |
| A cash-out's XRP | from 140 s to 18.2 minutes after the XRPL payment's ledger close across four live runs, set by the FAssets agent |
| `DEFAULT_DEADLINE_SECONDS` | 900 |

## Testnet FAssets

- **FTestXRP** is Coston2's FXRP, six decimals, the asset every live run moved. Read its address from the
  AssetManager's `fAsset()`, as the guides do.
- **A lot is 10 FXRP.** Minting and redemption both work in whole lots.
- **A testnet redemption queue is inventory.** It can be empty for minutes at a time; a redemption
  attempted then reverts `RedeemZeroLots()`.
