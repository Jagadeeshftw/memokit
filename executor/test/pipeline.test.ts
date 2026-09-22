/**
 * The executor's state machine, driven through every outcome that costs somebody money.
 *
 * All of it runs against fakes, deliberately. The interesting cases -- another executor wins
 * between the simulation and the block, a restart in the middle of an attestation, a proof
 * somebody else already paid for -- cannot be arranged on a live network on demand, and a test
 * that waits 150 s for a voting round is a test nobody runs.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, encodeBytes32String, ZeroAddress } from "ethers";
import { encodeResponse } from "@memokit/sdk/fdc";
import { prepareInstruction, encodeMemo, Opcode, toXrplMemoData, controllerInterface } from "@memokit/sdk";
import { Store, type TrackedInstruction } from "../src/service/store.js";
import { advance, isAlreadyUsed, describeRevert, RACE_COST, type PipelineDeps } from "../src/service/pipeline.js";
import { Metrics } from "../src/service/metrics.js";
import { createLogger } from "../src/service/log.js";
import { TokenBucket } from "../src/service/rateLimit.js";
import type { ExecutorChain } from "../src/service/chain.js";
import { COSTON2 } from "@memokit/sdk";

const CONTROLLER = "0x0E762EAe8fe53e5247C22E5B52feD7A018150714";
const ACCOUNT = "0x9dD656e6FE2f9B46E57CE29265b3C66feCa2d741";
const FXRP = "0x0b6A3645c240605887a5532109323A3E12273dc7";
const OWNER = "rpnDcUjasCYome3WntkxqQ3gG4wuLXM4WE";

/** A real inline instruction, so the pipeline decodes a real memo rather than a stub. */
function inlineInstruction(feeAmount: bigint) {
  const instruction = {
    sender: ACCOUNT,
    nonce: 0n,
    feeToken: FXRP,
    feeAmount,
    calls: [{ target: FXRP, value: 0n, data: "0x" }],
  };
  const { payload } = prepareInstruction(instruction);
  const memo = encodeMemo({
    kind: "execInline",
    opcode: Opcode.ExecInline,
    walletId: 1,
    executorFee: 0n,
    instruction,
  });
  return { payload, memo, memoData: toXrplMemoData(memo) };
}

function revert(name: string, args: unknown[]): Error & { data: string } {
  const error = new Error("execution reverted") as Error & { data: string };
  error.data = controllerInterface.encodeErrorResult(name, args);
  return error;
}

interface Harness {
  deps: PipelineDeps;
  store: Store;
  statePath: string;
  metrics: Metrics;
  chain: ExecutorChain & { calls: string[] };
  proofReady: { value: boolean };
  seed(memoData: string | null): TrackedInstruction;
}

function harness(over: Partial<ExecutorChain> = {}, policyOver = {}): Harness {
  const statePath = join(mkdtempSync(join(tmpdir(), "memokit-pipe-")), "state.json");
  const store = new Store(statePath, CONTROLLER);
  const metrics = new Metrics();
  const calls: string[] = [];
  const proofReady = { value: true };

  const chain = {
    calls,
    isConsumed: async () => {
      calls.push("isConsumed");
      return false;
    },
    accountFor: async () => ACCOUNT,
    simulate: async () => {
      calls.push("simulate");
    },
    execute: async () => {
      calls.push("execute");
      return { hash: "0xdeadbeef", blockNumber: 42, gasUsed: 123_456n };
    },
    requestAttestation: async () => {
      calls.push("requestAttestation");
      return { txHash: "0xreq", votingRoundId: 900, abiEncodedRequest: "0xabi", feeWei: 1000n };
    },
    ...over,
  } as ExecutorChain & { calls: string[] };

  const da = {
    proofByRequestRound: async () =>
      proofReady.value
        ? { status: 200, body: { proof: [], response_hex: RESPONSE_HEX, attestation_type: "Payment" } }
        : { status: 404, body: { error: "not finalised" } },
  };

  const deps: PipelineDeps = {
    network: COSTON2,
    provider: null as never,
    chain,
    store,
    policy: { minimumByToken: { [FXRP.toLowerCase()]: 100_000n }, relayRescues: true, unknownPayload: "wait", ...policyOver },
    da: da as never,
    bucket: new TokenBucket(1000),
    log: createLogger({ level: "error", sink: () => {} }),
    metrics,
    maxAttempts: 3,
    dryRun: false,
    payloadFor: () => undefined,
    findExistingProof: async () => null,
  };

  return {
    deps,
    store,
    statePath,
    metrics,
    chain,
    proofReady,
    seed(memoData) {
      store.observe({
        xrplHash: "A92E0E7CA45E071E641EAD562CFEE04B2C4B839B4BF13A914B19D17B190C3E47",
        transactionId: "0xa92e0e7ca45e071e641ead562cfee04b2c4b839b4bf13a914b19d17b190c3e47",
        xrplOwner: OWNER,
        receivingAddress: "rDfVHUx5SMgw5wwqjvzgFEFCnqW5CCGWyW",
        ledgerIndex: 1,
        closedAt: Math.floor(Date.now() / 1000) - 200,
        memo: memoData,
        opcode: null,
        account: null,
      });
      return store.all()[0];
    },
  };
}

