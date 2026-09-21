import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAddress, hexlify, randomBytes, keccak256 } from "ethers";
import {
  encodeMemo,
  decodeMemo,
  encodeInstruction,
  decodeInstruction,
  commitmentOf,
  toXrplMemoData,
  fromXrplMemoData,
  MemoEncodeError,
  MemoDecodeError,
  decodeFtsoBound,
} from "../src/memo.js";
import {
  PostConditionKind,
  ZERO_ADDRESS,
  MAX_POST_CONDITIONS,
  type PostCondition,
  Opcode,
  RESERVED_OPCODES,
  FSA_OPCODES,
  HEADER_LENGTH,
  LENGTH_WORD,
  LENGTH_WORD_FEE,
  XRPL_MEMO_BUDGET_BYTES,
  type Instruction,
  type Memo,
} from "../src/types.js";
import {
  erc20BalanceAtLeast,
  ftsoRateAtLeast,
  feedId,
} from "../src/postConditions.js";

const byteLength = (hex: string) => (hex.length - 2) / 2;

// --- arbitraries -----------------------------------------------------------------------

const addressArb = fc
  .uint8Array({ minLength: 20, maxLength: 20 })
  .map((b) => getAddress(hexlify(b)));
const u256Arb = fc.bigUint({ max: (1n << 256n) - 1n });
const u64Arb = fc.bigUint({ max: (1n << 64n) - 1n });
const byteArb = fc.integer({ min: 0, max: 255 });
const bytes32Arb = fc.uint8Array({ minLength: 32, maxLength: 32 }).map(hexlify);
const dataArb = fc.uint8Array({ minLength: 0, maxLength: 64 }).map(hexlify);

const callArb = fc.record({ target: addressArb, value: u256Arb, data: dataArb });
/** Simple post-conditions: the kinds with no `extra`. */
const simpleConditionArb: fc.Arbitrary<PostCondition> = fc
  .tuple(
    fc.constantFrom(
      PostConditionKind.Erc20BalanceAtLeast,
      PostConditionKind.Erc20DeltaAtLeast,
      PostConditionKind.NativeBalanceAtLeast,
      PostConditionKind.NativeDeltaAtLeast,
    ),
    addressArb,
    addressArb,
    u256Arb,
  )
  .map(([kind, token, subject, threshold]) => {
    const native =
      kind === PostConditionKind.NativeBalanceAtLeast ||
      kind === PostConditionKind.NativeDeltaAtLeast;
    return { kind, token: native ? ZERO_ADDRESS : token, subject, threshold, extra: "0x" };
  });

const instructionArb: fc.Arbitrary<Instruction> = fc.record({
  sender: addressArb,
  nonce: u256Arb,
  feeToken: addressArb,
  feeAmount: u256Arb,
  calls: fc.array(callArb, { minLength: 1, maxLength: 5 }),
  postConditions: fc.array(simpleConditionArb, { maxLength: 4 }),
});

/**
 * The header executorFee is reserved and `encodeMemo` refuses a non-zero one. The arbitraries
 * still generate them, because the codec must round-trip the field faithfully (a memo from a
 * Flare wallet arrives with it set, and has to be decodable in order to be recovered).
 */
const RESERVED_OK = { allowReservedFee: true } as const;

const memoArb: fc.Arbitrary<Memo> = fc.oneof(
  fc.record({
    kind: fc.constant("execInline" as const),
    opcode: fc.constant(Opcode.ExecInline),
    walletId: byteArb,
    executorFee: u64Arb,
    instruction: instructionArb,
  }),
  fc.record({
    kind: fc.constant("execCommit" as const),
    opcode: fc.constant(Opcode.ExecCommit),
    walletId: byteArb,
    executorFee: u64Arb,
    commitment: bytes32Arb,
  }),
  fc.record({
    kind: fc.constant("ignore" as const),
    opcode: fc.constant(Opcode.Ignore),
    walletId: byteArb,
    executorFee: u64Arb,
    targetTransactionId: bytes32Arb,
  }),
  fc.record({
    kind: fc.constant("setNonce" as const),
    opcode: fc.constant(Opcode.SetNonce),
    walletId: byteArb,
    executorFee: u64Arb,
    newNonce: u256Arb,
  }),
  fc.record({
    kind: fc.constant("nonceAtLeast" as const),
    opcode: fc.constant(Opcode.NonceAtLeast),
    walletId: byteArb,
    executorFee: u64Arb,
    targetNonce: u256Arb,
  }),
  fc.record({
    kind: fc.constant("replaceFee" as const),
    opcode: fc.constant(Opcode.ReplaceFee),
    walletId: byteArb,
    executorFee: u64Arb,
    targetTransactionId: bytes32Arb,
    newFee: u64Arb,
  }),
);

