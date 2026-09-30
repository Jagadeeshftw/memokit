---
title: "Memo wire format"
description: "The header, the opcodes and the versioned payload."
---

A memokit instruction travels in the memo of one XRPL Payment. The memo has a 10-byte header and a
body whose shape depends on the opcode. The header is byte-identical to Flare Smart Accounts'
header, so a wallet that already builds FSA memos changes one byte: the opcode.

## Header

```text
byte  0    : opcode
byte  1    : walletId (uint8)
bytes 2..9 : executorFee (uint64, big-endian)  -- reserved, must be zero
```

- **opcode** says what the memo is: run an instruction, or manage the account's queue.
- **walletId** keeps its place and meaning from Flare's header.
- **executorFee** keeps its place and width for byte-compatibility, but memokit rejects any non-zero
  value. The executor's fee lives in the payload, inside the hash, where an executor cannot change it.
  A wallet built for Flare that puts a fee in the header would otherwise sign a promise the contract
  never keeps.

The XRPL address the payment is sent to says which protocol the memo is addressed to. That is why
memokit can reuse Flare's rescue opcodes at their original values.

## Opcodes

| Opcode | Body | Memo length | What it does |
|---|---|---|---|
| `0xFD` | the instruction, inline | 10 + N | Run it. Any executor can, with nothing but the ledger. |
| `0xFC` | `keccak256(payload)` | 42 | Run the payload that hashes to this. The payload travels separately. |
| `0xFB` | `newNonce` | 42 | Advance the account's nonce to **at least** N. |
| `0xF8` to `0xFA` | reserved | | Rejected. |
| `0xE0` | `targetTxId` | 42 | Retire a stuck XRPL transaction id, so it never runs. |
| `0xE1` | `newNonce` | 42 | Set the nonce to exactly N, to move past a stuck instruction. |
| `0xE2` | `targetTxId` + `newFee` | 50 | Override the executor fee amount for a stuck instruction. |

`0xE0`, `0xE1` and `0xE2` are Flare's opcodes, with Flare's semantics. `0xFB` is memokit's own. `0xE1`
sets an exact nonce, so it reverts if anything else executes during the minutes its memo is in
flight: a rescue can fail because the queue unstuck itself. `0xFB` is monotonic and idempotent, so it
cannot. It is covered by tests and has never run live. See [Rescue](/docs/concepts/rescue).

## Inline or commit

**Inline (`0xFD`)** carries the whole instruction. It is self-contained: any executor watching the
receiving address can run it. The cost is size. XRPL allows about 1,019 bytes of memo payload, so an
inline instruction must fit in that. A cash-out is 875 bytes; a vault deposit with a post-condition,
1,003.

**Commit (`0xFC`)** carries only the payload's hash, 42 bytes whatever the instruction. The cost is that
`execute` takes the payload as an argument, so an executor that does not have it **cannot** run the
instruction: not "will not". The author must hand the payload to whoever delivers it. The open
executor accepts payloads for commit memos through a file its operator maintains; see
[Fee policy, racing and simulation](/docs/executor/fee-policy-racing-simulation).

Use inline for anything a stranger's executor should pick up. Use commit when you deliver the
instruction yourself, or when it is too large to inline.

## Payload

```text
byte 0     : payload version (0x02)
bytes 1..  : abi.encode(sender, nonce, feeToken, feeAmount, Call[], PostCondition[])
```

| Field | Type | Meaning |
|---|---|---|
| `sender` | `address` | the memokit account that acts; must be the one derived from the payment's sender |
| `nonce` | `uint256` | the account's next nonce; instructions run in order |
| `feeToken` | `address` | the token the executor is paid in; the zero address for no fee |
| `feeAmount` | `uint256` | the fee, in base units, paid only if every call and post-condition succeeds |
| `calls` | `(address target, uint256 value, bytes data)[]` | what the account calls, in order |
| `postConditions` | `(uint8 kind, address token, address subject, uint256 threshold, bytes extra)[]` | what must hold afterwards, at most 32 |

The version byte is in the **payload**, not the header, because the wallet chooses the header and
whoever built the instruction chooses the payload's shape. A version 1 payload begins with the zero
byte of a left-padded address, so the contract rejects it with `UnsupportedPayloadVersion(0)` instead
of decoding it as something else.

## In the SDK

```ts
import { prepareInstruction, encodeMemo, decodeMemo, Opcode } from "@memokit/sdk";

const { payload, commitment, memo } = prepareInstruction(instruction);       // a 0xFC commit memo
const inline = encodeMemo({ kind: "execInline", opcode: Opcode.ExecInline, walletId: 1, executorFee: 0n, instruction });
decodeMemo(memo);                                                              // back to a structure
```

The encoding is pinned by golden vectors in the repo's `fixtures/memo-wire.json`, which both the
Solidity tests and the SDK tests check. The full opcode table is in
[Opcodes and payload versions](/docs/reference/opcodes).
