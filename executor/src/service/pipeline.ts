/**
 * One instruction, one step at a time.
 *
 * The pipeline is written as "advance this instruction by one stage and return", rather than
 * as a routine that follows one instruction from XRPL to Flare. Two reasons, both learned from
 * the measurements:
 *
 *   - the slow leg is FDC's voting round, about 100 s, and blocking on it means a second
 *     instruction that arrived a second later waits for the first one's round for no reason;
 *   - a restart mid-instruction is the normal case, not the exceptional one, for a service
 *     that gets redeployed. A state machine persisted after every stage resumes; a call stack
 *     does not.
 *
 * Every stage is safe to run twice. The chain enforces that far more strongly than this code
 * does -- an XRPL transaction id is consumable exactly once -- so the worst a repeat costs is
 * a wasted fee, never a duplicate execution.
 */
import type { JsonRpcProvider } from "ethers";
import {
  controllerInterface,
  decodeMemo,
  decodeInstruction,
  fromXrplMemoData,
  type Network,
} from "@memokit/sdk";
import { DaLayerClient, decodeResponseHex, toProofTuple } from "@memokit/sdk/fdc";
import { rebuildRequest, findProofNearClose } from "./attestation.js";
import type { Logger } from "./log.js";
import type { Metrics } from "./metrics.js";
import type { Store, TrackedInstruction } from "./store.js";
import { evaluate, RESCUE_OPCODES, type FeePolicyConfig } from "./feePolicy.js";
import type { ExecutorChain } from "./chain.js";
import { backoffMs, TokenBucket } from "./rateLimit.js";

export interface PipelineDeps {
  network: Network;
  provider: JsonRpcProvider;
  chain: ExecutorChain;
  store: Store;
  policy: FeePolicyConfig;
  da: DaLayerClient;
  bucket: TokenBucket;
  log: Logger;
  metrics: Metrics;
  maxAttempts: number;
  dryRun: boolean;
  /** The committed preimage for a `0xFC` memo, if the operator has been given one. */
  payloadFor(transactionId: string): string | undefined;
  /**
   * Is there already a proof somebody else paid for?
   *
   * Injectable because the default rebuilds the attestation request from the live ledger and
   * searches the DA Layer, which a test of the state machine has no business doing.
   */
  findExistingProof?(
    instruction: TrackedInstruction,
  ): Promise<{ votingRoundId: number; abiEncodedRequest: string } | null>;
  /** Injected so tests can drive the clock. */
  now?(): number;
}

/**
 * What losing a race actually costs, in the two places it can be lost.
 *
 * Executors are not coordinated and there is nothing to coordinate with: the proof becomes
 * available to everyone in the same instant, and the first `execute` to be mined consumes the
 * transaction id. So racing is the normal case and losing is an ordinary outcome.
 *
 * Losing is cheap *if the simulation is done first*, which is the whole reason the pipeline
 * does one before every submission.
 */
export const RACE_COST = {
  /** Detected before submitting. The common case. */
  beforeSubmit:
    "lost the race before submitting: the winner's execute had already consumed the " +
    "transaction id when we simulated. Cost is the attestation fee if we were the one who " +
    "paid it, and nothing else -- a simulation is free and no transaction was sent.",
  /** The winner was mined between our simulation and our submission. */
  afterSubmit:
    "lost the race after submitting: the winner was mined in between, so our execute " +
    "reverted. Cost is the gas of a reverted transaction plus the attestation fee if we paid " +
    "it. This is the expensive way to lose, and it is the one the simulation cannot prevent: " +
    "the window is the time between the eth_call and the block our transaction lands in.",
} as const;

/** Kept as the name the logs used before the two cases were told apart. */
export const RACE_COST_NOTE = RACE_COST.beforeSubmit;

