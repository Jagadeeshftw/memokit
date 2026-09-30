---
title: "Look up an instruction"
description: "Where an XRPL-signed instruction is, from one executor's public status API."
---

Every memokit instruction starts as an XRPL payment, so its XRPL transaction hash is all you need to
find it. There are three ways to look one up.

## In the browser

Open https://memokit.0xo.in/status, paste the XRPL hash under **Lookup**, and press **Look up**.

The page shows the state in large type, why it is in that state, what would be lost if nobody did
anything more, and how long it spent in each state. While the instruction is still moving it shows
elapsed time next to the expected time, and asks again every 5 seconds. When the state is final,
it stops asking.

**Recent** lists every payment the deployed executor has seen, newest first. **Executor** shows its
health: balance, last tick, and whether the process holds any secret it should not.

## With curl

```bash
curl -s https://memokit-executor-production.up.railway.app/status/4D9F2AD97010C8E4DC20FCC570EEAD797DF7E914D3E275CD0336CC1BEF5A58EF
```

That is the demo dry run's cash-out. The answer, trimmed:

```json
{
  "state": "executed",
  "final": true,
  "classifier": {
    "state": "executed",
    "reason": "the transaction id is marked consumed on chain",
    "loss": "Carrier payment only. The instruction did what it said."
  },
  "elapsed": { "seen": 6, "attesting": 89, "proved": 15 },
  "execution": { "txHash": "0x5da0d80a…", "blockNumber": 35745285, "byUs": true }
}
```

The fields that matter:

| Field | Meaning |
|---|---|
| `state` | `seen`, `attesting`, `proved`, `executed`, `failed`, `stuck`, `rescued` or `skipped` |
| `final` | true when nothing further can change it |
| `classifier.reason` | why it is in that state, read from the chain and the ledger |
| `classifier.loss` | what is lost if nobody does anything more |
| `transitions` | when each state was entered, oldest first, with a note on each |
| `elapsed` | seconds spent in each state; a final state is not counted |
| `execution.byUs` | whether this executor sent the execute, or another one did |
| `skipReason`, `lastError` | why this executor declined it, or what last went wrong |

The full reference is [The status API](/docs/executor/status-api).

## Every payment you ever sent

The status API answers one hash at a time, and only for one executor's view. To classify every
payment an XRPL address has sent to the receiving address, straight from the ledger and the chain:

```bash
npm run rescue -w @memokit/executor -- --owner <your XRPL address>
```

Run it from a built clone of the repo. It needs no key. It lists each payment newest first, with its
state, the reason, and what was lost, and for a stuck one, how to rescue it. See
[Rescue](/docs/concepts/rescue).

## What the state means, and what it does not

The **state** is read from the chain, so it is exact wherever you ask. The **timestamps** are what
this one executor observed. When it did not work an instruction from the start, the answer says so,
and the times are when each state was first observed rather than when it was entered. The status
page is one executor's view, not the network's.
