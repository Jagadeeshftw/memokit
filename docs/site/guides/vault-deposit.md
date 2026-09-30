---
title: "Vault deposit"
description: "One XRPL payment, one ERC-4626 deposit."
---

Deposit FTestXRP that a memokit account already holds into an ERC-4626 vault, from one XRPL
payment. No FXRP is minted: the deposit moves a balance that is already on Flare.

**What you'll do:** build a deposit instruction that pays the open executor, sign it, submit it, and
confirm the shares arrived.

**Time:** about two and a half minutes. **Cost:** a 1 XRP carrier payment, plus a 0.1 FTestXRP fee to
the executor.

There are two ways to deliver an instruction. This guide uses the open executor, so the owner needs
no Flare key. To deliver it yourself instead, from a script, see
[A vault deposit with the SDK](/docs/quickstart/sdk-vault-deposit).

## Before you start

- Node 20 or later, [Foundry](https://book.getfoundry.sh/getting-started/installation), and a built
  clone of the memokit repo (`npm install && npm run build`).
- A `.env` with `XRPL_SEED`: an XRPL Testnet wallet with a few XRP.
- The account holding the deposit amount plus 0.1 FTestXRP. See
  [Fund an account with FTestXRP](/docs/guides/fund-an-account).

## 1. Set up your shell

```bash
set -a && . ./.env && set +a
export RPC=https://coston2-api.flare.network/ext/C/rpc
export OWNER=$(node -p "require('xrpl').Wallet.fromSeed(process.env.XRPL_SEED).address")
export DIAMOND=$(node -p "require('./fixtures/deployment.json').diamond")
export ACCOUNT=$(cast call $DIAMOND "computeAccountAddress(string)(address)" $OWNER --rpc-url $RPC)
export VAULT=$(grep '^MEMOKIT_VAULT=' .env.example | cut -d= -f2)
export FXRP=$(cast call $VAULT "asset()(address)" --rpc-url $RPC)
```

`VAULT` is the TESTearnXRP vault on Coston2 that memokit's live runs use. Any ERC-4626 vault whose
asset is FTestXRP works the same way.

## 2. Record where you start

```bash
cast call $FXRP "balanceOf(address)(uint256)" $ACCOUNT --rpc-url $RPC
cast call $VAULT "balanceOf(address)(uint256)" $ACCOUNT --rpc-url $RPC
```

The first is the account's FTestXRP, the second its vault shares, both in base units.

## 3. Build the instruction

```bash
npm run sign -w @memokit/executor -- --owner $OWNER --deposit $VAULT --amount 500000
```

`--amount` is in base units: 500000 is 0.5 FTestXRP. The instruction has two calls, `approve` and
`deposit`, with the shares going to the account itself. It carries a post-condition: the account's
shares must rise by at least 99% of what the vault quotes at signing, or the whole instruction
reverts. It pays the executor 0.1 FTestXRP, and it is inline, so any executor can run it.

The last line names the payload file:

```text
payload fixtures/measurements/signing/<stem>.json  (keep it: execute needs the preimage)
```

## 4. Sign, submit and watch

```bash
npm run sign-with-seed -w @memokit/executor -- fixtures/measurements/signing/<stem>.json
H=<the submitted hash it prints>
until curl -s https://memokit-executor-production.up.railway.app/status/$H | python3 -c '
import json, sys, time
d = json.load(sys.stdin)
print(time.strftime("%H:%M:%S"), d.get("state") or d.get("error"), d.get("elapsed", ""), flush=True)
sys.exit(0 if d.get("final") else 1)'; do sleep 10; done
```

`sign-with-seed` reads `XRPL_SEED` from your environment and stands in for a wallet. See
[Sign and submit, let the executor run it](/docs/quickstart/sign-and-submit) for what each state
means and why a wallet-scanned QR is not offered.

## What success looks like

The loop ends on `executed`. Then:

```bash
curl -s https://memokit-executor-production.up.railway.app/status/$H | grep -A3 '"execution"'
cast call $FXRP "balanceOf(address)(uint256)" $ACCOUNT --rpc-url $RPC
cast call $VAULT "balanceOf(address)(uint256)" $ACCOUNT --rpc-url $RPC
```

The FTestXRP balance is 600000 lower: 500000 deposited and 100000 paid to the executor. The share
balance is higher by about the vault's quote. On 2026-10-01 a 1.0 FTestXRP deposit into this vault
returned 988,911 or more shares, as its post-condition required.

To confirm nothing was minted, compare FTestXRP total supply in the block before the execute and the
execute block, with `B` set to the `blockNumber` from the status answer:

```bash
cast call $FXRP "totalSupply()(uint256)" --block $((B-1)) --rpc-url https://rpc.ankr.com/flare_coston2
cast call $FXRP "totalSupply()(uint256)" --block $B --rpc-url https://rpc.ankr.com/flare_coston2
```

The public RPC prunes old state, so these use an archive endpoint. If nobody else minted or redeemed
FTestXRP in that block, the two numbers are identical, as they were on the vault deposit of
2026-09-30.

## If something goes wrong

- **`cannot deposit …: the account holds …`:** the CLI checks the balance before building. Fund the
  account first.
- **It stays `seen`:** the executor declined it. Read `skipReason` from the status answer.
- **It ends `failed` with the post-condition named in `lastError`:** the vault's rate moved by more
  than 1% between signing and execution. Nothing moved, and the same proof can be delivered again,
  but the rate will not move back on its own. Build a new instruction.
- **It stays `attesting` for many minutes:** FDC did not attest the request; see
  [Sign and submit](/docs/quickstart/sign-and-submit) and [Rescue](/docs/concepts/rescue).
