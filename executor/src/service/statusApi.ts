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
import { FINAL, type Store, type TrackedInstruction, type TrackedState, type Transition } from "./store.js";

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
    case "superseded":
      // Can never run, like an expired one: the account's nonce has moved past it.
      return "stuck";
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
  attestation?: { txHash: string; votingRoundId: number; at: number; unservedRounds?: number[] };
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
  /**
   * A non-blocking slice of the DA Layer budget for public lookups.
   *
   * Without this, answering "where is my instruction" spends the same ~20 requests a minute
   * the executor needs to fetch proofs, and enough public traffic starves execution -- the
   * read path taking the write path's resources, in a process that shares both. So lookups
   * get a small, separate allowance and take it without waiting: no token means the proof
   * search is skipped, not queued.
   *
   * Skipping is safe because the classifier already treats a negative as "no proof in the
   * scanned window" rather than "no proof". The answer degrades from "attested, nobody
   * delivered" to "awaiting attestation", which it already knows how to say, and the state
   * read from the chain is unaffected.
   */
  daBudget?: { tryAcquire(): boolean };
  /**
   * True when this process also runs the pipeline, which records its own transitions for
   * everything it tracks. False or absent in read-only mode, where a lookup is the only thing
   * that ever writes a state the chain has reached.
   */
  working?: boolean;
}

export class NotFound extends Error {}

/**
 * What a transition's note says about who moved it. Only the first is a claim that this service
 * did not do the work, so it may only be written when that is true.
 */
export const TRANSITION_NOTES = {
  /** A lookup found the chain ahead, and no pipeline in this process will record the change. */
  notPerformed: "observed on chain; this service did not perform the transition",
  /** A lookup found the chain ahead of a pipeline that is still working it: a moment's lag. */
  notYetRecorded: "on chain; this service has not recorded it yet",
  /**
   * Replaces `notPerformed` on records written before 2026-10-01, where a lookup raced the
   * pipeline and the pipeline then did the work: its own `execution.byUs` says so.
   */
  recordedByLookup: "recorded by a status lookup moments before this service's own record",
  /** Not stored, and closed too long ago to be waiting for the watcher: this service missed it. */
  notWatching: "XRPL close; this service was not watching",
  /** Not stored yet, but recent: the watcher reads the ledger on an interval and will. */
  notPickedUpYet: "XRPL close; this service has not picked it up yet",
} as const;

/**
 * How long after its XRPL close an unstored payment is taken to be waiting for the watcher. The
 * watcher polls every 15 s by default and backfills recent history on start, so five minutes
 * covers a slow poll and a restart without calling a genuinely missed payment "not yet".
 */
export const PICKUP_WINDOW_SECONDS = 300;

/**
 * The transitions as they should be read.
 *
 * Until 2026-10-01 a lookup made while the pipeline was still working an instruction wrote the
 * chain's state with `notPerformed`, and the pipeline's own record of the same state then added
 * no transition, so the false note stayed. Where the record itself proves this service did the
 * work -- it requested the attestation and its own execute landed (`byUs`) -- that note is
 * corrected here, on read, rather than by rewriting the stored history.
 */
export function presentTransitions(tracked: TrackedInstruction): Transition[] {
  const didTheWork = tracked.execution?.byUs === true;
  const out: Transition[] = [];
  let furthest = -1;
  for (const t of tracked.transitions) {
    const rank = PROGRESS[t.state];
    // A lookup whose proof search was skipped or missed used to write the instruction back from
    // `proved` to `attesting`. Nothing moved on chain -- a served proof cannot be unserved -- so
    // those steps backwards, and the repeat of the state they left, are not history.
    if (rank !== undefined && rank < furthest && t.note === TRANSITION_NOTES.notPerformed) continue;
    if (rank !== undefined && rank === furthest && out.at(-1)?.state === t.state) continue;
    if (rank !== undefined) furthest = Math.max(furthest, rank);
    const provedByUs = t.state === "proved" && tracked.attestation !== undefined;
    if (didTheWork && t.note === TRANSITION_NOTES.notPerformed && (t.state === "executed" || provedByUs)) {
      out.push({ ...t, note: TRANSITION_NOTES.recordedByLookup });
    } else {
      out.push(t);
    }
  }
  return out;
}

