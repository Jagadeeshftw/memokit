---
title: "Import from Flare Smart Accounts"
description: "Move FXRP from a Flare Smart Accounts account to a memokit account, from XRPL alone."
---

One XRPL address owns a different account under each protocol: a personal account under Flare Smart
Accounts (FSA) and another under memokit. FXRP in the FSA account can be moved into the memokit
account using FSA's own transfer instruction, from one XRPL payment. No EVM wallet is involved.

**What you'll do:** send one XRPL payment to FSA's provider wallet, carrying a 32-byte FSA payment
reference that names your memokit account as the recipient, then relay the proof to FSA's
controller.

**Time:** about two minutes. **Cost:** a small XRPL payment to FSA's provider wallet, and the gas of
one FSA `executeInstruction` on Coston2. Often no attestation fee: in both runs since the script began
checking, an identical request was already on chain. See below.

## Before you start

- Node 20 or later, [Foundry](https://book.getfoundry.sh/getting-started/installation), and a built
  clone of the memokit repo (`npm install && npm run build`).
- A `.env` with `PRIVATE_KEY` (a Coston2 key with a few C2FLR, to relay the proof) and `XRPL_SEED`
  (the XRPL address that owns both accounts).
- FXRP in your FSA personal account.

## 1. Set up your shell

```bash
set -a && . ./.env && set +a
export RPC=https://coston2-api.flare.network/ext/C/rpc
export OWNER=$(node -p "require('xrpl').Wallet.fromSeed(process.env.XRPL_SEED).address")
export REGISTRY=$(node --input-type=module -e "import { COSTON2 } from '@memokit/sdk'; console.log(COSTON2.contractRegistry)")
export ASSET_MANAGER=$(cast call $REGISTRY "getContractAddressByName(string)(address)" AssetManagerFXRP --rpc-url $RPC)
export FXRP=$(cast call $ASSET_MANAGER "fAsset()(address)" --rpc-url $RPC)
export FSA=$(cast call $REGISTRY "getContractAddressByName(string)(address)" MasterAccountController --rpc-url $RPC)
export FSA_ACCOUNT=$(cast call $FSA "getPersonalAccount(string)(address)" $OWNER --rpc-url $RPC)
cast call $FXRP "balanceOf(address)(uint256)" $FSA_ACCOUNT --rpc-url $RPC
```

`FSA` is the controller Flare's contract registry names `MasterAccountController`. The last line is
what your FSA account holds, in base units.

## 2. Run the import

`--drops` is the amount of FXRP to move, in base units. This moves 0.5 FTestXRP:

```bash
npm run import-fsa -w @memokit/executor -- --drops 500000
```

What you see, trimmed:

```text
XRPL owner        rpnDcUjasCYome3WntkxqQ3gG4wuLXM4WE
FSA account       0xA7F3A5Ee…30f3
memokit account   0x9dD656e6…d741
FSA provider      rEyj8nsHLdgt79KJWzXR5BgF7ZbaohbXwq
reference         0x01000000000000000007a1209dd656e6…
  decodes to      {"instructionId":1,"walletId":0,"amountDrops":"500000","recipient":"0x9dD656e6…d741"}

before: FSA 0.5, memokit 0.65
  XRPL 060B0F9E… in ledger 21176833
  ATTESTATION REUSE: an identical request is already on chain -- … voting round 1470742. Not paying the 1000 wei fee; waiting for that round's proof.
  ATTESTATION REUSE: proof served for round 1470742; no fee paid.
  FSA executeInstruction 0xe0aadc85… in block 36044471 (relayed by us)

after:  FSA 0.0, memokit 1.15
moved:  0.5 out of FSA, 0.5 into memokit
```

What happens, in order:

1. The script derives both accounts from your XRPL address, and builds FSA's instruction `0x01`,
   an FXRP transfer, with your memokit account as the recipient.
2. It sends the XRPL payment to FSA's provider wallet, a wallet registered on the FSA controller.
   Who holds that wallet's key is not stated on chain.
3. Before paying for an attestation, it checks `FdcHub` for an identical request already on chain.
   Payments to that wallet are often attested by someone else first, and one proof covers every
   identical request. If it finds one, it waits for that round's proof and pays no fee.
4. It relays the proof to FSA's `executeInstruction`, which has no access control. Another relayer
   may deliver it first; then the script finds that execution and reports it instead.

The script writes a trace of the run to `fixtures/measurements/fsa-import-<time>.json`.

## What success looks like

The `after:` line shows the FSA account down and the memokit account up by the same amount. Check it:

```bash
export DIAMOND=$(node -p "require('./fixtures/deployment.json').diamond")
export ACCOUNT=$(cast call $DIAMOND "computeAccountAddress(string)(address)" $OWNER --rpc-url $RPC)
cast call $FXRP "balanceOf(address)(uint256)" $FSA_ACCOUNT --rpc-url $RPC
cast call $FXRP "balanceOf(address)(uint256)" $ACCOUNT --rpc-url $RPC
```

## If something goes wrong

- **`the FSA account holds … but the import moves …`:** `--drops` is more than the FSA account holds.
- **The reused round produces no proof:** the script falls back to paying for its own attestation.
  That fallback has never run live.
- **Another relayer executed it first:** normal, and costs nothing. The script's simulation refuses
  before sending, and it reports the other relayer's transaction.

This path uses FSA's fixed transfer instruction, so it mints nothing. It is one of the actions FSA
offers without minting; see [The gap, and Flare Smart Accounts](/docs/introduction/the-gap).
