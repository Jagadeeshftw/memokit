---
title: "Payout to many recipients"
description: "One payment, many transfers."
---

Pay several Flare addresses from one XRPL payment. The instruction is a list of ERC-20 transfers,
one per recipient, and a post-condition per recipient that it was paid. With a commit memo the
instruction's size costs nothing on XRPL: the memo stays 42 bytes whatever the number of recipients.

**What you'll do:** write a short script with the memokit SDK, send the payment, and deliver the
proof yourself.

**Time:** about two and a half minutes. **Cost:** a 1 XRP carrier payment, plus 1000 wei and the gas
of one execute on Coston2.

## Before you start

- Node 20 or later, [Foundry](https://book.getfoundry.sh/getting-started/installation), and a built
  clone of the memokit repo (`npm install && npm run build`).
- A `.env` with `PRIVATE_KEY` (a Coston2 key with a few C2FLR) and `XRPL_SEED` (an XRPL Testnet wallet
  with a few XRP).
- The account holding at least the sum of the payouts. See
  [Fund an account with FTestXRP](/docs/guides/fund-an-account).

## 1. Set up your shell

```bash
set -a && . ./.env && set +a
export RPC=https://coston2-api.flare.network/ext/C/rpc
export DIAMOND=$(node -p "require('./fixtures/deployment.json').diamond")
export RECEIVING=$(node -p "require('./fixtures/deployment.json').receivingAddress")
export REGISTRY=$(node --input-type=module -e "import { COSTON2 } from '@memokit/sdk'; console.log(COSTON2.contractRegistry)")
export ASSET_MANAGER=$(cast call $REGISTRY "getContractAddressByName(string)(address)" AssetManagerFXRP --rpc-url $RPC)
export FXRP=$(cast call $ASSET_MANAGER "fAsset()(address)" --rpc-url $RPC)
```

## 2. Choose the recipients

`RECIPIENTS` is a comma-separated list of Flare addresses, and `AMOUNTS` the matching amounts in base
units. To try it without addresses of your own, this derives the three throwaway addresses memokit's
Phase 2 payout used:

```bash
export RECIPIENTS=$(node -e "const { Wallet, keccak256, toUtf8Bytes } = require('ethers'); console.log([0, 1, 2].map((i) => new Wallet(keccak256(toUtf8Bytes('memokit-phase2-payout-recipient-' + i))).address).join(','))")
export AMOUNTS=100000,100000,100000
```

That is 0.1 FTestXRP to each. Check what they hold now:

```bash
for r in $(echo $RECIPIENTS | tr , " "); do cast call $FXRP "balanceOf(address)(uint256)" $r --rpc-url $RPC; done
```

## 3. Write the script

Save this as `payout.mts` in the repo root:

```ts
import { JsonRpcProvider, Wallet, Contract, Interface, ZeroAddress } from "ethers";
import { Wallet as XrplWallet } from "xrpl";
import { COSTON2, CONTROLLER_ABI, prepareInstruction, requestAttestation, waitForProof, submit, erc20DeltaAtLeast } from "@memokit/sdk";
import { sendMemoPayment } from "@memokit/sdk/xrpl";

const { DIAMOND, RECEIVING, FXRP, RECIPIENTS, AMOUNTS } = process.env as Record<string, string>;
const recipients = RECIPIENTS.split(",");
const amounts = AMOUNTS.split(",").map(BigInt);
if (recipients.length !== amounts.length) throw new Error("RECIPIENTS and AMOUNTS must be the same length");

const relayer = new Wallet(process.env.PRIVATE_KEY!, new JsonRpcProvider(COSTON2.rpc));
const owner = XrplWallet.fromSeed(process.env.XRPL_SEED!);
const memokit = new Contract(DIAMOND, CONTROLLER_ABI, relayer);
const account = await memokit.computeAccountAddress(owner.address);
const erc20 = new Interface(["function transfer(address,uint256)"]);

// One transfer per recipient, and one post-condition per recipient: each must be paid its amount.
const { payload, memo } = prepareInstruction({
  sender: account, nonce: await memokit.nonceOf(account), feeToken: ZeroAddress, feeAmount: 0n,
  calls: recipients.map((to, i) => ({ target: FXRP, value: 0n, data: erc20.encodeFunctionData("transfer", [to, amounts[i]]) })),
  postConditions: recipients.map((to, i) => erc20DeltaAtLeast(FXRP, to, amounts[i])),
});

const sent = await sendMemoPayment({ network: COSTON2, wallet: owner, destination: RECEIVING, drops: "1000000", memo });
console.log("XRPL payment", sent.hash);
const request = await requestAttestation({ signer: relayer, xrplHash: sent.hash, network: COSTON2 });
const { proof } = await waitForProof({ request, network: COSTON2 });
const receipt = await submit({ signer: relayer, controller: DIAMOND, proof, payload });
console.log("executed", receipt!.hash, "in block", receipt!.blockNumber, "paying", recipients.length, "recipients");
```

The post-conditions are what the instruction was *for*. They are covered by the same hash as the
calls, so no executor can drop them, and if any recipient ends up paid less than its amount, the
whole instruction reverts. A post-condition list holds at most 32 entries.

## 4. Run it

```bash
npx tsx payout.mts
```

## What success looks like

```text
XRPL payment 55EB7D13…
executed 0x38c8fde9… in block 36045172 paying 3 recipients
```

Run the balance loop from step 2 again. Each recipient holds exactly its amount more:

```text
1300000 [1.3e6]
1200000 [1.2e6]
1100000 [1.1e6]
```

## Paying an open executor instead

This script delivers the instruction itself, so it pays no fee. To let the open executor deliver it:

- set `feeToken` to `FXRP` and `feeAmount` to at least `100000n`, the deployed executor's minimum;
  the fee comes out of the same balance, after every transfer;
- send the instruction inline, with `encodeMemo({ kind: "execInline", … })`, because an executor
  cannot run a commit memo without the preimage. Inline memos are limited to about 1,019 bytes by
  XRPL, which bounds how many transfers fit.

`executor/src/cli/sign.ts` in the repo builds inline instructions this way.

## If something goes wrong

- **`execute` reverts in a transfer:** the account holds less than the total. Nothing moved. Fund the
  account and run the script again.
- **`execute` reverts naming a post-condition:** a recipient ended up with less than its amount more,
  for instance a token that takes a fee on transfer. Nothing moved.
- **`InvalidNonce`:** another instruction for the account executed first. Run the script again.
- **The script stopped after the XRPL payment:** the instruction is a `0xFC` commit, and its payload
  existed only in the script's memory, so nobody can deliver it now. Nothing moved; the carrier
  payment is the loss. Run the script again: the new instruction uses the same nonce and supersedes
  the old one. To keep a payload deliverable, save `payload` to a file before sending. See
  [Rescue](/docs/concepts/rescue).