export async function advance(instruction: TrackedInstruction, deps: PipelineDeps): Promise<void> {
  const now = deps.now?.() ?? Date.now();
  const log = deps.log.child({ txid: instruction.transactionId, state: instruction.state });

  try {
    switch (instruction.state) {
      case "seen":
        await triage(instruction, deps, log);
        return;
      case "attesting":
      case "proved":
      case "failed":
        await deliver(instruction, deps, log, now);
        return;
      default:
        return;
    }
  } catch (error) {
    const message = (error as Error).message ?? String(error);
    const attempts = instruction.attempts + 1;
    const giveUp = attempts >= deps.maxAttempts;
    deps.metrics.inc("memokit_executor_errors_total", { stage: instruction.state });
    deps.store.update(
      instruction.transactionId,
      {
        attempts,
        lastError: { at: now, stage: instruction.state, message: message.slice(0, 500) },
        nextAttemptAt: now + backoffMs(attempts),
        ...(giveUp ? { state: "stuck" as const } : {}),
      },
      giveUp ? `gave up after ${attempts} attempts: ${message.slice(0, 200)}` : undefined,
    );
    log[giveUp ? "error" : "warn"](giveUp ? "giving up" : "stage failed, will retry", {
      attempts,
      error: message.slice(0, 300),
    });
  }
}

/**
 * Decide whether the instruction is ours to work, and start it if so.
 *
 * The order here is chosen so that the cheapest disqualification happens first: decoding a
 * memo costs nothing, reading the chain costs a call, and requesting an attestation costs
 * real money.
 */
async function triage(instruction: TrackedInstruction, deps: PipelineDeps, log: Logger): Promise<void> {
  const memo = instruction.memo ? fromXrplMemoData(instruction.memo) : null;
  let opcode: number | null = null;
  let fee: { token: string; amount: bigint } | null = null;

  if (memo) {
    try {
      const decoded = decodeMemo(memo);
      opcode = decoded.opcode;
      const payload = payloadOf(decoded, memo, deps, instruction.transactionId);
      if (payload) {
        const { feeToken, feeAmount } = decodeInstruction(payload);
        fee = { token: feeToken, amount: feeAmount };
      }
    } catch (e) {
      log.debug("memo did not decode", { error: (e as Error).message });
    }
  }

  const verdict = evaluate(deps.policy, opcode, fee);
  if (!verdict.work) {
    // "wait" is the one refusal that is not final: a preimage may still turn up.
    const waiting = deps.policy.unknownPayload === "wait" && verdict.reason.includes("not supplied yet");
    deps.metrics.inc("memokit_executor_declined_total", { reason: waiting ? "awaiting-preimage" : "policy" });
    if (waiting) {
      deps.store.update(instruction.transactionId, {
        opcode,
        nextAttemptAt: Date.now() + 60_000,
      });
      log.debug("waiting for a preimage");
      return;
    }
    deps.store.update(instruction.transactionId, { opcode, state: "skipped", skipReason: verdict.reason }, verdict.reason);
    log.info("declined", { reason: verdict.reason, opcode });
    return;
  }

  if (await deps.chain.isConsumed(instruction.transactionId)) {
    deps.metrics.inc("memokit_executor_races_total", { outcome: "lost-before-start" });
    deps.store.update(
      instruction.transactionId,
      { opcode, state: "executed", execution: { txHash: "", blockNumber: 0, byUs: false, at: Date.now() } },
      "already executed by someone else before this service looked at it",
    );
    log.info("already executed elsewhere", { note: RACE_COST_NOTE });
    return;
  }

  const account = await deps.chain.accountFor(instruction.xrplOwner);

  // Somebody may already have requested the attestation -- another executor, or this service
  // before a restart that lost its state. The request bytes are deterministic, so the DA Layer
  // can be asked before paying for a duplicate.
  const existing = deps.findExistingProof
    ? await deps.findExistingProof(instruction)
    : await findExistingProof(instruction, deps);
  if (existing) {
    deps.metrics.inc("memokit_executor_attestations_reused_total");
    deps.store.update(
      instruction.transactionId,
      {
        opcode,
        account,
        state: "proved",
        attestation: {
          txHash: "",
          votingRoundId: existing.votingRoundId,
          abiEncodedRequest: existing.abiEncodedRequest,
          feeWei: "0",
          at: Date.now(),
        },
      },
      "a proof already existed; no attestation fee paid",
    );
    log.info("proof already available, someone else paid for it", { round: existing.votingRoundId });
    return;
  }

  if (deps.dryRun) {
    log.info("DRY RUN: would request an attestation", { account, fee: verdict.feeAmount?.toString() });
    deps.store.update(instruction.transactionId, { opcode, account, nextAttemptAt: Date.now() + 60_000 });
    return;
  }

  const request = await deps.chain.requestAttestation(instruction.xrplHash);
  deps.metrics.inc("memokit_executor_attestations_requested_total");
  deps.store.update(
    instruction.transactionId,
    {
      opcode,
      account,
      state: "attesting",
      attestation: {
        txHash: request.txHash,
        votingRoundId: request.votingRoundId,
        abiEncodedRequest: request.abiEncodedRequest,
        feeWei: request.feeWei.toString(),
        at: Date.now(),
      },
      nextAttemptAt: Date.now() + 60_000,
    },
    `attestation requested in round ${request.votingRoundId}`,
  );
  log.info("attestation requested", {
    round: request.votingRoundId,
    feeWei: request.feeWei.toString(),
    tx: request.txHash,
  });
}

