---
title: "Sign and submit, let the executor run it"
description: "Build an instruction with npm run sign, sign it, and let the open executor deliver it."
---

This is memokit as an XRPL user sees it: build one XRPL payment, sign it, submit it, and wait. The
open executor finds the payment, pays for the attestation, and executes the instruction on Flare
for the fee the instruction offers. You never need a Flare key.

The example deposits 0.5 FTestXRP, which the account already holds, into a vault.

> **About signing.** `npm run sign` builds the unsigned XRPL transaction and prints a QR code of it.
> **That QR cannot be scanned by a standard XRPL wallet**: no wallet reads its `xrpl:tx?json=`
> format, and an inline instruction is too large for a QR a phone can reliably scan. Signing through
> Xaman (`--xaman`) is built but **has never run against the live Xaman API**; it is marked Open in
> the [claim ledger](/docs/evidence/claim-ledger). This page signs with `npm run sign-with-seed`
> instead, which reads an XRPL seed from your environment. It stands in for a wallet. A real user's
> key would never leave their wallet.

## Before you start

- Node 20 or later, and a built clone of the memokit repo (`npm install && npm run build`).
- A `.env` at the repo root with `XRPL_SEED` set: an XRPL Testnet wallet with a few XRP, from
  https://faucet.altnet.rippletest.net/accounts. No Flare key is needed for this page.
- The memokit account for that address holding at least 0.6 FTestXRP: 0.5 to deposit and 0.1 for the
  executor's fee. See [Fund an account with FTestXRP](/docs/guides/fund-an-account).

## 1. Set up your shell

From the repo root:

```bash
set -a && . ./.env && set +a
export OWNER=$(node -p "require('xrpl').Wallet.fromSeed(process.env.XRPL_SEED).address")
export VAULT=$(grep '^MEMOKIT_VAULT=' .env.example | cut -d= -f2)
```

## 2. Build the instruction

```bash
npm run sign -w @memokit/executor -- --owner $OWNER --deposit $VAULT --amount 500000
```

What you see, trimmed:

```text
memokit account   0x9dD656e6…d741
nonce             11
instruction       deposit 0.5 of 0x0b6A3645… into vault 0xF97B2bBd… (TESTearnXRP), shares to the account itself; at least 494455 shares or it reverts
executor fee      100000 of 0x0b6A3645…
memo              0xFD inline, 1003 bytes  (self-contained: any executor can run it)

Unsigned XRPL Payment:
{ "TransactionType": "Payment", "Account": "r…", "Destination": "rDfVHUx5…", "Amount": "1000000", "Memos": [ … ] }

payload fixtures/measurements/signing/<stem>.json  (keep it: execute needs the preimage)
```

The CLI reads the account's current nonce, so build the instruction fresh each time. Three choices
it makes for you:

- **Inline memo (`0xFD`).** The whole instruction travels in the payment, so the open executor can
  run it with nothing but the ledger.
- **A 0.1 FTestXRP executor fee**, the deployed executor's minimum. A lower fee is ignored.
- **A post-condition**: the account's vault shares must rise by at least 99% of the vault's quote
  at signing, or the whole instruction reverts.

For a cash-out instead, replace `--deposit $VAULT --amount 500000` with `--cash-out`. See
[Cash out to XRPL](/docs/guides/cash-out).

## 3. Sign and submit

Use the `payload` path the previous step printed:

```bash
npm run sign-with-seed -w @memokit/executor -- fixtures/measurements/signing/<stem>.json
```

```text
signing as r…  (a stand-in for a wallet: the seed is read from the environment)
  autofilled  Sequence …, Fee 12 drops, LastLedgerSequence …
  submitted   231B7917…
  result      tesSUCCESS in ledger 21177044
```

Copy the submitted hash:

```bash
H=<the submitted hash>
```

Never sign the same payload file twice. The second payment carries the same nonce, fails on Flare,
and loses its 1 XRP carrier.

## 4. Watch it execute

```bash
until curl -s https://memokit-executor-production.up.railway.app/status/$H | python3 -c '
import json, sys, time
d = json.load(sys.stdin)
print(time.strftime("%H:%M:%S"), d.get("state") or d.get("error"), d.get("elapsed", ""), flush=True)
sys.exit(0 if d.get("final") else 1)'; do sleep 10; done
```

Or paste the hash into https://memokit.0xo.in/status. See
[Look up an instruction](/docs/quickstart/look-up-an-instruction).

## What success looks like

One line every ten seconds, ending in `executed`, usually about two and a half minutes after you
submitted. This is the loop's real output for the cash-out run on 2026-10-01; a deposit prints the
same states:

```text
01:00:39 seen {'seen': 7}
01:00:50 attesting {'seen': 5, 'attesting': 3}
01:01:02 attesting {'seen': 5, 'attesting': 14}
…
01:02:21 attesting {'seen': 5, 'attesting': 94}
01:02:32 proved {'seen': 5, 'attesting': 105, 'proved': 0}
01:02:43 proved {'seen': 5, 'attesting': 115, 'proved': 1}
01:02:54 executed {'seen': 5, 'attesting': 115, 'proved': 4}
```

- **seen**: the executor found your payment.
- **attesting**: it has paid for an FDC attestation and is waiting for the voting round.
- **proved**: the proof is out and it is submitting.
- **executed**: done on Flare.

## If something goes wrong

- **`no payment … to a memokit receiving address` for the first 15 s:** normal. The executor reads
  the ledger every 15 s.
- **It stays `seen` for more than a minute:** the executor declined it. Read the reason with
  `curl -s https://memokit-executor-production.up.railway.app/status/$H | grep -E 'skipReason|lastError'`.
  The usual cause is a fee below 0.1 FTestXRP, or a `0xFC` commit memo, which it cannot run without
  the preimage.
- **It stays `attesting` for more than about five minutes:** FDC may have finalised the round without
  attesting the request. This happened once, on 2026-10-01. The open executor now notices: two
  minutes after the round finalises with no proof served, it requests the attestation again in a later
  round, up to twice, and the status answer lists the rounds that went unserved under
  `attestation.unservedRounds`. If every round goes unserved, it parks the instruction as `stuck` and
  stops paying. Nothing moves in the meantime. See [Rescue](/docs/concepts/rescue).
- **It ends `failed` or `stuck`:** read `lastError` the same way. `InvalidNonce` means the instruction
  was built before another one executed: build it again and sign the new one.
- **The account holds too little:** `npm run sign` refuses before building. Fund it first.

Nothing in any of these states touches the account's assets. See [Rescue](/docs/concepts/rescue).
