# Phase 1 — Walking Skeleton

memokit: XRPL-originated arbitrary calls on Flare, acting on assets a personal account
already holds, with no FAssets mint in the path.

Status as of 2026-09-21. Everything below that says "measured" was run against live
infrastructure on that date; the raw captures are in [`fixtures/`](fixtures/).

---

## What is done

| Scope item | State |
|---|---|
| 1. Repo scaffold, periphery pinned | done — `@flarenetwork/flare-periphery-contracts@0.1.53` |
| 2. Memo codec, fixtures, conformance, property tests | done — 35 TS + 11 Solidity conformance tests |
| 3. Attestation client, offline MIC, DA Layer, measurements | done — **and the verifier is off the critical path, proven** |
| 4. Contracts: controller, account, recovery | done — 74 Solidity tests |
| 5. End-to-end on Coston2 + XRPL Testnet | done — **two traces**, mock vault and a live Coston2 vault |

Test counts: `forge test` 74 passed; `npm test` 63 passed (35 sdk + 28 executor).

---

## 1. The acceptance trace

Run twice, both on Coston2 and XRPL Testnet, against real FDC attestations.

**Deployment** (`fixtures/deployment.json`):

| | |
|---|---|
| memokit diamond | `0xd1B2EF71B305828Da135d5524E81fDd5523a3f73` |
| MemoControllerFacet | `0xc86A57b64eE8A30C7438bea15b6Eb5881A981928` |
| AdminFacet | `0x588050414b2eD7228E9afd2141B1Ab3D34A0474A` |
| AccountsFacet | `0x9dB28b3E4AFf8609F2a68D80E1C8270497221FDE` |
| PersonalAccount impl | `0x714E9B11CBb66716B4a688f5fE33Dde9e9D392D9` |
| PersonalAccountBeacon | `0x0c5537E3A9D41E4E5DdB48137873786D649E4178` |
| XRPL owner | `rpnDcUjasCYome3WntkxqQ3gG4wuLXM4WE` |
| receiving address | `rDfVHUx5SMgw5wwqjvzgFEFCnqW5CCGWyW` |
| derived account | `0x823d7dAe9e087D4c96225DE6385376a990067d4e` |

**Run 2 — live Coston2 vault** (`fixtures/measurements/e2e-trace-live-vault.json`). The one
that matters: real FTestXRP into `TESTearnXRP`, one of the four funded vaults from Phase 0.

| | |
|---|---|
| vault | `0xF97B2bBdB2f4a561806e5038a503eCA81554634E` TESTearnXRP |
| asset | `0x0b6A3645c240605887a5532109323A3E12273dc7` FTestXRP |
| XRPL tx | `11A56DB868A09588C2BBC57E6C957FA080FC78EE42561D26AB1ABBED437753A6` |
| memo | `0xfc01…` — opcode `0xFC`, 42 bytes |
| requestAttestation | `0xded36a56c8faccd5c280507c26253f8450804f43ae5f61c6f2bda7bd3e81272e` |
| voting round | 1461421 |
| execute | `0x69f5259f72139c4307246bbffd11f73937e85eacc34b23dd1718413b56821978` |
| **balances** | **10.0 → 5.0 FTestXRP, 0 → 4.994505 TESTearnXRP** |
| end to end | **152 s** |

The share count is not 1:1 with the deposit, which is the tell that this is a real vault with
a real exchange rate: `previewDeposit(5000000)` returns `4994505`, exactly what landed.

**Run 1 — mock vault** (`fixtures/measurements/e2e-trace-mock-vault.json`). Same pipeline,
synthetic deposit target, run first to shake out the plumbing.

