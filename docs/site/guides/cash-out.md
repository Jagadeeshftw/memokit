---
title: "Cash out to XRPL"
description: "Redeem FXRP through FAssets and receive XRP on XRPL."
---

Turn FTestXRP in a memokit account back into XRP on your own XRPL address, from one XRPL payment. You
start and end on the XRP Ledger, and never hold an EVM key.

The cash-out has two halves, and only the first is memokit's. memokit's instruction calls FAssets'
`redeem`, which burns the FXRP and creates an obligation. An FAssets **agent** then pays the XRP on
XRPL. When it pays is up to the agent.

**What you'll do:** build a cash-out instruction, sign it, let the open executor run it, then watch for
the XRP.

**Time:** about two and a half minutes to execute on Flare. The XRP then arrives when the agent pays:
across four live cash-outs, from the XRPL payment's ledger close to the payout's ledger close, 140 s
to 18.2 minutes. **Cost:** a 1 XRP carrier payment and a 0.1 FTestXRP executor fee.

## Before you start

- Node 20 or later, [Foundry](https://book.getfoundry.sh/getting-started/installation), and a built
  clone of the memokit repo (`npm install && npm run build`).
- A `.env` with `XRPL_SEED`: an XRPL Testnet wallet with a few XRP.
- The account holding at least one lot plus the fee: **10.1 FTestXRP**. FAssets redeems whole lots of
  10 FXRP, and the fee is paid after the redemption, out of what it leaves. See
  [Fund an account with FTestXRP](/docs/guides/fund-an-account).

## 1. Set up your shell

```bash
set -a && . ./.env && set +a
export RPC=https://coston2-api.flare.network/ext/C/rpc
export OWNER=$(node -p "require('xrpl').Wallet.fromSeed(process.env.XRPL_SEED).address")
export DIAMOND=$(node -p "require('./fixtures/deployment.json').diamond")
export REGISTRY=$(node --input-type=module -e "import { COSTON2 } from '@memokit/sdk'; console.log(COSTON2.contractRegistry)")
export ASSET_MANAGER=$(cast call $REGISTRY "getContractAddressByName(string)(address)" AssetManagerFXRP --rpc-url $RPC)
export FXRP=$(cast call $ASSET_MANAGER "fAsset()(address)" --rpc-url $RPC)
export ACCOUNT=$(cast call $DIAMOND "computeAccountAddress(string)(address)" $OWNER --rpc-url $RPC)
cast call $FXRP "balanceOf(address)(uint256)" $ACCOUNT --rpc-url $RPC
```

## 2. Build the cash-out

```bash
npm run sign -w @memokit/executor -- --owner $OWNER --cash-out
```

```text
memokit account   0x9dD656e6…d741
nonce             10
instruction       cash out 1 lot(s) = 10.0 FXRP, XRP to rpnDcUjasCYome3WntkxqQ3gG4wuLXM4WE (the payer's own address); 0.75 FXRP stays, of which 0.1 pays the executor
executor fee      100000 of 0x0b6A3645…
memo              0xFD inline, 875 bytes  (self-contained: any executor can run it)
…
payload fixtures/measurements/signing/d9823b09.json  (keep it: execute needs the preimage)
```

By default it redeems every whole lot the balance can cover with the fee left over. `--lots N` asks for
fewer. The XRP always goes to the address that signs; the CLI has no flag to send it elsewhere,
because sending XRP to the wrong address cannot be undone.

The instruction carries a post-condition: what stays in the account after the redemption must be at
least the expected remainder. It is a floor on what is left, because post-conditions are floors and a
redemption needs a ceiling on what is spent.

## 3. Sign, submit and wait for the execute

```bash
npm run sign-with-seed -w @memokit/executor -- fixtures/measurements/signing/<stem>.json
H=<the submitted hash it prints>
until curl -s https://memokit-executor-production.up.railway.app/status/$H | python3 -c '
import json, sys, time
d = json.load(sys.stdin)
print(time.strftime("%H:%M:%S"), d.get("state") or d.get("error"), d.get("elapsed", ""), flush=True)
sys.exit(0 if d.get("final") else 1)'; do sleep 10; done
curl -s https://memokit-executor-production.up.railway.app/status/$H | grep -A3 '"execution"'
```

The loop ends on `executed`, and the last command prints the execute's `txHash` and `blockNumber`. Set
them:

```bash
T=<txHash>; B=<blockNumber>
```

## 4. Watch for the XRP

```bash
curl -s -X POST https://s.altnet.rippletest.net:51234/ -H 'content-type: application/json' \
  -d "{\"method\":\"account_tx\",\"params\":[{\"account\":\"$OWNER\",\"limit\":5}]}" \
  | python3 -c 'import json,sys; [print(x["Account"], "->", x.get("Destination"), t["meta"].get("delivered_amount"), x["hash"]) for t in json.load(sys.stdin)["result"]["transactions"] for x in [t.get("tx") or t["tx_json"]]]'
```

The payout is an incoming payment of about 9.948 XRP, in drops, from the agent's XRPL address. Run the
command again until it appears. You can also watch
`https://testnet.xrpl.org/accounts/` followed by your address.

## What success looks like

- The execute succeeded, sent by the executor: `cast receipt $T --rpc-url $RPC | grep -E '^(status|from) '`.
- The account dropped by one lot and the fee:
  `cast call $FXRP "balanceOf(address)(uint256)" $ACCOUNT --rpc-url $RPC`.
- About **9.948010 XRP** arrived per 10.0 FXRP lot. One lot does not deliver one lot: FAssets takes a
  pool fee and the agent a redemption fee, and the exact figure is in the `RedemptionRequested` event.
- Your XRP balance rises by about 8.948 XRP net, because the 1 XRP carrier went out first.

**Total supply falls in a cash-out.** Compare FTestXRP supply in the block before and the execute block:

```bash
cast call $FXRP "totalSupply()(uint256)" --block $((B-1)) --rpc-url https://rpc.ankr.com/flare_coston2
cast call $FXRP "totalSupply()(uint256)" --block $B --rpc-url https://rpc.ankr.com/flare_coston2
```

On every live cash-out it fell by 9.998 FTestXRP: 10.0 burned, and 0.002 minted by FAssets to the
agent's collateral pool as its fee. memokit mints nothing, but a cash-out is never a zero-mint
transaction. If you see another difference, check the block for other FTestXRP activity first.

## If something goes wrong

- **`cannot cash out anything: the account holds …`:** fewer than 10.1 FTestXRP. The message prints the
  funding command.
- **It stays `seen`, or ends `failed` or `stuck`:** see the troubleshooting in
  [Sign and submit](/docs/quickstart/sign-and-submit). `InvalidNonce` means a stale instruction:
  build it again.
- **Executed, but no XRP yet:** the agent has not paid. It is not late until both deadlines in the
  `RedemptionRequested` event have passed, an XRPL ledger number and a timestamp. One live cash-out
  took 16.2 minutes from the execute and was still on time.
- **The agent defaults:** the redeemer is compensated in collateral on Flare, not in XRP, and only
  once somebody submits a non-payment proof. This is read from the FAssets contracts and has never
  been exercised; the [claim ledger](/docs/evidence/claim-ledger) lists it as Open.

A deep redemption queue, as on Flare mainnet, has been exercised only on a fork:
`FOUNDRY_PROFILE=fork forge test --match-contract CashOutForkTest -vv`.