// --- round trip ------------------------------------------------------------------------

describe("memo round trip", () => {
  it("decode(encode(memo)) === memo, for every opcode", () => {
    fc.assert(
      fc.property(memoArb, (memo) => {
        const decoded = decodeMemo(encodeMemo(memo, RESERVED_OK));
        expect(decoded).toEqual(memo);
      }),
      { numRuns: 500 },
    );
  });

  it("decodeInstruction(encodeInstruction(x)) === x", () => {
    fc.assert(
      fc.property(instructionArb, (instruction) => {
        expect(decodeInstruction(encodeInstruction(instruction))).toEqual(instruction);
      }),
      { numRuns: 500 },
    );
  });

  it("encoding is deterministic", () => {
    fc.assert(
      fc.property(memoArb, (memo) => {
        expect(encodeMemo(memo, RESERVED_OK)).toEqual(encodeMemo(memo, RESERVED_OK));
      }),
      { numRuns: 200 },
    );
  });

  it("XRPL MemoData hex survives the round trip", () => {
    fc.assert(
      fc.property(memoArb, (memo) => {
        const encoded = encodeMemo(memo, RESERVED_OK);
        expect(fromXrplMemoData(toXrplMemoData(encoded))).toEqual(encoded);
      }),
      { numRuns: 200 },
    );
  });
});

// --- header layout ---------------------------------------------------------------------

describe("header layout", () => {
  it("is exactly 10 bytes: opcode, walletId, uint64 BE fee field", () => {
    const memo = encodeMemo(
      {
        kind: "ignore",
        opcode: Opcode.Ignore,
        walletId: 0xab,
        executorFee: 0x0102030405060708n,
        targetTransactionId: "0x" + "cd".repeat(32),
      },
      RESERVED_OK,
    );
    expect(memo.slice(0, 2 + HEADER_LENGTH * 2)).toEqual("0xe0ab0102030405060708");
  });

  it("the field is big-endian", () => {
    const memo = encodeMemo(
      {
        kind: "ignore",
        opcode: Opcode.Ignore,
        walletId: 0,
        executorFee: 1n,
        targetTransactionId: "0x" + "00".repeat(32),
      },
      RESERVED_OK,
    );
    expect(memo.slice(2, 22)).toEqual("e000" + "0000000000000001");
  });

  it("is byte-identical to Flare's with the reserved field zero: same length, same offsets", () => {
    const memo = encodeMemo({
      kind: "execCommit",
      opcode: Opcode.ExecCommit,
      walletId: 7,
      executorFee: 0n,
      commitment: "0x" + "11".repeat(32),
    });
    // opcode | walletId | 8 zero bytes | 32-byte commitment: Flare's 0xFE with one byte changed.
    expect(memo).toEqual("0xfc07" + "00".repeat(8) + "11".repeat(32));
    expect(byteLength(memo)).toEqual(42);
  });
});

// --- the executor fee lives in the payload -----------------------------------------------

