# Phase 3 — Safety, rescue, and closing the loop

Phase 2 made memokit do useful things. Phase 3 is about what happens when they go wrong, and
about the one direction the protocol could not yet go: back out to the XRP Ledger.

Six items, in the order they were built. Everything here was run. Where a result comes from a
fork rather than the real attested path, it says so at the point of the claim.

## Contents

0. [Payload versioning](#0-payload-versioning)
1. [Post-conditions](#1-post-conditions)
2. [Price protection](#2-price-protection)
3. [Stuck-instruction rescue](#3-stuck-instruction-rescue)
4. [Import from Flare Smart Accounts](#4-import-from-flare-smart-accounts)
5. [Cash out to XRPL](#5-cash-out-to-xrpl)
6. [What surprised me against live contracts](#6-what-surprised-me-against-live-contracts)
7. [Not done, and open](#7-not-done-and-open)

Test counts at the end of Phase 3: **145** Solidity, **131** TypeScript, **24** fork tests
(`npm run test:fork`).

---

## 0. Payload versioning

The payload now begins with a version byte, `0x02`.

It goes in the **committed payload**, not in the 10-byte header. The header stays byte-identical
to Flare's, because the header is chosen by the wallet that builds the memo and the payload shape
is chosen by whoever built the instruction. Putting a version in the header would have made every
integrated wallet care about a memokit-internal decision.

v1 needs no special case to reject. A Phase 1/2 payload begins with the first word of a
left-padded address, so its leading byte is always zero, and zero is not a known version. Every v1
payload fails with `UnsupportedPayloadVersion(0)` rather than mis-decoding into something
plausible. [`fixtures/memo-wire-v1.json`](fixtures/memo-wire-v1.json) freezes fourteen of them and
both the Solidity and the TypeScript side assert exactly that.

The version byte is read before `abi.decode` runs, so an unknown version is a named error rather
than a bare revert. That distinction turned out to matter the same week — see
[§6](#6-what-surprised-me-against-live-contracts).

## 1. Post-conditions

Phase 2 found that Compound-family markets report most failures as a nonzero return value rather
than a revert: a call can succeed while doing nothing, and the instruction is consumed for a no-op.
Phase 2 worked around it by appending a self-transfer that reverts unless the balance is really
there. That worked, but it cost a call, expressed one shape of claim, and reading the instruction
gave no hint that the fifth call was an assertion rather than part of the operation.

`PostCondition[]` says what the instruction was *for*, separately from how it was done, and is
covered by the same commitment hash as the calls — so no executor can weaken it.

| Kind | Claim |
|---|---|
| `Erc20BalanceAtLeast` | a token balance is at least X |
| `Erc20DeltaAtLeast` | a token balance rose by at least X since before the calls |
| `NativeBalanceAtLeast` | a native balance is at least X |
| `NativeDeltaAtLeast` | a native balance rose by at least X |
| `FtsoRateAtLeast` | the realised rate beat the FTSOv2 rate by no worse than N bips |

Deltas are measured against a pre-execution snapshot **on any address**, not just the account, so
a payout can assert that each recipient was paid rather than only that the account emptied.
Maximum 32 conditions.

Ordering is load-bearing: conditions are evaluated **after the calls and before the executor fee**,
so an instruction that did not deliver does not pay for delivery. A failure reverts everything —
calls, nonce, and the replay mark — which means the identical proof can be resubmitted once the
cause is gone. A test drives exactly that.

Against Kinetic on a Flare mainnet fork, replacing the Phase 2 trailing self-transfer with an
`Erc20DeltaAtLeast` removed a call, cost slightly less gas (1,441,500 against 1,462,139), and made
the failure name itself: `PostConditionFailed(0, Erc20DeltaAtLeast, wanted, got)` instead of an
opaque `CallFailed(4, ...)`.

**The limit, stated plainly: every condition is a floor.** There is no `AtMost` and no
"went down by". That is fine for any instruction that acquires something and wrong for one that
spends — see [§5](#5-cash-out-to-xrpl), where it is the reason the cash-out cannot assert its own
purpose.

## 2. Price protection

`FtsoRateAtLeast` bounds a realised swap rate against the FTSOv2 oracle at execution time.

Tested against SparkDEX V3 on a fork of Flare mainnet, with the **real** oracle — only FDC
verification is simulated there. Real numbers at the pinned block:

| | |
|---|---|
| fair quote for 1,000 FXRP | 1408.79 USDT0 |
| after dumping 35,000 FXRP into the pool | 975.86 USDT0 (~31% below) |
| loose floor the user signed | 704.39 USDT0 |
| with the floor alone | **accepted** |
| with an FTSOv2 bound at 1% | **refused**, proof stays usable |

Three design decisions, each with a consequence worth knowing.

**Token decimals are committed; feed decimals are not.** A live read across both networks shows 3
of 7 reference feeds report different decimals on Coston2 than on Flare mainnet — USDT/USD and
USDC/USD are 6 against 5, SGB/USD is 9 against 8. Pinning them would have passed every test on
Coston2 and mispriced by 10x on mainnet. They are read from the feed on every evaluation.

**The bound is one-sided.** A fill better than the oracle is not the user's problem.

**It protects against pool state, not against time.** Manipulation, sandwiching and a thin pool
are caught. Genuine market movement during the ~150 s an attestation takes is *not*, because the
oracle moves with the market. Two tests pin the distinction from both directions: the oracle bound
alone lets a real 30% market move through, and an absolute floor alone lets a 26% pool
manipulation through. Use both. `DEFAULT_DEADLINE_SECONDS` exists for the time half.

**`maxFeedAgeSeconds` cannot be tested on a fork.** FTSOv2 derives its timestamp from the current
voting epoch, computed from `block.timestamp`, so a forked feed's age is always zero however far
you warp. A stale-feed fork test was written, failed, and was **removed rather than made to pass**;
the branch is covered against a mock in `test/FtsoRateBound.t.sol`, and the fork limitation is
asserted as its own test so nobody adds the misleading version back.

## 3. Stuck-instruction rescue

An instruction crosses two chains and an attestation protocol, and can stall in any of four
places. From the user's side all four look identical: they paid, and nothing happened.

`classifyPayments` sorts every XRPL payment an owner sent to the receiving address into one of
seven states and says what to do about each.

| State | Final | What is lost | What to do |
|---|---|---|---|
| `executed` | yes | the carrier payment | nothing — it did what it said |
| `retired` | yes | the carrier payment, plus the one that carried the `0xE0` | nothing |
| `awaiting-attestation` | no | nothing yet | request the attestation, wait ~150 s |
| `attested-not-executed` | no | nothing yet | submit the proof — anyone can, including the owner |
| `execution-failed` | no | nothing on chain; only the executor's gas | fix the cause and deliver the same proof again |
| `expired` | yes | carrier payment, and the attestation fee if one was paid | re-sign the same instruction in a fresh payment |
| `not-an-instruction` | yes | the payment | nothing — it carries no memo memokit understands |

`execution-failed` is the one worth reading twice: a failed execution **reverts**, so the
transaction id is not consumed, the nonce did not move, and the identical proof works once the
cause is gone. And a stuck instruction that is blocking the queue is a separate problem from a
lost one — that is what `0xFB` below is for.

Three separate things can go, and they are easy to conflate, so `RESCUE_STATES` spells it out per
state: the **carrier payment** (always spent, in every state including success — it is the
postage), the **attestation fee** (burnt, not refunded, if the request never confirms), and the
**instruction** itself. **The account's assets are never at risk in any stalled state**, because
they never moved.

### One new opcode: `0xFB NonceAtLeast`

`0xE0`/`0xE1`/`0xE2` cover most rescues, but `0xE1` sets an *exact* nonce and reverts unless it is
strictly greater than the current one. The value has to be chosen when the memo is signed and does
not land for ~150 s, so if anything else executes in that window the rescue reverts — the rescue
for a stuck queue fails because the queue unstuck itself.

`0xFB` says "be at least N": monotonic and idempotent, so tooling can issue it without racing.
Claimed from the reserved band; `0xF8`–`0xFA` stay reserved.

### What the failure-injection suite caught

It drives all seven states by construction through an injected chain reader, and checks the
proposed rescue is the right opcode with the right target. It caught an off-by-one: a dead
instruction bound to *exactly* the current nonce blocks the queue too, because the account can
only reach N+1 by executing N. The fix went in the implementation, not the test.

### Two honest limits

A `0xFC` memo carries only a hash, so the instruction's nonce is invisible from the ledger alone.
The classifier reports that rather than guessing, and accepts a preimage — checked against the
commitment — to reach a real verdict.

The DA Layer is keyed by round, not by transaction, and `eth_getLogs` is capped at 30 blocks on
the public RPC, so "is there a proof" is a bounded search forward from the XRPL close. A negative
answer means "not in the window", and the rescue it proposes — request an attestation — is
idempotent, so guessing low is safe.

Run against the live Coston2 deployment: 7 payments, 1 executed, 6 attested but never delivered,
which is exactly the debris the Phase 1 debugging left behind.

## 4. Import from Flare Smart Accounts

**The hypothesis was verified before anything was built, as asked, and it held.**

The split-balance problem is real. A memokit account address depends on the memokit beacon and
controller, so the same XRPL address owns a *different* account under each protocol, and FXRP
sitting in an FSA account cannot be reached without an EVM wallet — the thing memokit exists to
avoid needing.

What the verification established about FSA's payment-reference instruction `0x01`:

- it chains `Instructions.executeInstruction` → `FXrp.transfer` → `personalAccount.transferFXrp` →
  `fAsset.safeTransfer`;
- the source of funds is the FSA account's own balance;
- the recipient is bytes 12..31, with no allowlist beyond non-zero;
- the amount is a `uint80` in drops, and FXRP's 6 decimals make drops and base units the same
  number;
- byte 1 (wallet id) is not validated on this instruction at all;
- the protocol fee is `getInstructionFee(0x01)`, 1000 drops on Coston2.

On the open question of whether someone else relays FSA instructions for arbitrary users: in
practice, yes. `0xcA0Bf4Cb…` — the FSA controller's main relayer, an EOA whose recent transactions
all go to that controller — relayed our imports in runs 1 and 3 without any arrangement. The chain
does not say who operates it. memokit does not depend on it either way. `executeInstruction` has no access control — simulating it from an
unrelated EOA reverts `InvalidPaymentAmount`, a validation error rather than an authorisation one
— so memokit can relay the proof itself.

Both halves are on chain, which is better evidence than either alone:

| Run | Amount | Relayed by | Transaction |
|---|---|---|---|
| 1 | 5.0 FTestXRP | another relayer, `0xcA0Bf4Cb…` | [`0x7faeb3ec…7d84`](https://coston2-explorer.flare.network/tx/0x7faeb3ecf2f463cb269a0c2540c57c673cfd8f4d059cdfc4421f743132777d84) |
| 2 | 4.0 FTestXRP | us | [`0xe7f4ac74…106b`](https://coston2-explorer.flare.network/tx/0xe7f4ac745ed10d3e45dec8934afd9df9f15ddd3536ba393acaa7db7d4fd5106b) |

FSA account 10.0 → 5.0 → 1.0, memokit account 10.1 → 15.1 → 19.1, read from archive state at each
execute block rather than from script read-back. Run 1 is the more interesting one: our own relay
lost the race. It was refused with `TransactionAlreadyExecuted` in simulation and never broadcast —
there is no transaction from us to the FSA controller in the blocks around it — so it cost no gas.
Losing that race is treated as success, because it is: the instruction executed. The script detects
it, finds the transfer the other relayer produced, and records the address that sent it. End to
end, run 2 took 162 s; run 1 took 173 s from XRPL ledger close to the other relayer delivering it.

One more thing the chain shows, found when run 1 was re-read on 2026-09-23. **In both runs, an
attestation for the same XRPL payment was requested by `0x096103b7…` three to four blocks before
ours.** Our request was redundant both times: it cost the fee and about 83,000 gas and bought
nothing. `0x096103b7…` is an EOA whose recent transactions are all `requestAttestation` calls,
mostly for payments to the FSA controller's provider wallet. The chain does not say who operates
it, and this page does not guess.

The import script now checks for exactly this before paying: it rebuilds its request bytes, scans
FdcHub's `AttestationRequest` events from the XRPL close for an identical request, and reuses that
request's voting round if it finds one, paying for its own only if that round produces no proof.
**Run 3, on 2026-09-23, paid no attestation fee.** The check found `0x096103b7…`'s identical
request 7 blocks after the XRPL close, the proof for its round was served, and there is no request
from us on chain for that payment. Another relayer, `0xcA0Bf4Cb…` again, executed it: 0.5 FTestXRP,
FSA 1.0 → 0.5, memokit 7.35 → 7.85, 124 s end to end
([`fsa-import-run3-trace.json`](fixtures/measurements/fsa-import-run3-trace.json)).

Run 1's trace was reconstructed from the chain on 2026-09-23, because the script's own record of it
was overwritten by run 2: [`fsa-import-run1-trace.json`](fixtures/measurements/fsa-import-run1-trace.json).
Run 2's is [`fsa-import-trace.json`](fixtures/measurements/fsa-import-trace.json).

`deriveBothAccounts` reads each account from its own controller rather than reproducing FSA's
frozen creation-code constant, because a second copy of that derivation could silently disagree
with theirs about where someone's funds are. `buildImportReference` refuses what FSA would reject
on chain — zero value, zero recipient, an amount past `uint80` — before the payment is signed
rather than 150 s later.

## 5. Cash out to XRPL

The loop closes. One XRPL Testnet payment instructs the account to call FAssets `redeem`; the FXRP
burns on Flare and an agent sends XRP back. **The user starts and ends on the XRP Ledger and never
holds an EVM key.**

### Live on Coston2

| | |
|---|---|
| memokit diamond | [`0x0E762EAe…0714`](https://coston2-explorer.flare.network/address/0x0E762EAe8fe53e5247C22E5B52feD7A018150714) |
| account | [`0x9dD656e6…d741`](https://coston2-explorer.flare.network/address/0x9dD656e6FE2f9B46E57CE29265b3C66feCa2d741) |
| XRPL Payment in | [`A92E0E7C…3E47`](https://testnet.xrpl.org/transactions/A92E0E7CA45E071E641EAD562CFEE04B2C4B839B4BF13A914B19D17B190C3E47) |
| execute | [`0x4527b740…5022`](https://coston2-explorer.flare.network/tx/0x4527b740567a534f15452b65215304d2bdafdcdd216fdc9db01682eb2d105022) |
| XRPL payout | [`F7858109…9ECD`](https://testnet.xrpl.org/transactions/F7858109B0AD251D1BB44227AAB73E10F4651587FA30022278AA497A485E9ECD) |
| result | one 10.0 FXRP lot burned (account 19.1 → 9.1); 9.948010 XRP delivered on XRPL |
| latency | **148 s** from XRPL submit to XRP delivered on XRPL: 127 s to the execute (100 s of it attestation), then the agent paid 21 s later |
| Flare confirms the payout | 297 s after submit, block 35694411 — a separate measurement, see below |
| trace | [`cash-out-trace.json`](fixtures/measurements/cash-out-trace.json) |

Three clocks run through this, and an earlier version of this section conflated them:

- **148 s** — XRPL submit to XRP arriving on XRPL. What the user waits.
- **297 s** — XRPL submit to Flare *confirming* the payout. The agent can only confirm after proving
  its own XRPL payment through FDC, which is another voting round after the XRP has arrived.
- **321 s** — when the redemption tracker, polling every 15 s, *noticed* that confirmation. A
  property of the tracker, not of the protocol.

This page originally reported 321 s as the time "until the XRP landed", with "193 s for the agent to
pay". Both were wrong: the agent paid 21 s after `redeem`. The chain timestamps behind each figure
are in the trace's `timingCorrection`.

Verified independently of the script's own read-back: the payout's XRPL memo is byte-identical to
`paymentReference` in the Flare `RedemptionRequested` event
(`0x46425052664100020000000000000000000000000000000000000000033158c2`), `delivered_amount` on the
validated XRPL transaction is 9,948,010 drops, and the account's balance and nonce moved by exactly
one lot and one step.

### Three ways this instruction is not like the others

**It is not atomic.** Every other memokit instruction finishes inside one Flare transaction.
`redeem` creates an *obligation*; an agent discharges it minutes later by sending XRP, or is
defaulted. `redemptionTracker.ts` follows it to whichever, reading every deadline from the
`RedemptionRequested` event itself — `lastUnderlyingBlock` and `lastUnderlyingTimestamp` are the
contract's own per-request view of "late", not a global constant.

Two things about the default path that are easy to miss, so `REDEMPTION_DEFAULT_NOTE` states them:
the compensation is paid **on Flare, in collateral**, not in XRP — a user who cashed out to get XRP
and hit a default gets FLR-denominated value in their memokit account and has to cash out again —
and the default is **not automatic**: somebody has to submit the `ReferencedPaymentNonexistence`
proof.

**It is denominated in lots.** `redeem` takes whole lots and the Coston2 lot is 1e7 base units
(10 FXRP). Anything below a lot boundary cannot be redeemed at all, so `planCashOut` computes the
dust and reports it rather than rounding it away. In the live run, 9.1 FXRP stayed behind.

**A post-condition cannot express its claim.** Every condition memokit has is a floor
([§1](#1-post-conditions)) and the meaningful assertion here is that a balance went *down*. What
the instruction asserts instead is that the dust survived, which at least catches an execution
that emptied the account unexpectedly. `CASH_OUT_POST_CONDITION_NOTE` says so rather than leaving
it as a silent omission. A `BalanceAtMost` / `DeltaDownAtLeast` pair is the obvious next addition
to `IPostConditions`.

### Redirecting the payout

The XRP goes to the payer's own XRPL address by default. Sending it elsewhere requires both the
address and a literal `iAcknowledgeThisSendsToSomeoneElse: true`, because the destination is a
plain string inside a memo signed blind on a phone; a plausible wrong one is unrecoverable and
nothing downstream can catch it. The safe case is the silent one; the unsafe case cannot be reached
by a spread or a typo'd field name.

### What actually arrives

`plan.redeemableAmount` is what leaves the account. It is **not** what arrives. One 10.000000 FXRP
lot produced 9.948010 XRP, through two deductions that are neither memokit's nor configurable from
here:

1. `redeem` burns the full lot but mints a small FAsset fee to the agent's collateral pool in the
   same transaction — 2,000 of 10,000,000 base units, visible in the receipt. The obligation the
   agent takes on (`valueUBA`) is the remainder, 9.998000.
2. The agent keeps `feeUBA`, 0.049990 — 50 bips of `valueUBA` on Coston2 — and pays the rest.

Both are per-network settings that can change, so `CASH_OUT_SHRINKAGE` records the measurement and
tells callers to quote `valueUBA - feeUBA` from the event rather than predict it from the lot size.

### Why there is a fork test as well

The first attempt **failed**, but not the way this page first described it. It was a *simulated*
`redeem(1)` sent directly from the account, not a live cash-out through memokit, so none of
memokit's own checks were in the path. It reverted `RedeemZeroLots()` because Coston2's
redemption queue was empty at that block (35645314) — confirmed from archive state, where replaying
the same call at that block reproduces the revert. A 30 FXRP ticket appeared about three minutes
later and was drained again within ten. That is an inventory failure, not a code failure. A day
later the same instruction ran live; the queue was five tickets deep minutes before that trace and
one ticket deep minutes after. Both readings are in
[`coston2-redemption-capacity.json`](fixtures/measurements/coston2-redemption-capacity.json).

`test/fork/CashOutFork.t.sol` exercises the same instruction against the real AssetManager on a
fork of **Flare mainnet**, where the queue is hundreds of thousands of FXRP deep, so the suite does
not fail for reasons that have nothing to do with this code. FDC verification there is simulated,
as in every fork test.

## 6. What surprised me against live contracts

**A redeploy strands the funds, and the failure looks like nothing.** Payload v2 changed the
decoder, so the Phase 2 diamond — which decodes five fields — met a payload with a version byte and
six. The live cash-out reverted **with no data at all**. Traced on a local anvil fork: the proof
verified, then a bare revert with no external call, which is `abi.decode` failing. The named
`UnsupportedPayloadVersion` error only helps a *new* contract reading an *old* payload; the reverse
direction cannot be helped by anything in the new code, because the old code is what runs.

The second-order problem is worse than the first. The diamond address is inside every account's
CREATE2 init code, so a redeploy gives each owner a new account and the old one keeps the money.
`executor/src/migrateFunds.ts` is the way across: it spends the old account with a real instruction
on the old diamond, in the old payload format. Those legacy encoders no longer exist in the SDK —
the SDK only ever emits the current format — so they live in the migration script, which is the
difference between migrating funds and stranding them. Run for real:
[`0x8f35ae17…0ead`](https://coston2-explorer.flare.network/tx/0x8f35ae17ed4a341af871546362f1561ec80da1157876806b4e865c160fab0ead),
19.1 FTestXRP moved, verified from the receipt's `Transfer` log and both balances.

**`getFeedById` is payable, not view.** A rate bound therefore cannot be evaluated from a static
context, which is why `PostConditions.check()` is non-view while `snapshot()` is.

**Feed decimals are per-feed *and* per-network.** 3 of 7 reference feeds differ between Coston2 and
Flare mainnet. Committing them would have been a 10x mispricing that every testnet test passed.

**`RedemptionRequested` has nine non-indexed fields.** Decoding seven reverts, which is how the
count got checked.

**Flare's public RPC prunes state hard enough to break forking.** Fork tests that touch storage the
node has not already served fail with "missing trie node" — at a pinned block still 50 blocks
behind head. The other fork tests only survived because forge had cached their reads. `foundry.toml`
now carries a separate `flare_archive` endpoint.

**FSA's `executeInstruction` has no access control**, and the controller's main relayer will race you to it. See
[§4](#4-import-from-flare-smart-accounts).

**A testnet's FAssets inventory is not infrastructure.** It empties and refills on other people's
schedule. Any test that depends on it is flaky by construction.

## 7. Not done, and open

- **No `AtMost` post-condition.** The cash-out cannot assert its own purpose ([§5](#5-cash-out-to-xrpl)).
- **No mainnet deployment, and no mainnet transaction.** Lending, DEX and the deep-queue cash-out
  are fork results with simulated FDC verification.
- **A default is not automatic.** memokit does not submit the non-existence proof for a redeemer
  whose agent never pays; that is executor-service work.
- **The public DA Layer allows about 20 requests a minute.** A self-hosted one is still the obvious
  next step.
- **The agent's time to pay is not ours to improve**, and not bounded by anything memokit controls.
  It was 21 s in the one live run; Flare confirmed the payout 149 s after that, on the agent's own
  FDC proof.

## Reproducing

```bash
forge test              # 145 Solidity tests
npm test                # 131 TypeScript tests
npm run test:fork       # 24 fork tests: needs network and ffi

# live, needs .env (see .env.example):
npm run cash-out -w @memokit/executor -- --lots 1
npm run rescue   -w @memokit/executor
npm run import-fsa -w @memokit/executor
```
