---
title: "The status API"
description: "GET /healthz, /instructions and /status/{xrplHash}."
---

Every executor serves a small public HTTP API: its own health, the instructions it has seen, and where
any one instruction is. The deployed executor's API is at
https://memokit-executor-production.up.railway.app, and https://memokit.0xo.in/status is a page over it.

It is **one executor's view, not the network's**. The state of an instruction is read from the chain,
so it is the same whoever you ask. The timestamps are what this executor observed.

## Routes

| Route | Returns |
|---|---|
| `GET /healthz` | uptime, pending instructions, the controller, seconds since the last poll, the executor wallet's balance with a `lowBalance` flag, and `secretAudit` |
| `GET /status/<xrplHash>` | one instruction's position in the state machine, with seconds in each state |
| `GET /instructions?limit=&state=` | recent instructions this executor has seen, newest first |
| `GET /metrics` | Prometheus text: payments seen, attestations, executions, races, declines, rate limits, errors |

## `GET /healthz`

```bash
curl -s https://memokit-executor-production.up.railway.app/healthz
```

```json
{
  "ok": true,
  "controller": "0x0E762EAe…0714",
  "lastTickSecondsAgo": 8,
  "secretAudit": { "clean": true, "checkedNames": 7, "unexpectedSecretsPresent": [] },
  "executor": { "address": "0xD4dFA2b6…350D", "balanceFlr": 17.05, "lowBalance": false }
}
```

- `lastTickSecondsAgo` under about 20 means it is polling.
- `lowBalance` turns true below 2 C2FLR.
- `secretAudit.clean` is the boot-time check that the process holds no XRPL seed and no deployer key.
  The deployed executor refuses to start if it does.

## `GET /status/<xrplHash>`

```bash
curl -s https://memokit-executor-production.up.railway.app/status/95E4B21C2E2BB15222F553E62081228F918BF76DEA61E42A02C5B2EDC5B5B051
```

| Field | Meaning |
|---|---|
| `state` | `seen`, `attesting`, `proved`, `executed`, `failed`, `stuck`, `rescued` or `skipped` |
| `final` | true when nothing further can change it; a page can stop polling |
| `classifier` | the rescue classifier's own state, `reason`, `loss`, and a suggested `rescue` |
| `transitions` | each state entered, with its time and a note |
| `transitionsComplete` | false when the times are observations rather than a record of what this executor did |
| `note` | present when there is something about the answer not to assume away |
| `elapsed` | seconds spent in each state; a final state is not counted |
| `attestation` | the request this executor paid for, and its voting round |
| `execution` | the execute's hash and block, and `byUs`: whether this executor sent it |
| `skipReason` | why the fee policy declined it |
| `lastError` | the most recent failure, and the stage it happened at |
| `validitySecondsRemaining` | seconds left in the proof's 24-hour window; negative once it has closed |

### How to read the transitions

Each transition carries a note that says who moved it:

- `attestation requested in round N`, `proof available`, `executed in block N`: this executor did it.
- `on chain; this service has not recorded it yet`: the chain is a few seconds ahead of this
  executor's own record, for instance an execute mined before its receipt came back. The answer is
  not `final` until the executor catches up, so a polling page keeps asking.
- `observed on chain; this service did not perform the transition`: this executor did not do it. It
  appears only where that is true: a read-only instance, or a record this executor had already
  finished with.
- `XRPL close; this service has not picked it up yet`: a payment seconds old, before the executor's next
  read of the ledger.
- `XRPL close; this service was not watching`: a payment this executor never tracked.

Before 2026-10-01 the API could write the "did not perform" note on work it had just done, when a
lookup raced its own processing. Records from then are corrected when read, where the record proves
this executor did the work.

## `GET /instructions`

```bash
curl -s "https://memokit-executor-production.up.railway.app/instructions?limit=5&state=executed"
```

Returns `count` and `instructions`: for each, the XRPL hash, state, owner, account, opcode, XRPL close
time, transitions, who executed it, and the execute's hash.

## Limits

The API shares a process and the DA Layer's rate limit with the executor, so it is limited to protect
execution, not the data. Everything it serves is public on two chains anyway.

| Limit | Default |
|---|---|
| Requests per caller | 30 a minute, a burst of 10 |
| Requests across every caller | 300 a minute |
| `/status` lookups in flight | 10 |
| Caching of `/instructions` and `/metrics` | 5 seconds |

Past a limit it answers `429` with a `Retry-After` header, which browser pages can read. A lookup that
cannot afford a DA Layer query answers from the chain alone.

## Run it without a key

```bash
READ_ONLY=1 npm run status-api -w @memokit/executor
```

From a built clone, with no `.env` needed. It watches and serves on port 8080, and never signs.
