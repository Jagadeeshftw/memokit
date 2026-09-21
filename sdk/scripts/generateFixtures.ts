/**
 * Generates `fixtures/memo-wire.json`, the single source of truth that both the TypeScript
 * codec and the Solidity decoder are tested against.
 *
 * Numeric fields are emitted as 0x-prefixed hex strings because foundry's `vm.parseJsonUint`
 * handles those unambiguously at any width; decimal strings above 2^53 do not survive the
 * round trip through JSON reliably on either side.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, toBeHex, zeroPadValue } from "ethers";
import { encodeInstruction, encodeMemo, commitmentOf } from "../src/memo.js";
import { Opcode, type Instruction, type Memo } from "../src/types.js";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const ZERO_32 = "0x" + "00".repeat(32);

const ACC_A = "0x1111111111111111111111111111111111111111";
const ACC_B = "0x00000000000000000000000000000000000000ff";
const TX_A = "0x" + "ab".repeat(32);
const TX_B = "0x" + "01".repeat(32);

interface FixtureCase {
  name: string;
  memo: string;
  opcode: number;
  walletId: number;
  /** Header bytes 2..9. Reserved: zero on every well-formed case. */
  executorFee: string;
  /** True on the cases that put a non-zero value in the reserved header field. */
  headerFeeReserved: boolean;
  payload: string;
  sender: string;
  nonce: string;
  feeToken: string;
  feeAmount: string;
  callCount: number;
  commitment: string;
  targetTransactionId: string;
  newNonce: string;
  newFee: string;
}

const hex = (v: bigint, bytes: number) => zeroPadValue(toBeHex(v), bytes);

function base(name: string, memo: Memo): FixtureCase {
  return {
    name,
    // The reserved-fee cases are memos the contract rejects; building them needs the escape hatch.
    memo: encodeMemo(memo, { allowReservedFee: true }),
    opcode: memo.opcode,
    walletId: memo.walletId,
    executorFee: hex(memo.executorFee, 8),
    headerFeeReserved: memo.executorFee !== 0n,
    payload: "0x",
    sender: ZERO_ADDR,
    nonce: hex(0n, 32),
    feeToken: ZERO_ADDR,
    feeAmount: hex(0n, 32),
    callCount: 0,
    commitment: ZERO_32,
    targetTransactionId: ZERO_32,
    newNonce: hex(0n, 32),
    newFee: hex(0n, 8),
  };
}

function execInline(name: string, walletId: number, fee: bigint, instruction: Instruction): FixtureCase {
  const memo: Memo = { kind: "execInline", opcode: Opcode.ExecInline, walletId, executorFee: fee, instruction };
  const payload = encodeInstruction(instruction);
  return {
    ...base(name, memo),
    payload,
    sender: instruction.sender,
    nonce: hex(instruction.nonce, 32),
    feeToken: instruction.feeToken,
    feeAmount: hex(instruction.feeAmount, 32),
    callCount: instruction.calls.length,
    commitment: keccak256(payload),
  };
}

function execCommit(name: string, walletId: number, fee: bigint, instruction: Instruction): FixtureCase {
  const commitment = commitmentOf(instruction);
  const memo: Memo = { kind: "execCommit", opcode: Opcode.ExecCommit, walletId, executorFee: fee, commitment };
  return {
    ...base(name, memo),
    payload: encodeInstruction(instruction),
    sender: instruction.sender,
    nonce: hex(instruction.nonce, 32),
    feeToken: instruction.feeToken,
    feeAmount: hex(instruction.feeAmount, 32),
    callCount: instruction.calls.length,
    commitment,
  };
}

const FEE_TOKEN = "0x0b6A3645c240605887a5532109323A3E12273dc7"; // FTestXRP on Coston2

/** No fee: token is the zero address and the amount is zero. */
const oneCall: Instruction = {
  sender: ACC_A,
  nonce: 0n,
  feeToken: ZERO_ADDR,
  feeAmount: 0n,
  calls: [{ target: "0x2222222222222222222222222222222222222222", value: 0n, data: "0xdeadbeef" }],
};

