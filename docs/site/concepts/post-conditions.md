---
title: "Post-conditions"
description: "What an instruction was for, covered by the same hash as the calls."
---

The calls in an instruction say *how* to do something. Post-conditions say what it was *for*: what
must be true once the calls have run. If any post-condition fails, the whole instruction reverts.

## Why they exist

A call that does not revert has not necessarily done what you wanted. The plainest case is a
Compound-style lending market: it reports some failures as a return value rather than a revert. A
borrow that the market refuses returns an error code, the transaction succeeds, and without a check
the instruction is consumed as a success with nothing borrowed.

On a fork of Flare mainnet, Kinetic does exactly that with an oversized borrow. Without a
post-condition, the failed borrow is consumed as success; with one, the same failure unwinds
everything. See [Lending and swaps, on a mainnet fork](/docs/guides/lending-and-swaps-fork).

## How they work

- They are part of the payload, so they are **covered by the same hash as the calls**. No executor can
  drop or weaken them.
- They are evaluated **after every call and before the executor fee**. An instruction that did not
  deliver does not pay for delivery.
- A failure **reverts everything**, including the mark that consumes the XRPL transaction id. The same
  proof works again once the cause is gone.
- An instruction can carry **at most 32**.

## The kinds

| Kind | SDK helper | Holds when |
|---|---|---|
| `Erc20BalanceAtLeast` | `erc20BalanceAtLeast(token, subject, atLeast)` | `token.balanceOf(subject)` is at least `atLeast` afterwards |
| `Erc20DeltaAtLeast` | `erc20DeltaAtLeast(token, subject, atLeast)` | `token.balanceOf(subject)` rose by at least `atLeast`, against a snapshot taken before the calls |
| `NativeBalanceAtLeast` | `nativeBalanceAtLeast(subject, atLeast)` | the native balance of `subject` is at least `atLeast` |
| `NativeDeltaAtLeast` | `nativeDeltaAtLeast(subject, atLeast)` | the native balance of `subject` rose by at least `atLeast` |
| `FtsoRateAtLeast` | `ftsoRateAtLeast(tokenOut, subject, bound)` | a realised swap rate is within a bound of the FTSOv2 oracle; see [Price protection](/docs/concepts/price-protection) |

`subject` can be any address, not only the account. A payout asserts that each recipient was paid:

```ts
import { prepareInstruction, erc20DeltaAtLeast } from "@memokit/sdk";

prepareInstruction({
  sender: account, nonce, feeToken, feeAmount, calls,
  postConditions: recipients.map((to, i) => erc20DeltaAtLeast(token, to, amounts[i])),
});
```

[Payout to many recipients](/docs/guides/payout) runs this.

## Every condition is a floor

There is no "at most" and no "went down by". That matters for instructions that spend. A cash-out
cannot assert "exactly 10 FXRP left the account", so it asserts what must be left behind instead:
the account's balance after the redemption must be at least the expected remainder. The signing CLI
builds cash-outs and vault deposits with a floor already attached.

## Where they have run

Post-conditions have run live seven times, all passing: a balance floor on each of the four live
cash-outs, and a share floor on three vault deposits. None has yet caught a live failure. The
failure path is covered by the test suite (`test/PostConditions.t.sol`) and on the Kinetic fork.
