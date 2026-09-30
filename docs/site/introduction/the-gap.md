---
title: "The gap, and Flare Smart Accounts"
description: "Why a balance already on Flare was out of reach from XRPL, verified from deployed code."
---

Flare already lets an XRPL address control a Flare account. Flare Smart Accounts (FSA) derives a
personal account from an XRPL address and acts on it when an XRPL payment is proved through FDC.
memokit exists because of what FSA can and cannot do with FXRP that is already in that account.

The ledger states the gap in two parts. Both were read from the verified source and live state of
Flare's deployed `MasterAccountController` on 2026-09-30.

## Part one: without minting, a fixed set of actions

Without minting anything, FSA offers a fixed menu of instructions, each selected by a 32-byte
payment reference in the XRPL memo:

- transfer FXRP,
- redeem FXRP to XRP,
- deposit into, or withdraw from, vaults the controller's owner has registered.

These call typed methods on the personal account. None of them forwards calldata the user chose.
If what you want is on the menu, FSA does it without a mint.

## Part two: arbitrary calls only through direct minting

FSA does run arbitrary calls, through memo opcodes `0xFF` and `0xFE`. But the only code path that
reaches them is `handleMintedFAssets`, and that function accepts calls only from the FXRP
AssetManager, during FAssets **direct minting**. So every such instruction mints new FXRP, inherits
direct minting's hourly and daily limits, and pays its executor out of the freshly minted amount.

That last point is structural, not incidental. FSA's executor is paid from the minted fAsset. An
instruction that mints nothing has nothing to pay its executor from.

## What that leaves out

FXRP already sitting in an account, and something to do with it that is not on the fixed menu: a
swap, a payout to five addresses, a borrow against it, a deposit into a vault nobody registered.
Under FSA, each of those means minting more FXRP to carry the call.

memokit is the other path. Its instruction acts on the balance the account already has, it can call
any contract, and its executor is paid from that same balance, in the asset the instruction moves.

## How this was established

The ledger rows
["Flare Smart Accounts reaches arbitrary calls only through direct minting"](/docs/evidence/claim-ledger)
and "The FSA executor is paid from the minted fAsset" carry the evidence:

- every live selector of the controller was read and named, on Coston2 and on Flare mainnet;
- the three low-level call sites in the verified source were traced, and only one runs caller-chosen
  calldata, behind the AssetManager gate;
- a call to the gate from an unrelated address reverts with `OnlyAssetManager()` on both networks;
- a live direct mint on each network shows the executor fee leaving the minted amount.

One limit on that evidence: on Coston2, three FSA facets that were replaced recently have no
verified source, so there the claim holds for the other fifteen facets only. On Flare mainnet it
holds fully.

## memokit and FSA side by side

| | Flare Smart Accounts | memokit |
|---|---|---|
| Account derived from the XRPL address | yes | yes |
| Fixed actions without minting | yes: transfer, redeem, registered vaults | not needed: any call |
| Arbitrary calls | only through direct minting | on assets already held |
| Executor paid from | the minted fAsset | the account's balance, in the moved asset |
| Memo header | Flare's | byte-identical to Flare's |
| Where it runs | Coston2 and Flare mainnet | Coston2 only |

The two are complementary. memokit's header is byte-identical to FSA's, so a wallet that already
builds FSA memos changes one byte, the opcode. And FXRP can move from an FSA account into a memokit
account using FSA's own transfer instruction: see
[Import from Flare Smart Accounts](/docs/guides/import-from-fsa).
