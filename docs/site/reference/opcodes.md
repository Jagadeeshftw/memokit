---
title: "Opcodes and payload versions"
description: "The opcode table and the payload version byte."
---

Byte 0 of every memokit memo is its opcode. The receiving address says the memo is for memokit, so the
opcode space is memokit's own, with Flare's management opcodes kept at their original values.

## Opcodes

| Opcode | SDK name | Body after the header | Memo length | Effect |
|---|---|---|---|---|
| `0xFD` | `ExecInline` | the payload | 10 + N | Run the instruction in the memo. |
| `0xFC` | `ExecCommit` | `keccak256(payload)`, 32 bytes | 42 | Run the payload passed to `execute`, if it hashes to this. |
| `0xFB` | `NonceAtLeast` | `newNonce`, uint256 | 42 | Advance the account's nonce to at least N. Idempotent. |
| `0xF8`, `0xF9`, `0xFA` | | | | Reserved: rejected with `ReservedOpcode`. |
| `0xE0` | `Ignore` | `targetTxId`, bytes32 | 42 | Retire one XRPL transaction id; if delivered later, it is ignored. |
| `0xE1` | `SetNonce` | `newNonce`, uint256 | 42 | Set the account's nonce to exactly N. |
| `0xE2` | `ReplaceFee` | `targetTxId`, bytes32, then `newFee`, uint64 | 50 | Override the executor fee amount for one transaction id. |

Any other opcode is rejected with `UnknownOpcode`. `0xE0`, `0xE1` and `0xE2` are Flare Smart Accounts'
opcodes with Flare's semantics. `0xFB` is memokit's own; it is covered by tests and has never run live.

Flare Smart Accounts' own execute opcodes, `0xFF` and `0xFE`, and its executor opcodes `0xD0` and `0xD1`,
are not memokit opcodes. A memo carrying one, sent to a memokit receiving address, is rejected.

## Header

```text
byte  0    : opcode
byte  1    : walletId (uint8)
bytes 2..9 : executorFee (uint64, big-endian)  -- reserved, must be zero
```

A non-zero `executorFee` is rejected on every opcode with `HeaderFeeReserved`. The check comes after the
ignore flag, so a memo rejected for it can still be retired with `0xE0`.

## Payload versions

| Version | Byte 0 | Layout | Status |
|---|---|---|---|
| 2 | `0x02` | `abi.encode(sender, nonce, feeToken, feeAmount, Call[], PostCondition[])` after the version byte | current |
| 1 | none | `abi.encode(…)` with no version byte and no post-conditions | rejected with `UnsupportedPayloadVersion(0)` |

A version 1 payload starts with the zero byte of a left-padded address, which the current contract reads
as version 0 and rejects, rather than decoding it as something else. Fourteen version 1 vectors in the
repo's `fixtures/memo-wire-v1.json` pin that.

Changing the payload format means deploying a new diamond, and a new diamond moves every account's
address. See [Accounts and derivation](/docs/concepts/accounts).

## Limits

| | |
|---|---|
| XRPL memo budget | about 1,019 bytes of payload in one memo |
| Header | 10 bytes |
| Commit memos and most management memos | 42 bytes |
| `0xE2` | 50 bytes |
| Post-conditions per instruction | 32 |
| Memos per payment | exactly one |

Golden vectors for every opcode are in `fixtures/memo-wire.json`, checked by both the Solidity and the
SDK test suites.
