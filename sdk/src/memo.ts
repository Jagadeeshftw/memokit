import { AbiCoder, getAddress, hexlify, keccak256, getBytes, concat, zeroPadValue, toBeHex } from "ethers";
import {
  Opcode,
  RESERVED_OPCODES,
  HEADER_LENGTH,
  LENGTH_WORD,
  LENGTH_WORD_FEE,
  type Call,
  type Instruction,
  type Memo,
  type MemoHeader,
} from "./types.js";

const coder = AbiCoder.defaultAbiCoder();

/**
 * ABI type of the instruction payload.
 *
 * A five-element top-level tuple, not a wrapped struct. `abi.decode(payload, (address,
 * uint256, address, uint256, Call[]))` on the Solidity side reads exactly this. Wrapping it
 * in a struct would add a leading offset word and break the correspondence.
 *
 * Elements: sender, nonce, feeToken, feeAmount, calls. The fee is inside the payload so the
 * hash a 0xFC memo commits to covers it: an executor sees the preimage before acting, and
 * must not be able to change what it is paid or in what.
 */
export const INSTRUCTION_ABI_TYPES = [
  "address",
  "uint256",
  "address",
  "uint256",
  "tuple(address target, uint256 value, bytes data)[]",
] as const;

export class MemoEncodeError extends Error {}
export class MemoDecodeError extends Error {}

function assertUint(value: bigint, bits: number, label: string): void {
  if (value < 0n || value >= 1n << BigInt(bits)) {
    throw new MemoEncodeError(`${label} out of range for uint${bits}: ${value}`);
  }
}

function assertByte(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new MemoEncodeError(`${label} is not a byte: ${value}`);
  }
}

/** ABI-encode an instruction. This is the payload 0xFD inlines and 0xFC commits to. */
export function encodeInstruction(instruction: Instruction): string {
  assertUint(instruction.nonce, 256, "nonce");
  assertUint(instruction.feeAmount, 256, "feeAmount");
  const calls = instruction.calls.map((c) => {
    assertUint(c.value, 256, "call.value");
    return [getAddress(c.target), c.value, c.data];
  });
  return coder.encode(
    [...INSTRUCTION_ABI_TYPES],
    [
      getAddress(instruction.sender),
      instruction.nonce,
      getAddress(instruction.feeToken),
      instruction.feeAmount,
      calls,
    ],
  );
}

/** Inverse of {@link encodeInstruction}. */
export function decodeInstruction(payload: string): Instruction {
  let decoded;
  try {
    decoded = coder.decode([...INSTRUCTION_ABI_TYPES], payload);
  } catch (cause) {
    throw new MemoDecodeError(`instruction payload is not valid ABI: ${(cause as Error).message}`);
  }
  const calls: Call[] = decoded[4].map((c: unknown[]) => ({
    target: getAddress(c[0] as string),
    value: c[1] as bigint,
    data: c[2] as string,
  }));
  return {
    sender: getAddress(decoded[0]),
    nonce: decoded[1] as bigint,
    feeToken: getAddress(decoded[2]),
    feeAmount: decoded[3] as bigint,
    calls,
  };
}

/** keccak256 of the ABI-encoded instruction: what a 0xFC memo carries. */
export function commitmentOf(instruction: Instruction): string {
  return keccak256(encodeInstruction(instruction));
}

function encodeHeader(header: MemoHeader, allowReservedFee: boolean): Uint8Array {
  assertByte(header.opcode, "opcode");
  assertByte(header.walletId, "walletId");
  assertUint(header.executorFee, 64, "executorFee");
  if (header.executorFee !== 0n && !allowReservedFee) {
    throw new MemoEncodeError(
      `executorFee ${header.executorFee} is reserved and must be 0: the fee belongs in the ` +
        `instruction (feeToken, feeAmount). The contract rejects a non-zero header fee.`,
    );
  }
  if ((RESERVED_OPCODES as readonly number[]).includes(header.opcode)) {
    throw new MemoEncodeError(`opcode 0x${header.opcode.toString(16)} is reserved`);
  }
  const out = new Uint8Array(HEADER_LENGTH);
  out[0] = header.opcode;
  out[1] = header.walletId;
  // uint64 big-endian, bytes 2..9
  let fee = header.executorFee;
  for (let i = 9; i >= 2; i--) {
    out[i] = Number(fee & 0xffn);
    fee >>= 8n;
  }
  return out;
}

function requireBytes32(value: string, label: string): string {
  const bytes = getBytes(value);
  if (bytes.length !== 32) {
    throw new MemoEncodeError(`${label} must be 32 bytes, got ${bytes.length}`);
  }
  return hexlify(bytes);
}

