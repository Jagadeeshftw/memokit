/**
 * The reuse check decides whether to spend 20 FLR on mainnet. What it must get right: find an
 * identical request anywhere in the window, never mistake a different one for it, and never
 * start the window late.
 */
import { describe, it, expect } from "vitest";
import { AbiCoder } from "ethers";
import {
  findIdenticalRequest,
  firstBlockAtOrAfter,
  ATTESTATION_REQUEST_TOPIC,
  type RequestLogSource,
} from "../src/fdc/requestLog.js";

const coder = AbiCoder.defaultAbiCoder();
const OURS = "0x" + "5061796d656e74".padEnd(64, "0") + "74657374585250".padEnd(64, "0") + "ab".repeat(32) + "cd".repeat(32);
const log = (request: string, block: number, tx: string, fee = 1000n) => ({
  data: coder.encode(["bytes", "uint256"], [request, fee]),
  transactionHash: tx,
  blockNumber: block,
});

/** Blocks 1000..1100, one per 2 s from t=10_000; logs placed by the test. */
function chain(logs: ReturnType<typeof log>[], calls: Array<[number, number]> = []): RequestLogSource {
  return {
    head: async () => 1100,
    timestampOf: async (b) => 10_000 + (b - 1000) * 2,
    logs: async (from, to) => {
      calls.push([from, to]);
      return logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to);
    },
  };
}

describe("findIdenticalRequest", () => {
  it("finds an identical request and reports its block", async () => {
    const r = await findIdenticalRequest({
      source: chain([log(OURS, 1050, "0xtheirs")]),
      abiEncodedRequest: OURS,
      sinceUnixSeconds: 10_000,
    });
    expect(r.found).toEqual({ txHash: "0xtheirs", blockNumber: 1050, feeWei: 1000n });
  });

  it("returns the EARLIEST copy, because its round is the one to reuse", async () => {
    const r = await findIdenticalRequest({
      source: chain([log(OURS, 1080, "0xlater"), log(OURS, 1020, "0xfirst"), log(OURS, 1021, "0xsecond")]),
      abiEncodedRequest: OURS,
      sinceUnixSeconds: 10_000,
      pageSize: 100,
    });
    expect(r.found?.txHash).toBe("0xfirst");
  });

  it("does not match a different request, even one that contains ours as a prefix", async () => {
    const longer = OURS + "ee".repeat(32);
    const other = OURS.slice(0, -2) + "00";
    const r = await findIdenticalRequest({
      source: chain([log(longer, 1030, "0xlonger"), log(other, 1031, "0xother")]),
      abiEncodedRequest: OURS,
      sinceUnixSeconds: 10_000,
    });
    expect(r.found).toBeNull();
  });

  it("matches regardless of hex case", async () => {
    const r = await findIdenticalRequest({
      source: chain([log(OURS, 1040, "0xtheirs")]),
      abiEncodedRequest: OURS.toUpperCase().replace("0X", "0x"),
      sinceUnixSeconds: 10_000,
    });
    expect(r.found?.txHash).toBe("0xtheirs");
  });

  it("ignores requests made before the payment could have been requested", async () => {
    // t=10_100 is block 1050; a copy at 1049 predates the window.
    const r = await findIdenticalRequest({
      source: chain([log(OURS, 1049, "0xtooearly")]),
      abiEncodedRequest: OURS,
      sinceUnixSeconds: 10_100,
    });
    expect(r.found).toBeNull();
    expect(r.searched.fromBlock).toBe(1050);
  });

  it("pages the whole window with no gaps and no overlaps, in 30-block pages by default", async () => {
    const calls: Array<[number, number]> = [];
    const r = await findIdenticalRequest({ source: chain([], calls), abiEncodedRequest: OURS, sinceUnixSeconds: 10_000 });
    expect(r.found).toBeNull();
    expect(r.searched).toEqual({ fromBlock: 1000, toBlock: 1100 });
    expect(calls[0][0]).toBe(1000);
    expect(calls.at(-1)![1]).toBe(1100);
    for (let i = 1; i < calls.length; i++) expect(calls[i][0]).toBe(calls[i - 1][1] + 1);
    for (const [a, b] of calls) expect(b - a + 1).toBeLessThanOrEqual(30);
  });
});

describe("firstBlockAtOrAfter", () => {
  it("finds the exact first block at or after a timestamp", async () => {
    const src = chain([]);
    expect(await firstBlockAtOrAfter(src, 10_000)).toBe(1000);
    expect(await firstBlockAtOrAfter(src, 10_001)).toBe(1001);
    expect(await firstBlockAtOrAfter(src, 10_100)).toBe(1050);
  });

  it("returns the head when the timestamp is in the future", async () => {
    expect(await firstBlockAtOrAfter(chain([]), 99_999)).toBe(1100);
  });
});

describe("the event topic", () => {
  it("is the one FdcHub actually emits", () => {
    // Read from a live Coston2 FdcHub log (run 1's request, 0xc56f5fde…).
    expect(ATTESTATION_REQUEST_TOPIC).toBe("0x251377668af6553101c9bb094ba89c0c536783e005e203625e6cd57345918cc9");
  });
});
