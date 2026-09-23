# Claim ledger

Every factual claim the [README](README.md) makes, with the evidence behind it. The site copy and
the grant application are built from this file. A claim that is not here should not be made, and a
claim should never be stated more strongly than its row.

**Audited 2026-09-23** against the chain and the test suites, not against earlier documents.
Numbers were re-derived from transaction receipts, XRPL ledger records and archive state. Where the
audit found an error, the README has been corrected and the row says what changed.

## Evidence levels

| Level | Means | Does not mean |
|---|---|---|
| **Live** | Ran on Coston2 and XRPL Testnet with real FDC attestation. A transaction backs it. | Mainnet. Nothing here has run on mainnet. |
| **Fork** | Ran on a Foundry fork of Flare **mainnet** against the real deployed contracts, with FDC verification **simulated**. | That it ran on mainnet, or that it passed real attestation. |
| **Tested** | Covered by the unit or integration suite against contracts deployed in-test. | That it has run against any live network. |
| **Open** | Not done, or not verified. | — |

Test suites as of this audit: **145** Solidity (`forge test`), **24** fork (`npm run test:fork`),
**138** SDK and **63** executor (`npm test`).

## Easy to overstate

These are true, and each one is easy to state in a way that is not. Copy should use the wording in
the right-hand column or something no stronger.

| Claim | Status | Say | Do not say |
|---|---|---|---|
| `0xFB` NonceAtLeast rescue | **Tested only. Never run live.** | "a race-free rescue opcode, covered by tests" | "live rescue", or anything implying it has unstuck a real queue |
| FTSOv2 rate bound | **Fork only**, with the real oracle but simulated FDC | "tested against the real oracle on a mainnet fork" | "live price protection", "on mainnet" |
| Post-conditions | **Live exactly once**: the cash-out's dust floor (`Erc20BalanceAtLeast`), which passed. Otherwise Fork (Kinetic, SparkDEX) and Tested. | "shipped; exercised live once" | "live-proven post-conditions", or implying one has ever caught a live failure |
| Racing between executors | **Tested only.** Every live memokit run has had one executor. | "race handling is built and tested" | "battle-tested", "competitive executor market" |
| Rescue classifier | **Live, but unrecorded.** It ran against real history (7 payments), but no fixture was kept; the counts come from commit `6cf0978`. | "run against the deployment's real history" | citing it as a recorded trace |
| No FAssets mint in the path | **Live, checked on two runs**: `totalSupply` identical across the execute block for the Phase 1 vault deposit and the Phase 2 payout. | "no mint in the path; totalSupply checked unchanged on live runs" | "verified on every run" |
| Mainnet | **Open.** No mainnet deployment and no mainnet transaction. | "testnet" | anything implying mainnet |
| Xaman signing | **Open.** Built, never run against the live Xaman API. | "unsigned transaction and QR, signable by any XRPL wallet" | "Xaman integration" as a working feature |

## Claims, by README section

### What memokit is

