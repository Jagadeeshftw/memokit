---
title: "Fee policy, racing and simulation"
description: "What the executor accepts, what losing a race costs, and why it simulates first."
---

The open executor is a service anyone can run. It watches memokit's receiving addresses, decides which
instructions are worth delivering, pays for their attestations, simulates, and submits. This page is
how it makes those decisions. [Run your own](/docs/executor/run-your-own) covers deployment.

## What it does with a payment

1. **Sees it.** It reads the XRPL ledger for payments to every receiving address the diamond has
   registered, every 15 seconds by default.
2. **Decides.** It reads the memo's opcode and, for an instruction it can see, the fee. The fee policy,
   below, says yes or no.
3. **Requests the attestation**, unless a proof already exists.
4. **Waits for the proof** from the DA Layer.
5. **Simulates** `execute` with the proof. Only if that passes does it
6. **Submit**, and record the outcome.

Every stage writes its state to a file before returning, so a restart resumes rather than repeats.

## The fee policy

The fee is paid in whatever token the instruction moves. The executor's cost is gas in the network's
own token. Bridging the two needs a price, and a service that fetched prices to decide whether to work
for a penny would gain a dependency and a failure mode. So it does not price anything. **The operator
says what each token is worth to them**, and anything not listed is declined:

```bash
MIN_FEE=<token address>:<minimum amount in base units>,<token address>:<amount>
```

An unlisted token may be worthless, may revert on transfer, or may not exist. Declining it by default
keeps the first surprise from being the operator's. The deployed executor accepts FTestXRP, at a
minimum of 100000, which is 0.1 FTestXRP.

Other decisions the policy makes:

| Setting | Default | What it decides |
|---|---|---|
| `RELAY_RESCUES` | `true` | Relay `0xE0`, `0xE1`, `0xE2` and `0xFB` rescue memos, which pay nothing. It costs a little gas; it is how owners unstick their own queues. |
| `UNKNOWN_PAYLOAD` | `wait` | What to do with a `0xFC` commit memo whose payload it does not have: keep watching, or forget it. |
| `PAYLOADS_FILE` | none | A JSON map of transaction id to payload, for commit memos. Re-read on every lookup, so a payload can be added without a restart. |

### The one thing an executor cannot do

A `0xFC` commit memo carries only a hash, and `execute` takes the payload as an argument. An executor
without the payload **cannot** run the instruction. Either the author hands it over through
`PAYLOADS_FILE`, or the instruction is sent inline as `0xFD`. The signing CLI signs inline for that
reason.

## Racing

Every executor watching the same receiving address sees the proof at the same moment, and the first
`execute` mined consumes the XRPL transaction id. Losing is normal, and is logged as an outcome, not
an error.

| Where the race is lost | What it costs |
|---|---|
| At the simulation, before submitting | The attestation fee, if this executor paid it. A simulation is free. |
| After submitting, mined second | The gas of a reverted transaction, plus the attestation fee if this executor paid it. |

Racing is built and tested. It has never happened live: every live run has had one executor.

### Duplicate attestation requests

Two executors watching the same address may each pay for the same attestation. One proof serves
both, so one fee is wasted. On Coston2 that is 1000 wei; on Flare mainnet a request costs 20 FLR. The
executor does not yet check for an identical request before paying for its own. That is deferred
deliberately: with one executor it saves nothing, and doing it well means holding the request until
late in the voting round, which risks adding a round. It is marked Open in the
[claim ledger](/docs/evidence/claim-ledger), with what deferring costs.

## Simulation before every submission

The executor calls `execute` as a read-only simulation before sending it, every time. Two reasons:

- **A lost race costs less.** If another executor already delivered, the simulation fails with
  `TransactionAlreadyUsed` and nothing is sent. Most races end in the cheap first row above.
- **A real failure is not mistaken for a busy market.** If the simulation fails for any other reason,
  a bad nonce or a post-condition, the executor records the reason and retries later, up to
  `MAX_ATTEMPTS` (8) before parking the instruction as `stuck`.

## Trying it without spending

`DRY_RUN=1` does everything except spend: it watches, decides and logs, but requests no attestation and
submits nothing. From a built clone, with a Coston2 key in `.env` and a state file of its own:

```bash
set -a && . ./.env && set +a
export FXRP=$(grep '^MEMOKIT_FXRP=' .env.example | cut -d= -f2)
DRY_RUN=1 MIN_FEE=$FXRP:100000 STATE_FILE=/tmp/memokit-dry.json HTTP_PORT=8081 \
  npm run service -w @memokit/executor
```

It logs `starting` with `mode: executor` and `dryRun: true`, then a line for each payment it sees and
what it does with it: `declined` with a reason, `already executed elsewhere`, or
`DRY RUN: would request an attestation`. Stop it with Ctrl-C.

Its first line is a warning that the environment holds secrets an executor does not need. That is
because `.env` also holds `XRPL_SEED`. A real executor should run with its own Coston2 key and nothing
else; the deployed one refuses to start otherwise.

One thing the dry run shows that the executor does not yet handle: an instruction whose nonce another
instruction has already used can only fail with `InvalidNonce`, but the executor would still pay for
its attestation. The simulation stops it before any execute is sent.

## What it spends

On Coston2, at 650 gwei, the deployed executor measured 0.25 to 0.28 C2FLR per instruction: the
attestation request and the execute. It flags itself as low on funds below 2 C2FLR, about eight
instructions of headroom. See [The status API](/docs/executor/status-api) for `/healthz`.
