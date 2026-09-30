---
title: "SDK API"
description: "prepareInstruction, sendMemoPayment, requestAttestation, waitForProof, submit."
---

`@memokit/sdk` is a TypeScript library in the repo's `sdk/` folder. It is not published to npm; use it
from a clone of the repo, where `npm install && npm run build` links it for the workspace. The name is
provisional.

It has three entry points:

| Import from | What is there |
|---|---|
| `@memokit/sdk` | building instructions, attestation, submission, post-conditions, rescue, cash-out and import helpers, network constants |
| `@memokit/sdk/xrpl` | sending the XRPL payment. Separate, so code that only encodes memos does not install the XRPL client |
| `@memokit/sdk/fdc` | the lower-level FDC pieces: request and response encoding, the DA Layer client |

## The five calls

One instruction, from building to executed, is five calls. [A vault deposit with the SDK](/docs/quickstart/sdk-vault-deposit)
runs them.

### `prepareInstruction(instruction, options?)`

```ts
prepareInstruction(instruction: Instruction, options?: { walletId?: number }): PreparedInstruction
```

Encodes the instruction and returns `{ payload, commitment, memo }`. `memo` is a `0xFC` commit memo, 42
bytes, carrying `commitment`, the `keccak256` of `payload`. Keep `payload`: `execute` needs it.

```ts
interface Instruction {
  sender: string;              // the memokit account
  nonce: bigint;               // its next nonce: memokit.nonceOf(account)
  feeToken: string;            // the zero address for no fee
  feeAmount: bigint;
  calls: { target: string; value: bigint; data: string }[];
  postConditions?: PostCondition[];   // at most 32
}
```

### `sendMemoPayment(args)`, from `@memokit/sdk/xrpl`

```ts
sendMemoPayment(args: { network?: Network; wallet: Wallet; destination: string; drops: string; memo: string })
  : Promise<{ hash: string; ledgerIndex: number; validated: boolean }>
```

Sends one XRPL Payment with exactly one memo and no destination tag, and waits for validation. Both
constraints are enforced: memokit's contract rejects a tagged payment. `drops` is the carrier amount;
memokit's runs use `"1000000"`, 1 XRP.

### `requestAttestation(args)`

```ts
requestAttestation(args: { signer: Signer; xrplHash: string; network?: Network }): Promise<AttestationRequest>
```

Fetches the XRPL transaction, builds the `XRPPayment` request and its message integrity code offline,
and submits it to `FdcHub`, paying the fee from `signer`. Never calls Flare's verifier. Returns the
request, its voting round, and the response it expects.

### `waitForProof(args)`

```ts
waitForProof(args: { request; network?: Network; timeoutMs?: number; intervalMs?: number }): Promise<AttestedProof>
```

Polls the DA Layer for the round's proof, with no API key, and checks the attested response is the one
expected: in particular, that the memo is the one sent. Returns `{ proof, … }`.

### `submit(args)`

```ts
submit(args: { signer: Signer; controller: string; proof: unknown[]; payload: string; value?: bigint })
  : Promise<ContractTransactionReceipt>
```

Calls `execute(proof, payload)` on the diamond. For an inline memo, pass `"0x"` as the payload.

## Memo encoding

| Function | Does |
|---|---|
| `encodeInstruction(instruction)` / `decodeInstruction(payload)` | the versioned payload |
| `commitmentOf(instruction)` | `keccak256` of the payload |
| `encodeMemo(memo, options?)` / `decodeMemo(memoHex)` | a whole memo, any opcode |
| `decodeHeader(memoHex)` | the 10-byte header |
| `toXrplMemoData(memoHex)` / `fromXrplMemoData(memoData)` | between `0x…` hex and XRPL's `MemoData` |
| `Opcode` | `ExecInline` (`0xFD`), `ExecCommit` (`0xFC`), `NonceAtLeast` (`0xFB`), `Ignore` (`0xE0`), `SetNonce` (`0xE1`), `ReplaceFee` (`0xE2`) |
| `PAYLOAD_VERSION` | `2` |

An inline memo, for an executor to run with nothing but the ledger:

```ts
import { encodeMemo, Opcode } from "@memokit/sdk";

const memo = encodeMemo({ kind: "execInline", opcode: Opcode.ExecInline, walletId: 1, executorFee: 0n, instruction });
```

`executorFee` is the header field and must be zero; the fee is `instruction.feeAmount`.

## Post-conditions

| Function | Kind |
|---|---|
| `erc20BalanceAtLeast(token, subject, atLeast)` | balance floor |
| `erc20DeltaAtLeast(token, subject, atLeast)` | rise floor, against a snapshot before the calls |
| `nativeBalanceAtLeast(subject, atLeast)` | native balance floor |
| `nativeDeltaAtLeast(subject, atLeast)` | native rise floor |
| `ftsoRateAtLeast(tokenOut, subject, bound)` | realised rate within a bound of FTSOv2 |
| `feedId(name)` | an FTSOv2 feed id from a name such as `"XRP/USD"` |

See [Post-conditions](/docs/concepts/post-conditions) and [Price protection](/docs/concepts/price-protection).

## Deadlines

| Export | |
|---|---|
| `DEFAULT_DEADLINE_SECONDS` | `900` |
| `deadlineFromNow(seconds?, nowMs?)` | Unix seconds, for a protocol's `deadline` argument |

## Unsigned payments

| Export | |
|---|---|
| `buildUnsignedPayment({ owner, destination, drops?, memo, destinationTag? })` | the Payment a wallet signs, with no sequence, fee or signature |
| `AUTOFILLED_BY_THE_WALLET` | the fields a wallet fills in |
| `CARRIER_DROPS` | `"1000000"` |

## Rescue

| Export | |
|---|---|
| `classifyPayments(payments, options)` | the seven-state classifier; see [Rescue](/docs/concepts/rescue) |
| `RESCUE_STATES` | each state's `final` flag and what is lost in it |
| `fetchIncomingPayments({ network, receivingAddress, limit?, sinceLedger? })` | the payments to classify, from the XRPL ledger |
| `buildRetireMemo(targetTransactionId)` | a `0xE0` memo |
| `buildReplaceFeeMemo(targetTransactionId, newFee)` | a `0xE2` memo |
| `buildNonceAtLeastMemo(target)` | a `0xFB` memo |

## Cash-out and import

| Export | |
|---|---|
| `planCashOut({ assetManager, account, provider, xrplOwner, maxLots? })` | lots, amounts and the dust left, for a redemption to the owner's own address |
| `buildCashOutCalls(assetManager, plan)` | the calls for that plan |
| `lotsLeavingFee(balance, lotSize, fee)` | whole lots that leave at least `fee` |
| `waitForRedemption(…)` / `checkRedemption(…)` | follow a redemption to its XRPL payout |
| `deriveBothAccounts(xrplOwner, memokitController, provider)` | an owner's FSA account and memokit account |
| `buildImportReference(params)` / `decodeImportReference(ref)` | FSA's 32-byte transfer reference |

## Networks

| Export | |
|---|---|
| `COSTON2` | chain id, RPC, explorer, source id, DA Layer URL, contract registry, XRPL endpoints |
| `FLARE` | the same for Flare mainnet, for reading only: memokit is not deployed there |
| `CONTRACT_REGISTRY` | Flare's contract registry, the same address on every Flare network |
| `CONTROLLER_ABI`, `CONTROLLER_ERRORS`, `controllerInterface` | the diamond's ABI and custom errors, for decoding reverts |
