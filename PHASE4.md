# Phase 4 — Operating it for real

Phases 1 to 3 made memokit work. Phase 4 is about it working when nobody is watching: a service
anyone can run that executes instructions for the fee, an API that answers "where is my
instruction", and a way to sign one from a phone instead of from a seed in a file.

Everything here was run. The one thing that was not is labelled at the point of the claim.

## Contents

1. [The open executor](#1-the-open-executor)
2. [Racing, and what losing costs](#2-racing-and-what-losing-costs)
3. [The status API](#3-the-status-api)
4. [Signing by QR](#4-signing-by-qr)
5. [One end-to-end run](#5-one-end-to-end-run)
6. [What surprised me](#6-what-surprised-me)
7. [A scanner nobody reads is not a scanner](#7-a-scanner-nobody-reads-is-not-a-scanner)
8. [Deployed](#8-deployed)
9. [Not done, and open](#9-not-done-and-open)

Test counts at the end of Phase 4: **145** Solidity, **138** TypeScript in the SDK, **63** in the
executor, **24** fork tests.

---

## 1. The open executor

`executor/src/service/` is a long-running process with no privileges. It watches the receiving
addresses, builds attestation requests offline, pays for them, waits for the Data Availability
Layer, simulates, and submits `execute`. It is paid the fee the instruction committed to, in the
asset the instruction moves. `executor/DEPLOY.md` is the operator's guide.

Three properties shaped the design, and each came out of a measurement rather than a preference.

### It advances one instruction one stage at a time

The pipeline is not "follow this instruction from XRPL to Flare". It is "advance this instruction
by one stage and return". The slow leg is FDC's voting round — about 100 s of the 127 s to an
execute — and blocking on it would make an instruction that arrived a second later wait for the
first one's round for no reason. A restart mid-flight is also the normal case for a service that
gets redeployed: a state machine persisted after every stage resumes, a call stack does not.

### Idempotency is the chain's job; the store only saves money

State is persisted after every stage and every stage is safe to repeat, but the real guard is
that **an XRPL transaction id is consumable exactly once**. A duplicate submit cannot produce a
duplicate execution; it reverts. So losing the state file costs money, never correctness — which
is the right way round for a service anyone can run.

What it saves is the attestation fee. Before requesting one, the service rebuilds the request
offline — the bytes are a pure function of the XRPL transaction, so they can be reconstructed by
anyone — and asks the DA Layer whether a proof already exists. Somebody else's attestation is
just as good as one you paid for.

### It paces itself rather than reacting

The DA Layer sends no `Retry-After` and no `X-RateLimit-*` headers, so there is nothing to back
off against after the fact: a 429 arrives as a bare status and the only safe response is to have
not sent the request. One token bucket at the measured ~20 requests a minute covers every DA
call in the process. Retries are jittered, because every executor watching the same address sees
the same payment in the same instant and would otherwise retry in lockstep.

### The fee policy declines by default

The fee is in whatever token the instruction moves; the executor's cost is gas. Bridging those
needs a price, and a service that fetches prices to decide whether to work for a penny has a new
dependency and a new failure mode. So **the operator states what each token is worth to them**,
as a minimum per token, and an unlisted token is declined. It may be worthless, may revert on
transfer, or may not exist.

Rescue memos (`0xE0`/`0xE1`/`0xE2`/`0xFB`) pay nothing and are relayed anyway by default. They
are how a user unsticks their own queue, and the gas is small. It is a flag, not a hidden
default, because it is the operator's money.

### What an executor cannot do

A `0xFC` commit memo carries only a hash, and `execute` takes the preimage as an argument. An
executor without the preimage **cannot** run the instruction — not "will not". Either the author
hands it over, or the instruction is sent inline. In the live run below, the service was holding
ten older commit-memo payments for exactly this reason, and said so on every poll rather than
discarding them.

## 2. Racing, and what losing costs

Executors are not coordinated and there is nothing to coordinate with: the proof becomes
available to everyone in the same instant and the first `execute` mined consumes the transaction
id. Racing is the normal case, so it is an outcome, not an error.

| Where it is lost | What it costs | Counter |
|---|---|---|
| Before starting — already consumed when first looked at | Nothing | `races_total{outcome="lost-before-start"}` |
| At the simulation, before submitting | The attestation fee, if you paid it. A simulation is free. | `races_total{outcome="lost-before-submit"}` |
| After submitting, mined second | The gas of a reverted transaction, plus the attestation fee if you paid it | `races_total{outcome="lost-after-submit"}` |

The pipeline simulates before **every** submission, which is what keeps the common case in the
second row. The third row is not preventable: the window is between the `eth_call` and the block
the transaction lands in. It is counted separately so an operator can tell "the market is busy"
from "I am consistently arriving second".

`TransactionAlreadyUsed(bytes32)` is the only revert that means "this worked, just not by us".
Everything else is a real failure, and treating any of it as a lost race would make a broken
instruction look like a busy market. The controller's custom errors are now in the SDK's ABI, so
a revert is a name and arguments rather than four bytes.

## 3. The status API

`GET /status/{xrplHash}` answers where an instruction is, in seven terms: `seen`, `attesting`,
`proved`, `executed`, `failed`, `stuck`, `rescued` (plus `skipped` for a payment memokit will
never act on).

**The state machine is the Phase 3 classifier, not a second implementation of it.** That is a
correctness decision: two state machines over the same facts drift, and the one users read would
drift away from the one that decides what to do. The classifier decides the state from the chain
and the ledger; this module does the two things it cannot — translate the verdict into the
published vocabulary, and add the timestamps, which only a service that was watching can know.

The mapping is one function, and it is tested against every classifier state so a new one cannot
be added without deciding what it is called publicly. One case needs an argument the classifier
does not have: `awaiting-attestation` is `seen` or `attesting` depending on whether anybody has
paid for a request yet, which is in the store.

### It answers for instructions it never touched, and says so

The classifier only needs the chain and the ledger, so the API works for any payment to a
receiving address. But then the timestamps are observations, not a record. The response carries
`transitionsComplete: false` and a note saying so in words. **The state itself is always read
from the chain and is always exact**; it is only the timing that is partial.

This was caught by running it: the first live response reported `executed` with a single `seen`
transition and 151 seconds in it, which is true and reads as a lie.

### Read-only mode

The API is useful to people who are not executors — a wallet, a support desk, the status page.
Asking them for a funded Flare key to answer "where is my instruction" would be absurd, so
`READ_ONLY=1` watches and serves without a key, and none is read.

| Route | |
|---|---|
| `GET /healthz` | uptime, pending count, controller |
| `GET /metrics` | Prometheus: payments seen, attestations requested and reused, executions, races by outcome, declines, rate limits, errors by stage |
| `GET /instructions?limit=&state=` | recent instructions, newest first |
| `GET /status/{xrplHash}` | one instruction, with seconds in each state |

## 4. Signing by QR

`npm run sign` turns an instruction into an unsigned XRPL Payment, prints it, and renders it as
a QR — in the terminal and as a PNG. It signs nothing and reads no seed. That is the point:
every other script in this repo holds a key, and holding a key is what a memokit user is not
supposed to have to do.

The transaction is **deliberately partially specified**. `Sequence`, `Fee` and
`LastLedgerSequence` are left out for the signing wallet to fill in, because they depend on the
ledger at the moment of signing and a value computed here would be stale by the time anyone
scanned it. `AUTOFILLED_BY_THE_WALLET` names them, so a human reading the output knows what is
missing rather than wondering.

### Inline or commit, and why the QR changes the answer

A `0xFC` commit memo is 42 bytes whatever the instruction. But the preimage is keyed by a
transaction id that does not exist until after signing, so somebody has to hand it to an executor
out of band — which is fine for a script and hopeless for a QR someone scans in a café.

`--inline` emits `0xFD`, carrying the whole instruction: 523 bytes for a token transfer, and a
scanned payment that any executor watching can run with nothing but the ledger. That is the
right default for a QR and the wrong one for a large instruction, so it is a flag.

### Xaman

`--xaman` pushes the same unsigned transaction to Xaman's payload API and waits for the
signature, with `submit: true` so Xaman broadcasts it and the round trip is a single scan.

**Credentials are a hard stop, not a silent downgrade.** `XAMAN_API_KEY` and `XAMAN_API_SECRET`
come from the Xaman developer console; there is no anonymous mode. Without them the CLI names
exactly which variable is missing, links the console, and points out that everything except the
push already works — the unsigned transaction and its QR are produced either way and any XRPL
wallet can sign them.

The expiry is short by default (10 minutes) because the memo commits to an account nonce, and a
payment signed an hour later may find that nonce used. If the user signs with a different account
than the one the instruction was built for, the CLI says so rather than letting it fail on chain
with `SenderMismatch`: a memokit account is derived from its signer, so a different signer is a
different account.

## 5. One end-to-end run

One instruction, from a QR to a Flare transaction, with no human input after the signature.

| | |
|---|---|
| memo | `0xFD` inline, 523 bytes — self-contained |
| XRPL Payment | [`62A583F3…FD4A`](https://testnet.xrpl.org/transactions/62A583F332DAADDC5BE97FCFEA099B54E97E99989A8BE2267352F3467AE8FD4A) |
| requestAttestation | [`0x4ba4816f…2865`](https://coston2-explorer.flare.network/tx/0x4ba4816fc4b511a93c0b52115d56034e939bf9d0aba224f41c3419ba17ca2865) — by the service, round 1462823, 1000 wei |
| execute | [`0x1eefa273…60b4`](https://coston2-explorer.flare.network/tx/0x1eefa273d1a19fae0db851edcf964fce390edc08cb2f5a2a4de3485b2bd360b4) — by the service, 293,129 gas |
| result | 0.5 FTestXRP transferred, 0.2 FTestXRP executor fee paid out of the same balance |
| timing | **167 s** from XRPL ledger close. From the service seeing it: 159 s — 16 s before paying for the attestation, 138 s attesting, 5 s from proof to executed |
| trace | [`executor-service-run.json`](fixtures/measurements/executor-service-run.json) |

Verified from the receipt and chain state rather than the service's own logs: two `Transfer`
events out of the account, 500,000 to the recipient and 200,000 to `msg.sender`; the account went
9.1 → 8.4 FTestXRP and its nonce 1 → 2.

The wallet autofilled `Sequence: 20924593`, `Fee: 12`, `LastLedgerSequence: 20962521`, exactly the
fields the unsigned transaction leaves out.

Xaman was not in this run: the credentials are the operator's to create, and the same unsigned
JSON is what its payload API takes. Everything else — discovery, the attestation, the wait, the
simulation, the submission — was the service, unattended.

Most of the 138 s attesting is the FDC voting round, but not all of it: the service checks the DA
Layer every 30 s, so up to 30 s of it is the service's own polling. That part is a choice this
phase made, to stay inside the DA Layer's rate limit; the voting round is not.

## 6. What surprised me

**A transient RPC failure took down a read-only API.** The receiving addresses were read from
the controller on every tick and every status request, so three consecutive blips on the public
Coston2 RPC turned into three failed ticks and a 500 from `/status`. They change about never —
adding one is an owner transaction — so they are now cached for a minute, and the cache doubles
as the failure handling: a blip serves the last known answer instead of failing.

**A status API can be accurate and still mislead.** Reporting `executed` with one `seen`
transition and "151 seconds" against it is true in every field and wrong as a whole. The fix was
not more data, it was saying which kind of answer it is.

**Most of what an open executor sees, it cannot execute.** Ten of the eleven payments in the live
run carried commit memos whose preimages nobody had given it. That is not a bug and not a
misconfiguration; it is what a commit memo means. It is also the strongest argument for `--inline`
being the QR default.

## 7. A scanner nobody reads is not a scanner

Every push is preceded by gitleaks plus a targeted grep for the keys in `.env`. This phase's
trace tripped it twice, on `"tokenAddress": "0x0b6A36…"` — the public FTestXRP contract, already
in the README, `.env.example` and three earlier traces. Every trace file since Phase 1 has had
one of these to argue away, and a finding that is routinely dismissed trains the reader to
dismiss the next one.

`.gitleaks.toml` now allowlists exactly one shape: a `0x`-prefixed, **exactly 40** hex character
value. That is an EVM address and nothing else. It cannot hide what this repo actually has to
keep out — a private key is 64 hex characters, an XRPL seed is base58 beginning with `s`, an API
key is neither hex nor `0x`-prefixed.

That reasoning was checked rather than asserted. Each real secret from `.env` was planted in a
staged file under a key name designed to be missed (`"token"`, `"apiToken"`, `"secret"`), the
scan was run, and the file removed:

```
CAUGHT  the real Coston2 private key
CAUGHT  the real private key without 0x
CAUGHT  the real XRPL owner seed
CAUGHT  the real receiving-wallet seed
CAUGHT  an aceternity api key
```

The probe file was never committed and is not in the history.

## 8. Deployed

The executor runs on Railway at **https://memokit-executor-production.up.railway.app**, built
from the repository's Dockerfile. That build is also the verification the local container
runtime could not give: it built cleanly once a Railway-specific problem and a dependency
problem were fixed, and a third problem surfaced at boot. All three are in
[`executor/DEPLOY.md`](executor/DEPLOY.md#what-the-first-deploy-got-wrong).

### Its own key, and nothing else

The deployed service holds one secret: an EVM key generated for it and used by nothing else,
`0xD4dFA2b68d14fc71BF5940559Ad9F819c1b0350D`. Never the deployer key — an executor is a machine
on the public internet and the deployer key is an admin key. It lives only in Railway's secret
variables; it was never printed, never written into the repo, and `.env.example` has an empty
named slot for it and nothing more.

It was funded with **20 C2FLR** from the deployer address
([`0xbfd0e72e…c74d`](https://coston2-explorer.flare.network/tx/0xbfd0e72ee182ae0bdbaf18e5ebba3a31898daeb78a7cf5adb39b0abf8442c74d)).
The amount is sized from measured costs, and the measurement corrected an assumption: Coston2
charges **650 gwei**, so one complete instruction is 0.25–0.28 C2FLR — not the 0.011 an EVM habit
would guess. 20 C2FLR is about 75 instructions; the deployer keeps 22.2 for deployments.

**It holds no XRPL seed and no deployer key, confirmed from the running process rather than from
intent.** Railway's SSH needs a key registered on the account, which is not mine to add, so the
service checks its own environment at boot instead and publishes the result:

```json
"secretAudit": { "clean": true, "checkedNames": 7, "unexpectedSecretsPresent": [] }
```

That is on `/healthz` for anyone to read, it reports names and never values, and the deployment
runs with `REFUSE_IF_SECRETS_PRESENT=1`, so a seed added later would stop it booting rather than
sit there. It only ever reads the XRP Ledger.

### Public traffic cannot starve it

Before deploying, the status routes shared more than a process with execution: a `/status`
lookup spent the same DA Layer budget — about 20 requests a minute in total — that the executor
needs to fetch proofs. Enough public traffic would have stopped execution while every health
signal stayed green. That budget is now split three-to-one, and public lookups take their share
without waiting. Around it: 30 requests a minute per caller with a burst of 10 and `Retry-After`,
a global 300 a minute so a forged `x-forwarded-for` cannot multiply that, a concurrency cap of 10
on `/status`, and five-second caching on `/instructions` and `/metrics`.

Load-tested against a local instance with a real instruction in flight
([`http-load-test.json`](fixtures/measurements/http-load-test.json)):

| | |
|---|---|
| requests | 6,272,883 in 120 s — 52,274 a second, 20 concurrent |
| served / refused | 69 / 6,272,814, every refusal a 429 with `Retry-After` |
| socket errors | 0 |
| **the instruction** | **executed normally: 132 s seen to executed, against a 159 s unloaded baseline** |
| **the loop** | **15.4 s per tick against its 15 s target** |

One request peaked at 6.5 s: a lookup already past the limiter, waiting on chain reads. The
concurrency cap bounds it, and it delayed nobody but that caller.

### Verified against the public URL

| Check | Result |
|---|---|
| `/healthz`, `/metrics`, `/instructions`, `/status/{hash}` | all 200 |
| CORS | `access-control-allow-origin: *`, on the 429 as well; `OPTIONS` answers 204 |
| caching | `cache-control: public, max-age=5` on `/instructions` and `/metrics` |
| rate limit | 45 requests over one connection: 15 served, 30 refused, `Retry-After: 2` |
| balance | `lowBalance: false` at 19.72 C2FLR; the gauge is on `/metrics` |

### One instruction, executed by the deployed service

The owner signed and broadcast a QR-built payment. Nothing local was running. Everything after the
signature was the service at the public URL, paying with its own key.

| | |
|---|---|
| memo | `0xFD` inline, 523 bytes |
| XRPL Payment | [`12EC49C9…6894`](https://testnet.xrpl.org/transactions/12EC49C99940F9F91F70FE1EA3996432890CEF2D183A6DEA86208F09FE3E6894) |
| requestAttestation | [`0x8e122d18…c9ec`](https://coston2-explorer.flare.network/tx/0x8e122d188dc60d8742b99472293ae5c8566f270aeb952a92dc321e72be37c9ec) — from the deployed key, round 1463021 |
| execute | [`0xb2868ed4…9f4c`](https://coston2-explorer.flare.network/tx/0xb2868ed477162780dcbae916ecff5c8f83da3fc616e6f9aa5a7e0f5dd5979f4c) — from the deployed key, 310,213 gas |
| result | 0.3 FTestXRP transferred; 0.15 FTestXRP executor fee paid to the deployed key |
| timing | **165 s** from XRPL ledger close. From the service seeing it: 154 s — 5 s before paying for the attestation, 145 s attesting, 4 s from proof to executed |
| trace | [`deployed-executor-run.json`](fixtures/measurements/deployed-executor-run.json) |

Verified from the receipts rather than the service's own report: both transactions are `from`
`0xD4dFA2b6…`, the execute carries two `Transfer` events (300,000 to the recipient, 150,000 to
`msg.sender`), the transaction id reads consumed on the controller, the account's nonce went 3 → 4
and its balance 7.8 → 7.35 FTestXRP, and the executor's own balance fell by 0.2556 C2FLR of gas.

That response also exposed a bug worth fixing before a status page reads it: time in a *final*
state kept counting, so the instruction reported `executed: 33430` nine hours later — how long ago
it finished, rendered as if it were a wait. The clock now stops at a final state.

## 9. Not done, and open

- **Xaman is untested against the live API**, for want of credentials. The client is written
  against the documented payload endpoints and fails loudly rather than silently without them.
- **The status page does not exist.** It belongs in the memokit-site repository, which this work
  deliberately did not touch. The API it would read is live and documented above.
- **One executor is not a market.** Racing is handled and counted, but it has never actually been
  raced — every live run so far has had exactly one executor, which is a fair description of the
  evidence, not of the design.
- **No authentication on the HTTP surface.** Deliberate: everything it serves is already public
  on two chains. It is rate limited, cached and concurrency-capped — see §8.
- **Its state file is on one Railway volume.** Losing it costs attestation fees, never a duplicate
  execution, because the chain is the real guard.

## Reproducing

```bash
forge test              # 145 Solidity tests
npm test                # 138 SDK + 63 executor tests
npm run test:fork       # 24 fork tests: needs network and ffi

# live, needs .env (see .env.example):
MIN_FEE=0x0b6A3645c240605887a5532109323A3E12273dc7:100000 \
  npm run service -w @memokit/executor          # the executor
READ_ONLY=1 npm run status-api -w @memokit/executor   # the API alone, no key
npm run sign -w @memokit/executor -- --inline --to 0x... --amount 500000 --fee 200000
```