describe("executor fee", () => {
  const memoWithHeaderFee = (executorFee: bigint): Memo => ({
    kind: "execCommit",
    opcode: Opcode.ExecCommit,
    walletId: 1,
    executorFee,
    commitment: "0x" + "22".repeat(32),
  });

  it("encodeMemo refuses a non-zero header fee unless told otherwise", () => {
    expect(() => encodeMemo(memoWithHeaderFee(1n))).toThrow(MemoEncodeError);
    expect(() => encodeMemo(memoWithHeaderFee(1n))).toThrow(/reserved/);
    expect(() => encodeMemo(memoWithHeaderFee(0n))).not.toThrow();
    expect(() => encodeMemo(memoWithHeaderFee(1n), RESERVED_OK)).not.toThrow();
  });

  it("the payload round-trips its fee token and amount, including the extremes", () => {
    const base: Instruction = {
      sender: "0x1111111111111111111111111111111111111111",
      nonce: 0n,
      feeToken: "0x0b6A3645c240605887a5532109323A3E12273dc7",
      feeAmount: 0n,
      calls: [{ target: "0x2222222222222222222222222222222222222222", value: 0n, data: "0x" }],
    };
    for (const feeAmount of [0n, 1n, 250_000n, (1n << 128n) - 1n, (1n << 256n) - 1n]) {
      const i = { ...base, feeAmount, postConditions: [] };
      expect(decodeInstruction(encodeInstruction(i))).toEqual(i);
    }
  });

  it("rejects a fee amount above uint256", () => {
    expect(() =>
      encodeInstruction({
        sender: "0x1111111111111111111111111111111111111111",
        nonce: 0n,
        feeToken: "0x2222222222222222222222222222222222222222",
        feeAmount: 1n << 256n,
        calls: [],
      }),
    ).toThrow(MemoEncodeError);
  });

  it("the commitment binds the fee token and the fee amount separately", () => {
    const i: Instruction = {
      sender: "0x1111111111111111111111111111111111111111",
      nonce: 3n,
      feeToken: "0x0b6A3645c240605887a5532109323A3E12273dc7",
      feeAmount: 1_000n,
      calls: [{ target: "0x2222222222222222222222222222222222222222", value: 0n, data: "0xdeadbeef" }],
    };
    const c = commitmentOf(i);
    // An executor who could change either half would be able to redirect or inflate its own pay.
    expect(commitmentOf({ ...i, feeAmount: 1_001n })).not.toEqual(c);
    expect(commitmentOf({ ...i, feeToken: "0x3333333333333333333333333333333333333333" })).not.toEqual(c);
    expect(commitmentOf({ ...i })).toEqual(c);
  });
});

// --- exact lengths ---------------------------------------------------------------------

describe("fixed-length opcodes", () => {
  const cases: Array<[string, Memo, number]> = [
    [
      "execCommit",
      {
        kind: "execCommit",
        opcode: Opcode.ExecCommit,
        walletId: 1,
        executorFee: 0n,
        commitment: "0x" + "11".repeat(32),
      },
      LENGTH_WORD,
    ],
    [
      "ignore",
      {
        kind: "ignore",
        opcode: Opcode.Ignore,
        walletId: 1,
        executorFee: 0n,
        targetTransactionId: "0x" + "22".repeat(32),
      },
      LENGTH_WORD,
    ],
    [
      "setNonce",
      { kind: "setNonce", opcode: Opcode.SetNonce, walletId: 1, executorFee: 0n, newNonce: 3n },
      LENGTH_WORD,
    ],
    [
      "replaceFee",
      {
        kind: "replaceFee",
        opcode: Opcode.ReplaceFee,
        walletId: 1,
        executorFee: 0n,
        targetTransactionId: "0x" + "33".repeat(32),
        newFee: 9n,
      },
      LENGTH_WORD_FEE,
    ],
  ];

  it.each(cases)("%s encodes to exactly %o bytes", (_name, memo, expected) => {
    expect(byteLength(encodeMemo(memo))).toEqual(expected);
  });

  it("rejects a truncated fixed-length memo", () => {
    const good = encodeMemo({
      kind: "execCommit",
      opcode: Opcode.ExecCommit,
      walletId: 1,
      executorFee: 0n,
      commitment: "0x" + "11".repeat(32),
    });
    expect(() => decodeMemo(good.slice(0, good.length - 2))).toThrow(MemoDecodeError);
  });

  it("rejects an over-long fixed-length memo", () => {
    const good = encodeMemo({
      kind: "setNonce",
      opcode: Opcode.SetNonce,
      walletId: 1,
      executorFee: 0n,
      newNonce: 3n,
    });
    expect(() => decodeMemo(good + "00")).toThrow(MemoDecodeError);
  });
});

// --- opcode discipline -----------------------------------------------------------------

