---
title: "Attestation: FDC, offline MIC, DA Layer"
description: "FDC, the offline message integrity code and the Data Availability Layer."
---

memokit's contract on Flare acts on an XRPL payment only once the Flare Data Connector (FDC) has
proved it. This page is what that proof is, how it is requested, and why it takes the time it takes.

## What is proved

memokit uses FDC's **`XRPPayment`** attestation type, on source `testXRP` (XRPL Testnet). Its response
carries what the contract needs from the payment:

- the sender's address, from which the account is derived;
- the receiving address, which must be one the memokit diamond has registered;
- the full first memo, byte for byte, not a 32-byte digest;
- whether the payment carried a destination tag;
- whether the transaction succeeded, and when its ledger closed.

`XRPPayment` returns the memo verbatim, which is what makes inline instructions possible. FDC's older
`Payment` type exposes only a 32-byte payment reference.

## How a request is built: offline

An attestation request names the transaction and includes a **message integrity code** (MIC): the
hash of the response the requester expects. FDC's providers attest only if their own reading of the
ledger produces the same response.

The usual way to get a request and its MIC is to ask Flare's verifier server. memokit does not. The SDK
builds both from the XRPL ledger record itself (`sdk/src/fdc/buildResponse.ts`), so Flare's verifier is
not on the path. The verifier served once, as a test oracle: the repo's `fixtures/xrppayment-oracle.json`
is that one-time check against it. Anyone can repeat it:

```bash
npm run verify:mic -w @memokit/executor
```

It sends a small XRPL Testnet payment from `XRPL_SEED`, asks Flare's verifier for that payment's request
and MIC, and compares them with the SDK's own. It ends with
`VERIFIER-FREE PATH CONFIRMED: request and MIC computed from ledger data alone.` It also overwrites
`fixtures/xrppayment-oracle.json` with the new run; `git checkout` that file if you are not updating it.

## The voting round

The request goes to Flare's `FdcHub` with a fee: 1000 wei on Coston2. FDC's data providers vote on
every request in a voting round. Rounds are 90 seconds apart. When a round finalises, Flare's Relay
contract publishes the round's Merkle root on chain, and every attestation in the round becomes
provable against it.

This is the largest part of every run, and no client can shorten it. Across all live runs, from the
request to the root being published took most of the total: see
[Latency across all live runs](/docs/evidence/latency).

## The Data Availability Layer

The proof itself, a Merkle path from the attestation to the published root, is served by FDC's Data
Availability Layer. The public endpoint needs no API key. It allows about 20 requests a minute, and
a request for a proof that does not exist yet is simply retried.

The SDK's `waitForProof` polls it and checks that the attested memo is the one that was sent.

## What the contract checks

`execute` verifies the proof through Flare's `FdcVerification` contract, then checks:

- the source is XRPL Testnet (`testXRP`);
- the XRPL transaction succeeded;
- the payment is inside the validity window: 86,400 seconds (24 hours) after its ledger closed, on the
  current deployment;
- it carried no destination tag;
- it went to a registered receiving address;
- the sender in the proof is the address the account is derived from;
- it carried a memo.

Only then does it read the memo. See [Execution and the executor fee](/docs/concepts/execution-and-fee).

## One proof for many requests

The DA Layer keys proofs by voting round and request bytes, not by who asked. So if two parties request
an identical attestation, one proof serves both, in the round of the first request. The FSA import
script uses this: it looks on chain for an identical request before paying for its own, and reused one
in both live runs since it started checking. The executor service does not check yet; with one
executor there is nothing to save.

## When FDC does not attest

A finalised round can leave a request unattested. It happened once, on 2026-10-01: the round's root was
published, and the DA Layer never served a proof for that request. A proof can still be had by
requesting the attestation again, in a later round. The open executor does not do that yet; it is
recorded as Open in the [claim ledger](/docs/evidence/claim-ledger). See
[Rescue](/docs/concepts/rescue).
