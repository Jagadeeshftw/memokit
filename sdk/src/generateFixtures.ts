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
import { encodeInstruction, encodeMemo, commitmentOf } from "./memo.js";
import { Opcode, type Instruction, type Memo } from "./types.js";

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
  executorFee: string;
  payload: string;
  sender: string;
  nonce: string;
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
    memo: encodeMemo(memo),
    opcode: memo.opcode,
    walletId: memo.walletId,
    executorFee: hex(memo.executorFee, 8),
    payload: "0x",
    sender: ZERO_ADDR,
    nonce: hex(0n, 32),
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
    callCount: instruction.calls.length,
    commitment,
  };
}

const oneCall: Instruction = {
  sender: ACC_A,
  nonce: 0n,
  calls: [{ target: "0x2222222222222222222222222222222222222222", value: 0n, data: "0xdeadbeef" }],
};

const twoCalls: Instruction = {
  sender: ACC_B,
  nonce: 1n,
  calls: [
    { target: "0x3333333333333333333333333333333333333333", value: 0n, data: "0x095ea7b3" + "00".repeat(64) },
    { target: "0x4444444444444444444444444444444444444444", value: 12345n, data: "0x6e553f65" },
  ],
};

const emptyData: Instruction = {
  sender: ACC_A,
  nonce: (1n << 255n) + 7n,
  calls: [{ target: "0x5555555555555555555555555555555555555555", value: (1n << 128n) - 1n, data: "0x" }],
};

const manyCalls: Instruction = {
  sender: ACC_A,
  nonce: 4096n,
  calls: Array.from({ length: 8 }, (_, i) => ({
    target: "0x" + (i + 1).toString(16).padStart(40, "0"),
    value: BigInt(i),
    data: "0x" + "ff".repeat(i * 3),
  })),
};

const MAX_U64 = (1n << 64n) - 1n;

const cases: FixtureCase[] = [
  execInline("execInline/one-call/zero-fee", 0, 0n, oneCall),
  execInline("execInline/two-calls/mid-fee", 7, 250_000n, twoCalls),
  execInline("execInline/empty-calldata/max-nonce-ish", 255, MAX_U64, emptyData),
  execInline("execInline/eight-calls", 1, 1n, manyCalls),
  execCommit("execCommit/one-call/zero-fee", 0, 0n, oneCall),
  execCommit("execCommit/two-calls/mid-fee", 7, 250_000n, twoCalls),
  execCommit("execCommit/eight-calls/max-fee", 42, MAX_U64, manyCalls),
  {
    ...base("ignore/tx-a", {
      kind: "ignore",
      opcode: Opcode.Ignore,
      walletId: 3,
      executorFee: 99n,
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
      executorFee: 1000n,
      newNonce: 4_294_967_295n,
    }),
    newNonce: hex(4_294_967_295n, 32),
  },
  {
    ...base("replaceFee/lower-to-zero", {
      kind: "replaceFee",
      opcode: Opcode.ReplaceFee,
      walletId: 2,
      executorFee: 500n,
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
      executorFee: MAX_U64,
      targetTransactionId: TX_A,
      newFee: MAX_U64,
    }),
    targetTransactionId: TX_A,
    newFee: hex(MAX_U64, 8),
  },
];

const out = { version: 1, count: cases.length, cases };
const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, "../../fixtures/memo-wire.json");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${cases.length} cases to ${target}`);
