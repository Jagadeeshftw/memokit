---
title: "Fund an account with FTestXRP"
description: "Getting FTestXRP into a memokit account on Coston2."
---

memokit acts on assets an account already holds, so every other guide starts from a funded account.
On Coston2 the only source of FTestXRP (Coston2's FXRP) is FAssets minting. This guide mints one lot
through the classic FAssets path and moves it into your memokit account.

Funding is deliberately outside the instruction path. It is a setup step, not something memokit
does.

**What you'll do:** reserve collateral with an FAssets agent, pay the agent in XRP on XRPL Testnet,
prove that payment through FDC, mint one lot of FTestXRP, and transfer it into your account.

**Time:** about two and a half minutes. **Cost:** about 3 C2FLR from your Coston2 key and 10.025 XRP
from your XRPL wallet.

## Before you start

- Node 20 or later, [Foundry](https://book.getfoundry.sh/getting-started/installation), and a built
  clone of the memokit repo (`npm install && npm run build`).
- A `.env` at the repo root, copied from `.env.example`, with:
  - `PRIVATE_KEY`: a Coston2 key with at least 5 C2FLR, from https://faucet.flare.network/coston2;
  - `XRPL_SEED`: an XRPL Testnet wallet with at least 12 XRP, from
    the XRPL Testnet faucet on [XRPL's faucets page](https://xrpl.org/resources/dev-tools/xrp-faucets). Its address owns the memokit account being
    funded.

## 1. Set up your shell

From the repo root:

```bash
set -a && . ./.env && set +a
export RPC=https://coston2-api.flare.network/ext/C/rpc
export OWNER=$(node -p "require('xrpl').Wallet.fromSeed(process.env.XRPL_SEED).address")
export DIAMOND=$(node -p "require('./fixtures/deployment.json').diamond")
export REGISTRY=$(node --input-type=module -e "import { COSTON2 } from '@memokit/sdk'; console.log(COSTON2.contractRegistry)")
export ASSET_MANAGER=$(cast call $REGISTRY "getContractAddressByName(string)(address)" AssetManagerFXRP --rpc-url $RPC)
export FXRP=$(cast call $ASSET_MANAGER "fAsset()(address)" --rpc-url $RPC)
export ACCOUNT=$(cast call $DIAMOND "computeAccountAddress(string)(address)" $OWNER --rpc-url $RPC)
```

`ASSET_MANAGER` is read from Flare's contract registry and `FXRP` from the AssetManager, so both are
always the current ones.

## 2. See what the account holds

```bash
cast call $FXRP "balanceOf(address)(uint256)" $ACCOUNT --rpc-url $RPC
```

FTestXRP has six decimals, so `1750000` is 1.75 FTestXRP. The account exists as an address before it
holds anything: it is derived from your XRPL address, and deployed on its first instruction.

## 3. Mint one lot and move it in

```bash
npm run fund -w @memokit/executor
```

What you see:

```text
funding account 0x9dD656e6…d741 with FTestXRP
agent 0x55c81526…14dC, 1 lot(s), collateral reservation fee 2.017542671362774315 C2FLR
  reserveCollateral 0xba64f849…
  crtId 59813733, pay 10.025 XRP to r4uKJRy9mjxGHw1yzS1SrtaKCUwT66MCcP ref 0x46425052…
  XRPL E8D16C8A… in ledger 21176710
  attempt 1: INVALID: TRANSACTION DOES NOT EXIST
  requestAttestation 0x9a6d6f5d…
  voting round 1470738, waiting for the proof...
  executeMinting 0x028d943a…
  minter holds 10.0 FTestXRP
  transfer 0xc8546659…

account 0x9dD656e6…d741 now holds 10.75
```

`attempt 1: INVALID: TRANSACTION DOES NOT EXIST` is normal. Flare's verifier had not indexed the
XRPL payment yet, and the script retries on its own.

The FTestXRP is minted to your Coston2 key first, then transferred into the account, and the script
moves everything that key holds, not only the new lot. That keeps funding visibly separate from
anything an instruction does.

## What success looks like

The last line reports the account's new balance. Check it yourself:

```bash
cast call $FXRP "balanceOf(address)(uint256)" $ACCOUNT --rpc-url $RPC
```

It is at least 10000000 higher than in step 2.

## If something goes wrong

- **`missing env ASSET_MANAGER`:** step 1 was not run in this terminal.
- **A revert on `reserveCollateral`:** the chosen agent has no free collateral. Run again, or choose an
  agent yourself: list them with
  `cast call $ASSET_MANAGER "getAvailableAgentsList(uint256,uint256)(address[],uint256)" 0 10 --rpc-url $RPC`,
  then prefix the fund command with `AGENT_VAULT=` and the agent's address.
- **`tecUNFUNDED_PAYMENT` or another XRPL error:** the XRPL wallet is short of XRP. Refill it from the
  faucet.
- **It stops after the XRPL payment:** the payment and the collateral reservation are recorded on
  chain. The script accepts `RESUME_CRT_ID` and `RESUME_XRPL_TXID` to pick up from there instead of
  paying again.

Nothing in this guide is a memokit instruction, so the [rescue classifier](/docs/concepts/rescue)
does not apply to it.
