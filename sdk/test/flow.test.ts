import { describe, it, expect, vi, afterEach } from "vitest";
import { keccak256, ZeroAddress } from "ethers";
import {
  prepareInstruction,
  decodeMemo,
  encodeInstruction,
  commitmentOf,
  fetchXrplTransaction,
  toTransactionId,
  deadlineFromNow,
  DEFAULT_DEADLINE_SECONDS,
  COSTON2,
  FLARE,
  Opcode,
  type Instruction,
} from "../src/index.js";

const instruction: Instruction = {
  sender: "0x1111111111111111111111111111111111111111",
  nonce: 3n,
  feeToken: "0x2222222222222222222222222222222222222222",
  feeAmount: 100_000n,
  calls: [{ target: "0x3333333333333333333333333333333333333333", value: 0n, data: "0xdeadbeef" }],
};

describe("prepareInstruction", () => {
  it("commits the memo to the keccak of the payload it returns", () => {
    const p = prepareInstruction(instruction);
    expect(p.commitment).toBe(keccak256(p.payload));
    expect(p.payload).toBe(encodeInstruction(instruction));
    expect(p.commitment).toBe(commitmentOf(instruction));
    const memo = decodeMemo(p.memo);
    expect(memo.kind).toBe("execCommit");
    expect(memo.opcode).toBe(Opcode.ExecCommit);
    if (memo.kind !== "execCommit") throw new Error("unreachable");
    expect(memo.commitment).toBe(p.commitment);
    expect(memo.executorFee).toBe(0n);
  });

  it("is 42 bytes however large the instruction", () => {
    const big: Instruction = {
      ...instruction,
      calls: Array.from({ length: 40 }, () => instruction.calls[0]),
    };
    expect((prepareInstruction(big).memo.length - 2) / 2).toBe(42);
  });

  it("changes the commitment when the fee changes, so an executor cannot alter it", () => {
    const a = prepareInstruction(instruction).commitment;
    expect(prepareInstruction({ ...instruction, feeAmount: 100_001n }).commitment).not.toBe(a);
    expect(prepareInstruction({ ...instruction, feeToken: ZeroAddress }).commitment).not.toBe(a);
  });
});

describe("deadline", () => {
  it("defaults to 900 s, well above the measured 152-162 s", () => {
    expect(DEFAULT_DEADLINE_SECONDS).toBe(900);
    expect(DEFAULT_DEADLINE_SECONDS).toBeGreaterThan(162 * 3);
  });
  it("adds to the given clock", () => {
    expect(deadlineFromNow(60, 1_000_000_000_000)).toBe(1_000_000_060);
    expect(deadlineFromNow(undefined, 0)).toBe(900);
  });
});

describe("networks", () => {
  it("pair each Flare network with the right XRPL network and source id", () => {
    expect(COSTON2.sourceId).toBe("testXRP");
    expect(FLARE.sourceId).toBe("XRP");
    expect(COSTON2.contractRegistry).toBe(FLARE.contractRegistry);
  });
});

describe("fetchXrplTransaction", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the merged transaction once validated, retrying while it propagates", async () => {
    const replies = [
      { result: { error: "txnNotFound" } },
      { result: { validated: false, Account: "rX" } },
      { result: { validated: true, Account: "rX", tx_json: { Destination: "rY" }, ledger_index: 7 } },
    ];
    const fetchMock = vi.fn(async () => ({ json: async () => replies.shift() }));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    const p = fetchXrplTransaction("ABC", COSTON2, 5);
    await vi.runAllTimersAsync();
    const tx = await p;
    vi.useRealTimers();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(tx).toMatchObject({ Account: "rX", Destination: "rY", ledger_index: 7 });
  });

  it("gives up with the last thing the server said", async () => {
    vi.stubGlobal("fetch", async () => ({ json: async () => ({ result: { error: "txnNotFound" } }) }));
    vi.useFakeTimers();
    const p = fetchXrplTransaction("ABC", COSTON2, 2).catch((e: Error) => e);
    await vi.runAllTimersAsync();
    const err = await p;
    vi.useRealTimers();
    expect((err as Error).message).toMatch(/not validated.*txnNotFound/);
  });
});

describe("toTransactionId", () => {
  it("lowercases and prefixes, as FDC keys XRPL transactions", () => {
    expect(toTransactionId("ABCDEF")).toBe("0xabcdef");
    expect(toTransactionId("0xABCDEF")).toBe("0xabcdef");
  });
});
