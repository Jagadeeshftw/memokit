/**
 * "Where is my instruction?", answered over HTTP.
 *
 * The state machine is **the Phase 3 classifier**, not a second implementation of it. That is
 * a correctness decision, not a tidiness one: two state machines over the same facts drift,
 * and the one users read would drift away from the one that decides what to do. So the
 * classifier decides the state and this module does two things it cannot -- it translates the
 * verdict into the vocabulary the API publishes, and it adds the timestamps, which only a
 * service that was watching at the time can know.
 *
 * It answers for instructions this service never touched, too. The classifier only needs the
 * chain and the ledger; the store only adds detail.
 */
import { JsonRpcProvider } from "ethers";
import {
  classifyPayments,
  fetchIncomingPayments,
  RESCUE_STATES,
  type ClassifiedPayment,
  type InstructionState,
  type Network,
} from "@memokit/sdk";
import { DaLayerClient } from "@memokit/sdk/fdc";
import { rebuildRequest, findProofNearClose } from "./attestation.js";
import type { Store, TrackedState, Transition } from "./store.js";

/** The published vocabulary. One term per place an instruction can be. */
export type StatusState = TrackedState;

/**
 * Classifier verdict to published state.
 *
 * `seen` splits on a fact the classifier cannot see: whether anybody has paid for an
 * attestation yet. That is in the store, so the mapping takes it as an argument rather than
 * guessing.
 */
export function toStatusState(
  classified: InstructionState,
  hasAttestationRequest: boolean,
): StatusState {
  switch (classified) {
    case "executed":
      return "executed";
    case "retired":
      return "rescued";
    case "awaiting-attestation":
      return hasAttestationRequest ? "attesting" : "seen";
    case "attested-not-executed":
      return "proved";
    case "execution-failed":
      return "failed";
    case "expired":
      return "stuck";
    case "not-an-instruction":
      return "skipped";
  }
}

export interface StatusResponse {
  xrplHash: string;
  transactionId: string;
  /** The published state. */
  state: StatusState;
  /** True when nothing further can change it. */
  final: boolean;
  /** The classifier's own verdict and reasoning, unmapped. */
  classifier: {
    state: InstructionState;
    reason: string;
    loss: string;
    rescue: ClassifiedPayment["rescue"];
  };
  xrplOwner: string;
  account: string | null;
  /** Seconds until the proof validity window closes; negative once it has. */
  validitySecondsRemaining: number;
  /**
   * When each state was entered, oldest first.
   *
   * Only an instruction this service worked from the start has a complete set. For anything
   * else the timestamps say when a state was first *observed*, which is not the same thing --
   * `transitionsComplete` says which kind you are holding, and `note` says it in words.
   */
  transitions: Transition[];
  /** False when the timestamps are observations rather than a record of the transitions. */
  transitionsComplete: boolean;
  /** Present when there is something about this answer the caller should not assume away. */
  note?: string;
  /** Seconds spent in each state so far, so the ~150 s attestation wait is visible. */
  elapsed: Record<string, number>;
  attestation?: { txHash: string; votingRoundId: number; at: number };
  execution?: { txHash: string; blockNumber: number; byUs: boolean; at: number };
  /** Set when the service declined to work it, with the policy's reason. */
  skipReason?: string;
  lastError?: { at: number; stage: string; message: string };
  observedByThisService: boolean;
}

export interface StatusDeps {
  network: Network;
  controller: string;
  provider: JsonRpcProvider;
  store: Store;
  da: DaLayerClient;
  receivers(): Promise<string[]>;
  now?(): number;
}

export class NotFound extends Error {}