/** Fetch the proof if it is ready, then simulate and submit. */
async function deliver(
  instruction: TrackedInstruction,
  deps: PipelineDeps,
  log: Logger,
  now: number,
): Promise<void> {
  if (!instruction.attestation) {
    // Nothing to poll for: fall back to triage, which will request or find one.
    deps.store.update(instruction.transactionId, { state: "seen" }, "no attestation on record");
    return;
  }

  await deps.bucket.acquire();
  const { status, body } = await deps.da.proofByRequestRound(
    instruction.attestation.votingRoundId,
    instruction.attestation.abiEncodedRequest,
  );
  if (status === 429) {
    deps.metrics.inc("memokit_executor_rate_limited_total", { service: "da-layer" });
    deps.store.update(instruction.transactionId, { nextAttemptAt: now + backoffMs(instruction.attempts + 1) });
    log.warn("DA Layer rate limited");
    return;
  }
  if (status !== 200 || !("proof" in body)) {
    deps.store.update(instruction.transactionId, { nextAttemptAt: now + 30_000 });
    log.debug("proof not ready", { status, round: instruction.attestation.votingRoundId });
    return;
  }

  if (instruction.state !== "proved") {
    instruction = deps.store.update(instruction.transactionId, { state: "proved" }, "proof available");
    deps.metrics.inc("memokit_executor_proofs_total");
  }

  const response = decodeResponseHex(body.response_hex);
  const proof = toProofTuple(body.proof, response);
  const payload = executePayload(instruction, deps);
  if (payload === null) {
    deps.store.update(instruction.transactionId, { state: "skipped", skipReason: "preimage no longer available" });
    return;
  }

  // Simulate first, always. It is free, and it is the difference between losing a race for
  // nothing and losing a race for the gas of a reverting transaction.
  try {
    await deps.chain.simulate(proof, payload);
  } catch (error) {
    const lost = isAlreadyUsed(error);
    if (lost) {
      deps.metrics.inc("memokit_executor_races_total", { outcome: "lost-before-submit" });
      deps.store.update(
        instruction.transactionId,
        { state: "executed", execution: { txHash: "", blockNumber: 0, byUs: false, at: now } },
        RACE_COST.beforeSubmit,
      );
      log.info("lost the race", { where: "before-submit", note: RACE_COST.beforeSubmit });
      return;
    }
    throw new Error(`simulation reverted: ${describeRevert(error)}`);
  }

  if (deps.dryRun) {
    log.info("DRY RUN: simulation passed, not submitting");
    deps.store.update(instruction.transactionId, { nextAttemptAt: now + 60_000 });
    return;
  }

  let receipt;
  try {
    receipt = await deps.chain.execute(proof, payload);
  } catch (error) {
    // The other way to lose: somebody else's execute was mined between our simulation and our
    // transaction. Ours reverts, and the gas is spent. Still not an error -- the instruction
    // ran, which is the point -- but it is the expensive kind of losing, counted separately so
    // an operator can see whether they are consistently arriving second.
    if (isAlreadyUsed(error)) {
      deps.metrics.inc("memokit_executor_races_total", { outcome: "lost-after-submit" });
      deps.store.update(
        instruction.transactionId,
        { state: "executed", execution: { txHash: "", blockNumber: 0, byUs: false, at: now } },
        RACE_COST.afterSubmit,
      );
      log.info("lost the race", { where: "after-submit", note: RACE_COST.afterSubmit });
      return;
    }
    throw new Error(`execute reverted on chain: ${describeRevert(error)}`);
  }

  deps.metrics.inc("memokit_executor_executions_total", { by: "us" });
  deps.metrics.inc("memokit_executor_races_total", { outcome: "won" });
  deps.store.update(
    instruction.transactionId,
    {
      state: "executed",
      execution: {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        byUs: true,
        gasUsed: receipt.gasUsed.toString(),
        at: now,
      },
    },
    `executed in block ${receipt.blockNumber}`,
  );
  log.info("executed", { tx: receipt.hash, block: receipt.blockNumber, gasUsed: receipt.gasUsed.toString() });
}

