/**
 * The pipeline's fakes, shared by every test that drives `advance` for real: a store on a temp
 * file, a chain that records what was called, and a DA Layer whose proof can be withheld.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, encodeBytes32String, ZeroAddress } from "ethers";
import { encodeResponse } from "@memokit/sdk/fdc";
import { prepareInstruction, encodeMemo, Opcode, toXrplMemoData, COSTON2 } from "@memokit/sdk";
import { Store, type TrackedInstruction } from "../src/service/store.js";
import type { PipelineDeps } from "../src/service/pipeline.js";
import { Metrics } from "../src/service/metrics.js";
import { createLogger } from "../src/service/log.js";
import { TokenBucket } from "../src/service/rateLimit.js";
import type { ExecutorChain } from "../src/service/chain.js";

export const CONTROLLER = "0x0E762EAe8fe53e5247C22E5B52feD7A018150714";
export const ACCOUNT = "0x9dD656e6FE2f9B46E57CE29265b3C66feCa2d741";
export const FXRP = "0x0b6A3645c240605887a5532109323A3E12273dc7";
export const OWNER = "rpnDcUjasCYome3WntkxqQ3gG4wuLXM4WE";

/** A real inline instruction, so the pipeline decodes a real memo rather than a stub. */
export function inlineInstruction(feeAmount: bigint) {
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


export interface Harness {
  deps: PipelineDeps;
  store: Store;
  statePath: string;
  metrics: Metrics;
  chain: ExecutorChain & { calls: string[] };
  proofReady: { value: boolean };
  seed(memoData: string | null): TrackedInstruction;
}

export function harness(over: Partial<ExecutorChain> = {}, policyOver = {}): Harness {
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
    nonceOf: async () => 0n,
    isRoundFinalized: async () => false,
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
export const RESPONSE_HEX = encodeResponse({
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