/** Options for {@link encodeMemo}. */
export interface EncodeMemoOptions {
  /**
   * Permit a non-zero header executorFee. Off by default because the contract rejects it; on
   * only for tests that need to build the memos the contract must reject.
   */
  allowReservedFee?: boolean;
}

/** Encode a memo to the raw bytes that go in the XRPL MemoData field. */
export function encodeMemo(memo: Memo, options: EncodeMemoOptions = {}): string {
  const header = encodeHeader(memo, options.allowReservedFee ?? false);
  switch (memo.kind) {
    case "execInline":
      return hexlify(concat([header, encodeInstruction(memo.instruction)]));
    case "execCommit":
      return hexlify(concat([header, requireBytes32(memo.commitment, "commitment")]));
    case "ignore":
      return hexlify(concat([header, requireBytes32(memo.targetTransactionId, "targetTransactionId")]));
    case "setNonce": {
      assertUint(memo.newNonce, 256, "newNonce");
      return hexlify(concat([header, zeroPadValue(toBeHex(memo.newNonce), 32)]));
    }
    case "replaceFee": {
      assertUint(memo.newFee, 64, "newFee");
      const fee = getBytes(zeroPadValue(toBeHex(memo.newFee), 8));
      return hexlify(concat([header, requireBytes32(memo.targetTransactionId, "targetTransactionId"), fee]));
    }
  }
}

/** Read the 10-byte common header. */
export function decodeHeader(memoHex: string): MemoHeader {
  const bytes = getBytes(memoHex);
  if (bytes.length < HEADER_LENGTH) {
    throw new MemoDecodeError(`memo shorter than header: ${bytes.length}`);
  }
  let fee = 0n;
  for (let i = 2; i < 10; i++) {
    fee = (fee << 8n) | BigInt(bytes[i]);
  }
  return { opcode: bytes[0], walletId: bytes[1], executorFee: fee };
}

function requireLength(actual: number, expected: number, opcode: number): void {
  if (actual !== expected) {
    throw new MemoDecodeError(
      `opcode 0x${opcode.toString(16)} needs exactly ${expected} bytes, got ${actual}`,
    );
  }
}

/** Inverse of {@link encodeMemo}. */
export function decodeMemo(memoHex: string): Memo {
  const bytes = getBytes(memoHex);
  const header = decodeHeader(memoHex);
  const { opcode } = header;

  if ((RESERVED_OPCODES as readonly number[]).includes(opcode)) {
    throw new MemoDecodeError(`opcode 0x${opcode.toString(16)} is reserved`);
  }

  switch (opcode) {
    case Opcode.ExecInline: {
      if (bytes.length <= HEADER_LENGTH) {
        throw new MemoDecodeError("0xFD carries no payload");
      }
      const payload = hexlify(bytes.slice(HEADER_LENGTH));
      return { kind: "execInline", ...header, instruction: decodeInstruction(payload) };
    }
    case Opcode.ExecCommit:
      requireLength(bytes.length, LENGTH_WORD, opcode);
      return { kind: "execCommit", ...header, commitment: hexlify(bytes.slice(HEADER_LENGTH, LENGTH_WORD)) };
    case Opcode.Ignore:
      requireLength(bytes.length, LENGTH_WORD, opcode);
      return {
        kind: "ignore",
        ...header,
        targetTransactionId: hexlify(bytes.slice(HEADER_LENGTH, LENGTH_WORD)),
      };
    case Opcode.SetNonce: {
      requireLength(bytes.length, LENGTH_WORD, opcode);
      return { kind: "setNonce", ...header, newNonce: BigInt(hexlify(bytes.slice(HEADER_LENGTH, LENGTH_WORD))) };
    }
    case Opcode.ReplaceFee: {
      requireLength(bytes.length, LENGTH_WORD_FEE, opcode);
      return {
        kind: "replaceFee",
        ...header,
        targetTransactionId: hexlify(bytes.slice(HEADER_LENGTH, LENGTH_WORD)),
        newFee: BigInt(hexlify(bytes.slice(LENGTH_WORD, LENGTH_WORD_FEE))),
      };
    }
    default:
      throw new MemoDecodeError(`unknown opcode 0x${opcode.toString(16)}`);
  }
}

/** Raw memo bytes as the uppercase hex XRPL expects in MemoData. */
export function toXrplMemoData(memoHex: string): string {
  return memoHex.replace(/^0x/, "").toUpperCase();
}

/** Inverse of {@link toXrplMemoData}. */
export function fromXrplMemoData(memoData: string): string {
  return "0x" + memoData.replace(/^0x/, "").toLowerCase();
}
