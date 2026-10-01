---
title: "Status and limits"
description: "What has run live, what ran on a fork, and what is open."
---

**Coston2 and XRPL Testnet only.** There is no mainnet deployment and no mainnet transaction.

Every claim in these docs has an evidence level in the [claim ledger](/docs/evidence/claim-ledger).
When a page and the ledger disagree, the ledger is right.

## Evidence levels

| Level | Means | Does not mean |
|---|---|---|
| **Live** | Ran on Coston2 and XRPL Testnet with real FDC attestation. A transaction backs it. | That it ran anywhere else. |
| **Fork** | Ran on a Foundry fork of Flare mainnet, against the real deployed contracts, with FDC verification simulated. | That it passed real attestation, or ran as a mainnet transaction. |
| **Tested** | Covered by the unit or integration suite, against contracts deployed in the test. | That it has run against any live network. |
| **Verified from deployed code** | Read from someone else's verified source and live state, at a stated block. | That it stays true: a diamond can be upgraded. |
| **Open** | Not done, or not verified. | |

## What has run where

| | Coston2 + XRPL Testnet | Flare mainnet fork, FDC simulated |
|---|---|---|
| Vault deposit | live | |
| Payout, one payment to many recipients | live | fork |
| Executor fee in the moved asset | live | fork |
| Import from Flare Smart Accounts | live | |
| Cash out to XRPL | live | fork |
| Rescue classifier | live, not recorded as a fixture | |
| Open executor service | live, deployed | |
| Status API | live | |
| Lending (Kinetic) | | fork |
| DEX (SparkDEX V3) | | fork |
| FTSOv2 rate bound | | fork, real oracle |

## Limits

**Latency is about two and a half minutes**, and most of it is FDC's voting round. See
[Latency across all live runs](/docs/evidence/latency) for every run.

**A cash-out's XRP arrives when an FAssets agent pays it**, not when memokit executes. Across five
live cash-outs, from the XRPL payment's ledger close to the payout's ledger close, that took from
140 s to 18.2 minutes; from the execute, from 9 s to 16.2 minutes. Every agent paid on time.

**A cash-out burns FXRP, and FAssets mints itself a fee.** Total supply falls by the redeemed lot
less that fee. memokit mints nothing, but it would be wrong to say nothing was minted in a
cash-out.

**One lot does not deliver one lot.** A 10.0 FXRP lot delivered 9.948010 XRP, after FAssets' pool
fee and the agent's redemption fee.

**Post-conditions are floors only.** There is no "at most" and no "went down by" yet.

**A payload-format change needs a redeploy, and a redeploy moves every account address.** See
[Accounts and derivation](/docs/concepts/accounts).

**An executor cannot run a `0xFC` commit instruction without its preimage**, because `execute` takes
the preimage as an argument. Sign inline for anything a stranger's executor should pick up.

**Racing between executors is built and tested, but has never happened live.** Every live run has
had one executor.

**The deployed executor is one machine with one key.** It flags itself when its balance runs low.

**Xaman signing is built but has never run against the live Xaman API.** The CLI's local QR
cannot be scanned by a standard XRPL wallet.

**The public infrastructure has limits.** The public DA Layer allows about 20 requests a minute. The
public Coston2 RPC prunes history and caps `eth_getLogs` at 30 blocks. See
[Networks and limits](/docs/reference/networks-and-limits).

**Mainnet costs are different.** A mainnet FDC request costs 20 FLR plus gas, against 1000 wei on
Coston2. See [FDC attestation request fees](/docs/reference/fdc-fees).

## Open

- A mainnet deployment: none exists.
- Xaman signing against the live API.
- A live `0xFB` rescue: tested only.
- What happens on an FAssets agent default, read from the FAssets contracts but never exercised.
- The executor service checking for an identical attestation request before paying for its own:
  deferred, because it saves nothing with one executor. The FSA import script does check, and has
  reused one twice.