| Claim | Status | Evidence |
|---|---|---|
| Executes XRPL-originated calls on assets a Flare account already holds | **Live** | Phase 1 vault deposit [`0x69f5259f…`](https://coston2-explorer.flare.network/tx/0x69f5259f72139c4307246bbffd11f73937e85eacc34b23dd1718413b56821978), Phase 2 payout [`0x2f6faf66…`](https://coston2-explorer.flare.network/tx/0x2f6faf66bcb73632cf5762ee93a40e6943670ecf06a382d36766062c4edf64ad) |
| No FAssets mint in the path | **Live** (two runs — see above) | `e2e-trace-live-vault.json`, `e2e-trace-payout.json`: `totalSupply` unchanged, no Transfer from the zero address |
| No Flare-assigned destination tag, no wallet registration | **Live** + **Tested** | every live run; `test_revertsOnDestinationTag` |
| The account is derived from the XRPL address alone | **Live** + **Tested** | `computeAccountAddress` returns `0x8F1eD3f5…` (Phase 2 diamond) and `0x9dD656e6…` (Phase 3), re-read 2026-09-23; `test/AccountDerivation.t.sol` (6 tests) |
| The memo is a 42-byte commitment, or the instruction inline | **Live** | 42 bytes: every `0xFC` run. Inline: Phase 4 runs, 523 bytes. *README said only "42-byte"; corrected.* |
| The user never holds an EVM key | **Live** | cash-out: XRPL in → XRPL out; Phase 4 runs signed only on XRPL |
| Flare's verifier is not on the path | **Live** | every live run built its request and MIC offline (`sdk/src/fdc/buildResponse.ts`); `fixtures/xrppayment-oracle.json` is the one-time check against Flare's verifier |
| Flare Smart Accounts reaches arbitrary calls only via `executeDirectMintingWithData` | **Open** (investigation, not measurement) | `phase0-report.md`. A reading of FSA's code, not a test. |

### Latency

| Claim | Status | Evidence |
|---|---|---|
| About two and a half minutes | **Live** | range 114–173 s XRPL ledger close → execute across nine live runs, re-derived from block timestamps |
| Phase 1: 152 s and 162 s, submit → execute | **Live** | `e2e-trace-live-vault.json` (152), `e2e-trace-mock-vault.json` (162) |
| Phase 2: 118 s | **Live** | `e2e-trace-payout.json` |
| Phase 3: 127 s (cash-out) and 162 s (import run 2) | **Live** | `cash-out-trace.json`, `fsa-import-trace.json` |
| Phase 4, through the open executor: 165 s and 167 s from XRPL **ledger close** | **Live** | block timestamps of `0xb2868ed4…` and `0x1eefa273…`. *README said "159 s", which was timed from when the service noticed the payment, not comparable with the others; corrected.* |
| 80–90% of the time is waiting for the FDC round and the DA Layer | **Live** | request→proof share: 89%, 89% (Phase 1), 81% (Phase 2), 79% (cash-out), 83% (import). *README said "about 90%", which holds for Phase 1 only; corrected.* |
| FDC voting round ~90 s | **Live** | Coston2 Relay `getVotingRoundId`: round boundaries 90 s apart, read 2026-09-23 |

### Phase 3: import and cash-out

| Claim | Status | Evidence |
|---|---|---|
| FSA instruction `0x01` moves FXRP from an FSA account to a memokit account | **Live** | run 1 XRPL [`3EB2AABB…`](https://testnet.xrpl.org/transactions/3EB2AABBB0B78B7C96D08BE259573C2D6AB5366C6A0AE24C124DA1507586A992) → [`0x7faeb3ec…`](https://coston2-explorer.flare.network/tx/0x7faeb3ecf2f463cb269a0c2540c57c673cfd8f4d059cdfc4421f743132777d84); run 2 XRPL [`3B2780C1…`](https://testnet.xrpl.org/transactions/3B2780C10EB02D085C5AFCE50AAC999FF0E9EE246AFF3004CD397C00C1E8E453) → [`0xe7f4ac74…`](https://coston2-explorer.flare.network/tx/0xe7f4ac745ed10d3e45dec8934afd9df9f15ddd3536ba393acaa7db7d4fd5106b) |
| FSA 10.0 → 5.0 → 1.0, memokit 10.1 → 15.1 → 19.1 FTestXRP | **Live** | archive state at blocks 35644916/7 and 35645079/80, two endpoints agreeing; `fsa-import-run1-trace.json`, `fsa-import-trace.json`. *Run 1 was previously derived by subtraction; the derivation was correct.* |
| Run 1 was relayed by Flare's own operator | **Live** | `0x7faeb3ec…` sent by `0xcA0Bf4Cb…` |
| Our losing relay cost no gas | **Live** | no transaction from `0x8848d857…` to the FSA controller in blocks 35644912–35644947. *PHASE3.md said it "reverted"; it was refused in simulation. Corrected.* |
| Flare's operator relays `0x01` for any user; `executeInstruction` has no access control | **Live** | run 1 relayed by the operator; a simulation from an unrelated EOA reverts `InvalidPaymentAmount`, a validation error |
| Cash-out: one XRPL payment redeems FXRP and XRP arrives back on XRPL | **Live** | XRPL in [`A92E0E7C…`](https://testnet.xrpl.org/transactions/A92E0E7CA45E071E641EAD562CFEE04B2C4B839B4BF13A914B19D17B190C3E47) → execute [`0x4527b740…`](https://coston2-explorer.flare.network/tx/0x4527b740567a534f15452b65215304d2bdafdcdd216fdc9db01682eb2d105022) → XRPL payout [`F7858109…`](https://testnet.xrpl.org/transactions/F7858109B0AD251D1BB44227AAB73E10F4651587FA30022278AA497A485E9ECD) |
| **148 s** from XRPL submit to XRP delivered on XRPL; the agent paid 21 s after the execute | **Live** | payout ledger 20961833 closed 12:57:11Z; submit 12:54:42Z; execute block 12:56:49Z. *README and PHASE3.md said "321 s until the XRP landed" and "193 s for the agent to pay". Both wrong; corrected.* |
| Flare confirmed the payout 297 s after submit | **Live** | `RedemptionPerformed`, block 35694411, 12:59:40Z. *321 s was when the tracker noticed, polling every 15 s, not a chain event.* |
| One 10.0 FXRP lot delivered 9.948010 XRP | **Live** | `delivered_amount` 9,948,010 drops; `RedemptionRequested` `valueUBA` 9,998,000 and `feeUBA` 49,990; 2,000 base units minted to the agent's pool in the execute |
| The payout's XRPL memo is the event's `paymentReference`, byte for byte | **Live** | `0x464250526641000200…033158c2` on both |
| Dust below one lot stays in the account | **Live** | 9.1 FXRP remained after `0x4527b740…` |
| A testnet redemption queue is inventory | **Live** | queue empty at block 35645314, a 30 FXRP ticket at 35645480, empty again by 35645914 — archive state. *README said "the first live cash-out attempt" reverted `RedeemZeroLots()`; it was a simulated `redeem` from the account, not a live attempt through memokit. Corrected.* |
| Cash-out against the deep mainnet queue | **Fork** | `test/fork/CashOutFork.t.sol` |
| On default, the redeemer is paid in collateral on Flare, not XRP; default is not automatic | **Open** (read from FAssets contracts, never exercised) | `REDEMPTION_DEFAULT_NOTE` in `sdk/src/redemptionTracker.ts` |

### Phase 4

| Claim | Status | Evidence |
|---|---|---|
| A QR-built instruction executed by the open executor with no human input after the signature | **Live** | [`62A583F3…`](https://testnet.xrpl.org/transactions/62A583F332DAADDC5BE97FCFEA099B54E97E99989A8BE2267352F3467AE8FD4A) → [`0x1eefa273…`](https://coston2-explorer.flare.network/tx/0x1eefa273d1a19fae0db851edcf964fce390edc08cb2f5a2a4de3485b2bd360b4) (local service); [`12EC49C9…`](https://testnet.xrpl.org/transactions/12EC49C99940F9F91F70FE1EA3996432890CEF2D183A6DEA86208F09FE3E6894) → [`0xb2868ed4…`](https://coston2-explorer.flare.network/tx/0xb2868ed477162780dcbae916ecff5c8f83da3fc616e6f9aa5a7e0f5dd5979f4c) (deployed service) |
| 0.5 FTestXRP transferred, 0.2 fee paid in the moved asset | **Live** | two `Transfer` events in `0x1eefa273…`; account 9.1 → 8.4 |
| The executor is deployed and public | **Live** | https://memokit-executor-production.up.railway.app; its key `0xD4dFA2b6…` sent both transactions of the deployed run |
| The deployed service holds no XRPL seed and no deployer key | **Live** | `/healthz` → `secretAudit.clean: true`, and it runs with `REFUSE_IF_SECRETS_PRESENT=1`; `executor/test/secrets.test.ts` |
| Public traffic cannot starve the executor | **Tested**, locally under load | `http-load-test.json`: 52,274 requests/s for 120 s, the in-flight instruction executed in 132 s, the loop held 15.4 s per tick. **Not load-tested against the deployed URL.** |
| Rate limit answers 429 with `Retry-After` | **Live** | public URL, 45 requests on one connection: 15 served, 30 refused, `Retry-After: 2`. Recorded in PHASE4.md §8, not as a fixture. |
| Funded for about 75 instructions; flags itself below eight | **Live** | funding tx [`0xbfd0e72e…`](https://coston2-explorer.flare.network/tx/0xbfd0e72ee182ae0bdbaf18e5ebba3a31898daeb78a7cf5adb39b0abf8442c74d), 20 C2FLR; measured cost 0.25–0.28 C2FLR per instruction |
| Coston2 charges 650 gwei | **Live** | `eth_gasPrice`, and `effectiveGasPrice` on every Phase 4 receipt, re-read 2026-09-23 |
| An executor cannot run a `0xFC` instruction without its preimage | **Tested** + **Live** | `execute(proof, data)` takes it as an argument; the Phase 4 service held ten commit-memo payments it could not run |
| Simulation before every submission | **Tested** | `executor/test/pipeline.test.ts` ("simulates before submitting, every time") |

### Safety machinery

| Claim | Status | Evidence |
|---|---|---|
| Pause facet | **Tested** | `test_pauseBlocksExecution`, `test_onlyPauserMayPause`, `test_onlyUnpauserMayUnpause` |
| Owner-managed receiving-address registry, immediate | **Tested** + **Live** | `test_receivingAddressRegistryIsImmediate`; every live run's receiving address is registered on chain |
| Timelock on economic parameters, Flare's split | **Tested** | `test_timelockedSetterSchedulesThenExecutes`, `test_ownershipTransferIsTimelocked` |
| Facets are cuttable into Flare's diamond | **Tested** | `test/FacetDropIn.t.sol` (10 tests). Never cut into Flare's real diamond. |
| Selectors diffed against Flare's live controller on Coston2 and mainnet | **Tested** against a pinned snapshot | `test/SelectorCollision.t.sol`; the snapshot is `fixtures/flare-selectors/`, refreshed by `selectors:check` |
| Post-conditions: covered by the commitment, evaluated before the fee, failure unwinds everything including the replay mark | **Tested** + **Fork**, live once | `test/PostConditions.t.sol` (16), `test_aFailedInstructionCanBeRetriedUnchanged`, `test_conditionsAreCheckedBeforeTheExecutorIsPaid`; Kinetic fork |
| A Compound-style market reports some failures as a return value | **Fork** | `test_kineticRefusesAnOversizedBorrowWithACodeNotARevert`, `test_withoutAnAssertionAFailedBorrowIsConsumedAsSuccess` |
| FTSOv2 bound refuses a 31% pool move that a signed floor accepted, at a 1% bound | **Fork** | `test_aManipulatedPoolPassesTheLooseFloorAndFailsTheOracleBound`: fair 1408.79 → 975.86 USDT0 after the dump (30.7%), floor 704.39 |
| The bound does not catch genuine market movement | **Tested** | `test_ftsoBoundAloneDoesNotCatchGenuineMarketMovement` |
| 3 of 7 reference feeds report different decimals on Coston2 and mainnet | **Live** (read-only) | [`docs/ftso-feeds.md`](docs/ftso-feeds.md), read 2026-09-23; `test/fork/FtsoFeeds.t.sol` |
| Stale-feed protection | **Tested** against a mock only | `test_aStaleFeedReverts`. Cannot be tested on a fork: a forked feed's age is always zero. |
| Rescue classifier: seven states, what is lost in each | **Tested** + **Live** (unrecorded) | `sdk/test/rescue.test.ts`, every state; the live run is in commit `6cf0978` only |
| `0xFB` rescue | **Tested only** | `test/Recovery.t.sol` (5 `nonceAtLeast` tests). **Never live.** |
| `0xE0` / `0xE1` / `0xE2` rescues | **Tested** + **Fork** | `test/Recovery.t.sol`; SparkDEX fork `test_setNonceUnsticksTheQueue`, `test_ignoreRetiresTheStuckInstructionButDoesNotMoveTheNonce` |
| The account's assets are never at risk in a stalled state | **Tested** | a stalled instruction has not executed, so nothing moved; `test_failingCallUnwindsTheWholeInstruction`, rescue suite |

### Wire format and SDK

| Claim | Status | Evidence |
|---|---|---|
| Header byte-identical to Flare's | **Tested** | `test_headerMatchesFixture`, `fixtures/memo-wire.json` |
| Header fee reserved, non-zero rejected | **Tested** | `test_nonZeroHeaderFeeIsRejectedOnEveryOpcode` |
| Payload version byte `0x02`; v1 rejected as `UnsupportedPayloadVersion(0)` | **Tested** + **Live** | `test_v1PayloadsAreRejectedAsVersionZero`, `fixtures/memo-wire-v1.json` (14 vectors); every live instruction on the current diamond used v2 (the cash-out and the three Phase 4 runs). The fund migration deliberately used the old format, on the old diamond. |
| Reserved band is `0xF8`–`0xFA` | **Tested** | `test_reservedBandIsExactlyF8ToFB` (the name predates `0xFB` being claimed; the assertion covers the current band) |
| Fee in the payload, in the moved asset, after every call | **Tested** + **Live** | `test_executorCannotSubstituteADifferentFee`, `test_executorIsNotPaidWhenACallFails`; Phase 2 payout and Phase 4 runs paid the fee in FTestXRP |
| A full vault deposit in 29 lines | **Tested** (by count) | `sdk/README.md`, the first code block is 29 lines |
| `DEFAULT_DEADLINE_SECONDS` = 900 | **Tested** (constant) | derivation in `sdk/src/deadline.ts`. *The "worst measured" it cites rose from 162 s to ~180 s; the margin is now ~3.3×, not 3.5×. Corrected in README and in the comment; the constant stands.* |

### Limits

| Claim | Status | Evidence |
|---|---|---|
| Public DA Layer allows about 20 requests a minute | **Live** (measured) | `da-layer.json`: 19 accepted before the first 429, recovering in 48–58 s; no rate-limit headers |
| `eth_getLogs` capped at 30 blocks on the public Coston2 RPC | **Live** | a 31-block range is refused with "maximum is set to 30", re-read 2026-09-23 |
| A redeploy moves every account address | **Live** | `0x8F1eD3f5…` → `0x9dD656e6…` for the same XRPL owner; migration [`0x8f35ae17…`](https://coston2-explorer.flare.network/tx/0x8f35ae17ed4a341af871546362f1561ec80da1157876806b4e865c160fab0ead) |
| Public Coston2 RPC prunes history | **Live** | historical `balanceOf` returns "missing trie node"; archive endpoints needed for anything older |

## Addresses

All re-read on 2026-09-23.

| | Address |
|---|---|
| memokit diamond, current (v2 payloads) | `0x0E762EAe8fe53e5247C22E5B52feD7A018150714` — facet code hash matches the local compile |
| memokit diamond, Phase 2 (retired) | `0x98882776ED3CB4b3abB86CceFE2f46C1aAed9E36` |
| Account for `rpnDcUjasCYome3WntkxqQ3gG4wuLXM4WE`, current | `0x9dD656e6FE2f9B46E57CE29265b3C66feCa2d741` |
| Same owner, Phase 2 | `0x8F1eD3f5355846008A47ce91Fbc49EE1808d43b1` |
| FTestXRP (Coston2 AssetManager's `fAsset()`) | `0x0b6A3645c240605887a5532109323A3E12273dc7` |
| Deployed executor key | `0xD4dFA2b68d14fc71BF5940559Ad9F819c1b0350D` |
| FSA controller (Coston2) | `0x434936d47503353f06750Db1A444DBDC5F0AD37c` |
| FSA provider wallet (XRPL Testnet) | `rEyj8nsHLdgt79KJWzXR5BgF7ZbaohbXwq` |
| memokit receiving address (XRPL Testnet) | `rDfVHUx5SMgw5wwqjvzgFEFCnqW5CCGWyW` |
