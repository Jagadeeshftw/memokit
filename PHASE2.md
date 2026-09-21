# Phase 2 — Housekeeping, three integrations, a publishable SDK

Phase 1 proved the path with one instruction. Phase 2 closes the open items it left, runs three
different kinds of instruction through it (a payout live on Coston2, lending and a DEX on a fork of
Flare mainnet), and packages the client as a library.

Everything here was run. Where a result comes from a simulation rather than the real attested
path, it says so at the point of the claim.

## Contents

1. [Housekeeping](#1-housekeeping)
2. [The executor fee](#2-the-executor-fee) — design, and the griefing analysis
3. [Selector collisions](#3-selector-collisions)
4. [Payout, live on Coston2](#4-payout-live-on-coston2)
5. [Lending and DEX on a mainnet fork](#5-lending-and-dex-on-a-mainnet-fork)
6. [Recovery: what "stuck" actually means](#6-recovery-what-stuck-actually-means)
7. [The SDK](#7-the-sdk)
8. [What surprised me against live contracts](#8-what-surprised-me-against-live-contracts)
9. [Not done, and open](#9-not-done-and-open)

Test counts at the end of Phase 2: **105** Solidity, **78** TypeScript, **15** fork tests
(`npm run test:fork`).

---

## 1. Housekeeping

Done first, before any new account address was recorded, as asked.

| Item | Outcome |
|---|---|
| Rename `isTransactionIdUsed` | Now `isXrplTransactionConsumed`. It was the last known collision with Flare's controller. |
| Collision class closed | A test diffs every memokit external selector against Flare's live selector set on both networks. [§3](#3-selector-collisions). |
| Executor fee in the moved asset | No separate fee token. Fee token and amount are inside the committed payload. [§2](#2-the-executor-fee). |
| ERC-1363 receiver | `PersonalAccount.onTransferReceived`, matching Flare's live account, with a `transferAndCall` test. |

### A Phase 1 defect found on the way: the repo did not build from a clean clone

`.gitignore` contained `lib/`. That silently excluded `scripts/lib/FacetSelectors.sol`, which the
deploy script and every test import, and `forge-std` was not tracked either. Phase 1 built and tested
green on the machine that made it, and a fresh clone failed to compile.

Fixed in `cacf634`: the rule is gone, `FacetSelectors.sol` is tracked, `forge-std` is a pinned
submodule (v1.10.0). Verified from a fresh `git clone --recurse-submodules`: **74 tests passed at that
commit**, and the previous commit fails on the same clone. The README now says to clone with
`--recurse-submodules`.

### ERC-1363: what Flare's account actually does

Flare's live `PersonalAccount` (Coston2 and mainnet, checked 2026-09-21) accepts
`onTransferReceived` **unconditionally** and returns the magic value. memokit's does the same and
answers ERC-165 for the interface. It does nothing else on purpose: the account's assets move only by
attested instruction, so an unconditional accept cannot be turned into a way to spend them.

The interface surprise: the account is created **lazily**, so before its first instruction an
address holds no code. A plain ERC-20 `transfer` into it works (the Phase 1 trace depended on one).
`transferAndCall` reverts against an account that does not exist yet, because ERC-1363 requires the
receiver to answer. `test/Erc1363Receiver.t.sol` pins both, plus a hookless control.

---

## 2. The executor fee

### What was wrong

Phase 1 paid the executor in a separately configured fee token, read from a header `uint64`. That
made the account hold two assets: the one it was moving and the one it paid with. The live runs used
a zero fee to avoid the problem, so the design was never exercised.

### The design

The fee is two fields **inside the committed instruction**:

```
payload = abi.encode(sender, nonce, feeToken, feeAmount, Call[] calls)
memo    = header ++ keccak256(payload)             // 0xFC; 42 bytes
```

- **Asset.** `feeToken` is whatever the instruction moves, so the account never needs a second token
  and never needs FLR. The live payout paid its executor 0.1 FTestXRP out of the 5.0 it was paying
  out.
- **Committed.** Because both fields are in the hashed payload, an executor who reads the preimage
  cannot change the token or the amount. `test_executorCannotSubstituteADifferentFee`. On the fork, the
  same property protects a swap's `amountOutMinimum`: `test_anExecutorCannotLoosenTheCommittedFloor`.
- **Paid last, only on success.** The fee transfer happens after every call has succeeded, in the
  same transaction as the calls. A failing call reverts the whole `execute`, so the fee is never paid
  for a failure. If the calls leave the account unable to pay it, the whole execution reverts too
  (`test_revertsAndUnwindsWhenTheCallsLeaveNothingToPayTheFee`); paying it *from the proceeds* of the
  calls is allowed and tested.
- **Recipient.** `msg.sender` of `execute`. Whoever lands it first is paid.
- **`feeAmount == 0`** means no fee and the token field is ignored.

### What the header's `uint64 executorFee` means now

**It is reserved and must be zero.** The field keeps its position and width so the header stays
byte-compatible with Flare's, but a non-zero value is rejected on every opcode (`HeaderFeeReserved`).

The alternative was "the amount, in the payload's token". I rejected it because the header and the
payload would then both carry a fee, and three things break:

1. The two can disagree, and something has to say which wins.
2. `0xE0`, `0xE1` and `0xE2` memos have a header but **no payload**, so a header fee on them has no
   token to be paid in.
3. `0xE2` (replace fee) exists to override the fee; with the fee in two places it is unclear which
   it overrides.

One place, inside the hash, has none of these. The cost is that a wallet written for Flare's header
that sets a fee gets a loud revert instead of a silently ignored number. That is deliberate. A memo
rejected for it is not stranded: `test_aMemoRejectedForItsHeaderFeeCanStillBeRetired` shows `0xE0`
retiring it. `0xE2` now overrides the payload's **amount** only, never the token.

The SDK enforces it too: `encodeMemo` throws on a non-zero header fee unless told to allow it.

### Griefing analysis

The premise: an executor sees the whole preimage before it decides to submit, and submits at its own
expense. What can it do to the user, and what can the user (or anyone else) do to it?

All gas numbers come from `test/ExecutorEconomics.t.sol` and the fork tests. The unit-test numbers use
a mock FDC verifier, which is far cheaper than the real Merkle check, so treat them as floors.

#### What an executor cannot do

| Attempt | Why it fails |
|---|---|
| Change a call, a target, an amount, the nonce or the sender | The payload is hashed into the memo; `CommitmentMismatch`. |
| Change the fee token or amount | Both are inside that hash. |
| Loosen a swap's `amountOutMinimum` or extend its `deadline` | Both are call arguments, so inside that hash. Demonstrated on the fork. |
| Take a larger fee via the header | The header fee must be zero. |
| Replay an instruction | The transaction id is consumed on success; `TransactionAlreadyUsed`. |
| Run instruction N+1 before N | `InvalidNonce`. |
| Use `msg.value` to change what runs | It is forwarded to the account and can only add to its native balance; no call in the payload depends on it (`test_executorValueOnlyDonatesToTheAccount`). |
| Skip the fee check by reverting late | A revert unwinds everything, including the calls. |

#### What an executor can do

| Action | Bound |
|---|---|
| **Delay.** Hold the proof and submit late. | Proofs stay valid for `validityDurationSeconds` (24 h in the deployment). A price-sensitive instruction is bounded by its own committed deadline instead: the swap reverts with `TransactionDeadlinePassed` after it. |
| **Extract value from a price-sensitive call** (sandwich a swap). | Bounded by the committed floor. With a 0.5% floor the most an executor can take is 0.5% of the output. The floor is the user's *price* for permissionless execution. |
| **Refuse to submit.** Censor. | Execution is permissionless: anyone with the proof and the preimage can submit and earn the fee. |
| **Copy another executor's transaction.** | It can win the fee (first valid `execute` is paid) but cannot alter what runs. |

#### The executor's gas when an instruction reverts

The whole `execute` reverts. The executor **pays the gas and earns nothing**: no fee is paid, and
nothing is consumed. The transaction id stays unused and the nonce does not move, so the same proof
and preimage work again once whatever made it fail has cleared
(`test_aFailedInstructionIsRetriableOnceItsCauseClears`).

| Measured | Gas |
|---|---|
| Successful execute (one transfer + fee, mock verifier, includes first-use account deployment) | 406,710 |
| Reverted execute (one failing call, same setup) | 303,621 |
| Reverted swap on the fork (real router, price moved) | 488,134 vs 707,012 for the successful one |
| Executor's loss when the owner's own instruction lands first | 45,875 |

So a failed attempt costs an executor most of a successful one. The protocol does not compensate it,
by design: the requirement was that a fee is paid only for a success. What the executor can do is
**simulate immediately before submitting** (`eth_call` with the same proof and preimage). The residual
risk is what changes between simulation and inclusion.

That residual is real and **an owner can exploit it**. `test_anOwnerCanMakeASimulatedSuccessRevertOnChain`
does it: the executor's dry run passes, the owner's own competing instruction lands first, and the
executor's transaction reverts on the nonce. The owner has spent an XRPL payment and an attestation
fee; the executor has spent gas. It is cheap for an executor to lose (45,875 gas above) but it is not
free, and it is not something contracts can fix: it needs executors to price it into the fee they
require, or a reputation layer. **Nothing in the protocol makes the fee cover the expected loss.**

#### A lever the tests found, and closed

The first version of `ExecutorEconomicsTest` asserted that a target cannot make a failing instruction
more expensive by reverting with a large blob, on the assumption that the account already bounded
what it copies back. **It did not.** `executeUserOp` used a plain `target.call(data)`, which copies
the callee's whole return data into memory, on success as well as failure, and the failure path
re-encoded it into `CallFailed`.

| Callee reverts with | Account's overhead before | After |
|---|---|---|
| 32 bytes | 334k | 334k |
| 10 KB | 348k | 338k |
| 300 KB | **1.82M** | 338k |

An owner could therefore bill an executor five times as much gas for a revert by pointing one call at
a contract that returns a large blob. The account now makes the call without copying return data and,
on failure, copies at most 256 bytes of reason (`PersonalAccount._call`). Callers' own gas is still
whatever the callee burns building the blob, which the owner could equally spend in a loop and which
the executor bounds with its gas limit.

Verified by mutation: with the naive call restored, three tests go red
(`test_theAccountAddsNoSizeProportionalCostToARevert`,
`test_aLargeReturnValueOnASuccessfulCallIsNotCopied`,
`test_revertReasonsAreKeptUpToTheCapAndTruncatedBeyondIt`); with the fix they pass. The bounded reason
is still enough to be useful: the fork tests decode the router's `V3TooLittleReceived` from it.

---

## 3. Selector collisions

**Result: green. Zero overlaps with Flare's live `MasterAccountController` in the drop-in unit, on
both networks, at the pinned blocks.** `test/SelectorCollision.t.sol`, 5 tests.

The bug class: a selector that memokit shares with Flare's diamond is not a compile error and not a
failure anywhere else in the repo. It surfaces as a reverted cut at best, and at worst as callers
silently reaching Flare's implementation and reading Flare's state as if it were memokit's.

| | Coston2 | Flare mainnet |
|---|---|---|
| Fixture block | 35,633,008 | 70,265,577 |
| Facets in Flare's diamond | 18 | 15 |
| Selectors | 74 | 59 |

The two networks differ, so both are pinned. `fixtures/flare-selectors/{coston2,flare}.json` are the
loupe output at those blocks.

**How it stays honest**

- memokit's side is read from the **compiled artifacts** (`methodIdentifiers`), not from
  `FacetSelectors`. A function added to a facet is checked whether or not anyone listed it. A
  companion test asserts the deploy cut routes every external function of every facet, closing the
  reverse hole (passes in tests, `FunctionNotFound` on chain).
- Overlap is the failure. `MemoControllerFacet` and `AccountsFacet` (the drop-in unit) have **zero**
  exemptions. Every other exemption is exact and justified in the test; an entry that no longer
  overlaps also fails, so it cannot rot into a blanket allow.
- It collects **every** overlap into one report rather than stopping at the first.

**Refresh:** `npm run selectors:refresh -w @memokit/executor` rewrites both fixtures from chain.
`npm run selectors:check` re-reads the chain and **exits 1 on drift**; I verified that by tampering
with a fixture. The fixtures are snapshots: Flare's diamond is upgradeable, so a green test proves no
collision *as of the pinned blocks*. Run `selectors:check` before trusting an old green.

**The mechanical diff beat the hand diff.** Phase 1 recorded three overlaps in `AdminFacet` (`owner`,
`pause`, `unpause`) from a hand diff. The mechanical one found **six**: `isPauser(address)`,
`isUnpauser(address)` and `transferOwnership(address)` had been missed. All six are in a facet that was
already outside the drop-in unit, which is why the miss was harmless, but it is the argument for not
diffing by hand.

**The other exemptions, and why they are structural**

| Surface | Overlap | Why it is not a bug |
|---|---|---|
| `AdminFacet` | the six above | A host diamond has its own owner and pause; `AdminFacet` is not part of the drop-in unit. |
| `DiamondLoupeFacet` | 4 | EIP-2535 requires exactly these; any two diamonds overlap. |
| `DiamondCutFacet` | `diamondCut` | Same. |
| `PersonalAccountBeacon` | `implementation()` | `IBeacon` fixes this name. Flare's controller is its own beacon, so it has it. memokit's beacon is a **separate contract, never cut into Flare's diamond**, which is the reason it is separate. |
| `PersonalAccount` | `supportsInterface(bytes4)` | ERC-165; both mean "what does this contract implement". Never cut into any diamond. |

**Proof the detector can go red.** I renamed the controller's view back to Flare's
`isTransactionIdUsed` (in the facet, interface, `FacetSelectors` and the tests that call it) and ran
the suite:

```
[FAIL: MemoControllerFacet overlaps Flare in fixtures/flare-selectors/coston2.json: 1 != 0]
        test_dropInUnitNeverOverlapsFlare()
[FAIL: memokit selectors also routed by Flare's MasterAccountController ...
  coston2: MemoControllerFacet 0x8e103030 (isTransactionIdUsed(bytes32))
  flare:   MemoControllerFacet 0x8e103030 (isTransactionIdUsed(bytes32))]
        test_everyOverlapIsExplainedAndNoExplanationIsStale()
```

Restored, 5 of 5 pass. `test_theDiffDetectsAPlantedCollision` keeps that proof permanent.

---

## 4. Payout, live on Coston2

One XRPL Payment with a `0xFC` memo produced five FTestXRP transfers. Trace:
[`fixtures/measurements/e2e-trace-payout.json`](fixtures/measurements/e2e-trace-payout.json).

| | |
|---|---|
| XRPL Payment | [`3CBD8EC9…48C1`](https://testnet.xrpl.org/transactions/3CBD8EC9C22984B2E2CD97C842BBE01C2A2D34E373705F4C81FB56B08A5948C1) (validated, `tesSUCCESS`, one memo, **no destination tag**) |
| requestAttestation | [`0x220592a4…0102`](https://coston2-explorer.flare.network/tx/0x220592a48930a10d7ec73d2981622d2d94dc3f16b85231c5cb97d2b69d690102), block 35,634,011, round 1,461,499 |
| execute | [`0x2f6faf66…64ad`](https://coston2-explorer.flare.network/tx/0x2f6faf66bcb73632cf5762ee93a40e6943670ecf06a382d36766062c4edf64ad), block 35,634,055, 915,998 gas, **one attempt** |
| memokit diamond | [`0x98882776…9E36`](https://coston2-explorer.flare.network/address/0x98882776ED3CB4b3abB86CceFE2f46C1aAed9E36) |
| account | [`0x8F1eD3f5…43b1`](https://coston2-explorer.flare.network/address/0x8F1eD3f5355846008A47ce91Fbc49EE1808d43b1) |

**Per-recipient balance deltas** (block before → execute block):

| Recipient | Delta (FTestXRP) |
|---|---|
| `0x3831fD5b…4FDc` | +1.2 |
| `0x7ebD4725…AF97` | +1.1 |
| `0x43102538…Ea34` | +1.0 |
| `0xF8884B95…b3fA` | +0.9 |
| `0xa87489ea…07bC` | +0.7 |
| executor (`0x8848d857…2cD7`) | **+0.1**, paid in the moved asset |
| account | 5.0 → **0** |

**No mint.** FTestXRP `totalSupply` is `9150684279193` at block 35,634,054 **and** at 35,634,055,
identical. The receipt carries six Transfer events, all from the account, **zero from the zero
address**.

**Cross-checked, not taken from my own script.** I re-read the chain independently (`cast receipt`,
`cast call`) and the XRPL server: six Transfer logs with the amounts above, the transaction id
consumed, account nonce 1, account balance 0, and the XRPL payment validated with a single memo and no
destination tag.

**Latency: 118 s** (XRPL submit→validated 7 s; →request mined 11 s; →proof served 96 s; →executed
3 s). The 96 s attestation leg is shorter than Phase 1's 136–144 s because it depends on where in the
90 s round the request lands. Across the three complete runs it is 118, 152 and 162 s.

### Plain `Call[]`, not a helper contract

A helper is not justified, on measurement:

- **Memo budget is not the constraint, and 0xFC makes it irrelevant.** The memo is 42 bytes for any N.
  Inline (`0xFD`) would not even fit: an N=5 payload is 1,472 bytes against XRPL's ~1,019.
- **A helper does the same transfers.** Per-recipient cost on a fork with real FXRP is flat, about
  **79k gas** each:

  | N | Gas | Payload (off-chain, hashed) |
  |---|---|---|
  | 1 | 528,869 | 448 B |
  | 5 | 843,120 | 1,472 B |
  | 20 | 2,022,059 | 5,312 B |
  | 100 | 8,327,376 | 25,792 B |

  A helper would still make N transfers, and would add an approve or an intermediate custody step for
  the account. The block gas limit (about 28M) caps one payout at roughly 300 recipients either way.
- **Attack surface.** A helper is one more contract that holds user funds within a transaction.

The trade: with `0xFC` the *preimage* travels off-chain, so the wallet must hand it to whoever
submits. That is true of every `0xFC` instruction and is Phase 1's existing design.

### Funding the new account

The new diamond means new account addresses (`CREATE2` over the beacon and controller). Rather than
mint again, the 5.0 FTestXRP at the Phase 1 account was spent by a **real old-format instruction on the
old diamond**, through the SDK: [`migrate-phase1-funds.json`](fixtures/measurements/migrate-phase1-funds.json)
(old account 5.0 → 0, new account 0 → 5.0). It also checked that the SDK's attestation path does not
depend on the payload format; only `prepareInstruction` is format-specific.

---

## 5. Lending and DEX on a mainnet fork

> **SIMULATED VERIFICATION.** In every test in this section
> `FdcVerification.verifyXRPPayment` is **mocked to return true**. Nothing was attested by FDC and no
> XRPL transaction was sent. The real path is §4 and Phase 1. What these tests establish is what
> memokit does with the calls **once an attestation exists**, against the real contracts they target.

**How the proofs are built.** By Phase 1's `buildXrpPaymentResponse`, through `vm.ffi` running
`sdk/scripts/forkProof.ts`, from a representative ledger record (the real Coston2 capture in
`fixtures/xrppayment-oracle.json` with sender, destination, memo, hash and close time substituted). So
every field the contract reads other than the Merkle check (source id, status, timestamp, address
hashes, memo bytes, no destination tag) is produced by production code, not by a hand-written struct.
The proof looks as old as a real one: its XRPL close time is 150 s before the fork block.

**Setup.** Foundry fork of Flare mainnet, **pinned at block 70,267,728**. `ffi` is enabled only under
`FOUNDRY_PROFILE=fork` (`npm run test:fork`); the default profile skips `test/fork/`. The real EIP-2470
factory and Contract Registry are on mainnet, so nothing is etched.

### Kinetic (lending)

**Is FXRP a Kinetic market? No.** The comptroller
(`0x8041680Fb73E1Fe5F851e76233DCDfA0f2D2D7c8`) lists seven markets at the pinned block, read from chain:

| Market | Collateral factor | Supplied | Borrowed | Cash |
|---|---|---|---|---|
| kUSDC.e | 0.80 | $786k | $606k | $181k |
| kUSDT | 0.80 | $6k | $4k | $3k |
| **kSFLR** | 0.71 | **$5.01M** | $95k | **$4.92M** |
| kWETH | 0.62 | $2.11M | $1.52M | $589k |
| kFLRETH | 0.62 | $2.51M | $11k | $2.50M |
| **kUSDT0** | 0.80 | $2.57M | $2.13M | **$451k** |
| kFLR | 0.70 | $1.42M | $340k | $1.08M |

Prices are Kinetic's own oracle. So the instruction uses the most liquid collateral, **sFLR**, and
borrows the deepest stablecoin, **USDT0**.

**One `Call[]`:** `approve` → `mint` → `enterMarkets` → `borrow` → a balance assertion (below), with a
100 sFLR executor fee in the moved asset. 200,000 sFLR collateral, 1,000 USDT0 borrowed.

| Assertion | Result |
|---|---|
| kSFLR balance × exchange rate ≈ collateral deposited | holds (within 1e9 wei) |
| `borrowBalanceStored(account)` | exactly 1,000 USDT0 |
| USDT0 balance of the account | exactly 1,000 USDT0 |
| Collateral enabled; `getAccountLiquidity` | member; shortfall 0; headroom > 0 |
| Executor paid | 100 sFLR, account left with no sFLR |
| Gas | 1,462,139 |

**Mutation.** Removing `enterMarkets` turns the happy path red with
`CallFailed(4, "ERC20: transfer amount exceeds balance")`: the assertion, not the borrow, is what
catches it.

**The interface surprise: a refused borrow is not a revert.** Kinetic is Compound v2, and Compound
reports most failures as a **nonzero return value**. Borrowing 5,000 USDT0 against ~$2.5k of collateral
returns error code **3** (`COMPTROLLER_REJECTION`) and does not revert, so the account sees a
*successful* call. Without protection:

- `test_withoutAnAssertionAFailedBorrowIsConsumedAsSuccess`: the instruction is **consumed**, the nonce
  advances, the collateral was deposited, and **nothing was borrowed**. The user's XRPL payment is
  spent on a no-op.
- `test_withTheAssertionTheSameFailureUnwindsEverything`: with a trailing
  `USDT0.transfer(account, borrowed)` (a self-transfer, which reverts unless the account really holds
  that much), the same failure reverts the whole instruction: not consumed, nonce unchanged, deposit
  unwound, proof reusable.

That is a general rule for `Call[]` on Compound-family markets, and it is documented in the README: **end
an instruction that depends on a soft-failing call with a balance assertion.** The assertion costs one
ordinary call and needs no helper contract.

### SparkDEX V3 (DEX)

**Swap: FXRP → USDT0, 0.05% pool.** Chosen by measurement. Raw `liquidity()` is not comparable across
pools whose tokens differ in decimals (FXRP has 6, WFLR and WETH 18), so I compared price impact on the
same swap through the QuoterV2 at the pinned block:

| Pool | 1 FXRP out | Impact @ 1,000 FXRP | @ 10,000 | @ 100,000 |
|---|---|---|---|---|
| **FXRP/USDT0 0.05%** | 1.411858 | **0.22%** | **2.13%** | 37.4% |
| FXRP/WFLR 0.05% | 214.60 | 1.78% | 14.9% | 76.1% |
| FXRP/WFLR 0.3% | 214.46 | 25.4% | 86.6% | 98.6% |
| FXRP/USDT0 0.3% / 1% | 1.34 / 1.31 | 98% | 99.8% | 100% |
| FXRP/WETH 0.05% | 0.000524 | 93.9% | 99.4% | 99.9% |
| FXRP/sFLR 0.05% | 0.000998 | 99.9% | 100% | 100% |

So FXRP/USDT0 at 0.05% is the only deep FXRP pool; WFLR at 0.05% is a distant second, and the rest
exist but are unusable even at 1,000 FXRP. Router `0x0f3D8a38…15D3` (UniversalRouter), factory
`0x8A2578d2…E652`, QuoterV2 `0x5B5513c5…B705`.

**Shape.** Two calls: `FXRP.transfer(router, amountIn)`, then `router.execute(V3_SWAP_EXACT_IN, ...)`
with `payerIsUser = false`, so the router spends what it was just sent and **no Permit2 signature is
needed**. An account cannot sign. `amountOutMinimum` and `deadline` are arguments of that call, so
they sit **inside the committed payload**.

**Reference deadline: 900 s.** Derived from measurement: worst observed 162 s, plus one missed 90 s
FDC round (252 s), times a safety factor of about 3.5. Mirrored as `DEFAULT_DEADLINE_SECONDS` in the
SDK, derivation next to it in `sdk/src/deadline.ts`.
`test_deadlineSurvivesTheWorstMeasuredLatencyPlusAMissedRound` warps 252 s and still has **648 s** of
margin. Reference slippage floor: 0.5% under the quote.

| Test | Result |
|---|---|
| Swap within the committed minimum | 1,000 FXRP → **1,408.788917 USDT0**; quote 1,408.788917; floor 1,401.744972. Router holds none of either token afterwards. Executor paid 0.1 FXRP. 707,012 gas. |
| **Price moves past the minimum** | An unrelated trader sells 5,000 FXRP into the pool; the same swap would now return 1,378.585615 (−2.1%). The instruction **reverts cleanly**: call index 1 (the swap), reason `V3TooLittleReceived` (`0x39d35496`). Not consumed, nonce unchanged, the account still holds all 1,000.1 FXRP, **the transfer to the router was unwound** (router balance 0), executor paid nothing. 488,134 gas. |
| Expired deadline | Warp past it: reverts cleanly with `TransactionDeadlinePassed` (`0x5bf6f916`); nothing moved. |
| Executor loosens the floor | Payload with `amountOutMinimum = 0` submitted against the honest proof: `CommitmentMismatch`. Nothing swapped at the worse price. |

**Mutation.** Committing `amountOutMinimum = 0` makes the price-moved test fail with
`expected the instruction to revert`: the swap goes through at the worse price, so the committed
floor is what protects the user.

---

## 6. Recovery: what "stuck" actually means

The brief asked me to confirm the recovery opcodes can unstick "the resulting consumed-but-failed
instruction". **That premise is inaccurate, and the difference matters.**

A failing instruction is **not consumed**. `execute` reverts as a whole, so its transaction id stays
unused and the nonce does not advance (Phase 1's semantics, unchanged). What is stuck is the **queue**:
the account's nonce is waiting for an instruction that will not run again, and every later one is
refused with `InvalidNonce` until the nonce moves. All of these are on the fork, after a real
price-driven failure:

| Way out | Test | What happens |
|---|---|---|
| **Nothing** | `test_theQueueIsBlockedBehindTheStuckInstruction` | Nonce 1 is refused: `InvalidNonce(0, 1)`. The stuck instruction may still run if the price comes back before its deadline. |
| **`0xE1` setNonce** | `test_setNonceUnsticksTheQueue` | Nonce jumps to 1; the next instruction runs; the stuck one can **never** run again (`InvalidNonce(2, 0)`), even if the price returns. |
| **Re-issue at the same nonce** | `test_aFreshInstructionAtTheSameNonceSupersedesTheStuckOne` | No opcode needed: the failed one never spent nonce 0. A new instruction re-quoted at today's price executes, and the original is refused afterwards. |
| **`0xE0` ignore** | `test_ignoreRetiresTheStuckInstructionButDoesNotMoveTheNonce` | Retires the transaction id: submitting the stuck proof emits `InstructionIgnored` instead of swapping. **Does not move the nonce**, so on its own it does not unstick the queue. |

So: `0xE1` or a same-nonce re-issue unsticks the queue; `0xE0` is for a memo that cannot execute *or
even parse*, which is its job in `test/Recovery.t.sol` (the ignore flag is consumed **before** the memo
is parsed, so garbage is recoverable). **Recommendation for wallets:** on a failed instruction, offer
"try again" (re-quote, same nonce), not "cancel".

---

## 7. The SDK

`sdk/` is a publishable TypeScript library, **not published**. The name (`@memokit/sdk`) is provisional
and lives in one field of `sdk/package.json`.

**Public API** (`@memokit/sdk`): `prepareInstruction` (build and hash the payload, produce the memo),
`encodeMemo` / `decodeMemo`, `requestAttestation`, `waitForProof`, `submit`, plus `COSTON2` / `FLARE`
network presets and `DEFAULT_DEADLINE_SECONDS`. Sending the XRPL payment is `@memokit/sdk/xrpl` (the
only entry that needs the `xrpl` package, an optional peer). Lower-level FDC pieces are
`@memokit/sdk/fdc`.

**What changed.** The FDC code moved out of `executor/` into the SDK: offline response and MIC
construction, ABI shapes, DA Layer and round clients. FdcHub, the fee configuration and the Relay are
read from the Contract Registry at call time, so no Flare address is pinned in the package. (I checked
that the registry's `Relay` equals the address the scripts pinned.) The Phase 1 vault run and the
Phase 2 payout are now thin scenarios over one runner that uses only the public API.

**Verified from a packed tarball in an empty project outside the repo:**

- the quickstart (29 lines, `sdk/examples/quickstart.ts`, embedded verbatim in the README) typechecks
  against the installed package;
- all three entry points import in plain Node ESM;
- the root entry **loads without `xrpl` installed**;
- a deep import outside the `exports` map is refused (`ERR_PACKAGE_PATH_NOT_EXPORTED`);
- `npm pack` contents are `dist/`, `LICENSE`, `README.md` and `package.json` only.

I also added an MIT `LICENSE` to `sdk/`, consistent with the contracts' SPDX headers. **That is a choice
made on your behalf; change or remove it before publishing.**

---

## 8. What surprised me against live contracts

Reported as in Phase 1: things that were not what the docs, my memory or the spec said.

1. **FXRP is not a Kinetic market.** Seven markets; none is FXRP. [§5](#5-lending-and-dex-on-a-mainnet-fork).
2. **Kinetic returns error codes instead of reverting.** A refused borrow is a successful call, so a
   `Call[]` cannot see it. Needs an explicit assertion.
3. **`deal()` cannot fund FXRP.** After `deal(FXRP, a, 1000e6)`, `balanceOf(a)` reports 1,000 but
   `transfer` **panics with an arithmetic underflow**, with or without adjusting `totalSupply`. FXRP is
   a Flare FAsset with checkpointed balances, so a raw storage write satisfies one read path and not
   the other. Anything that funds FXRP in a fork test must move it from a real holder; I use the
   Firelight stXRP vault (≈51.6M FXRP at the pinned block). sFLR does not have this problem.
4. **SparkDEX's V3 factory is not the address I remembered.** The router, QuoterV2 and Permit2
   addresses I had were right; the factory I had returned no pool for *any* pair, including WFLR/USDT0.
   The real one is `0x8A2578d23d4C532cC9A98FaD91C0523f5efDE652` (from SparkDEX's docs), which I confirmed
   on chain: it is **baked into the UniversalRouter's bytecode**, alongside the published pool init
   code hash. I did not trust the docs page alone: it came through a summariser.
5. **FXRP liquidity on SparkDEX is thin outside one pool.** Most FXRP pairs and fee tiers exist as
   pools but are unusable: FXRP/WETH takes 94% price impact on 1,000 FXRP, FXRP/sFLR 99.9%. Only
   FXRP/USDT0 at 0.05% is deep (0.22% at 1,000 FXRP); FXRP/WFLR at 0.05% is workable for small sizes.
   I first judged this from raw `liquidity()`, which is not comparable across pools whose tokens have
   different decimals; the quoter is the honest comparison.
6. **The router's error is unwrapped.** The Uniswap `UniversalRouter` can wrap a failed command in
   `ExecutionFailed`; SparkDEX's surfaces `V3TooLittleReceived` and `TransactionDeadlinePassed`
   directly, so the account's `CallFailed` reason is the 4-byte selector.
7. **Flare attaches daemon logs to execute receipts.** The payout receipt has 18 logs: six Transfers,
   the account's and the diamond's events, and six from `0x1000…0002` (the FlareDaemon) with one topic
   and an `(address, uint)` payload. They are not ERC-20 events. A check that counts logs breaks; one
   that filters on the token address and the Transfer topic, as the trace does, does not.
8. **The account did not bound revert data**, and an owner could exploit that. Found by the
   economics tests. [§2](#a-lever-the-tests-found-and-closed).
9. **The consumed-but-failed premise.** A failure is not consumed; the queue is stuck.
   [§6](#6-recovery-what-stuck-actually-means).
10. **Flare's account returns the ERC-1363 magic value unconditionally**, and the account is created
    lazily, so `transferAndCall` reverts against an address that has never executed anything.
11. **The mechanical selector diff found six `AdminFacet` overlaps where the hand diff found three.**
    [§3](#3-selector-collisions).
12. **The public Flare RPC caps `eth_getLogs` at 30 blocks**, and serves archive state at least 100k
    blocks back, which is what makes a pinned-block fork reproducible without an archive provider.
13. **Phase 1 did not build from a clean clone.** [§1](#a-phase-1-defect-found-on-the-way-the-repo-did-not-build-from-a-clean-clone).

---

## 9. Not done, and open

**Out of scope, as briefed:** no frontend, no npm publish, no mainnet deployment, no real mainnet
trace.

**Caveats to carry**

- Lending and DEX are fork results with **simulated FDC verification**. The mainnet path is unproven
  live, and I do not claim it.
- The selector fixtures are snapshots. Run `npm run selectors:check` before trusting an old green.
- The unit-test gas figures in §2 use a mock verifier and are floors; the live payout is 915,998 gas
  for N=5 against 843,120 on the fork with simulated verification.
- Nothing in the protocol makes the executor fee cover an executor's expected loss on reverts. §2.

**Open items carried forward**

1. **Self-host a DA Layer.** ~20 requests a minute is a low ceiling for more than one concurrent user
   (Phase 1 item 4; unchanged).
2. **Re-check the zeroed voting round** in the MIC if a non-zero round ever appears (Phase 1 item 2).
3. **Freeze the proxy creation code** to a hex literal. `test_proxyCreationCodeHashIsPinned` pins the
   hash; the literal is not done (Phase 1 item 3).
4. **Preimage delivery.** With `0xFC` the preimage travels off-chain from the wallet to whoever submits.
   There is no protocol for that yet.
5. **Decide the package name and license** before anything is published.

**Closed from Phase 1's list:** item 1 (rename), item 5 (ERC-1363 receiver), item 6 (executor fee).

## Reproducing

```bash
git clone --recurse-submodules <repo-url> && cd flare && npm install
forge test                     # 105
npm test                       # 78
npm run test:fork              # 15, needs network + ffi, fork profile only
npm run selectors:check -w @memokit/executor
# live, needs .env (see .env.example):
npm run payout -w @memokit/executor
```
