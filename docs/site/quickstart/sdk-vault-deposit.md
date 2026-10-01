---
title: "A vault deposit with the SDK"
description: "The 29-line quickstart from sdk/README."
---

The whole memokit path is five SDK calls. This page runs them as one script: an XRPL payment tells a
memokit account on Coston2 to deposit 1.0 FTestXRP it already holds into an ERC-4626 vault. You run
the executor's part yourself, with your own Coston2 key.

Expect about two and a half minutes from start to `executed`. Most of it is the FDC voting round.

## Before you start

You need:

- Node 20 or later and [Foundry](https://book.getfoundry.sh/getting-started/installation) (`cast`).
- A clone of the memokit repo, built: `npm install && npm run build` from its root.
- A `.env` at the repo root with two values, copied from `.env.example`:
  - `PRIVATE_KEY`: a Coston2 key with a few C2FLR, from https://faucet.flare.network/coston2. It pays
    the attestation fee (1000 wei) and the execute gas.
  - `XRPL_SEED`: an XRPL Testnet wallet with a few XRP, from
    the XRPL Testnet faucet on [XRPL's faucets page](https://xrpl.org/resources/dev-tools/xrp-faucets). Its address owns the memokit account.
- The memokit account for that XRPL address holding at least 1.0 FTestXRP. If it holds none, follow
  [Fund an account with FTestXRP](/docs/guides/fund-an-account) first.

## 1. Set up your shell

From the repo root. This loads `.env` and reads every address from the chain or the repo's
fixtures, so nothing is typed by hand:

```bash
set -a && . ./.env && set +a
export RPC=https://coston2-api.flare.network/ext/C/rpc
export OWNER=$(node -p "require('xrpl').Wallet.fromSeed(process.env.XRPL_SEED).address")
export DIAMOND=$(node -p "require('./fixtures/deployment.json').diamond")
export RECEIVING=$(node -p "require('./fixtures/deployment.json').receivingAddress")
export REGISTRY=$(node --input-type=module -e "import { COSTON2 } from '@memokit/sdk'; console.log(COSTON2.contractRegistry)")
export ASSET_MANAGER=$(cast call $REGISTRY "getContractAddressByName(string)(address)" AssetManagerFXRP --rpc-url $RPC)
export FXRP=$(cast call $ASSET_MANAGER "fAsset()(address)" --rpc-url $RPC)
export ACCOUNT=$(cast call $DIAMOND "computeAccountAddress(string)(address)" $OWNER --rpc-url $RPC)
export VAULT=$(grep '^MEMOKIT_VAULT=' .env.example | cut -d= -f2)
export ASSET=$FXRP
```

`VAULT` is the TESTearnXRP vault on Coston2 that memokit's live runs deposit into; its asset is
FTestXRP. Check the account's balance, in base units (six decimals):

```bash
cast call $FXRP "balanceOf(address)(uint256)" $ACCOUNT --rpc-url $RPC
```

## 2. Write the script

Save this as `deposit.mts` in the repo root:

```ts
import { JsonRpcProvider, Wallet, Contract, Interface, ZeroAddress } from "ethers";
import { Wallet as XrplWallet } from "xrpl";
import { COSTON2, CONTROLLER_ABI, prepareInstruction, requestAttestation, waitForProof, submit } from "@memokit/sdk";
import { sendMemoPayment } from "@memokit/sdk/xrpl";

const { DIAMOND, RECEIVING, VAULT, ASSET } = process.env as Record<string, string>;
const relayer = new Wallet(process.env.PRIVATE_KEY!, new JsonRpcProvider(COSTON2.rpc));
const owner = XrplWallet.fromSeed(process.env.XRPL_SEED!);
const memokit = new Contract(DIAMOND, CONTROLLER_ABI, relayer);
const account = await memokit.computeAccountAddress(owner.address); // holds the assets already
const amount = 1_000_000n;

// 1. What the account should do: approve, then deposit into an ERC-4626 vault.
const { payload, memo } = prepareInstruction({
  sender: account, nonce: await memokit.nonceOf(account), feeToken: ZeroAddress, feeAmount: 0n,
  calls: [
    { target: ASSET, value: 0n, data: new Interface(["function approve(address,uint256)"]).encodeFunctionData("approve", [VAULT, amount]) },
    { target: VAULT, value: 0n, data: new Interface(["function deposit(uint256,address)"]).encodeFunctionData("deposit", [amount, account]) },
  ],
});

// 2. One XRPL payment carrying the 42-byte memo, then FDC attests it in its next voting round (~90 s).
const sent = await sendMemoPayment({ network: COSTON2, wallet: owner, destination: RECEIVING, drops: "1000000", memo });
const request = await requestAttestation({ signer: relayer, xrplHash: sent.hash, network: COSTON2 });
const { proof } = await waitForProof({ request, network: COSTON2 });

// 3. Anyone can deliver the proof and the preimage; the account executes exactly what was committed.
const receipt = await submit({ signer: relayer, controller: DIAMOND, proof, payload });
console.log("executed", receipt.hash);
```

What each part does:

- `prepareInstruction` encodes the instruction and returns the `payload` and a `0xFC` commit
  `memo`, which carries only the payload's hash. Keep `payload`: the contract needs it to execute.
- The fee is zero because you are delivering it yourself. An open executor would ignore an
  instruction that pays nothing.
- `sendMemoPayment` sends 1 XRP to the receiving address with the memo, and waits for validation.
- `requestAttestation` builds the FDC request from the ledger record and submits it to `FdcHub`.
- `waitForProof` polls the Data Availability Layer until the voting round's proof is served.
- `submit` calls `execute(proof, payload)` on the diamond.

## 3. Run it

```bash
npx tsx deposit.mts
```

## What success looks like

After about two and a half minutes, one line:

```text
executed 0x92322b6c…
```

That hash is a Coston2 transaction. Open it at `https://coston2-explorer.flare.network/tx/` followed
by the hash: its token transfers show the FTestXRP moving from the account into the vault, and vault
shares arriving at the account. Check the account afterwards:

```bash
cast call $FXRP "balanceOf(address)(uint256)" $ACCOUNT --rpc-url $RPC
cast call $VAULT "balanceOf(address)(uint256)" $ACCOUNT --rpc-url $RPC
```

The first is 1000000 lower than before; the second is the vault shares the account received.

## If something goes wrong

- **The script throws before sending anything:** a variable is missing. Re-run step 1 in the same
  terminal.
- **`execute` reverts with `InvalidNonce`:** another instruction for the same account executed between
  building and delivering this one. Run the script again; it reads the current nonce.
- **The deposit reverts because the account holds too little:** fund it; see
  [Fund an account with FTestXRP](/docs/guides/fund-an-account). The XRPL payment was spent, but the
  account's assets did not move.
- **The script stopped after the XRPL payment:** nothing is lost but the carrier. See
  [Rescue](/docs/concepts/rescue) and [Look up an instruction](/docs/quickstart/look-up-an-instruction).

## Next

To let an executor do steps 2 and 3 for a fee, so the owner needs no Flare key, see
[Sign and submit, let the executor run it](/docs/quickstart/sign-and-submit).
