# Claim ledger

Every factual claim the [README](README.md) makes, with the evidence behind it.

**This ledger once stated an identity it could not back.** Rows below called `0xcA0Bf4Cb…` "Flare's
operator", from nothing more than the fact that its transactions go to Flare's FSA controller. That
was an inference written as fact, and it reached a grant draft before it was caught. It was
corrected on 2026-09-23, and the "Who an address belongs to" row below is the rule that replaces
it. A name is only chain-stated when a contract states it — Flare's Contract Registry naming
`0x434936d4…` `MasterAccountController`, for example — or when an official source does. The site copy and
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
| **Verified from deployed code** | Read from the verified source and live state of someone else's deployed contract, at a stated block, with live transactions to match. | That it stays true: a diamond can be cut at any time. |
| **Open** | Not done, or not verified. | — |

Test suites as of this audit: **145** Solidity (`forge test`), **24** fork (`npm run test:fork`),
**152** SDK and **66** executor (`npm test`). All four re-run 2026-09-30; the fork suite passed five
runs in a row that day.

## Easy to overstate

These are true, and each one is easy to state in a way that is not. Copy should use the wording in
the right-hand column or something no stronger.

| Claim | Status | Say | Do not say |
|---|---|---|---|
| `0xFB` NonceAtLeast rescue | **Tested only. Never run live.** | "a race-free rescue opcode, covered by tests" | "live rescue", or anything implying it has unstuck a real queue |
| FTSOv2 rate bound | **Fork only**, with the real oracle but simulated FDC | "tested against the real oracle on a mainnet fork" | "live price protection", "on mainnet" |
| Post-conditions | **Live twice, both the same kind and both passing**: each live cash-out carried a dust floor (`Erc20BalanceAtLeast`) — Phase 3 `0x4527b740…` and the demo dry run `0x5da0d80a…`, confirmed by decoding each execute's payload. None has ever caught a live failure. Otherwise Fork (Kinetic, SparkDEX) and Tested. | "shipped; exercised live twice, as a balance floor on cash-outs" | "live-proven post-conditions", or implying one has ever caught a live failure |
| Racing between executors | **Tested only.** Every live memokit run has had one executor. | "race handling is built and tested" | "battle-tested", "competitive executor market" |
| Rescue classifier | **Live, but unrecorded.** It ran against real history (7 payments), but no fixture was kept; the counts come from commit `6cf0978`. | "run against the deployment's real history" | citing it as a recorded trace |
| No mint | **Scoped to two runs.** `totalSupply` was identical across the execute block for the Phase 1 vault deposit and the Phase 2 payout, and only those. **A cash-out is the opposite:** supply fell 9.998 FTestXRP across the execute block on both live cash-outs — 10.0 burned, and FAssets' redemption minted itself a 0.002 pool fee. | "memokit never mints FXRP; on the vault-deposit and payout runs total supply was identical across the execute block" | "no mint" or "nothing was minted" about a cash-out, or "supply unchanged on live runs" in general |
| How long a cash-out's XRP takes | **Live, two runs, and not memokit's to control.** Two measures, both from chain timestamps, both labelled: **end to end, from the XRPL payment's ledger close to the payout's ledger close: 141 s to 18.2 min** (141 s; 1,090 s); **from the execute's block to the payout's ledger close: 22 s to 16.2 min** (22 s; 970 s). Both agents paid on time. | "depends on the FAssets agent: seconds to about twenty minutes observed" | "148 s" or "under three minutes" as if it were typical — 148 s was one run |
| Mainnet | **Open.** No mainnet deployment and no mainnet transaction. | "testnet" | anything implying mainnet |
| Xaman signing | **Open.** Built, never run against the live Xaman API. | "builds the unsigned transaction; Xaman signing is built but not yet live-tested" | "Xaman integration" as a working feature, or "any XRPL wallet can sign the QR" — no wallet reads its `xrpl:tx?json=` format *(this row used to recommend that wording; corrected 2026-09-23)* |
| Destination tags | **Verified from deployed code on 2026-09-30.** Flare's minting tags are bought, not assigned: anyone can reserve one for 100 FLR. memokit's payments never reach the path that reads them. | "no destination tag, no wallet registration"; "on Flare's direct-minting path a registered tag overrides the memo" | "Flare-assigned destination tag", "tags are registered by Flare", or that memokit's own path could be front-run through a tag |
| **Who an address belongs to** | **An inference, unless a contract or an official source names it.** The chain states what an address *did*, never who controls it. | "`0xcA0Bf4Cb…`, the FSA controller's main relayer — an EOA whose recent transactions all go to that controller" | "Flare's operator", "a third party", or any name the chain does not state |
| Attestation reuse on the import path | **Live once** (import run 3), and one path of it — the fallback when a reused round produces no proof — has never run | "the import reuses an identical attestation already on chain instead of paying for another" | "memokit never pays for duplicate attestations": the executor service does not check yet (deferred, below) |