| | |
|---|---|
| vault / asset | `0x6ed3519C362d7c97198fcdA8822eba67176590ed` / `0x41BbB3B8C1e359D7E8DDCBb3AD6EE140bf82b1e3` |
| XRPL tx | `47ABC62C4D1B955444A6934C3476B2814A3EFAFC6E411C8845F5D0F61B6F2976` |
| execute | `0xe58bc5bda9aeff90400a603e5f2f650cc7b37c01fa5309c56570a0562b229dfb` |
| balances | 100.0 → 75.0 asset, 0 → 25.0 shares |
| end to end | 162 s |

### The claim, checked rather than asserted

**No mint in the instruction path.** FTestXRP `totalSupply` is `9150713669273` in block
35630915 and `9150713669273` in block 35630916, the block containing `execute`. The
instruction moved a balance that already existed. This is the capability Flare's
`0xFF`/`0xFE` cannot reach, because those are only ever reached as a side effect of
`executeDirectMintingWithData`.

**The verifier was not used.** Both runs built the attestation request and its message
integrity code from XRPL ledger data alone, via `fdc/buildResponse.ts`. FDC confirmed both
requests, so verifier independence is no longer a claim about an offline fixture.

**Independently verified on chain**, not just read back from the script: account holds
5000000 FTestXRP and 4994505 vault shares, nonce advanced to 2, the XRPL transaction id is
marked consumed, and the account reports `xrplOwner()` = `rpnDcUjas…` with `controller()` =
the diamond. The execute transaction emitted `AccountCreated`, `UserOpExecuted` and
`InstructionExecuted` whose topic hashes match our declarations exactly.

### Funding the account

`scripts/DeployMocks.s.sol` handles the mock case. For the live vault the account needed
real FTestXRP, which cannot be minted freely, so `executor/src/fundWithFxrp.ts` runs the
classic FAssets path out of band: `reserveCollateral` → XRPL payment to the agent →
`Payment` attestation → `executeMinting` → transfer into the account. The FXRP lands on the
relayer EOA first and is then transferred in, which keeps funding visibly separate from
anything memokit does.

Direct minting would have been simpler but is not available to us: Coston2 routes
direct-mint targets by XRPL **DestinationTag** (confirmed by reading a live direct-mint
payment — tag 1186 with no memo at all), and tags are registered by Flare, not by arbitrary
callers. That is worth knowing independently of funding: it means Flare's direct-mint rail
has a registration gate that memokit's does not.

That funding script does use the verifier, to encode the classic `Payment` request. That is
deliberate and harmless — it is not the protocol path, and replicating `buildResponse` for a
second attestation type would prove nothing new.

## 2. Measured: DA Layer limits

Phase 0 recorded "Flare's docs describe a rate-limited public endpoint but publish no
numbers". Measured against `https://ctn2-data-availability.flare.network`, capture in
[`fixtures/measurements/da-layer.json`](fixtures/measurements/da-layer.json):

| Property | Measured |
|---|---|
| API key required | **No.** Unauthenticated `GET /api/v0/fsp/latest-voting-round` → HTTP 200 |
| Sequential burst | **19 requests succeed, the 20th returns 429** |
| Concurrent burst (30 at once, limiter released) | **19 succeed, 11 return 429** |
| Recovery after a 429 | **~48 s and ~58 s** across two observations |
| Rate-limit headers | **None.** No `Retry-After`, no `X-RateLimit-*` |
| Response latency | p50 ~430 ms, p90 ~570 ms sequential; p50 ~900 ms under concurrency |

Two independent shapes both stopping at exactly 19 successes, with ~50 s recovery, reads as
a token bucket of roughly **20 requests per minute per client**. The absence of any
rate-limit header is the operationally annoying part: a client cannot back off politely, it
can only discover the wall.

What that means for us: 20 req/min is ample for a single executor polling one proof, and
immediately insufficient for a production executor serving many users, since each pending
instruction needs repeated polls. Self-hosting a DA Layer moves from "recommended" to
"required" at very low volume. Phase 0 ranked this risk 5; the measurement supports keeping
it there, with the note that the binding constraint arrives earlier than expected.

The probe is bounded — it stops at the first 429 and caps total requests — because this is a
shared public endpoint.

