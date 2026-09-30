---
title: "Rescue: stuck instructions and the classifier"
description: "Stuck instructions, the seven states, and the rescue opcodes."
---

An instruction can stop in four places between the XRPL payment and the execute, and from outside
they all look the same: the payment went out, and nothing happened on Flare. memokit's classifier says
which one it is, what is lost, and what fixes it.

**The account's assets are never at risk in a stalled state.** A stalled instruction has not executed,
so nothing moved.

## The seven states

`classifyPayments` in the SDK sorts every payment an owner sent to a receiving address into one of
seven states. The loss in each is the classifier's own wording.

| State | Final | What is lost |
|---|---|---|
| `executed` | yes | Carrier payment only. The instruction did what it said. |
| `retired` | yes | Carrier payment, plus the carrier payment of the `0xE0` memo that retired it. The instruction never ran. |
| `awaiting-attestation` | no | Nothing yet. Anyone can still request the attestation; the window has not closed. |
| `attested-not-executed` | no | Nothing yet, and the attestation fee is already sunk whoever delivers it. Anyone can submit the proof, including the owner. |
| `execution-failed` | no | Nothing on chain: a failed execution reverts, so the transaction id is not consumed, the nonce did not move, and the same proof can be delivered again once the cause is gone. Only gas was spent, by the executor who tried. |
| `expired` | yes | Carrier payment and the attestation fee, if one was paid. The instruction can never run. The account's assets are untouched: re-sign the same instruction in a fresh payment. |
| `not-an-instruction` | yes | Carrier payment. memokit will never act on this payment; it carries no memo it understands. |

The status API publishes the same states in shorter words: `seen` or `attesting` for
awaiting-attestation, `proved`, `failed`, `stuck` for expired, `rescued` for retired, and `skipped`.
See [The status API](/docs/executor/status-api).

## Classify an owner's payments

From a built clone of the memokit repo, with no key:

```bash
npm run rescue -w @memokit/executor -- --owner rpnDcUjasCYome3WntkxqQ3gG4wuLXM4WE
```

It reads the XRPL ledger and the chain, and prints each payment newest first. Its real output on
2026-10-01, top three entries:

```text
EXECUTED               55EB7D1325058E258ACA21113E4DF26AE1A77E377D02FB04EDB32F8D627CBB77
  ledger 21177282  the transaction id is marked consumed on chain
  loss if ignored: Carrier payment only. The instruction did what it said.

AWAITING-ATTESTATION   231B79178A50B5E828744E08E0B77CF110E9FE8D3CBCC3755D16BF13E839276A
  ledger 21177044  no proof available from the DA Layer yet
  instruction nonce 11, account at 12
  proof window: 24h left
  loss if ignored: Nothing yet. Anyone can still request the attestation; the window has not closed.
  -> request-attestation: Request the attestation and wait one FDC round (~150 s). No XRPL payment needed.

EXECUTED               95E4B21C2E2BB15222F553E62081228F918BF76DEA61E42A02C5B2EDC5B5B051
  ledger 21176774  the transaction id is marked consumed on chain
  instruction nonce 10, account at 12
  loss if ignored: Carrier payment only. The instruction did what it said.
```

Read the middle entry closely. It is the instruction FDC did not attest (see below), and its nonce, 11,
is behind the account's, 12: a later instruction used that nonce first. So requesting the attestation
would now only produce an execute that fails with `InvalidNonce`. The classifier prints both numbers
but does not yet draw that conclusion. When the instruction's nonce is below the account's, treat it as
superseded: nothing more to do, and nothing was lost but the carrier.

The classifier checks only the current diamond. A payment that executed on a retired diamond shows as
`EXPIRED` here.

## The rescue opcodes

Each is a memo, sent in a new XRPL payment from the same owner, like any instruction. Executors relay
them without a fee, because they pay nothing; the open executor does by default.

| Opcode | Use it when | What it does |
|---|---|---|
| `0xE0` | an instruction must never run | Retires one XRPL transaction id. If it is delivered later, it is ignored. The nonce does not move. |
| `0xE1` | an instruction blocks the queue | Sets the account's nonce to exactly N, so later instructions can run. Reverts if the nonce changed in the meantime. |
| `0xFB` | the same, but race-free | Advances the nonce to **at least** N. Idempotent: it succeeds even if the queue unstuck itself. |
| `0xE2` | an instruction's fee is too low for any executor | Overrides the fee amount for one stuck transaction id. |

The SDK builds each memo: `buildRetireMemo`, `buildReplaceFeeMemo` and `buildNonceAtLeastMemo`.
`0xE0`, `0xE1` and `0xE2` are tested; `0xE0` and `0xE1` are also exercised on the SparkDEX fork. `0xFB` is a race-free rescue
opcode covered by tests; it has never run live.

Often no rescue opcode is needed. A fresh instruction at the same nonce supersedes a stuck one: once it
executes, the stuck one can only fail with `InvalidNonce`.

## Which fix for which state

- **`awaiting-attestation`, for longer than a few minutes:** nobody requested the attestation, or FDC did
  not attest it. Anyone can request it again and deliver the proof, within 24 hours of the payment.
  The open executor does not currently re-request on its own. This happened once live, on 2026-10-01;
  the [claim ledger](/docs/evidence/claim-ledger) records it.
- **`attested-not-executed`:** the proof exists. Deliver it: anyone can, including the owner. For a
  `0xFC` commit memo, whoever delivers also needs the payload.
- **`execution-failed`:** read why. If the cause will go away, such as a balance to top up, deliver the
  same proof again. If it will not, supersede it with a fresh instruction, or retire it with `0xE0`.
- **`expired`:** nothing can run it now. Sign the instruction again in a new payment.

In every case the account's assets stayed where they were.