/**
 * A real `abi.encode(Response)`, built with the SDK's own encoder.
 *
 * Hand-rolled filler would be decoded by `decodeResponseHex` before the pipeline ever reached
 * the interesting part, and the test would fail for a reason that has nothing to do with the
 * state machine -- which is exactly what happened when this was a stub.
 */
const RESPONSE_HEX = encodeResponse({
  attestationType: encodeBytes32String("Payment"),
  sourceId: encodeBytes32String("testXRP"),
  votingRound: 900n,
  lowestUsedTimestamp: 1n,
  requestBody: { transactionId: keccak256("0x01"), proofOwner: ZeroAddress },
  responseBody: {
    blockNumber: 1n,
    blockTimestamp: 1n,
    sourceAddress: OWNER,
    sourceAddressHash: keccak256("0x02"),
    receivingAddressHash: keccak256("0x03"),
    intendedReceivingAddressHash: keccak256("0x03"),
    spentAmount: 1_000_012n,
    intendedSpentAmount: 1_000_012n,
    receivedAmount: 1_000_000n,
    intendedReceivedAmount: 1_000_000n,
    hasMemoData: true,
    firstMemoData: "0x00",
    hasDestinationTag: false,
    destinationTag: 0n,
    status: 0,
  },
});

describe("triage", () => {
  it("declines a payment carrying no memo, and stops looking at it", async () => {
    const h = harness();
    await advance(h.seed(null), h.deps);
    const row = h.store.all()[0];
    expect(row.state).toBe("skipped");
    expect(row.skipReason).toBe("no memokit memo");
    expect(h.chain.calls).toEqual([]);
  });

  it("declines a fee below the minimum before spending anything on chain", async () => {
    const h = harness();
    await advance(h.seed(inlineInstruction(1n).memoData), h.deps);
    expect(h.store.all()[0].state).toBe("skipped");
    expect(h.store.all()[0].skipReason).toMatch(/below the 100000 minimum/);
    expect(h.chain.calls).toEqual([]);
  });

  it("requests an attestation for an instruction that pays, and records the round", async () => {
    const h = harness();
    await advance(h.seed(inlineInstruction(200_000n).memoData), h.deps);
    const row = h.store.all()[0];
    expect(row.state).toBe("attesting");
    expect(row.attestation!.votingRoundId).toBe(900);
    expect(row.account).toBe(ACCOUNT);
    expect(h.chain.calls).toContain("requestAttestation");
    expect(h.metrics.value("memokit_executor_attestations_requested_total")).toBe(1);
  });

  it("does not pay for an attestation somebody else already paid for", async () => {
    const h = harness();
    h.deps.findExistingProof = async () => ({ votingRoundId: 871, abiEncodedRequest: "0xreused" });
    await advance(h.seed(inlineInstruction(200_000n).memoData), h.deps);
    const row = h.store.all()[0];
    expect(row.state).toBe("proved");
    expect(row.attestation!.feeWei).toBe("0");
    expect(h.chain.calls).not.toContain("requestAttestation");
    expect(h.metrics.value("memokit_executor_attestations_reused_total")).toBe(1);
  });

  it("stops before paying when the transaction id is already consumed", async () => {
    const h = harness({ isConsumed: async () => true });
    await advance(h.seed(inlineInstruction(200_000n).memoData), h.deps);
    const row = h.store.all()[0];
    expect(row.state).toBe("executed");
    expect(row.execution!.byUs).toBe(false);
    expect(h.chain.calls).not.toContain("requestAttestation");
    expect(h.metrics.value("memokit_executor_races_total", { outcome: "lost-before-start" })).toBe(1);
  });

  it("keeps waiting for a commit memo's preimage rather than discarding the payment", async () => {
    const h = harness();
    const commit = encodeMemo({
      kind: "execCommit",
      opcode: Opcode.ExecCommit,
      walletId: 1,
      executorFee: 0n,
      commitment: keccak256("0x1234"),
    });
    await advance(h.seed(toXrplMemoData(commit)), h.deps);
    const row = h.store.all()[0];
    expect(row.state).toBe("seen");
    expect(row.nextAttemptAt).toBeGreaterThan(Date.now());
  });
});