describe("opcode discipline", () => {
  it.each(RESERVED_OPCODES)("refuses to encode reserved opcode 0x%s", (opcode) => {
    expect(() =>
      encodeMemo({
        kind: "ignore",
        opcode,
        walletId: 0,
        executorFee: 0n,
        targetTransactionId: "0x" + "00".repeat(32),
      } as unknown as Memo),
    ).toThrow(MemoEncodeError);
  });

  it.each(RESERVED_OPCODES)("refuses to decode reserved opcode 0x%s", (opcode) => {
    const memo = "0x" + opcode.toString(16).padStart(2, "0") + "00".repeat(HEADER_LENGTH - 1 + 32);
    expect(() => decodeMemo(memo)).toThrow(MemoDecodeError);
  });

  it.each(FSA_OPCODES)("does not claim FSA opcode 0x%s", (opcode) => {
    const memo = "0x" + opcode.toString(16).padStart(2, "0") + "00".repeat(HEADER_LENGTH - 1 + 32);
    expect(() => decodeMemo(memo)).toThrow(MemoDecodeError);
  });

  it("rejects a memo shorter than the header", () => {
    expect(() => decodeMemo("0xfd0000")).toThrow(MemoDecodeError);
  });

  it("rejects 0xFD with no payload", () => {
    expect(() => decodeMemo("0xfd" + "00".repeat(HEADER_LENGTH - 1))).toThrow(MemoDecodeError);
  });
});

// --- range checks ----------------------------------------------------------------------

describe("range checks", () => {
  it("rejects a header fee above uint64, even when reserved fees are allowed", () => {
    expect(() =>
      encodeMemo(
        {
          kind: "ignore",
          opcode: Opcode.Ignore,
          walletId: 0,
          executorFee: 1n << 64n,
          targetTransactionId: "0x" + "00".repeat(32),
        },
        RESERVED_OK,
      ),
    ).toThrow(MemoEncodeError);
  });

  it("rejects a walletId above uint8", () => {
    expect(() =>
      encodeMemo({
        kind: "ignore",
        opcode: Opcode.Ignore,
        walletId: 256,
        executorFee: 0n,
        targetTransactionId: "0x" + "00".repeat(32),
      }),
    ).toThrow(MemoEncodeError);
  });

  it("rejects a commitment that is not 32 bytes", () => {
    expect(() =>
      encodeMemo({
        kind: "execCommit",
        opcode: Opcode.ExecCommit,
        walletId: 0,
        executorFee: 0n,
        commitment: "0x1234",
      }),
    ).toThrow(MemoEncodeError);
  });
});

// --- commitment ------------------------------------------------------------------------

describe("commitment", () => {
  it("binds every field of the instruction", () => {
    fc.assert(
      fc.property(instructionArb, instructionArb, (a, b) => {
        fc.pre(JSON.stringify(a, bigintReplacer) !== JSON.stringify(b, bigintReplacer));
        expect(commitmentOf(a)).not.toEqual(commitmentOf(b));
      }),
      { numRuns: 300 },
    );
  });
});

function bigintReplacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}

// --- XRPL budget -----------------------------------------------------------------------

describe("XRPL memo budget", () => {
  it("0xFC always fits, whatever the instruction", () => {
    fc.assert(
      fc.property(instructionArb, (instruction) => {
        const memo = encodeMemo({
          kind: "execCommit",
          opcode: Opcode.ExecCommit,
          walletId: 0,
          executorFee: 0n,
          commitment: commitmentOf(instruction),
        });
        expect(byteLength(memo)).toEqual(LENGTH_WORD);
      }),
      { numRuns: 100 },
    );
  });

  it("0xFD overruns the XRPL budget for a large enough instruction", () => {
    const big: Instruction = {
      sender: getAddress(hexlify(randomBytes(20))),
      nonce: 0n,
      feeToken: getAddress(hexlify(randomBytes(20))),
      feeAmount: 0n,
      calls: [{ target: getAddress(hexlify(randomBytes(20))), value: 0n, data: hexlify(randomBytes(1200)) }],
    };
    const memo = encodeMemo({
      kind: "execInline",
      opcode: Opcode.ExecInline,
      walletId: 0,
      executorFee: 0n,
      instruction: big,
    });
    expect(byteLength(memo)).toBeGreaterThan(XRPL_MEMO_BUDGET_BYTES);
  });
});

// --- golden fixtures -------------------------------------------------------------------

