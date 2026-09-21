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
| 4. Contracts: controller, account, recovery | done — 68 Solidity tests |
| 5. End-to-end on Coston2 + XRPL Testnet | **blocked** — needs a funded Coston2 EOA; see below |

Test counts: `forge test` 68 passed; `npm test` 63 passed (35 sdk + 28 executor).

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

**A second prerequisite, worth deciding before the run.** The instruction deposits into one
of the live Coston2 vaults, whose asset is FTestXRP
(`0x0b6A3645c240605887a5532109323A3E12273dc7`). The personal account must therefore hold
FTestXRP *before* the instruction runs — that is the whole point of the positioning, and the
script refuses to proceed otherwise with an explicit message. FTestXRP cannot be minted
freely; acquiring it means running the FAssets mint once, out of band, into the account
address (which `computeAccountAddress` gives you before any deployment). That mint is
deliberately outside the instruction path and the trace records the balance before and after
so the distinction is on the record.

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
hits three problems, found by diffing our selectors against the live Coston2
`MasterAccountController` (74 selectors):

**a. `isTransactionIdUsed(bytes32)` collides — and silently.** Flare's diamond already has
`0x8e103030`. A cut including it reverts with `SelectorAlreadyExists`, which is the good
case. The bad case is cutting everything *except* it: callers then reach Flare's
implementation reading Flare's replay set, and get a confident wrong answer about memokit
state. **Fix: rename it.** It is a view with no external consumers yet, so this is free now
and expensive later.

Of `MemoControllerFacet`'s five selectors, only that one collides. `execute`, `nonceOf`,
`isIgnored` and `replacementFeeOf` are clear.

**b. `implementation()` collides, and this one is architectural.** Account proxies are beacon
proxies whose beacon is the controller, so the controller must answer `implementation()`.
Flare's diamond already answers it — with *their* `PersonalAccount`. Cut memokit into their
diamond and every memokit account would delegate to Flare's implementation, which does not
have our `executeUserOp`/`payExecutorFee` surface.

This is not fixable by renaming, because `IBeacon.implementation()` is fixed by the proxy.
The fix is to stop using the controller as the beacon: give accounts a dedicated beacon
contract and hold its address in memokit's namespaced storage. That also removes
`AccountsFacet` from the set of facets a host has to accept. Worth doing before anything
depends on account addresses, since it changes the proxy init code and therefore every
derived address.

**c. Ownership and pause duplicate the host's.** `owner()`, `pause()` and `unpause()` all
collide. This is expected rather than wrong — a host diamond has its own governance and would
drive memokit's namespaced config through it — but it means **`AdminFacet` is not part of the
drop-in unit.** Only `MemoControllerFacet` (after fix a) and the account machinery (after fix
b) are. That should be stated plainly rather than implied by "the facets are drop-in".

**d. A smaller one:** `Accounts.initCode` puts `address(this)` in the proxy init code, so an
account's address depends on which diamond created it. Correct, and deliberate — we do not
want Flare's diamond as our beacon — but it means the same XRPL address maps to a different
account in a host deployment than in ours. Fix (b) makes this explicit rather than incidental.

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
`0x59953ab402ba5b2b9267d7273cd5a416e2a1caa5c273bff368d8a5d0360c4dd1` in
`test/AccountDerivation.t.sol`. Freezing to a literal remains a pre-mainnet task. Note that
facet fix (b) above will change this hash — do it before any address is relied on.

---

## Open items for Phase 2

1. **Run the acceptance trace.** Needs a funded Coston2 EOA and FTestXRP in the account.
2. **Rename `isTransactionIdUsed`** before anything consumes it.
3. **Move the beacon off the controller** — the one real blocker on the A2 drop-in path, and
   it changes every account address, so it is cheapest now.
4. **Re-check the zeroed voting round** in the MIC if a non-zero round ever appears.
5. **Freeze the proxy creation code** to a hex literal, after (3).
6. **Self-host a DA Layer.** 20 req/min is a low ceiling for more than one concurrent user.
7. **Measure round-close → proof-served**, the one latency leg still open.