describe("delivery and racing", () => {
  async function attested(over: Partial<ExecutorChain> = {}) {
    const h = harness(over);
    const instruction = h.seed(inlineInstruction(200_000n).memoData);
    await advance(instruction, h.deps);
    return h;
  }

  it("simulates before submitting, every time", async () => {
    const h = await attested();
    await advance(h.store.all()[0], h.deps);
    expect(h.chain.calls.indexOf("simulate")).toBeLessThan(h.chain.calls.indexOf("execute"));
    expect(h.store.all()[0].state).toBe("executed");
    expect(h.store.all()[0].execution!.byUs).toBe(true);
  });

  it("treats a race lost at simulation as an ordinary outcome, and submits nothing", async () => {
    const h = await attested({
      simulate: async () => {
        throw revert("TransactionAlreadyUsed", [keccak256("0x00")]);
      },
    });
    await advance(h.store.all()[0], h.deps);
    const row = h.store.all()[0];
    expect(row.state).toBe("executed");
    expect(row.execution!.byUs).toBe(false);
    expect(row.lastError).toBeUndefined();
    expect(h.chain.calls).not.toContain("execute");
    expect(h.metrics.value("memokit_executor_races_total", { outcome: "lost-before-submit" })).toBe(1);
    expect(row.transitions.at(-1)!.note).toBe(RACE_COST.beforeSubmit);
  });

  it("counts a race lost after submitting separately, because that one costs gas", async () => {
    const h = await attested({
      execute: async () => {
        throw revert("TransactionAlreadyUsed", [keccak256("0x00")]);
      },
    });
    await advance(h.store.all()[0], h.deps);
    const row = h.store.all()[0];
    expect(row.state).toBe("executed");
    expect(row.execution!.byUs).toBe(false);
    expect(h.metrics.value("memokit_executor_races_total", { outcome: "lost-after-submit" })).toBe(1);
    expect(row.transitions.at(-1)!.note).toBe(RACE_COST.afterSubmit);
  });

  it("retries a genuine revert with backoff, and gives up only after maxAttempts", async () => {
    const h = await attested({
      simulate: async () => {
        throw revert("InvalidNonce", [1n, 0n]);
      },
    });
    for (let i = 0; i < 3; i++) {
      const row = h.store.all()[0];
      await advance({ ...row, nextAttemptAt: 0 }, h.deps);
    }
    const row = h.store.all()[0];
    expect(row.state).toBe("stuck");
    expect(row.attempts).toBe(3);
    expect(row.lastError!.message).toMatch(/InvalidNonce\(1, 0\)/);
  });

  it("waits quietly while the voting round is still open", async () => {
    const h = await attested();
    h.proofReady.value = false;
    await advance(h.store.all()[0], h.deps);
    const row = h.store.all()[0];
    expect(row.state).toBe("attesting");
    expect(h.chain.calls).not.toContain("execute");
  });

  it("resumes from disk after a restart instead of paying for a second attestation", async () => {
    const h = await attested();
    expect(h.store.all()[0].state).toBe("attesting");

    // What a redeploy looks like: the process is gone, only the file survives.
    const restarted = new Store(h.statePath, CONTROLLER);
    const deps = { ...h.deps, store: restarted };
    const row = restarted.pending(Date.now() + 10 * 60_000)[0];
    expect(row.state).toBe("attesting");
    expect(row.attestation!.votingRoundId).toBe(900);

    await advance(row, deps);
    expect(restarted.all()[0].state).toBe("executed");
    expect(h.chain.calls.filter((c) => c === "requestAttestation")).toHaveLength(1);
  });
});

describe("revert decoding", () => {
  it("recognises the replay guard and nothing else as a lost race", () => {
    expect(isAlreadyUsed(revert("TransactionAlreadyUsed", [keccak256("0x00")]))).toBe(true);
    expect(isAlreadyUsed(revert("InvalidNonce", [1n, 0n]))).toBe(false);
    expect(isAlreadyUsed(new Error("connection reset"))).toBe(false);
  });

  it("names a revert instead of printing four bytes", () => {
    expect(describeRevert(revert("PostConditionFailed", [0n, 1, 100n, 99n]))).toBe(
      "PostConditionFailed(0, 1, 100, 99)",
    );
    expect(describeRevert(revert("ContractPaused", []))).toBe("ContractPaused()");
    expect(describeRevert(new Error("boom"))).toBe("boom");
  });
});