// --- helpers ----------------------------------------------------------------------------

/** The bytes `execute` takes as `_data`: the payload, or empty for a management opcode. */
function executePayload(instruction: TrackedInstruction, deps: PipelineDeps): string | null {
  if (instruction.opcode !== null && RESCUE_OPCODES.has(instruction.opcode)) return "0x";
  const memo = instruction.memo ? fromXrplMemoData(instruction.memo) : null;
  if (!memo) return null;
  const decoded = decodeMemo(memo);
  return payloadOf(decoded, memo, deps, instruction.transactionId) ?? null;
}

function payloadOf(
  decoded: { kind: string; opcode: number },
  memo: string,
  deps: PipelineDeps,
  transactionId: string,
): string | undefined {
  if (decoded.opcode === 0xfd) return "0x" + memo.replace(/^0x/, "").slice(20);
  if (decoded.opcode === 0xfc) return deps.payloadFor(transactionId);
  return undefined;
}

/**
 * Is there already a proof for this payment, without paying for a request?
 *
 * Another executor may have requested it, or this service may have, before a restart that lost
 * its state. See {@link rebuildRequest} for why the bytes can be reconstructed at all.
 */
async function findExistingProof(
  instruction: TrackedInstruction,
  deps: PipelineDeps,
): Promise<{ votingRoundId: number; abiEncodedRequest: string } | null> {
  const rebuilt = await rebuildRequest(instruction.xrplHash, deps.network);
  if (!rebuilt) return null;
  const found = await findProofNearClose({
    abiEncodedRequest: rebuilt.abiEncodedRequest,
    closedAt: instruction.closedAt,
    network: deps.network,
    provider: deps.provider,
    da: deps.da,
    gate: () => deps.bucket.acquire(),
  });
  return found ? { votingRoundId: found.votingRoundId, abiEncodedRequest: rebuilt.abiEncodedRequest } : null;
}

/**
 * Did this revert because somebody else got there first?
 *
 * `TransactionAlreadyUsed(bytes32)` is the controller's replay guard, and it is the only
 * revert that means "this worked, just not by us". Everything else is a real failure and must
 * not be swallowed as a lost race, or a broken instruction would look like a busy market.
 */
export function isAlreadyUsed(error: unknown): boolean {
  const data = revertData(error);
  if (!data) return false;
  return data.toLowerCase().startsWith(ALREADY_USED_SELECTOR);
}

/** `keccak256("TransactionAlreadyUsed(bytes32)")[0:4]`, checked against the ABI at load. */
const ALREADY_USED_SELECTOR = controllerInterface.getError("TransactionAlreadyUsed")!.selector;

function revertData(error: unknown): string | null {
  const e = error as { data?: unknown; info?: { error?: { data?: unknown } }; error?: { data?: unknown } };
  const candidates = [e?.data, e?.info?.error?.data, e?.error?.data];
  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("0x") && c.length >= 10) return c;
  }
  return null;
}

/** A revert as something an operator can read, falling back to the raw data. */
export function describeRevert(error: unknown): string {
  const data = revertData(error);
  if (!data) return ((error as Error).message ?? String(error)).slice(0, 300);
  try {
    const parsed = controllerInterface.parseError(data);
    if (parsed) return `${parsed.name}(${parsed.args.map(String).join(", ")})`;
  } catch {
    /* not a controller error; fall through to the raw selector */
  }
  return `unrecognised revert ${data.slice(0, 74)}`;
}
