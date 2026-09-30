---
title: "Price protection: deadlines and the FTSOv2 bound"
description: "Deadlines and the FTSOv2 rate bound."
---

> **Fork only.** The FTSOv2 bound has been tested against the real oracle on a fork of Flare
> mainnet, with FDC verification simulated. It has not run as a live transaction.

An instruction is signed minutes before it executes. For anything that touches a price, a swap or a
borrow, those minutes matter. memokit gives an instruction three tools, all committed inside it, so
no executor can loosen them.

## 1. A minimum output

The simplest protection is the protocol's own: a swap's `amountOutMinimum`, set in the calldata you
sign. If the pool pays less, the swap reverts, and with it the whole instruction.

A minimum is absolute. It caps how much you can lose to anything, but it has to be loose enough to
survive the minutes of waiting, and a loose floor lets a manipulated pool through.

## 2. A deadline

Put a deadline in the calldata too, for protocols that take one, so a stale instruction cannot fill
long after you signed it:

```ts
import { deadlineFromNow, DEFAULT_DEADLINE_SECONDS } from "@memokit/sdk";

const deadline = deadlineFromNow();          // now + 900 s, in Unix seconds
```

`DEFAULT_DEADLINE_SECONDS` is **900**. It was derived from the worst run Phase 1 measured, plus one
missed 90-second FDC round, times 3.5. The slowest live run since took 174 s from the XRPL ledger
close to the execute, about 180 s from signing, so 900 s is still about 3.3 times a slow but ordinary
path. The derivation is next to the constant in `sdk/src/deadline.ts`. Pass your own number if your
tolerance is tighter.

## 3. The FTSOv2 rate bound

`FtsoRateAtLeast` is a post-condition. It bounds the rate a swap actually achieved against Flare's
FTSOv2 oracle, at execution time:

```ts
import { ftsoRateAtLeast, feedId } from "@memokit/sdk";

ftsoRateAtLeast(tokenOut, account, {
  feedIdIn: feedId("XRP/USD"),
  feedIdOut: feedId("USDT/USD"),
  decimalsIn: 6,               // the input token's decimals
  decimalsOut: 6,              // the output token's decimals
  amountIn: 1_000_000_000n,    // what the swap sells, in base units
  maxDeviationBps: 100,        // 1%
  maxFeedAgeSeconds: 300n,
});
```

After the calls, the contract measures how much `tokenOut` the subject actually received, prices
`amountIn` at the two feeds, and requires the received amount to be at least that fair amount less
`maxDeviationBps`. The feeds' own decimals are read live from the oracle, never committed. Three of
seven reference feeds report different decimals on Coston2 than on Flare mainnet, so a committed
value would misprice by powers of ten on one of them. See [FTSOv2 feeds](/docs/reference/ftso-feeds).

### What it catches

Pool manipulation, sandwiches, thin or stale pools: anything that moves one pool away from the wider
market, because the oracle is the wider market. On a Flare mainnet fork, a 35,000 FXRP dump moved the
real SparkDEX pool so that 1,000 FXRP returned 975.86 USDT0 instead of a fair 1,408.79, about 31%. A
signed minimum of 704.39 let that through. A 1% bound refused it. Run it:
[Lending and swaps, on a mainnet fork](/docs/guides/lending-and-swaps-fork).

### What it does not catch

Genuine market movement during the wait for an attestation. If XRP falls 3% in those minutes, the
oracle falls with it, and the fill is judged against the new rate. That is what the minimum output and
the deadline are for. **Use all three together**: each covers what the others cannot.

### Stale feeds

`maxFeedAgeSeconds` makes the instruction revert if either feed is older than that at execution. This
is tested against a mock oracle only. On a fork a feed's age is always zero, so it cannot be exercised
there.