describe("golden fixtures", () => {
  const path = resolve(import.meta.dirname, "../../fixtures/memo-wire.json");
  const fixture = JSON.parse(readFileSync(path, "utf8"));

  it("every case decodes to the recorded fields", () => {
    for (const c of fixture.cases) {
      const decoded = decodeMemo(c.memo);
      expect(decoded.opcode, c.name).toEqual(c.opcode);
      expect(decoded.walletId, c.name).toEqual(c.walletId);
      expect(decoded.executorFee, c.name).toEqual(BigInt(c.executorFee));
    }
  });

  it("every case re-encodes byte-identically", () => {
    for (const c of fixture.cases) {
      expect(encodeMemo(decodeMemo(c.memo), RESERVED_OK), c.name).toEqual(c.memo);
    }
  });

  it("a case encodes without the escape hatch exactly when its header fee is zero", () => {
    let reserved = 0;
    for (const c of fixture.cases) {
      const decoded = decodeMemo(c.memo);
      if (c.headerFeeReserved) {
        reserved++;
        expect(BigInt(c.executorFee), c.name).toBeGreaterThan(0n);
        expect(() => encodeMemo(decoded), c.name).toThrow(MemoEncodeError);
      } else {
        expect(BigInt(c.executorFee), c.name).toEqual(0n);
        expect(encodeMemo(decoded), c.name).toEqual(c.memo);
      }
    }
    expect(reserved, "the fixtures must include memos the contract rejects").toBeGreaterThan(0);
  });

  it("recorded commitments match the recorded payloads", () => {
    for (const c of fixture.cases) {
      if (c.payload === "0x") continue;
      const instruction = decodeInstruction(c.payload);
      expect(commitmentOf(instruction), c.name).toEqual(c.commitment);
      expect(instruction.sender, c.name).toEqual(getAddress(c.sender));
      expect(instruction.nonce, c.name).toEqual(BigInt(c.nonce));
      expect(instruction.feeToken, c.name).toEqual(getAddress(c.feeToken));
      expect(instruction.feeAmount, c.name).toEqual(BigInt(c.feeAmount));
      expect(instruction.calls.length, c.name).toEqual(c.callCount);
    }
  });
});


// --- payload versioning -----------------------------------------------------------------