## Claims, by README section

### What memokit is

| Claim | Status | Evidence |
|---|---|---|
| Executes XRPL-originated calls on assets a Flare account already holds | **Live** | Phase 1 vault deposit [`0x69f5259f…`](https://coston2-explorer.flare.network/tx/0x69f5259f72139c4307246bbffd11f73937e85eacc34b23dd1718413b56821978), Phase 2 payout [`0x2f6faf66…`](https://coston2-explorer.flare.network/tx/0x2f6faf66bcb73632cf5762ee93a40e6943670ecf06a382d36766062c4edf64ad) |
| memokit never mints FXRP; supply unchanged on the deposit and payout runs | **Live** (two runs — see above) | `e2e-trace-live-vault.json`, `e2e-trace-payout.json`: `totalSupply` unchanged, no Transfer from the zero address. Not true of cash-outs: supply fell 9.998 FTestXRP on both (blocks 35694327→35694328 and 35745284→35745285). |
| No destination tag, no wallet registration | **Live** + **Tested** | every live run carried no tag; memokit rejects a tagged payment on chain (`test_revertsOnDestinationTag`). *Previously "No Flare-assigned destination tag" — tags are not assigned by Flare: anyone can reserve one (next row). Corrected 2026-09-30.* |
| How a destination tag becomes a direct-minting target | **Verified from deployed code on 2026-09-30.** The Phase 0 spec's front-running warning is **verified**, with its location corrected. Phase 1's "tags are registered by Flare, not by arbitrary callers" is **refuted**. | [`minting-tags.json`](fixtures/flare-selectors/minting-tags.json). Read at Coston2 block 36039083 and Flare block 70996880: `AssetManager.getMintingTagManager()` → `0x09451173…` (Coston2), `0xb426b5AE…` (Flare), verified proxies over identical implementation source. **Who:** `reserve()` has no access modifier; its only check is `msg.value == reservationFee` (100 C2FLR / 100 FLR). The caller owns the tag, an ERC-721, and is its first recipient. Numbers are sequential (`nextAvailableTag`), so a buyer cannot pick one but can buy an existing tag from its owner. The owner sets the recipient (effective at once) and an optional allowed executor (after a cooldown). **Permissioned only in its parameters:** governance sets the fee, its recipient and the executor cooldown, and the AssetManager's governance chooses the tag contract. **Live:** `eth_call` of `reserve()` from an unrelated address returns the next tag (1377 on Coston2, 803 on Flare); 1 wei short reverts `WrongReservationPaymentAmount()`. 773 Flare tags have 349 distinct reservers. **Routing** (`DirectMintingFacet._decodeTarget`): a destination tag with a recipient wins and the memo is ignored; otherwise a 32-byte payment reference, then a 48-byte one, then the smart-account controller. So a core-vault payment carrying a tag mints to whoever the tag's owner names at execution — the spec's front-run, except that the tag is bought from the MintingTagManager, not "on the direct-minting facet". **Phase 1 was wrong when written:** the same facet and tag manager were live at its blocks (35628898, 35630179), and tag 1186, which Phase 1 read, was reserved by `0x66ecee0c…`, an address the chain does not name. Direct minting by memo payment reference, with no tag, was available too. **memokit is not on this path:** its receiving address (`rDfVHUx5…`) is not the core vault (`rDhpmiPq…`), which is the only address direct minting accepts. |
| The account is derived from the XRPL address alone | **Live** + **Tested** | `computeAccountAddress` returns `0x8F1eD3f5…` (Phase 2 diamond) and `0x9dD656e6…` (Phase 3), re-read 2026-09-23; `test/AccountDerivation.t.sol` (6 tests) |
| The memo is a 42-byte commitment, or the instruction inline | **Live** | 42 bytes: every `0xFC` run. Inline: Phase 4 runs, 523 bytes. *README said only "42-byte"; corrected.* |
| The user never holds an EVM key | **Live** | cash-out: XRPL in → XRPL out; Phase 4 runs signed only on XRPL |
| Flare's verifier is not on the path | **Live** | every live run built its request and MIC offline (`sdk/src/fdc/buildResponse.ts`); `fixtures/xrppayment-oracle.json` is the one-time check against Flare's verifier |
| Flare Smart Accounts reaches arbitrary calls only through direct minting | **Verified from deployed code on 2026-09-30** — mainnet fully; Coston2 except three unverified facets | [`gap-verification.json`](fixtures/flare-selectors/gap-verification.json). MasterAccountController `0x434936d4…` (the registry's `MasterAccountController` on both networks), every live selector named: Flare block 70988574 (59 selectors, 15 facets), Coston2 block 36034536 (74, 18). In the verified source there are three low-level call sites. The one that runs caller-chosen calldata is `MemoInstructions.execute` → `personalAccount.call(userOp.callData)` (opcodes `0xFF`, calldata in the memo, and `0xFE`, calldata supplied by the executor against a hash in the memo), reached only from `handleMintedFAssets`, which requires `msg.sender` to be the FXRP AssetManager. The other two are the owner's `diamondCut` and `executeTimelockedCall`, which runs only calls the owner scheduled. `executeInstruction` and its siblings call typed personal-account methods only. **Gate, live:** `eth_call` from an unrelated address reverts `OnlyAssetManager()` (`0x6d5ab9d3`) on both networks; called as the AssetManager with dummy arguments it passes the gate and reverts further in, `Error("ERC20: transfer to the zero address")` — the executor-fee transfer to the zero executor passed. **Both entry points seen live:** `executeDirectMintingWithData` on Flare (`0xd0d9a792…`, which also emitted `UserOperationExecuted`) and `executeDirectMinting` on Coston2 (`0x2deb3036…`). *Previously "only via `executeDirectMintingWithData`" — too narrow: `0xFF` arrives through plain `executeDirectMinting`.* **Not verified:** Coston2's three replaced facets (personal accounts, subaccounts, bridge routes) have no verified source, so on Coston2 this holds for the other fifteen facets only. |
| The FSA executor is paid from the minted fAsset | **Verified from deployed code on 2026-09-30** + seen live on both networks | [`gap-verification.json`](fixtures/flare-selectors/gap-verification.json). Source: `_distributeFAssets` requires `amount >= executorFee`, pays `fAsset.safeTransfer(_executor, executorFee)` and sends the rest to the personal account; with no fee in the memo the fee defaults to `getDirectMintingExecutorFeeUBA()` (0.2 FXRP on Flare, 0.1 FTestXRP on Coston2, at the probe blocks). Receipts: Flare `0xd0d9a792…` mints 9.9 FXRP to the controller, which pays 0.3 to the executor and 9.6 to the account; Coston2 `0x2deb3036…` mints 10.1, pays 0.1 and 10.0. 273 of 275 Flare `DirectMintingExecuted` events since block 70265577 carried a non-zero fee. So an FSA instruction that mints nothing has nothing to pay its executor from. |

### Latency

| Claim | Status | Evidence |
|---|---|---|
| About two and a half minutes | **Live** | **114–174 s, median 151 s**, measured from the XRPL payment's ledger close to the execute's block timestamp, from chain timestamps only, across **all twelve live runs to 2026-09-30**: Phase 1 mock vault and live vault; Phase 2 payout; FSA imports 1, 2 and 3; the fund migration; the Phase 3 cash-out; Phase 4's QR run, under-load run and deployed-executor run; and the demo dry-run cash-out. Every run, with its four timestamps, is in [`latency-all-runs.json`](fixtures/measurements/latency-all-runs.json). *The earlier "114–173 s across nine runs" left out the fund migration (174 s, the slowest) and predates import run 3 and the dry run.* |
| The slowest run | **Live** | **174 s** from XRPL ledger close: the fund migration (`9766BF74…` → `0x8f35ae17…`). About 180 s from submit, which precedes ledger close by several seconds — an estimate, since submit time is not on chain. `DEFAULT_DEADLINE_SECONDS` is checked against this. |
| Phase 1: 152 s and 162 s, submit → execute | **Live** | `e2e-trace-live-vault.json` (152), `e2e-trace-mock-vault.json` (162) |
| Phase 2: 118 s | **Live** | `e2e-trace-payout.json` |
| Phase 3: 127 s (cash-out) and 162 s (import run 2) | **Live** | `cash-out-trace.json`, `fsa-import-trace.json` |
| Phase 4, through the open executor: 165 s and 167 s from XRPL **ledger close** | **Live** | block timestamps of `0xb2868ed4…` and `0x1eefa273…`. *README said "159 s", which was timed from when the service noticed the payment, not comparable with the others; corrected.* |
| The FDC leg is the largest part: **46–86% of the total, median 73%** | **Live** | **What "FDC leg" means here:** from the block of the payment's attestation request (FdcHub `AttestationRequest`) to the block in which Flare's Relay published that voting round's Merkle root (`ProtocolMessageRelayed`, protocol 200) — the moment the proof became final on Flare. Across the same twelve runs it took **64–146 s, median 108 s**. The rest of each run: XRPL ledger close to the request, 8–23 s; root published to the execute, 11–53 s, which is the DA Layer serving the proof and the relayer fetching and submitting it, highest on the open executor's runs because it polls. [`latency-all-runs.json`](fixtures/measurements/latency-all-runs.json). **Why this differs from the older "80–90%" (and "79–94%"):** those came from the scripts' own stage marks, measured request → proof *fetched from the DA Layer*, so they counted DA-Layer lag and our polling inside the FDC leg. The chain cannot see when the DA Layer began serving a proof; it can see the root being published, so that is where this leg ends. Both are honest; only this one is reproducible from the chain. |
| FDC voting round ~90 s | **Live** | Coston2 Relay `getVotingRoundId`: round boundaries 90 s apart, read 2026-09-23 |

### Phase 3: import and cash-out

| Claim | Status | Evidence |
|---|---|---|
| FSA instruction `0x01` moves FXRP from an FSA account to a memokit account | **Live** | run 1 XRPL [`3EB2AABB…`](https://testnet.xrpl.org/transactions/3EB2AABBB0B78B7C96D08BE259573C2D6AB5366C6A0AE24C124DA1507586A992) → [`0x7faeb3ec…`](https://coston2-explorer.flare.network/tx/0x7faeb3ecf2f463cb269a0c2540c57c673cfd8f4d059cdfc4421f743132777d84); run 2 XRPL [`3B2780C1…`](https://testnet.xrpl.org/transactions/3B2780C10EB02D085C5AFCE50AAC999FF0E9EE246AFF3004CD397C00C1E8E453) → [`0xe7f4ac74…`](https://coston2-explorer.flare.network/tx/0xe7f4ac745ed10d3e45dec8934afd9df9f15ddd3536ba393acaa7db7d4fd5106b) |
| FSA 10.0 → 5.0 → 1.0, memokit 10.1 → 15.1 → 19.1 FTestXRP | **Live** | archive state at blocks 35644916/7 and 35645079/80, two endpoints agreeing; `fsa-import-run1-trace.json`, `fsa-import-trace.json`. *Run 1 was previously derived by subtraction; the derivation was correct.* |
| Run 1 was relayed by another address, not by memokit | **Live** | `0x7faeb3ec…` sent by `0xcA0Bf4Cb…`: an EOA whose last 200 transactions all go to the FSA controller. **Unidentifiable**: no contract or official source names it. *Previously labelled "Flare's own operator" — an inference; corrected.* |
| Our losing relay cost no gas | **Live** | no transaction from `0x8848d857…` to the FSA controller in blocks 35644912–35644947. *PHASE3.md said it "reverted"; it was refused in simulation. Corrected.* |
| Another relayer executes `0x01` for arbitrary users; `executeInstruction` has no access control | **Live** | `0xcA0Bf4Cb…` relayed runs 1 and 3 with no arrangement with us; a simulation from an unrelated EOA reverts `InvalidPaymentAmount`, a validation error, not an authorisation one |
| The FSA controller is Flare's | **Live** (official source) | Flare's Contract Registry maps `MasterAccountController` to `0x434936d4…`, read 2026-09-23 |
| The import payment goes to a provider wallet registered on that controller | **Live** | the controller's `xrplProviderWalletHashes` gate accepts `rEyj8…`: every import passed it. Who holds that wallet's key is **not** on chain. *phase0 and the SDK said "Flare-operated" / "Flare's provider wallet"; corrected.* |
| Someone else requested an identical attestation first, in both paid imports | **Live** | `0x096103b7…`, blocks 35644791 and 35645002, byte-identical `Payment` requests, same voting round as ours. An EOA whose recent transactions are all `requestAttestation`, mostly for payments to `rEyj8…`. **Unidentifiable.** |
| The import reuses an identical attestation instead of paying for another | **Live, once** | import run 3: XRPL [`5B804958…`](https://testnet.xrpl.org/transactions/5B8049580FB50D4F8DF4E8849730A46E982FC1FBBFE9007F19C529403832AF02), reused request `0x1953b81c…` (block 35728808, round 1463556), execute [`0x488f0935…`](https://coston2-explorer.flare.network/tx/0x488f0935be2cb1270a9b333fd95c6ba237f888c6791778b899c58a0f8a7a6bc6); FdcHub shows no request from us for that payment. `fsa-import-run3-trace.json`. |
| One proof covers every identical copy of a request, served for the first copy's round | **Live** (sampled) | 24 of 24 randomly sampled duplicated requests from 20,000 blocks of Coston2 history (10 single-round, 14 cross-round), plus both paid imports, read 2026-09-23. By construction, too: the DA Layer is keyed by (round, request bytes), not by requester. **Not ruled out:** a first copy whose round attests nothing; the import falls back to paying if so, and that fallback has never run. |
| Cash-out: one XRPL payment redeems FXRP and XRP arrives back on XRPL | **Live** | XRPL in [`A92E0E7C…`](https://testnet.xrpl.org/transactions/A92E0E7CA45E071E641EAD562CFEE04B2C4B839B4BF13A914B19D17B190C3E47) → execute [`0x4527b740…`](https://coston2-explorer.flare.network/tx/0x4527b740567a534f15452b65215304d2bdafdcdd216fdc9db01682eb2d105022) → XRPL payout [`F7858109…`](https://testnet.xrpl.org/transactions/F7858109B0AD251D1BB44227AAB73E10F4651587FA30022278AA497A485E9ECD) |
| **148 s** from XRPL submit to XRP delivered on XRPL, **in one run**; the agent paid 21 s after the execute | **Live, one run** — the second live cash-out took 18.2 min from XRPL close to payout (row above) | payout ledger 20961833 closed 12:57:11Z; submit 12:54:42Z; execute block 12:56:49Z. *README and PHASE3.md said "321 s until the XRP landed" and "193 s for the agent to pay". Both wrong; corrected.* |
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
| A cash-out built by `sign --cash-out`, executed by the deployed executor, paid out in XRP | **Live, once** | XRPL in [`4D9F2AD9…`](https://testnet.xrpl.org/transactions/4D9F2AD97010C8E4DC20FCC570EEAD797DF7E914D3E275CD0336CC1BEF5A58EF) → execute [`0x5da0d80a…`](https://coston2-explorer.flare.network/tx/0x5da0d80a47718e905daeb59c5cdf93b214b251bddbd1302d208404dd1e6caeae) from the deployed key → XRPL payout [`0ECB1546…`](https://testnet.xrpl.org/transactions/0ECB1546CA1820CD8DF056E23E77BBDCB5FE6A53980ECFAED59B44F34538821C), 9.948010 XRP, 16 min after the execute. **Signed by the `sign-with-seed` stand-in, not a wallet.** `demo-dry-run-cash-out.json`. |
| Simulation before every submission | **Tested** | `executor/test/pipeline.test.ts` ("simulates before submitting, every time") |
| The executor service avoids paying for duplicate attestations | **Open — deferred to mainnet work, deliberately.** | It reuses only a proof that has already *finalised*, which never happens for a payment it sees live, and it does not read `AttestationRequest` events. **Why deferred:** it saves nothing today — one executor, and in all nine live memokit runs nobody else requested the same attestation (one request per payment, from the relayer that executed it: [`attestation-requesters.json`](fixtures/measurements/attestation-requesters.json), checked 2026-09-30) — and doing it properly means holding the request until late in the voting round, which risks adding a round (~90 s). **What deferring costs:** nothing on Coston2 (~0.054 C2FLR per duplicate); on mainnet, ~20.05 FLR per duplicate request, so up to (N−1) × 20 FLR per instruction once N executors watch the same address. Noted at the decision point in `executor/src/service/pipeline.ts`. |

### Safety machinery

| Claim | Status | Evidence |
|---|---|---|
| Pause facet | **Tested** | `test_pauseBlocksExecution`, `test_onlyPauserMayPause`, `test_onlyUnpauserMayUnpause` |
| Owner-managed receiving-address registry, immediate | **Tested** + **Live** | `test_receivingAddressRegistryIsImmediate`; every live run's receiving address is registered on chain |
| Timelock on economic parameters, Flare's split | **Tested** | `test_timelockedSetterSchedulesThenExecutes`, `test_ownershipTransferIsTimelocked` |
| Facets are cuttable into Flare's diamond | **Tested** | `test/FacetDropIn.t.sol` (10 tests). Never cut into Flare's real diamond. |
| Selectors diffed against Flare's live controller on Coston2 and mainnet | **Tested** against a pinned snapshot | `test/SelectorCollision.t.sol`; the snapshot is `fixtures/flare-selectors/`, refreshed by `selectors:check` |
| Post-conditions: covered by the commitment, evaluated before the fee, failure unwinds everything including the replay mark | **Tested** + **Fork**, live twice (both cash-out dust floors, both passed) | `test/PostConditions.t.sol` (16), `test_aFailedInstructionCanBeRetriedUnchanged`, `test_conditionsAreCheckedBeforeTheExecutorIsPaid`; Kinetic fork |
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
| Payload version byte `0x02`; v1 rejected as `UnsupportedPayloadVersion(0)` | **Tested** + **Live** | `test_v1PayloadsAreRejectedAsVersionZero`, `fixtures/memo-wire-v1.json` (14 vectors); every live instruction on the current diamond used v2 (both cash-outs and the three Phase 4 runs). The fund migration deliberately used the old format, on the old diamond. |
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
| A mainnet attestation request costs 20 FLR plus ~0.054 FLR gas; Coston2's costs 1000 wei plus gas | **Live** (read-only) | `getRequestFee` on Flare block 70425801 and Coston2 block 35725152, both `Payment` and `XRPPayment`; [docs/fdc-fees.md](docs/fdc-fees.md). Phase 0 read the same value on 2026-09-20. |

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
| Provider wallet registered on the FSA controller (XRPL Testnet; key holder not on chain) | `rEyj8nsHLdgt79KJWzXR5BgF7ZbaohbXwq` |
| FSA controller's main relayer (unidentifiable EOA) | `0xcA0Bf4Cbc1Cf8c4b5FD7984b42AF907099084466` |
| High-volume attestation requester (unidentifiable EOA) | `0x096103b7541bc4Ad716ABE6CfCddA728819f4b2f` |
| memokit receiving address (XRPL Testnet) | `rDfVHUx5SMgw5wwqjvzgFEFCnqW5CCGWyW` |
