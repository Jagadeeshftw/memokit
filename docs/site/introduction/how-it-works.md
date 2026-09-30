---
title: "How it works"
description: "Sign on XRPL, FDC proves the payment, the account executes."
---

One instruction takes three steps, and only the first needs the owner.

```text
XRPL wallet                 anyone (an SDK script, or the open executor)          Flare (Coston2)
-----------                 ---------------------------------------------         ---------------
1. Payment + memo  ──────►  2a. build the attestation request offline
   to the receiving             from the validated ledger record
   address                  2b. requestAttestation  ──────────────────────────►  FdcHub
                                                                                  │ voting round,
                            2c. fetch the Merkle proof  ◄── DA Layer  ◄───────────┘ about 90 s
                            3.  execute(proof, payload) ──────────────────────►  memokit diamond
                                                                                  ├ checks the proof
                                                                                  ├ runs the calls from
                                                                                  │ the owner's account
                                                                                  └ pays the fee
```

## 1. Sign on XRPL

The owner's wallet sends one XRPL Payment to a memokit receiving address, currently
{{deployment.receivingAddress}}. Its memo starts with a 10-byte header that is byte-identical to
Flare Smart Accounts' header, then carries the instruction in one of two forms:

- **inline** (`0xFD`): the whole instruction is in the memo, so any executor can run it with nothing
  but the ledger;
- **commit** (`0xFC`): the memo carries only `keccak256` of the instruction, 42 bytes in all, and the
  instruction itself travels to the executor separately.

The instruction names the account that acts, its next nonce, the fee token and amount, the list of
calls, and the post-conditions that must hold afterwards. See
[Memo wire format](/docs/concepts/memo-wire-format).

The payment itself only has to exist. memokit's own runs send 1 XRP as the carrier.

## 2. FDC proves the payment

The Flare Data Connector attests that the XRPL payment happened, with its memo, sender and receiver.
Someone requests an attestation from `FdcHub` on Flare. FDC's data providers vote on it in the next
voting round, about 90 seconds, and Flare publishes the round's Merkle root. The proof is then
served by the public Data Availability Layer, which needs no API key.

The request is built offline, from the XRPL ledger record. Flare's verifier server is not on the
path. See [Attestation](/docs/concepts/attestation).

Anyone can pay for the request. It costs 1000 wei plus gas on Coston2.

## 3. The account executes

Anyone calls `execute(proof, payload)` on the memokit diamond, {{deployment.diamond}}. The contract:

1. verifies the proof through Flare's `FdcVerification`, and checks the payment went to a registered
   receiving address, succeeded, carried no destination tag, and is inside the 24-hour validity
   window;
2. derives the account from the XRPL sender's address, creating it on first use;
3. marks the XRPL transaction id as consumed, so one payment drives at most one action;
4. checks the instruction matches the memo and the account's nonce;
5. runs the calls from the account, evaluates the post-conditions, and only then pays the executor
   its fee, in the asset the instruction moved.

If any call or post-condition fails, the whole transaction reverts, including the consumed mark.
The same proof can be delivered again once the cause is gone. See
[Execution and the executor fee](/docs/concepts/execution-and-fee).

## Who does step 2 and step 3

Either a script you run, holding a Coston2 key that pays the attestation fee and the gas, or an
executor that watches the receiving address and does both for the fee the instruction offers. One
open executor is deployed at https://memokit-executor-production.up.railway.app. With it, the owner
signs one XRPL payment and nothing else.

## How long it takes

Across all live runs, from the XRPL payment's ledger close to the execute on Flare, a run takes
about two and a half minutes. The largest part is the FDC voting round, which no client can shorten.
The per-run figures are in [Latency across all live runs](/docs/evidence/latency).