describe("payload versioning", () => {
  it("puts the version in byte 0 of the payload, never in the header", () => {
    const payload = encodeInstruction({
      sender: ZERO_ADDRESS.replace(/0$/, "1"),
      nonce: 0n,
      feeToken: ZERO_ADDRESS,
      feeAmount: 0n,
      calls: [{ target: ZERO_ADDRESS.replace(/0$/, "2"), value: 0n, data: "0x" }],
    });
    expect(payload.slice(0, 4)).toEqual("0x02");

    // The header is untouched by versioning: opcode, walletId, reserved fee.
    const memo = encodeMemo({
      kind: "execCommit",
      opcode: Opcode.ExecCommit,
      walletId: 1,
      executorFee: 0n,
      commitment: keccak256(payload),
    });
    expect(memo.slice(0, 22)).toEqual("0xfc01" + "00".repeat(8));
  });

  it("omitting postConditions is the same as an empty list", () => {
    const base = {
      sender: ZERO_ADDRESS.replace(/0$/, "1"),
      nonce: 0n,
      feeToken: ZERO_ADDRESS,
      feeAmount: 0n,
      calls: [{ target: ZERO_ADDRESS.replace(/0$/, "2"), value: 0n, data: "0x" }],
    };
    expect(encodeInstruction(base)).toEqual(encodeInstruction({ ...base, postConditions: [] }));
    expect(decodeInstruction(encodeInstruction(base)).postConditions).toEqual([]);
  });

  /**
   * The v1 vectors are Phase 1/2 payloads. Every one begins with the zero byte of a
   * left-padded address, which is why version 0 is a reliable marker for "this is v1" rather
   * than a coincidence. Both sides reject them, and the message says so in words.
   */
  it("rejects every frozen v1 payload, naming it as v1", () => {
    const v1 = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../fixtures/memo-wire-v1.json"), "utf8"),
    );
    let checked = 0;
    for (const c of v1.cases) {
      if (c.payload === "0x") continue;
      expect(c.payload.slice(0, 4), c.name).toEqual("0x00");
      expect(() => decodeInstruction(c.payload), c.name).toThrow(/version 0.*v1/);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("rejects any unknown version explicitly", () => {
    const good = encodeInstruction({
      sender: ZERO_ADDRESS.replace(/0$/, "1"),
      nonce: 0n,
      feeToken: ZERO_ADDRESS,
      feeAmount: 0n,
      calls: [{ target: ZERO_ADDRESS.replace(/0$/, "2"), value: 0n, data: "0x" }],
    });
    for (const v of [1, 3, 0x7f, 0xff]) {
      const tampered = "0x" + v.toString(16).padStart(2, "0") + good.slice(4);
      expect(() => decodeInstruction(tampered)).toThrow(/version/);
    }
  });

  it("rejects an empty payload", () => {
    expect(() => decodeInstruction("0x")).toThrow(/empty/);
  });
});

// --- post-conditions --------------------------------------------------------------------

describe("post-conditions", () => {
  const acct = "0x1111111111111111111111111111111111111111";
  const token = "0x2222222222222222222222222222222222222222";

  const withConditions = (postConditions: PostCondition[]) => ({
    sender: acct,
    nonce: 0n,
    feeToken: ZERO_ADDRESS,
    feeAmount: 0n,
    calls: [{ target: token, value: 0n, data: "0x" }],
    postConditions,
  });

  it("round-trips every kind", () => {
    fc.assert(
      fc.property(fc.array(simpleConditionArb, { maxLength: 6 }), (conds) => {
        const decoded = decodeInstruction(encodeInstruction(withConditions(conds)));
        expect(decoded.postConditions).toEqual(conds);
      }),
      { numRuns: 200 },
    );
  });

  it("round-trips an FTSO bound through extra", () => {
    const bound = {
      feedIdIn: feedId("XRP/USD"),
      feedIdOut: feedId("USDT/USD"),
      decimalsIn: 6,
      decimalsOut: 18,
      amountIn: 5_000_000n,
      maxDeviationBps: 150,
      maxFeedAgeSeconds: 300n,
    };
    const c = ftsoRateAtLeast(token, acct, bound);
    const decoded = decodeInstruction(encodeInstruction(withConditions([c])));
    expect(decodeFtsoBound(decoded.postConditions![0].extra!)).toEqual(bound);
  });

  it("builds the documented feed ids", () => {
    // Category byte 0x01 (crypto), then the ASCII name, zero-padded to 21 bytes.
    expect(feedId("FLR/USD")).toEqual("0x01464c522f55534400000000000000000000000000");
    expect(feedId("XRP/USD")).toEqual("0x015852502f55534400000000000000000000000000");
  });

  it("changes the commitment, so an executor cannot strip one", () => {
    const without = commitmentOf(withConditions([]));
    const withOne = commitmentOf(withConditions([erc20BalanceAtLeast(token, acct, 1n)]));
    expect(withOne).not.toEqual(without);
  });

  it("refuses a native condition that names a token", () => {
    expect(() =>
      encodeInstruction(
        withConditions([
          { kind: PostConditionKind.NativeBalanceAtLeast, token, subject: acct, threshold: 1n, extra: "0x" },
        ]),
      ),
    ).toThrow(/native kinds/);
  });

  it("refuses a token condition with no token", () => {
    expect(() =>
      encodeInstruction(
        withConditions([erc20BalanceAtLeast(ZERO_ADDRESS, acct, 1n)]),
      ),
    ).toThrow(/token address/);
  });

  it("refuses an FTSO condition with no bound, and extra on any other kind", () => {
    expect(() =>
      encodeInstruction(
        withConditions([
          { kind: PostConditionKind.FtsoRateAtLeast, token, subject: acct, threshold: 0n, extra: "0x" },
        ]),
      ),
    ).toThrow(/FtsoBound/);
    expect(() =>
      encodeInstruction(
        withConditions([{ ...erc20BalanceAtLeast(token, acct, 1n), extra: "0xdead" }]),
      ),
    ).toThrow(/only FtsoRateAtLeast/);
  });

  it("refuses more conditions than the contract will evaluate", () => {
    const tooMany = Array.from({ length: MAX_POST_CONDITIONS + 1 }, () =>
      erc20BalanceAtLeast(token, acct, 1n),
    );
    expect(() => encodeInstruction(withConditions(tooMany))).toThrow(/cap of 32/);
    expect(() =>
      encodeInstruction(withConditions(tooMany.slice(0, MAX_POST_CONDITIONS))),
    ).not.toThrow();
  });

  it("refuses a deviation of 100% or more, which would assert nothing", () => {
    expect(() =>
      ftsoRateAtLeast(token, acct, {
        feedIdIn: feedId("XRP/USD"),
        feedIdOut: feedId("USDT/USD"),
        decimalsIn: 6,
        decimalsOut: 6,
        amountIn: 1n,
        maxDeviationBps: 10_000,
        maxFeedAgeSeconds: 60n,
      }),
    ).toThrow(/below 10000/);
  });
});
