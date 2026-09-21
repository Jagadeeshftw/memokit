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
| 5. End-to-end on Coston2 + XRPL Testnet | **blocked** — needs a funded Coston2 EOA; see below |

Test counts: `forge test` 74 passed; `npm test` 63 passed (35 sdk + 28 executor).

---

## 1. The blocked item, precisely

The acceptance trace is the one thing not delivered, and it is blocked on funding, not code.

Coston2's faucet (`https://faucet.flare.network/coston2`) is a browser app with no API, so
this session could not obtain C2FLR. The XRPL Testnet side is not a problem — its faucet is
an open HTTP endpoint and this repo already used it to send real Testnet payments (see
`fixtures/xrppayment-oracle.json`).

To run it, set `PRIVATE_KEY` to a funded Coston2 EOA and:

```bash
forge script scripts/DeployMemoKit.s.sol:DeployMemoKit \
  --rpc-url https://coston2-api.flare.network/ext/C/rpc --broadcast
npm run e2e -w @memokit/executor
```

`executor/src/e2e.ts` performs the whole path and writes
`fixtures/measurements/e2e-trace.json` with the XRPL hash, both Coston2 hashes, the vault
share delta, and per-leg latency.

**The funding prerequisite, and the two-run plan.** The personal account must hold the
vault's asset *before* the instruction runs — that is the whole point of the positioning,
and `e2e.ts` refuses to proceed otherwise with an explicit message.

The real target is one of the four funded Coston2 vaults, whose asset is FTestXRP
(`0x0b6A3645c240605887a5532109323A3E12273dc7`), which cannot be minted freely: getting it
into an account means running the FAssets mint once, out of band, into the account address
(`computeAccountAddress` gives you that before anything is deployed). That mint sits
deliberately outside the instruction path, and the trace records the balance before and
after so the distinction is on the record.

So the trace runs twice. First against a mock token and vault from
`scripts/DeployMocks.s.sol`: every part that can actually fail — the XRPL payment, the
offline request encoding, the attestation, the DA Layer poll, the on-chain proof
verification, the dispatch — runs against real Flare infrastructure, and only the deposit
target is synthetic. Then against a live vault once FTestXRP is in hand, with two addresses
changed and nothing else.

Everything else in the path is already exercised against live infrastructure: real XRPL
Testnet payments were sent, indexed by Flare, and attested-in-shape during the MIC work.

---

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

Fully measured legs:

| Leg | Measured |
|---|---|
| Round finalisation lag (newest finalised round vs wall clock) | **min 5 s, max 85 s, mean ~52 s** over 12 samples |
| XRPL submit → validated | **~4 s** (single ledger close, observed repeatedly) |
| XRPL validated → visible to Flare's indexer | **~4–8 s** (1–2 retries at 4 s intervals) |

The finalisation figure is consistent with 90 s voting rounds: a request lands uniformly
within a round, so the wait to round close averages ~45 s. That is a floor nothing we build
can reduce.

Estimated total from these parts: **~2 minutes** from signing the XRPL payment to a usable
proof, dominated by round finalisation. The one leg still unmeasured is round close → proof
actually served by the DA Layer, which needs a submitted request and therefore the funded
EOA. `e2e.ts` records every leg when it runs.

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
`test/AccountDerivation.t.sol`. Freezing to a literal remains a pre-mainnet task. Note that
facet fix (b) above will change this hash — do it before any address is relied on.

---

## Open items for Phase 2

1. **Run the acceptance trace.** Needs a funded Coston2 EOA. Planned as two runs: first
   against a mock token and vault deployed by `scripts/DeployMocks.s.sol`, which exercises
   every part that can fail against real Flare infrastructure, then against a live Coston2
   vault once FTestXRP is in the account.
2. **Rename `isTransactionIdUsed`** before anything consumes it — the last known drop-in
   collision, and free to fix today.
3. **Re-check the zeroed voting round** in the MIC if a non-zero round ever appears in a
   response.
4. **Freeze the proxy creation code** to a hex literal now that the beacon split has settled
   the derivation.
5. **Self-host a DA Layer.** 20 req/min is a low ceiling for more than one concurrent user.
6. **Measure round-close → proof-served**, the one latency leg still open.
