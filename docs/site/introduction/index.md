---
title: "What memokit is"
description: "XRPL-originated calls on assets a Flare account already holds."
---

memokit lets someone who holds XRP on the XRP Ledger act on assets their Flare account already
holds, by signing one ordinary XRPL payment.

The payment carries a memo. The memo is either the instruction itself or a 42-byte commitment to
it: which contracts the account should call, with what data, what fee the executor earns, and what
must be true afterwards. The Flare Data Connector (FDC) proves the payment happened. Anyone can
then hand that proof to the memokit contract on Flare, and the account runs exactly the calls the
owner committed to. The owner never holds an EVM key.

What that makes possible, from XRPL alone:

- **Deposit** FXRP the account already holds into an ERC-4626 vault.
- **Pay out** to many Flare addresses from one payment.
- **Cash out**: redeem FXRP through FAssets and receive XRP back on your own XRPL address.
- **Import** FXRP from a Flare Smart Accounts account into your memokit account.
- **Borrow or swap**, with a deadline and an oracle bound committed inside the instruction.
  These two are tested on a fork of Flare mainnet only; see [Status and limits](/docs/introduction/status-and-limits).

## Three properties

**No FXRP is minted to do it.** memokit acts on a balance that is already on Flare. On the
vault-deposit and payout runs recorded so far, FXRP total supply was identical in the block before
and the block that executed the instruction. A cash-out is different by nature: it burns FXRP, and
FAssets mints itself a small pool fee in the same transaction. The
[claim ledger](/docs/evidence/claim-ledger) records both.

**No destination tag and no registration.** Your Flare account's address is derived from your XRPL
address alone, so there is nothing to register first and no tag to buy. memokit rejects a payment
that carries a destination tag.

**Nobody needs to trust the executor.** The fee, the calls and the post-conditions are inside the
committed instruction. An executor can deliver it or not; it cannot change what it does or what it
is paid. The fee is paid only if every call succeeds.

## Where it runs

memokit is on **Coston2 and XRPL Testnet only**. There is no mainnet deployment and no mainnet
transaction. The current deployment's diamond is {{deployment.diamond}}, and its XRPL receiving
address is {{deployment.receivingAddress}}. An open executor that anyone can inspect is deployed; its health is at
https://memokit-executor-production.up.railway.app/healthz, and its other routes are on
[The status API](/docs/executor/status-api).

## Where to go next

- [The gap, and Flare Smart Accounts](/docs/introduction/the-gap): why this exists alongside Flare's
  own smart accounts.
- [How it works](/docs/introduction/how-it-works): the path of one instruction, end to end.
- [A vault deposit with the SDK](/docs/quickstart/sdk-vault-deposit): the whole path in 29 lines of
  TypeScript.
- [Sign and submit, let the executor run it](/docs/quickstart/sign-and-submit): the same thing with
  no Flare key at all.

Every factual claim in these docs is in the [claim ledger](/docs/evidence/claim-ledger), with its
evidence level and the transaction or test behind it.