/**
 * The forward path an instruction takes. A lookup never reports a state earlier on it than the
 * store already holds: the store's `proved` means a proof was fetched, and a lookup that could
 * not afford or did not find one knows less, not something different.
 */
const PROGRESS: Partial<Record<TrackedState, number>> = { seen: 0, attesting: 1, proved: 2, executed: 3 };

function behind(chain: TrackedState, stored: TrackedState): boolean {
  const a = PROGRESS[chain];
  const b = PROGRESS[stored];
  return a !== undefined && b !== undefined && a < b;
}

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

  const read = toStatusState(classified.state, tracked?.attestation !== undefined);
  // Never step backwards from what this service already recorded (see PROGRESS).
  const state = tracked && behind(read, tracked.state) ? tracked.state : read;

  // The chain is the authority, not the store. A service running read-only, or one that was
  // started after the fact, has a store that lags -- and reporting its own stale view over the
  // chain's would be the one thing this endpoint must never do. So the classifier's verdict
  // wins, the observation is recorded, and the answer says the timestamps are observations.
  //
  // But a lookup made while this process's own pipeline is still working the instruction is not
  // "the store lags": it is the chain a few seconds ahead of a pipeline that is about to record
  // the same state itself -- the execute is mined before its receipt is back, a proof is served
  // before the next poll. Writing the chain's state then would put "did not perform" on work
  // this service is in the middle of doing, and the pipeline's own record of that state would
  // add no transition to replace it. So in that case nothing is written: the answer carries the
  // chain's state as an unrecorded transition, and is not final until the pipeline catches up.
  const now = deps.now?.() ?? Date.now();
  // A payment this service has not stored yet, looked up moments after it closed, is one the
  // watcher has not reached on its next pass -- not one this service missed. Saying it "did not
  // work this instruction from the start" would be the same false claim in a different place.
  const awaitingPickup = !tracked && deps.working === true && now / 1000 - record.closedAt < PICKUP_WINDOW_SECONDS;
  let transitionsComplete = true;
  let unrecorded: Transition | undefined;
  if (tracked && tracked.state !== state) {
    const pipelineWillRecord = deps.working === true && !FINAL.has(tracked.state);
    if (pipelineWillRecord) {
      unrecorded = { state, at: now, note: TRANSITION_NOTES.notYetRecorded };
    } else {
      deps.store.update(tracked.transactionId, { state }, TRANSITION_NOTES.notPerformed);
      transitionsComplete = false;
    }
  } else if (!tracked && !awaitingPickup) {
    transitionsComplete = false;
  }

  const stored = deps.store.get(transactionId);
  const transitions: Transition[] = stored
    ? [...presentTransitions(stored), ...(unrecorded ? [unrecorded] : [])]
    : [{ state: "seen", at: record.closedAt * 1000, note: awaitingPickup ? TRANSITION_NOTES.notPickedUpYet : TRANSITION_NOTES.notWatching }];

  return {
    xrplHash: normalised,
    transactionId,
    state,
    // A state the pipeline has yet to record is still going to change -- its execution details,
    // at least -- so a caller that stops polling on `final` should not stop yet.
    final: RESCUE_STATES[classified.state].final && unrecorded === undefined,
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
    elapsed: elapsedByState(transitions, now),
    ...(tracked?.attestation
      ? {
          attestation: {
            txHash: tracked.attestation.txHash,
            votingRoundId: tracked.attestation.votingRoundId,
            at: tracked.attestation.at,
            // Rounds that finalised without serving a proof, each followed by a fresh request.
            ...(tracked.attestation.unservedRounds?.length ? { unservedRounds: tracked.attestation.unservedRounds } : {}),
          },
        }
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
 *
 * The clock stops at a final state. "executed: 33430" is not a duration anything spent -- it
 * is how long ago it finished -- and a status page that renders every entry here as time
 * spent waiting would show a completed instruction as nine hours stuck. So a final state is
 * absent from the map; when it was reached is on its transition.
 */
export function elapsedByState(transitions: Transition[], now: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < transitions.length; i++) {
    const from = transitions[i];
    const next = transitions[i + 1];
    if (!next && FINAL.has(from.state)) break;
    const until = next?.at ?? now;
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
  // Checked before any work, not before each call, so one lookup cannot spend three tokens.
  if (deps.daBudget && !deps.daBudget.tryAcquire()) return false;
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