/** Resolve one XRPL hash to its position in the state machine. */
export async function statusOf(xrplHash: string, deps: StatusDeps): Promise<StatusResponse> {
  const normalised = xrplHash.replace(/^0x/, "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(normalised)) {
    throw new NotFound(`"${xrplHash}" is not an XRPL transaction hash`);
  }
  const transactionId = "0x" + normalised.toLowerCase();
  const tracked = deps.store.get(transactionId);

  // The store is a cache of what this service saw. If it did not see it, go to the ledger.
  let record = tracked
    ? {
        hash: normalised,
        ledgerIndex: tracked.ledgerIndex,
        closedAt: tracked.closedAt,
        destination: tracked.receivingAddress,
        memo: tracked.memo,
        sender: tracked.xrplOwner,
      }
    : null;

  if (!record) {
    const receivers = await deps.receivers();
    for (const receiver of receivers) {
      const payments = await fetchIncomingPayments({
        network: deps.network,
        receivingAddress: receiver,
        limit: 200,
      });
      const hit = payments.find((p) => p.hash.toUpperCase() === normalised);
      if (hit) {
        record = { ...hit, sender: hit.sender ?? "" };
        break;
      }
    }
  }
  if (!record || !record.sender) {
    throw new NotFound(
      `no payment ${normalised} to a memokit receiving address. If it was sent recently it may ` +
        `not be validated yet; if it was sent long ago it may be past the window this API reads.`,
    );
  }

  const [classified] = await classifyPayments([record], {
    network: deps.network,
    controller: deps.controller,
    provider: deps.provider,
    xrplOwner: record.sender,
    hasProof: async (_id, closedAt) => hasProof(normalised, closedAt, deps),
    payloadFor: () => undefined,
  });

  const state = toStatusState(classified.state, tracked?.attestation !== undefined);

  // The chain is the authority, not the store. A service running read-only, or one that was
  // started after the fact, has a store that lags -- and reporting its own stale view over the
  // chain's would be the one thing this endpoint must never do. So the classifier's verdict
  // wins, the observation is recorded, and the answer says the timestamps are observations.
  let transitionsComplete = true;
  if (tracked && tracked.state !== state) {
    deps.store.update(
      tracked.transactionId,
      { state },
      "observed on chain; this service did not perform the transition",
    );
    transitionsComplete = false;
  } else if (!tracked) {
    transitionsComplete = false;
  }

  const transitions: Transition[] = deps.store.get(transactionId)?.transitions ?? [
    { state: "seen", at: record.closedAt * 1000, note: "XRPL close; this service was not watching" },
  ];

  return {
    xrplHash: normalised,
    transactionId,
    state,
    final: RESCUE_STATES[classified.state].final,
    classifier: {
      state: classified.state,
      reason: classified.reason,
      loss: RESCUE_STATES[classified.state].loss,
      rescue: classified.rescue,
    },
    xrplOwner: record.sender,
    account: tracked?.account ?? null,
    validitySecondsRemaining: classified.validitySecondsRemaining,
    transitions,
    transitionsComplete,
    ...(transitionsComplete
      ? {}
      : {
          note:
            "This service did not work this instruction from the start, so the timestamps are " +
            "when each state was first observed, not when it was entered. The state itself is " +
            "read from the chain and is exact.",
        }),
    elapsed: elapsedByState(transitions, deps.now?.() ?? Date.now()),
    ...(tracked?.attestation
      ? { attestation: { txHash: tracked.attestation.txHash, votingRoundId: tracked.attestation.votingRoundId, at: tracked.attestation.at } }
      : {}),
    ...(tracked?.execution ? { execution: tracked.execution } : {}),
    ...(tracked?.skipReason ? { skipReason: tracked.skipReason } : {}),
    ...(tracked?.lastError ? { lastError: tracked.lastError } : {}),
    observedByThisService: tracked !== undefined,
  };
}

/**
 * Seconds spent in each state.
 *
 * The point of the whole endpoint: "attesting: 104" is what makes a two and a half minute
 * wait legible instead of looking like a hang.
 */
export function elapsedByState(transitions: Transition[], now: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < transitions.length; i++) {
    const from = transitions[i];
    const until = transitions[i + 1]?.at ?? now;
    out[from.state] = (out[from.state] ?? 0) + Math.max(0, Math.round((until - from.at) / 1000));
  }
  return out;
}

/**
 * Does a proof exist for this payment?
 *
 * Bounded, and the classifier knows it: a `false` means "no proof in the scanned window", and
 * the classifier reports that rather than asserting absence. A thrown rate limit is caught
 * here and answered as `false` for the same reason -- the honest fallback is "cannot see one",
 * not "there is none".
 */
async function hasProof(xrplHash: string, closedAt: number, deps: StatusDeps): Promise<boolean> {
  try {
    const rebuilt = await rebuildRequest(xrplHash, deps.network);
    if (!rebuilt) return false;
    const found = await findProofNearClose({
      abiEncodedRequest: rebuilt.abiEncodedRequest,
      closedAt,
      network: deps.network,
      provider: deps.provider,
      da: deps.da,
    });
    return found !== null;
  } catch {
    return false;
  }
}
