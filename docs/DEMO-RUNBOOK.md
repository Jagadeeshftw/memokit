# Demo runbook: cash out to XRPL through the open executor

Type exactly what is in the grey blocks, in order. Every command was run end to end on
2026-09-23; the "what you see" blocks are real output from that run, trimmed. Where a value
changes from run to run (a hash, a block number), it is shown as `<...>`.

The demo: one XRPL payment, built as a QR, tells a memokit account on Flare to redeem 10 FXRP.
The deployed executor picks it up, gets it attested and executes it, with nobody touching a
keyboard. An FAssets agent then sends XRP back to the same XRPL address.

**Read [Before you record](#before-you-record) first.** One step in this demo is not under our
control, and in the dry run it took 16 minutes.

Everything here is Coston2 and XRPL Testnet. Nothing touches mainnet.

---

## Before you record

Do these the day of, not on camera.

1. **Build and run the fork test once** (steps 0 and 7). The first run compiles and prints a wall
   of compiler warnings. Every later run is quiet.
2. **Fund the account** (step 2), so the recording starts from a funded account.
3. **Decide how you will sign** (step 4). Xaman needs developer credentials, and it has never
   been tested live. Without them, you sign with a stand-in command, and there is no QR a phone
   can scan.
4. **Plan for the XRP taking a while.** Step 5b depends on an FAssets agent. In the Phase 3 run
   the agent paid 21 s after the execute. In this runbook's dry run it paid **16 minutes** after,
   still inside its window. Record steps 0–5a as one take, and come back for 5b once it has landed.
   Have the Phase 3 payout ready to show in case it hasn't (link in 5b).
5. **Don't hammer the executor URL.** During testing, a burst of rapid `curl` calls made this
   laptop's DNS refuse to resolve `*.up.railway.app` for about a minute. The waiting loop in
   step 5 polls every 10 s, which is fine. Don't run two loops at once.

---

## 0. Setup

### 0.1 Tools

```bash
node --version && cast --version | head -1
```

What you see (about 1 s):

```
v24.20.0
cast Version: 1.5.0-stable
```

**If it fails:** `command not found: cast` means Foundry isn't installed. Install it with
`curl -L https://foundry.paradigm.xyz | bash`, then run `foundryup`. Node must be v20 or later.

### 0.2 Build

From the repo root:

```bash
npm install && npm run build
```

About 2 s if dependencies are already installed; a minute or two on a fresh clone. Success is
silence: no `error TS` lines.

**If it fails:** `Cannot find module '@memokit/sdk'` later on means this step was skipped.
Run it again.

### 0.3 Load and check the environment

```bash
set -a && . ./.env && set +a
for v in PRIVATE_KEY XRPL_SEED; do printenv $v >/dev/null && echo "$v: set" || echo "$v: MISSING"; done
```

What you see:

```
PRIVATE_KEY: set
XRPL_SEED: set
```

This prints *whether* each is set, never its value. What they are:

| Variable | Used by | What it is |
|---|---|---|
| `PRIVATE_KEY` | steps 1 (top-up) and 2 (fund) | the deployer's Coston2 key. It is **not** the executor's key, which lives only on Railway. |
| `XRPL_SEED` | step 2 (fund) and step 4 without Xaman | the XRPL owner's seed, for `rpnDcUjasCYome3WntkxqQ3gG4wuLXM4WE` |
| `XAMAN_API_KEY`, `XAMAN_API_SECRET` | step 4 with Xaman only | optional; see step 4 |

`set -a && . ./.env && set +a` loads `.env` into this terminal only. Open a new terminal and you
have to run it again.

**If it fails:** `MISSING` means `.env` has no value for it. Copy the template with
`cp .env.example .env` and fill the value in. Don't paste a key or seed anywhere else.

### 0.4 Which network and which diamond

```bash
cat fixtures/deployment.json | grep -E '"chainId"|"diamond"|"receivingAddress"'
cast chain-id --rpc-url https://coston2-api.flare.network/ext/C/rpc
```

What you see:

```
  "chainId": 114,
  "diamond": "0x0E762EAe8fe53e5247C22E5B52feD7A018150714",
  "receivingAddress": "rDfVHUx5SMgw5wwqjvzgFEFCnqW5CCGWyW"
114
```

Chain 114 is Coston2. Every command in this runbook reads the diamond from
`fixtures/deployment.json`. Step 1 confirms the deployed executor watches the same one.

---

## 1. The deployed executor is healthy and funded

```bash
curl -s https://memokit-executor-production.up.railway.app/healthz
```

About 1 s. What you see:

```json
{
  "ok": true,
  "controller": "0x0E762EAe8fe53e5247C22E5B52feD7A018150714",
  "lastTickSecondsAgo": 14,
  "secretAudit": { "clean": true, "checkedNames": 7, "unexpectedSecretsPresent": [] },
  "executor": {
    "address": "0xD4dFA2b68d14fc71BF5940559Ad9F819c1b0350D",
    "balanceFlr": "18.98",
    "lowBalance": false
  }
}
```

Check four things:

- `controller` matches the diamond from step 0.4.
- `lastTickSecondsAgo` is under about 20. That means it is polling.
- `lowBalance` is `false`.
- `secretAudit.clean` is `true`: the service holds no XRPL seed and no deployer key.

**If it fails:**

- **No output, or `Could not resolve host`:** the local DNS problem from "Before you record".
  Wait a minute and retry. Don't loop.
- **`"lastTickSecondsAgo"` in the hundreds:** the service is up but stalled. Check Railway's
  dashboard for the service's logs, and redeploy there if needed.
- **`"lowBalance": true`:** top it up.

### Top-up (only if `lowBalance` is true)

```bash
cast send 0xD4dFA2b68d14fc71BF5940559Ad9F819c1b0350D --value 5ether \
  --private-key "$PRIVATE_KEY" --rpc-url https://coston2-api.flare.network/ext/C/rpc
```

About 5 s. What you see (trimmed):

```
blockNumber          <...>
gasUsed              21000
status               1 (success)
transactionHash      0x<...>
```

`5ether` means 5 C2FLR: `cast` says "ether" for any chain's native token. That's about ten cash-outs.
The key comes from the environment and is never typed. Confirm the new balance:

```bash
cast balance 0xD4dFA2b68d14fc71BF5940559Ad9F819c1b0350D --ether --rpc-url https://coston2-api.flare.network/ext/C/rpc
```

**If it fails:**

- **`insufficient funds`:** the deployer itself is low. Get more C2FLR from
  https://faucet.flare.network/coston2 for `0x8848d8578756A1110161eEB32E868Be1415F2cD7`.
- **`missing --private-key`:** step 0.3 wasn't run in this terminal.

---

## 2. The account holds enough FTestXRP

A cash-out redeems whole **lots of 10 FXRP**, and the executor's fee of 0.1 FTestXRP must be
left over afterwards. So the account needs **at least 10.1 FTestXRP**.

```bash
cast call 0x0b6A3645c240605887a5532109323A3E12273dc7 "balanceOf(address)(uint256)" \
  0x9dD656e6FE2f9B46E57CE29265b3C66feCa2d741 --rpc-url https://coston2-api.flare.network/ext/C/rpc
```

About 1 s. What you see:

```
9150000 [9.15e6]
```

That is 9.15 FTestXRP (six decimals). Below 10.1, it needs funding. After the dry run it holds
9.15, so **it needs funding before you record.**

`0x9dD656e6…` is the memokit account for `rpnDcUjasCYome3WntkxqQ3gG4wuLXM4WE`. To see it derived
rather than take it on trust:

```bash
cast call 0x0E762EAe8fe53e5247C22E5B52feD7A018150714 "computeAccountAddress(string)(address)" \
  rpnDcUjasCYome3WntkxqQ3gG4wuLXM4WE --rpc-url https://coston2-api.flare.network/ext/C/rpc
```

### Fund it (mints one lot through FAssets)

```bash
ASSET_MANAGER=0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA npm run fund -w @memokit/executor
```

About 2 min 15 s. What you see:

```
funding account 0x9dD656e6FE2f9B46E57CE29265b3C66feCa2d741 with FTestXRP
agent 0x55c8…, 1 lot(s), collateral reservation fee 2.14 C2FLR
  reserveCollateral 0x<...>
  crtId <...>, pay 10.025 XRP to r4uKJRy9mjxGHw1yzS1SrtaKCUwT66MCcP ref 0x<...>
  XRPL <...> in ledger <...>
  attempt 1: INVALID: TRANSACTION DOES NOT EXIST
  requestAttestation 0x<...>
  voting round <...>, waiting for the proof...
  executeMinting 0x<...>
  minter holds 11.4 FTestXRP
  transfer 0x<...>
account 0x9dD656e6FE2f9B46E57CE29265b3C66feCa2d741 now holds 19.25
```

Two things to know:

- **`attempt 1: INVALID: TRANSACTION DOES NOT EXIST` is normal.** The verifier hasn't indexed
  the XRPL payment yet, and the script retries on its own.
- **It moves everything the deployer holds**, not only the new lot. That's why the dry run
  ended at 19.25: the deployer's leftover 1.4 came too.

It costs about **3 C2FLR** from the deployer and **10.025 XRP** from the owner's XRPL wallet.

**If it fails:**

- **`missing env ASSET_MANAGER`:** you left off the `ASSET_MANAGER=…` prefix. Copy the whole line.
- **A revert on `reserveCollateral`:** the chosen agent has no free collateral. Run again, and it
  may pick another one. To choose one yourself, list them:
  `cast call 0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA "getAvailableAgentsList(uint256,uint256)(address[],uint256)" 0 10 --rpc-url https://coston2-api.flare.network/ext/C/rpc`.
  Then prefix the fund command with `AGENT_VAULT=0x…`.
- **`tecUNFUNDED_PAYMENT` or a similar XRPL error:** the owner's XRPL wallet is short of XRP.
  Refill it from https://faucet.altnet.rippletest.net/accounts.

---

## 3. Build the cash-out and show the QR

Build it **fresh for each take**. It embeds the account's current nonce, so a QR built before
another instruction ran is dead on arrival.

```bash
npm run sign -w @memokit/executor -- --owner rpnDcUjasCYome3WntkxqQ3gG4wuLXM4WE --cash-out
```

About 4 s. What you see:

```
memokit account   0x9dD656e6FE2f9B46E57CE29265b3C66feCa2d741
nonce             <n>
instruction       cash out 1 lot(s) = 10.0 FXRP, XRP to rpnDcUjasCYome3WntkxqQ3gG4wuLXM4WE (the payer's own address); 9.25 FXRP stays, of which 0.1 pays the executor
executor fee      100000 of 0x0b6A3645c240605887a5532109323A3E12273dc7
memo              0xFD inline, 875 bytes  (self-contained: any executor can run it)

Unsigned XRPL Payment:
{ "TransactionType": "Payment", "Account": "rpnDc…", "Destination": "rDfVHUx5…", "Amount": "1000000", "Memos": [ … ] }

(QR is 171 columns wide, wider than this 100-column terminal: open the PNG below instead)
QR      …/fixtures/measurements/signing/<stem>.png
payload …/fixtures/measurements/signing/<stem>.json  (keep it: execute needs the preimage)
```

The flags, and why these values:

| Flag | Value | Why |
|---|---|---|
| `--owner` | `rpnDcUjasCYome3WntkxqQ3gG4wuLXM4WE` | the XRPL address that signs; it owns the memokit account |
| `--cash-out` | — | build a redemption instead of a transfer |
| `--lots` | *(leave off)* | defaults to every lot the balance can cover with the fee left over |
| `--fee` | *(leave off)* | defaults to 100000 (0.1 FTestXRP), exactly the deployed executor's minimum. Lower and it will ignore the instruction. |

**About the QR.** A cash-out memo is 875 bytes, so the whole transaction only just fits in a QR at
the lowest error-correction level. The result, the PNG, is extremely dense, and no wallet reads its
`xrpl:tx?json=` format anyway. **Don't scan it on camera.** Show it as "the whole instruction,
in one payment" if you like. The QR a phone can actually scan is Xaman's (step 4, option A).

**If it fails:**

- **`cannot cash out anything: the account holds 9.15 FXRP, one lot is 10.0, and 0.1 must be
  left over for the executor fee. Fund it (mints one lot): ASSET_MANAGER=… npm run fund …`:** go
  back to step 2. The command it prints is the same one.
- **`missing env XRPL_OWNER_ADDRESS`:** you left off `--owner`.

---

## 4. Sign

Pick one, before recording.

### Option A: Xaman (scannable on a phone; **not yet tested live**)

1. Create an application at https://apps.xaman.dev.
2. Put its credentials in `.env` as `XAMAN_API_KEY=` and `XAMAN_API_SECRET=`, then re-run step 0.3.
3. In the Xaman app, switch to XRPL Testnet and make sure the account
   `rpnDcUjasCYome3WntkxqQ3gG4wuLXM4WE` is in it.
4. Build and push in one command:

```bash
npm run sign -w @memokit/executor -- --owner rpnDcUjasCYome3WntkxqQ3gG4wuLXM4WE --cash-out --xaman
```

It prints the same summary as step 3, then:

```
Xaman payload <uuid>
  open on the phone: https://xumm.app/sign/<uuid>
<a small QR -- this is the one to scan>
waiting for a signature...
signed: XRPL <HASH>
```

Scan the **second, small** QR with Xaman and approve. The payload expires after 10 minutes.

**If it fails:** `Xaman is not configured. Missing: XAMAN_API_KEY, XAMAN_API_SECRET` means step 2
of this list hasn't been done in this terminal. **This path has never run end to end. Test it
off camera first.**

### Option B: sign with the seed (a stand-in for a wallet; tested)

This signs the payload saved in step 3 with `XRPL_SEED` from the environment. It is **not** how a
memokit user signs: their key never leaves their wallet. If you use it on camera, say it's
standing in for the wallet.

Use the `payload` path that step 3 printed:

```bash
npm run sign-with-seed -w @memokit/executor -- fixtures/measurements/signing/<stem>.json
```

About 6 s. What you see:

```
signing as rpnDcUjasCYome3WntkxqQ3gG4wuLXM4WE  (a stand-in for a wallet: the seed is read from the environment)
  autofilled  Sequence <...>, Fee 12 drops, LastLedgerSequence <...>
  submitted   <HASH>
  result      tesSUCCESS in ledger <...>

follow it:   curl -s https://memokit-executor-production.up.railway.app/status/<HASH>
```

`<HASH>` is the XRPL transaction hash, and every later step needs it. Copy it, then:

```bash
H=<HASH>
```

**If it fails:**

- **`XRPL_SEED is for r…, but this payment is from r…`:** the seed in `.env` isn't the owner's.
- **`tecUNFUNDED_PAYMENT`:** the owner is out of XRP. Use the faucet link in step 2.
- **Never sign the same payload file twice.** The second payment carries the same nonce, fails
  on Flare, and loses its 1 XRP carrier.

---

## 5. Wait for it, then confirm it on chain

### 5a. The executor runs it

This polls the deployed executor every 10 seconds and stops when the instruction is final:

```bash
until curl -s https://memokit-executor-production.up.railway.app/status/$H | python3 -c '
import json, sys, time
d = json.load(sys.stdin)
print(time.strftime("%H:%M:%S"), d.get("state") or d.get("error"), d.get("elapsed", ""), flush=True)
sys.exit(0 if d.get("final") else 1)'; do sleep 10; done
```

About **2 minutes**. What you see, one line every 10 s:

```
22:11:49 seen {'seen': 3}
22:12:00 attesting {'seen': 6, 'attesting': 9}
22:12:12 attesting {'seen': 6, 'attesting': 21}
   …
22:13:09 attesting {'seen': 6, 'attesting': 78}
22:13:20 proved {'seen': 6, 'attesting': 89, 'proved': 0}
22:13:42 executed {'seen': 6, 'attesting': 89, 'proved': 15}
```

What the states mean, for the voice-over:

- **`seen`:** the executor found the XRPL payment.
- **`attesting`:** it has paid for an FDC attestation and is waiting for the voting round. This is
  the ~90 s that no software can shorten.
- **`proved`:** the proof is out and the executor is submitting it.
- **`executed`:** done on Flare.

**If it fails:**

- **`no payment <HASH> to a memokit receiving address`** for the first 15 s or so is normal: the
  executor polls the ledger every 15 s. It should turn into `seen`.
- **It stays `seen` for more than a minute:** the executor declined it. Check the reason with
  `curl -s https://memokit-executor-production.up.railway.app/status/$H | grep -E 'skipReason|lastError'`.
  The usual cause is a fee below 0.1 FTestXRP.
- **It ends `failed` or `stuck`:** read `lastError` with the same command. `InvalidNonce` means a
  stale QR: rebuild it (step 3) and sign again.

### Confirm the execute on Flare

```bash
curl -s https://memokit-executor-production.up.railway.app/status/$H | grep -A3 '"execution"'
```

What you see:

```
  "execution": {
    "txHash": "0x5da0d80a47718e905daeb59c5cdf93b214b251bddbd1302d208404dd1e6caeae",
    "blockNumber": 35745285,
    "byUs": true,
```

Copy the execute transaction hash into `T` and its block number into `B`. Then read the receipt
from the chain itself, not from the executor:

```bash
T=<txHash>; B=<blockNumber>
cast receipt $T --rpc-url https://coston2-api.flare.network/ext/C/rpc | grep -E '^(status|blockNumber|from) '
```

```
blockNumber          35745285
from                 0xD4dFA2b68d14fc71BF5940559Ad9F819c1b0350D
status               1 (success)
```

`from` is the deployed executor's own key, so nobody at this keyboard sent it. The account
dropped by one lot plus the fee:

```bash
cast call 0x0b6A3645c240605887a5532109323A3E12273dc7 "balanceOf(address)(uint256)" \
  0x9dD656e6FE2f9B46E57CE29265b3C66feCa2d741 --rpc-url https://coston2-api.flare.network/ext/C/rpc
```

```
9150000 [9.15e6]
```

That's 19.25 − 10.0 redeemed − 0.1 fee. In the browser:
`https://coston2-explorer.flare.network/tx/<T>`.

### 5b. The XRP comes back (not under our control)

An FAssets agent now owes about 9.948 XRP to `rpnDcUjasCYome3WntkxqQ3gG4wuLXM4WE`: 10.0 minus
FAssets' fees. Watch the owner's XRPL account:

- Browser: `https://testnet.xrpl.org/accounts/rpnDcUjasCYome3WntkxqQ3gG4wuLXM4WE`, where an
  incoming payment of 9.948010 XRP appears.
- Terminal, the XRP balance right now:

```bash
curl -s -X POST https://s.altnet.rippletest.net:51234/ -H 'content-type: application/json' \
  -d '{"method":"account_info","params":[{"account":"rpnDcUjasCYome3WntkxqQ3gG4wuLXM4WE","ledger_index":"validated"}]}' \
  | python3 -c 'import json,sys; print(int(json.load(sys.stdin)["result"]["account_data"]["Balance"])/1e6, "XRP")'
```

**How long it takes is up to the agent.** In the Phase 3 run the agent paid 21 s after the
execute. In this runbook's dry run it paid **16 minutes** after:
`https://testnet.xrpl.org/transactions/0ECB1546CA1820CD8DF056E23E77BBDCB5FE6A53980ECFAED59B44F34538821C`,
9.948010 XRP from the agent's address `r4uKJRy9…`. That was on time, because an agent is only
late once *both* its deadlines have passed: an XRPL ledger number and a timestamp, both in the
`RedemptionRequested` event. This one paid 4 minutes after the timestamp deadline but 170 ledgers
before the ledger deadline.

If an agent really does default, the account is compensated in collateral on Flare, not in XRP,
and only once somebody submits a non-payment proof. None of that happens on camera.

The owner's XRP balance rises by 8.947998 XRP, not 9.948: the 1.000012 XRP carrier payment for the
instruction went out first.

To show a completed payout regardless, use the Phase 3 one:
`https://testnet.xrpl.org/transactions/F7858109B0AD251D1BB44227AAB73E10F4651587FA30022278AA497A485E9ECD`.
That's 9.948010 XRP, paid 21 s after its execute.

---

## 6. Look it up by XRPL hash

The one-line lookup, which is the one to show:

```bash
curl -s https://memokit-executor-production.up.railway.app/status/$H
```

About 1 s. It returns the whole record: `state`, the classifier's `reason` and `loss` in plain
English, seconds in each state, and the attestation and execute transactions.

The full history for the owner:

```bash
npm run rescue -w @memokit/executor -- --owner rpnDcUjasCYome3WntkxqQ3gG4wuLXM4WE
```

About 20 s. It lists every payment the owner ever sent to the receiving address, newest first,
each with its state and what was lost. What you see (top):

```
EXECUTED               4D9F2AD97010C8E4DC20FCC570EEAD797DF7E914D3E275CD0336CC1BEF5A58EF
  ledger 20991018  the transaction id is marked consumed on chain
  instruction nonce 4, account at 5
  loss if ignored: Carrier payment only. The instruction did what it said.
```

**Careful with this one on camera.** Further down, `9766BF74…` shows `EXPIRED`, but it actually
executed on the retired Phase 2 diamond. The classifier only checks the current diamond. If it's
on screen, say so or crop it. `4F90F05F…` really did expire.

---

## 7. The manipulated-pool fork test, on its own

```bash
FOUNDRY_PROFILE=fork forge test --match-test test_aManipulatedPoolPassesTheLooseFloorAndFailsTheOracleBound -vv
```

About 4 s once compiled. **Run it once before recording:** the first run compiles, which takes
longer and prints a block of `Warning (2519): This declaration shadows…` first. What you see on
a later run:

```
No files changed, compilation skipped

Ran 1 test for test/fork/SparkDexFork.t.sol:SparkDexForkTest
[PASS] test_aManipulatedPoolPassesTheLooseFloorAndFailsTheOracleBound() (gas: 2099361)
Logs:
  SIMULATED FDC VERIFICATION: verifyXRPPayment mocked to true (see ForkBase)
  FXRP dumped into the pool to move it: 35000000000
  fair out (USDT0): 1408788917
  manipulated out (USDT0): 975864088
  accepted with the floor alone (USDT0): 975864088

Suite result: ok. 1 passed; 0 failed; 0 skipped
```

What it shows, in the order it happens:

1. On a copy of **Flare mainnet**, someone dumps 35,000 FXRP into the real SparkDEX pool. A 1,000
   FXRP swap now returns 975.86 USDT0 instead of a fair 1,408.79.
2. With only the signed minimum (704.39), the manipulated swap is **accepted**.
3. With an FTSOv2 bound of 1% against the real oracle, the same swap is **refused**. The test
   asserts that revert; `PASS` means it happened, and that the proof stays usable.

Say "on a fork of Flare mainnet, with FDC verification simulated". The logs' first line says so,
and it's the honest description: the oracle and the pool are real, the attestation is mocked.

**If it fails:**

- **`missing trie node`** or an RPC error: the archive endpoint in `foundry.toml`
  (`flare_archive`) is having trouble. Retry in a minute.
- **`No tests found`:** the test name was retyped wrong. Copy it from here.

---

## 8. Show on the explorer what was and wasn't minted

**What to say.** In a cash-out, FXRP is **burned**, not minted. **No FXRP is minted for the
user.** The chain does show one small mint in the same transaction: FAssets' own 0.002 FXRP fee
to the agent's collateral pool. So "nothing was minted" is not literally true of a cash-out.
"Nothing was minted for the user, and supply fell by what was redeemed" is.

### The transaction's token movements

```
https://coston2-explorer.flare.network/tx/<T>?tab=token_transfers
```

Click path from the transaction page: **Token transfers** tab. In the dry run it listed:

| Type | From | To | Amount |
|---|---|---|---|
| Token burning | the memokit account `0x9dD656e6…` | `0x000…000` | 10.0 FTestXRP |
| Token minting | `0x000…000` | the agent's pool `0x6E815bB9…` | 0.002 FTestXRP |
| Token transfer | the memokit account | the executor `0xD4dFA2b6…` | 0.1 FTestXRP (its fee) |

### Total supply, the block before and the block of the execute

**The explorer can't show this.** Its token page
(`https://coston2-explorer.flare.network/token/0x0b6A3645c240605887a5532109323A3E12273dc7`) shows
**current** total supply only, and has no way to read it at a past block. Read it from the chain
with `B` from step 5:

```bash
cast call 0x0b6A3645c240605887a5532109323A3E12273dc7 "totalSupply()(uint256)" --block $((B-1)) --rpc-url https://coston2-api.flare.network/ext/C/rpc
cast call 0x0b6A3645c240605887a5532109323A3E12273dc7 "totalSupply()(uint256)" --block $B --rpc-url https://coston2-api.flare.network/ext/C/rpc
```

In the dry run:

```
11221231169768 [1.122e13]
11221221171768 [1.122e13]
```

That is **9.998000 FTestXRP less**: 10.0 burned, 0.002 minted to the agent's pool. The
difference is exact only if nobody else minted or redeemed FXRP in the same block. If the
numbers don't match 9.998, check the block's other FXRP transactions before saying anything.

**If it fails:** `missing trie node` means the public RPC has pruned that block's state. That
only happens for old blocks, never for one from this demo. Use
`--rpc-url https://rpc.ankr.com/flare_coston2`, which keeps history.

**For a "nothing minted at all" shot,** use a transfer instead of a cash-out, for example the
Phase 4 run:
`https://coston2-explorer.flare.network/tx/0xb2868ed477162780dcbae916ecff5c8f83da3fc616e6f9aa5a7e0f5dd5979f4c?tab=token_transfers`.
It has two transfers and no mint or burn.

---

## What one run costs

Measured in the dry run on 2026-09-23:

| Who pays | What | Per run |
|---|---|---|
| Deployed executor | attestation request (fee + gas) and the execute | **0.50 C2FLR** (it earns 0.1 FTestXRP) |
| Deployer | funding: collateral reservation fee + gas | **~3.0 C2FLR** per lot minted |
| Owner's XRPL wallet | 10.025 XRP to mint, 1 XRP carrier, back ~9.948 XRP if the agent pays | **~1.1 XRP net**, or ~11 XRP if the agent defaults |
| Fork test | nothing | local |

Each practice run needs a fresh lot, because a cash-out takes the account from ~19 back to ~9.
**About 3.5 C2FLR per practice run in total**, most of it the minting.

Balances after the dry run, payout included: executor 18.98 C2FLR, deployer 19.15 C2FLR, account
9.15 FTestXRP, owner 61.80 XRP. That's **about 6 practice runs before the deployer runs dry**; the executor
alone would last ~38. The deployer refills from https://faucet.flare.network/coston2, and the
owner from https://faucet.altnet.rippletest.net/accounts.