## 3. Measured: latency

Every leg, from two complete runs:

| Leg | Run 1 (mock) | Run 2 (live vault) |
|---|---|---|
| XRPL submit → validated | 7 s | 7 s |
| XRPL validated → request built offline | <1 s | <1 s |
| request built → attestation request mined | 7 s | 5 s |
| **request mined → proof served by DA Layer** | **144 s** | **136 s** |
| proof available → `execute` mined | 3 s | 3 s |
| **total** | **162 s** | **152 s** |

So roughly **two and a half minutes** from signing the XRPL payment to the deposit landing,
and around 90% of that is one leg: waiting for the voting round to close and the DA Layer to
serve the proof. That matches the independently measured round-finalisation lag (mean ~52 s
on a 90 s round) plus the DA Layer's own publication delay.

Two consequences worth stating plainly. Nothing memokit does can meaningfully reduce this —
the floor is FDC's round cadence, not our code. And the remaining ~15 s of controllable
latency is not worth optimising until the 140 s leg changes.

## 4. Where `XRPPayment` diverged from expectation

Three findings, all from running against live infrastructure rather than reading.

**a. The MIC salt is ABI-encoded, not appended. This was the dangerous one.**

The message integrity code is

```
keccak256(abi.encode(Response, "Flare"))    with Response.votingRound = 0
```

and specifically **not** `keccak256(abi.encode(Response) ‖ "Flare")`, which was the natural
reading and the implementation this repo started with. The two differ completely. Getting it
wrong produces a well-formed request that FDC simply never confirms — no revert, no error,
the fee is burnt and the user waits forever.

Rather than guess, `executor/src/measure/micOracle.ts` sends a real XRPL Testnet payment and
tests four candidate constructions against the verifier's own answer. The first guess lost.
The result is pinned offline in `executor/test/encode.test.ts` so the finding cannot be
undone by a later edit.

One honest gap: the verifier returns `votingRound: 0` already, so the "zero the voting round"
half of the construction is **untested** — `zeroRoundSaltAppended` and
`keepRoundSaltAppended` produced identical output. If a non-zero round ever appears in a
response, that branch needs re-checking.

**b. The request encoding was correct as transcribed.** Our offline
`abi.encode(attestationType, sourceId, mic, (transactionId, proofOwner))` matches the
verifier's `abiEncodedRequest` byte for byte. No divergence.

**c. The response body behaves exactly as `IXRPPayment.sol` declares**, which is the finding
that matters most for the architecture:

- `firstMemoData` returned our 42-byte memo **verbatim** — not truncated, not a digest.
  This is the premise of the whole design and it is now confirmed on live infrastructure.
- `sourceAddress` is the full XRPL address string, and
  `keccak256(sourceAddress) == sourceAddressHash` holds exactly, so `Proofs.verify`'s
  binding is sound.
- `hasDestinationTag` is populated, so the contract can assert the absence of a tag on chain
  rather than relying on Flare's by-convention prohibition.

**d. Not FDC's fault, but it cost real debugging time:** rippled's API v2 renames `Amount` to
`DeliverMax` in `tx_json`. Reading only `Amount` yields `intendedReceivedAmount = 0`, a wrong
MIC, and the exact silent failure described in (a). `buildResponse.ts` accepts both, and
`executor/test/buildResponse.test.ts` has a regression for it.

**e. Three more, found only by running it live.** All were silent or misleading failures,
which is the point of running rather than reasoning:

- `Relay` has no `firstVotingRoundStartTs()` or `votingEpochDurationSeconds()`. Those were a
  plausible guess and both revert *with no revert data*, so ethers reports only "missing
  revert data" against a bare address. Only `getVotingRoundId(uint256)` is in `IRelay`.
