/**
 * Durable per-instruction state, so a restart resumes rather than repeats.
 *
 * **The chain is the source of truth, not this file.** An XRPL transaction id can be consumed
 * exactly once, so a duplicate submit can never produce a duplicate execution -- it reverts.
 * The store exists to stop the service paying twice for things the chain does not deduplicate:
 * the attestation fee, and the gas of a submit that is certain to lose. Losing the file costs
 * money, not correctness, which is the right way round for a service anyone can run.
 *
 * A JSON file written by atomic rename. Not a database: the working set is the instructions
 * that have not finished yet, which is tens, and a dependency-free service is one more person
 * able to run one.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

/** Where an instruction has got to, in the vocabulary the status API speaks. */
export type TrackedState =
  | "seen"
  | "attesting"
  | "proved"
  | "executed"
  | "failed"
  | "stuck"
  | "rescued"
  | "skipped";

export interface Transition {
  state: TrackedState;
  at: number;
  note?: string;
}

export interface TrackedInstruction {
  /** XRPL hash, uppercase as the ledger prints it. */
  xrplHash: string;
  /** 0x-prefixed lowercase, as FDC keys attestations. */
  transactionId: string;
  /** The XRPL address that sent the carrier payment: the account's owner. */
  xrplOwner: string;
  receivingAddress: string;
  ledgerIndex: number;
  /** Unix seconds of the XRPL close. */
  closedAt: number;
  memo: string | null;
  opcode: number | null;
  account: string | null;

  state: TrackedState;
  transitions: Transition[];

  /** Set once this service has submitted an attestation request. */
  attestation?: {
    txHash: string;
    votingRoundId: number;
    abiEncodedRequest: string;
    feeWei: string;
    at: number;
  };
  /** Set once the instruction has been executed, by anyone. */
  execution?: {
    txHash: string;
    blockNumber: number;
    /** False when another executor won the race. */
    byUs: boolean;
    gasUsed?: string;
    at: number;
  };
  /** Why the fee policy declined to work it. */
  skipReason?: string;
  attempts: number;
  /** The most recent thing that went wrong, for the operator and for the status API. */
  lastError?: { at: number; stage: string; message: string };
  /** Earliest wall-clock time the pipeline should look at this again. */
  nextAttemptAt?: number;
}

interface FileShape {
  version: 1;
  controller: string;
  instructions: Record<string, TrackedInstruction>;
}

export class Store {
  private data: FileShape;

  constructor(
    private readonly path: string,
    controller: string,
  ) {
    this.data = { version: 1, controller, instructions: {} };
    if (existsSync(path)) {
      const loaded = JSON.parse(readFileSync(path, "utf8")) as FileShape;
      // A store written against a different deployment describes accounts that no longer
      // exist, and silently reusing it would make the service skip live work as "executed".
      if (loaded.controller && loaded.controller.toLowerCase() !== controller.toLowerCase()) {
        throw new Error(
          `${path} was written for controller ${loaded.controller}, not ${controller}. ` +
            `Point STATE_FILE somewhere else rather than reusing it.`,
        );
      }
      this.data = { ...loaded, controller };
    }
  }

  get controller(): string {
    return this.data.controller;
  }

  all(): TrackedInstruction[] {
    return Object.values(this.data.instructions);
  }

  get(transactionId: string): TrackedInstruction | undefined {
    return this.data.instructions[transactionId.toLowerCase()];
  }

  /** Everything not in a final state, oldest first: the queue the pipeline works. */
  pending(now = Date.now()): TrackedInstruction[] {
    return this.all()
      .filter((i) => !FINAL.has(i.state))
      .filter((i) => (i.nextAttemptAt ?? 0) <= now)
      .sort((a, b) => a.closedAt - b.closedAt);
  }

  /** Insert if new; never overwrite what is already known. Returns true when it was new. */
  observe(instruction: Omit<TrackedInstruction, "state" | "transitions" | "attempts">): boolean {
    const key = instruction.transactionId.toLowerCase();
    if (this.data.instructions[key]) return false;
    this.data.instructions[key] = {
      ...instruction,
      state: "seen",
      transitions: [{ state: "seen", at: Date.now() }],
      attempts: 0,
    };
    this.flush();
    return true;
  }

  /**
   * Apply a change and persist it.
   *
   * Every transition is recorded with its timestamp, including a repeat of the current state,
   * because "it has been attesting for eleven minutes" is the answer to the only question a
   * user actually asks.
   */
  update(transactionId: string, patch: Partial<TrackedInstruction>, note?: string): TrackedInstruction {
    const key = transactionId.toLowerCase();
    const current = this.data.instructions[key];
    if (!current) throw new Error(`store: ${transactionId} is not tracked`);
    const next = { ...current, ...patch };
    if (patch.state && patch.state !== current.state) {
      next.transitions = [...current.transitions, { state: patch.state, at: Date.now(), ...(note ? { note } : {}) }];
    }
    this.data.instructions[key] = next;
    this.flush();
    return next;
  }

  private flush(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n");
    // Rename is atomic within a filesystem, so a crash mid-write leaves the previous file
    // intact rather than a truncated one that would fail to parse on the next start.
    renameSync(tmp, this.path);
  }
}

export const FINAL = new Set<TrackedState>(["executed", "stuck", "rescued", "skipped"]);
