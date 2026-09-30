---
title: "Accounts and derivation"
description: "An account is derived from the XRPL address; a redeploy moves every address."
---

Every XRPL address has one memokit account on Flare, at an address anyone can compute. Nothing needs
registering, and the account exists as an address before anything is deployed there.

## How the address is derived

The account is a proxy, deployed with CREATE2 through the standard EIP-2470 singleton factory, with a
zero salt. The XRPL address is part of the proxy's init code, together with the diamond's address and
the beacon the proxy reads its implementation from. So the account's address is a function of three
things:

- the **beacon**,
- the **controller**, which is the memokit diamond,
- the **XRPL owner** string.

This is the same construction Flare Smart Accounts uses, with one difference: FSA's controller is its
own beacon, memokit's beacon is a separate contract. Because the controller is in the init code, a
memokit account and an FSA account for the same XRPL address are different addresses, and one owner
can hold balances in both. See [Import from Flare Smart Accounts](/docs/guides/import-from-fsa).

Compute it for any XRPL address:

```bash
export DIAMOND=$(node -p "require('./fixtures/deployment.json').diamond")
cast call $DIAMOND "computeAccountAddress(string)(address)" rpnDcUjasCYome3WntkxqQ3gG4wuLXM4WE \
  --rpc-url https://coston2-api.flare.network/ext/C/rpc
```

On the current deployment that returns the account memokit's live runs use.

## When it is deployed

On its first instruction. `execute` derives the address from the proof's sender, and deploys the proxy
if nothing is there yet. Until then the address can still receive tokens. Funding an account before
its first instruction, as [Fund an account](/docs/guides/fund-an-account) does, is normal.

## Who controls it

The account accepts calls to run a batch, or to pay an executor fee, only from its controller. The
controller runs only what a proved XRPL payment from the owner committed to. There is no EVM key for
the account.

There is one administrative path, and it is worth knowing: every account reads its code from the
beacon, and the beacon's implementation can be replaced by the diamond's owner, through the
timelocked `setAccountImplementation`. That upgrades every account at once, after the timelock delay.
It is the same kind of control Flare Smart Accounts' owner has over its accounts.

The account can hold ERC-20s, receive native C2FLR, and accept ERC-1363 transfers that require a
callback. It does not implement the ERC-721 receiver callback, so a safe NFT transfer to it reverts.

## A redeploy moves every address

The diamond's address is part of every account's derivation. Deploying a new diamond, which a change
to the payload format requires, gives every XRPL owner a **new account address**. Balances at the old
address stay there, owned by the old diamond.

This has happened on Coston2. The change to version 2 payloads moved the same owner's account from
`0x8F1eD3f5…` to `0x9dD656e6…`, and the funds were moved across with one instruction on the old diamond, built by the
repo's `executor/src/migrateFunds.ts`. Without that step they would have been stranded.

Two consequences:

- **Always compute the account from the current diamond.** An address from an old guide or an old
  trace may belong to a retired deployment. The docs read the diamond from `fixtures/deployment.json`
  for that reason.
- **The derivation is pinned by tests.** `test/AccountDerivation.t.sol` pins the proxy's creation-code
  hash, so an innocent change to the proxy cannot silently move every account.

The current deployment's diamond is {{deployment.diamond}}, its beacon {{deployment.personalAccountBeacon}}.