- The DA Layer's `proof-by-request-round-raw` returns `{proof, response_hex,
  attestation_type}` — `response_hex` being `abi.encode(Response)`, not a JSON response
  object. That is what "raw" means, and it is not documented in the endpoint name. Decoding
  it with our own `RESPONSE_ABI` turned out to be a bonus: it is one more independent check
  that the transcription from `IXRPPayment.sol` is correct.
- An extra pair of parentheses around the proof tuple in an ethers ABI string fails only at
  call time, with `array is wrong length`, pointing nowhere near the actual mistake.

**f. FAssets FXRP transfers can revert transiently.** Transferring the freshly minted FXRP
immediately after `executeMinting` reverted with no reason string, while the identical call
simulated and then succeeded moments later. Worth knowing before building a funding flow
that assumes mint-then-transfer is atomic from the caller's point of view.

**The outcome that matters:** `fdc/buildResponse.ts` reconstructs the whole attestation
response from ledger data alone, and its MIC matches Flare's. The verifier is a test oracle
in this repo, never a runtime dependency — so the API-keyed, Flare-operated service is not
between a user and their funds.

## 5. Where the facet-shaped constraint is awkward

The constraint holds — `MemoControllerFacet` has no constructor, no immutables, and only
ERC-7201 namespaced storage, and `test/FacetDropIn.t.sol` proves it coexists with a host
facet writing raw slots 0–2 in both directions. But cutting it into Flare's *actual* diamond
turned up three problems, found by diffing our selectors against the live Coston2
`MasterAccountController` (74 selectors). One was serious enough to fix inside this phase.

**a. `implementation()` collided, and it was architectural. Fixed.**

Account proxies are beacon proxies, so whatever they name as beacon must answer
`implementation()`. Both Flare and the first cut of memokit made the controller its own
beacon — which puts `0x5c60da1b` on the controller. Flare's diamond already has it. Cutting
memokit in would either revert on the cut, or, if that selector were simply omitted from the
cut, silently point every memokit account at *Flare's* `PersonalAccount`, which has neither
`executeUserOp` nor `payExecutorFee` in the shape memokit calls them. A wrong answer, not an
error.

Renaming cannot help, because `IBeacon.implementation()` is fixed by the proxy. The fix was
to stop using the controller as the beacon: `PersonalAccountBeacon` is now a standalone
contract, its address lives in memokit's namespaced storage, and `AccountsFacet` no longer
declares `implementation()` at all. `test/FacetDropIn.t.sol::BeaconSeparationTest` asserts
the diamond does not route `0x5c60da1b`, that the beacon is a different address from the
diamond, that only the diamond can upgrade it, and that one beacon write repoints existing
accounts.

This changed the account derivation from `(controller, owner)` to `(beacon, controller,
owner)` and therefore every account address — which is exactly why it was worth doing before
any address was recorded. The pinned proxy code hash was updated in the same change.

**b. `isTransactionIdUsed(bytes32)` still collides. Deliberately deferred.**

Flare's diamond already has `0x8e103030`. A cut including it reverts with
`SelectorAlreadyExists`, which is the safe failure. The unsafe one is cutting everything
*except* it: callers then reach Flare's implementation reading Flare's replay set and get a
confident wrong answer about memokit state. Renaming is free today — it is a view with no
external consumers — and expensive once anything depends on it. It is carried as a Phase 2
item rather than folded in here. `BeaconSeparationTest` pins the collision so it cannot be
forgotten.

Of `MemoControllerFacet`'s five selectors, only that one collides. `execute`, `nonceOf`,
`isIgnored` and `replacementFeeOf` are clear.

**c. Ownership and pause duplicate the host's. Expected, not a defect.**

`owner()`, `pause()` and `unpause()` all collide with Flare's. This is inherent — a host
diamond has its own governance and would drive memokit's namespaced config through it — but
it means **`AdminFacet` is not part of the drop-in unit**. Only `MemoControllerFacet` (after
fix b) and `AccountsFacet` are. Better to state that plainly than to imply "the facets are
drop-in" and let someone discover it during a cut.

**d. A smaller one, now explicit rather than incidental.** The account address depends on
which diamond and which beacon created it, so the same XRPL address maps to a different
account in a host deployment than in ours. That is intended — we do not want Flare's diamond
as our beacon — but it does mean a user can hold balances under both protocols.

---

## Design decisions worth recording

**Opcodes.** memokit claims `0xFD` (inline) and `0xFC` (hash-commit), reserves `0xF8`–`0xFB`,
and **reuses Flare's `0xE0`/`0xE1`/`0xE2` at their original values with their original
semantics and lengths**. The receiving XRPL address disambiguates which protocol a memo is
addressed to, so reuse is unambiguous and maximises wallet compatibility. `0xFC` is
byte-identical in shape to Flare's `0xFE`: same 10-byte header, same 42-byte total, same
hash-commitment semantics, one byte different.

**Instruction payload.** `abi.encode(address sender, uint256 nonce, Call[] calls)` — a
three-element top-level tuple, deliberately not a wrapped struct, because that keeps it
trivially reproducible by ethers' `AbiCoder` and avoids a leading offset word. The
conformance test proves Solidity's `abi.encode` and ethers agree byte for byte.

**`Call[]`, not `PackedUserOperation`.** Flare honours only `sender`, `nonce` and `callData`
from the UserOp and carries the other six fields for ABI compatibility. memokit is not an
ERC-4337 bundler, so the dead weight would only cost memo bytes.

**Executor fee.** Flare pays its direct-mint executor out of the freshly minted fAsset.
memokit has no mint, so the executor is paid from what the account already holds — the
positioning in miniature. A zero fee is valid and is the lockout escape hatch: `execute` is
permissionless, so an owner whose account cannot pay always submits it themselves.

**Recovery ordering.** The ignore flag is consumed *before* the memo is parsed. Check it
after and a memo too malformed to parse could never be recovered from, because recovery
would revert on the same bad bytes. `test/Recovery.t.sol` pins this with a 3-byte memo that
nothing can decode.

**Account derivation.** Flare froze their proxy creation code as a hex literal because CBOR
metadata made it drift on unrelated edits. memokit builds with `bytecode_hash = "none"`,
which removes the cause, and pins `keccak256(creationCode)` =
`0x6aecc412c9302a9f3d2e48b1104b85786f85f9d2ac2a95efd97d1bcbdec02944` in
`test/AccountDerivation.t.sol`. The beacon split changed this hash once, deliberately and
before any address was recorded; it is settled now. Freezing to a literal remains a
pre-mainnet task.

---

## Open items for Phase 2

1. **Rename `isTransactionIdUsed`** before anything consumes it — the last known drop-in
   collision, and free to fix today.
2. **Re-check the zeroed voting round** in the MIC if a non-zero round ever appears in a
   response.
3. **Freeze the proxy creation code** to a hex literal now that the beacon split has settled
   the derivation.
4. **Self-host a DA Layer.** 20 req/min is a low ceiling for more than one concurrent user,
   and the measured 140 s proof leg means each pending instruction polls many times.
5. **Consider an ERC-1363 receiver hook on `PersonalAccount`.** Flare's own account
   implements `onTransferReceived`; ours does not. Plain ERC-20 transfers into the account
   work — the live trace depended on one — but any counterparty using `transferAndCall`
   would fail.
6. **Reconsider whether the executor fee should be a separate token.** The live run used a
   zero fee. Paying in the fee token means the account must hold two assets, which is
   friction the positioning does not need.

---

**Status at the end of Phase 2** (see [PHASE2.md](PHASE2.md)): item 1 (rename) is done, item 5
(ERC-1363 receiver) is done, and item 6 is closed by moving the executor fee into the committed
payload, in the moved asset. Items 2, 3 and 4 remain open. Phase 2 also found that this repo did not
build from a clean clone (an ignore rule hid `scripts/lib/FacetSelectors.sol`); that is fixed.