/** A fee in the token the calls move -- the case the design exists for. */
const twoCalls: Instruction = {
  sender: ACC_B,
  nonce: 1n,
  feeToken: FEE_TOKEN,
  feeAmount: 250_000n,
  calls: [
    { target: "0x3333333333333333333333333333333333333333", value: 0n, data: "0x095ea7b3" + "00".repeat(64) },
    { target: "0x4444444444444444444444444444444444444444", value: 12345n, data: "0x6e553f65" },
  ],
};

/** The extremes: a nonce near the top of uint256 and the largest representable fee. */
const emptyData: Instruction = {
  sender: ACC_A,
  nonce: (1n << 255n) + 7n,
  feeToken: FEE_TOKEN,
  feeAmount: (1n << 256n) - 1n,
  calls: [{ target: "0x5555555555555555555555555555555555555555", value: (1n << 128n) - 1n, data: "0x" }],
};

/** A fee token named but a zero amount: the token must be ignored, not required to be zero. */
const manyCalls: Instruction = {
  sender: ACC_A,
  nonce: 4096n,
  feeToken: "0x9999999999999999999999999999999999999999",
  feeAmount: 0n,
  calls: Array.from({ length: 8 }, (_, i) => ({
    target: "0x" + (i + 1).toString(16).padStart(40, "0"),
    value: BigInt(i),
    data: "0x" + "ff".repeat(i * 3),
  })),
};

const MAX_U64 = (1n << 64n) - 1n;

const cases: FixtureCase[] = [
  execInline("execInline/one-call/no-fee", 0, 0n, oneCall),
  execInline("execInline/two-calls/fee-in-moved-asset", 7, 0n, twoCalls),
  execInline("execInline/empty-calldata/max-fee-and-nonce", 255, 0n, emptyData),
  execInline("execInline/eight-calls/token-named-amount-zero", 1, 0n, manyCalls),
  execCommit("execCommit/one-call/no-fee", 0, 0n, oneCall),
  execCommit("execCommit/two-calls/fee-in-moved-asset", 7, 0n, twoCalls),
  execCommit("execCommit/eight-calls/token-named-amount-zero", 42, 0n, manyCalls),
  // The header field is reserved. These are the memos a Flare wallet would build if it put its
  // fee where Flare does; the contract must reject them, and the codec must still read them.
  execCommit("execCommit/reserved-header-fee", 1, 250_000n, twoCalls),
  execInline("execInline/reserved-header-fee-max", 1, MAX_U64, oneCall),
  {
    ...base("ignore/tx-a", {
      kind: "ignore",
      opcode: Opcode.Ignore,
      walletId: 3,
      executorFee: 0n,
      targetTransactionId: TX_A,
    }),
    targetTransactionId: TX_A,
  },
  {
    ...base("setNonce/small", {
      kind: "setNonce",
      opcode: Opcode.SetNonce,
      walletId: 0,
      executorFee: 0n,
      newNonce: 5n,
    }),
    newNonce: hex(5n, 32),
  },
  {
    ...base("setNonce/uint32-jump", {
      kind: "setNonce",
      opcode: Opcode.SetNonce,
      walletId: 9,
      executorFee: 0n,
      newNonce: 4_294_967_295n,
    }),
    newNonce: hex(4_294_967_295n, 32),
  },
  {
    ...base("replaceFee/lower-to-zero", {
      kind: "replaceFee",
      opcode: Opcode.ReplaceFee,
      walletId: 2,
      executorFee: 0n,
      targetTransactionId: TX_B,
      newFee: 0n,
    }),
    targetTransactionId: TX_B,
    newFee: hex(0n, 8),
  },
  {
    ...base("replaceFee/raise-to-max", {
      kind: "replaceFee",
      opcode: Opcode.ReplaceFee,
      walletId: 200,
      executorFee: 0n,
      targetTransactionId: TX_A,
      newFee: MAX_U64,
    }),
    targetTransactionId: TX_A,
    newFee: hex(MAX_U64, 8),
  },
];

const out = { version: 2, count: cases.length, cases };
const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, "../../fixtures/memo-wire.json");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${cases.length} cases to ${target}`);
