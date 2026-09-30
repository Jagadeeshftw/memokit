---
title: "Execution and the executor fee"
description: "What the controller checks, what the account runs, and how the executor is paid."
---

`execute(proof, data)` on the memokit diamond is the only way an instruction runs. Anyone may call
it. What they can make it do is fixed by the owner's signed payment.

## What `execute` does, in order

1. **Checks the diamond is not paused.**
2. **Verifies the proof**, and the payment's source, success, validity window, receiving address,
   sender and memo. See [Attestation](/docs/concepts/attestation).
3. **Finds the account** for the payment's XRPL sender, deploying it if this is its first instruction.
   See [Accounts and derivation](/docs/concepts/accounts).
4. **Consumes the XRPL transaction id.** One payment drives at most one action, whatever happens next.
   A second `execute` with the same proof reverts with `TransactionAlreadyUsed`.
5. **Checks the ignore flag.** If the owner retired this transaction id with `0xE0`, it stops here.
6. **Reads the header.** A reserved opcode or a non-zero header fee is rejected.
7. **Dispatches on the opcode.** For `0xFD` the instruction is the memo's body; for `0xFC`, `data` must
   hash to the memo's commitment. Management opcodes (`0xE0`, `0xE1`, `0xE2`, `0xFB`) change the
   account's queue and return.
8. **Runs the instruction:** checks `sender` is this account and `nonce` is its next nonce, runs the
   calls in order from the account, evaluates the post-conditions, and pays the executor.

Any failure in step 8 reverts the whole transaction, including step 4's consumed mark. Nothing moved,
the nonce did not advance, and the same proof can be delivered again once the cause is gone, within
the validity window.

## Who can run it

Anyone holding the proof and, for a commit memo, the payload. The account only accepts calls from its
controller, the diamond, and the diamond only runs what the owner signed. An executor chooses
*whether* and *when* to deliver. It cannot choose *what*.

## The executor fee

The fee is two fields inside the payload: `feeToken` and `feeAmount`. Because they are inside the
hashed or inline instruction, an executor who reads them cannot change them.

- **It is paid in the asset the instruction moves.** A payout of FTestXRP pays its executor in
  FTestXRP, out of the same balance. The account never needs a second token or any C2FLR.
- **It is paid last**: after every call has succeeded and every post-condition has held. An instruction
  that did not deliver does not pay for delivery.
- **It is paid in the same transaction.** A failing call unwinds the fee with everything else.
- **Zero is allowed.** With `feeToken` set to the zero address, nobody is paid. That suits an owner who
  delivers the instruction themselves; an open executor will not pick it up.

The live runs paid their executors this way, in FTestXRP, out of the moved balance: the Phase 2
payout, the Phase 4 runs, and every instruction the deployed executor has run.

### Why not in the header

Flare's header has an `executorFee` field, and memokit keeps it in place for byte-compatibility. But a
header fee is in the part of the memo a wallet fills in, and it would be paid in a fixed unit rather
than the moved asset. memokit rejects any non-zero header fee on every opcode, so a wallet built for
Flare cannot sign a fee memokit would never pay.

### Changing a fee after signing

If an instruction is stuck because its fee is too low for any executor, the owner can send `0xE2`
with the stuck transaction id and a new fee amount. See [Rescue](/docs/concepts/rescue).

## What an executor risks

Delivering costs the attestation fee, if it paid for the request, and the gas of `execute`. On Coston2
the deployed executor measured 0.25 to 0.28 C2FLR per instruction, at Coston2's 650 gwei.

Two executors can race to deliver the same proof. The first `execute` mined consumes the transaction
id, and the second reverts. The open executor simulates every `execute` first, so losing a race
usually costs only what it paid for the attestation. See
[Fee policy, racing and simulation](/docs/executor/fee-policy-racing-simulation). Racing is built and
tested, and has never happened live: every live run has had one executor.
