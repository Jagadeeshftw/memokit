/**
 * A status lookup racing the executor's own pipeline.
 *
 * The deployed service showed "observed on chain; this service did not perform the transition"
 * on instructions it had just executed itself (2026-09-30, `5B0F1DF6…`, `byUs: true`). The
 * status page polls every 5 s, the chain gets ahead of the pipeline by a few seconds -- a proof
 * is served before the next DA poll, an execute is mined before its receipt comes back -- and
 * the lookup used to write the chain's state with that label. The pipeline's own record of the
 * same state then added no transition, so the false label stayed.
 *
 * These drive the real pipeline against the same fakes as pipeline.test.ts, look the
 * instruction up in the middle of its processing, and check every answer on the way.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InstructionState } from "@memokit/sdk";
import { advance } from "../src/service/pipeline.js";
import { statusOf, presentTransitions, TRANSITION_NOTES, type StatusDeps, type StatusResponse } from "../src/service/statusApi.js";
import type { TrackedInstruction } from "../src/service/store.js";
import { harness, inlineInstruction, CONTROLLER, type Harness } from "./harness.js";

// What the chain says, as the classifier reads it. The classifier itself is covered elsewhere;
// here it stands in for "the chain", so each step can put the chain exactly where it was.
const chainSays = vi.hoisted(() => ({ state: "awaiting-attestation" as InstructionState }));
vi.mock("@memokit/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@memokit/sdk")>();
  return {
    ...actual,
    classifyPayments: async (payments: Array<{ hash: string }>) =>
      payments.map(() => ({
        state: chainSays.state,
        reason: `chain says ${chainSays.state}`,
        rescue: null,
        validitySecondsRemaining: 80_000,
      })),
  };
});

const FALSE_CLAIM = /did not perform|did not work this instruction/;

function statusDeps(h: Harness, working: boolean): StatusDeps {
  return {
    network: h.deps.network,
    controller: CONTROLLER,
    provider: null as never,
    store: h.store,
    da: null as never,
    receivers: async () => ["rDfVHUx5SMgw5wwqjvzgFEFCnqW5CCGWyW"],
    working,
  };
}

/** Nothing in the answer may claim this service did not do what it did. */
function expectNoFalseLabel(r: StatusResponse): void {
  for (const t of r.transitions) expect(t.note ?? "").not.toMatch(FALSE_CLAIM);
  expect(r.note ?? "").not.toMatch(FALSE_CLAIM);
  expect(r.transitionsComplete).toBe(true);
}

/** An execute that stays in flight until the test lets it land. */
function heldExecute() {
  let land!: () => void;
  const landed = new Promise<void>((r) => (land = r));
  return {
    land: () => land(),
    execute: async () => {
      await landed;
      return { hash: "0xfeed", blockNumber: 36039650, gasUsed: 681_359n };
    },
  };
}

beforeEach(() => {
  chainSays.state = "awaiting-attestation";
});

describe("a lookup polled during the executor's own processing", () => {
  it("never labels the executor's own work as someone else's, from request to execute", async () => {
    const held = heldExecute();
    const h = harness({ execute: held.execute });
    h.proofReady.value = false;
    const deps = statusDeps(h, true);
    const tx = h.seed(inlineInstruction(200_000n).memoData);

    // The executor requests the attestation. Chain and store agree.
    await advance(tx, h.deps);
    let r = await statusOf(tx.xrplHash, deps);
    expect(r.state).toBe("attesting");
    expectNoFalseLabel(r);

    // The DA Layer serves the proof before the pipeline's next poll: the chain is ahead.
    chainSays.state = "attested-not-executed";
    r = await statusOf(tx.xrplHash, deps);
    expect(r.state).toBe("proved");
    expect(r.transitions.at(-1)).toMatchObject({ state: "proved", note: TRANSITION_NOTES.notYetRecorded });
    expect(r.final).toBe(false);
    expect(h.store.get(tx.transactionId)!.state).toBe("attesting"); // left for the pipeline
    expectNoFalseLabel(r);

    // The pipeline fetches the proof, simulates, and sends the execute, which is still in flight.
    h.proofReady.value = true;
    const working = advance(h.store.get(tx.transactionId)!, h.deps);
    await vi.waitFor(() => expect(h.chain.calls).toContain("simulate"));
    await new Promise((r) => setTimeout(r, 0));

    // The execute is mined before its receipt is back: the exact case the page caught.
    chainSays.state = "executed";
    r = await statusOf(tx.xrplHash, deps);
    expect(r.state).toBe("executed");
    expect(r.final).toBe(false); // keep polling: the executor's record is a moment away
    expect(r.transitions.at(-1)).toMatchObject({ state: "executed", note: TRANSITION_NOTES.notYetRecorded });
    expectNoFalseLabel(r);

    // The receipt lands and the pipeline records its own execution.
    held.land();
    await working;
    r = await statusOf(tx.xrplHash, deps);
    expect(r.state).toBe("executed");
    expect(r.final).toBe(true);
    expect(r.execution).toMatchObject({ byUs: true, blockNumber: 36039650 });
    expect(r.transitions.map((t) => t.state)).toEqual(["seen", "attesting", "proved", "executed"]);
    expect(r.transitions.at(-1)!.note).toBe("executed in block 36039650");
    expectNoFalseLabel(r);
  });

  it("still says so when this service genuinely did not perform it: read-only mode", async () => {
    const h = harness();
    const tx = h.seed(inlineInstruction(200_000n).memoData);
    await advance(tx, h.deps); // attesting

    chainSays.state = "executed";
    const r = await statusOf(tx.xrplHash, statusDeps(h, false));
    expect(r.state).toBe("executed");
    expect(r.transitions.at(-1)).toMatchObject({ state: "executed", note: TRANSITION_NOTES.notPerformed });
    expect(r.transitionsComplete).toBe(false);
    expect(r.note).toMatch(/did not work this instruction from the start/);
  });

  it("still says so when the record is final and the chain moved on without this service", async () => {
    const h = harness();
    const tx = h.seed(null);
    await advance(tx, h.deps); // skipped: no memo -- the pipeline will never look again

    chainSays.state = "retired";
    const r = await statusOf(tx.xrplHash, statusDeps(h, true));
    expect(r.state).toBe("rescued");
    expect(r.transitions.at(-1)).toMatchObject({ state: "rescued", note: TRANSITION_NOTES.notPerformed });
  });
});

describe("a lookup that knows less than the store", () => {
  it("does not step back from proved when its own proof search comes up empty", async () => {
    // The public DA budget is small; a lookup that cannot afford a proof search reads
    // "awaiting attestation" even though this service has already fetched the proof.
    for (const working of [true, false]) {
      const h = harness();
      h.proofReady.value = false;
      const tx = h.seed(inlineInstruction(200_000n).memoData);
      await advance(tx, h.deps); // attesting
      h.store.update(tx.transactionId, { state: "proved" }, "proof available");

      chainSays.state = "awaiting-attestation";
      const r = await statusOf(tx.xrplHash, statusDeps(h, working));
      expect(r.state).toBe("proved");
      expect(h.store.get(tx.transactionId)!.transitions.map((t) => t.state)).toEqual(["seen", "attesting", "proved"]);
      expectNoFalseLabel(r);
    }
  });
});

describe("records written before the fix", () => {
  it("drops the steps backwards a skipped proof search wrote, as the deposit of 2026-09-30 shows", () => {
    // The stored history of 7316F6FE…, the video's vault deposit, as the deployed service held it.
    const n = TRANSITION_NOTES.notPerformed;
    const record = {
      transitions: [
        { state: "seen", at: 1 },
        { state: "attesting", at: 2, note: "attestation requested in round 1470627" },
        { state: "proved", at: 3, note: n },
        { state: "attesting", at: 4, note: n },
        { state: "proved", at: 5, note: n },
        { state: "attesting", at: 6, note: n },
        { state: "proved", at: 7, note: "proof available" },
        { state: "executed", at: 8, note: n },
      ],
      attestation: { txHash: "0x", votingRoundId: 1470627, abiEncodedRequest: "0x", feeWei: "1000", at: 2 },
      execution: { txHash: "0xbdae", blockNumber: 36039729, byUs: true, at: 8 },
    } as TrackedInstruction;
    const shown = presentTransitions(record);
    expect(shown.map((t) => t.state)).toEqual(["seen", "attesting", "proved", "executed"]);
    expect(shown.map((t) => t.note ?? "").filter((x) => FALSE_CLAIM.test(x))).toEqual([]);
  });

  const legacy = (byUs: boolean): TrackedInstruction =>
    ({
      transitions: [
        { state: "seen", at: 1 },
        { state: "attesting", at: 2, note: "attestation requested in round 1470625" },
        { state: "proved", at: 3, note: TRANSITION_NOTES.notPerformed },
        { state: "executed", at: 4, note: TRANSITION_NOTES.notPerformed },
      ],
      attestation: { txHash: "0x1d40", votingRoundId: 1470625, abiEncodedRequest: "0x", feeWei: "1000", at: 2 },
      execution: { txHash: "0x70db", blockNumber: 36039650, byUs, at: 4 },
    }) as TrackedInstruction;

  it("corrects the label where the record proves this service did the work", () => {
    const notes = presentTransitions(legacy(true)).map((t) => t.note ?? "");
    expect(notes.filter((n) => FALSE_CLAIM.test(n))).toEqual([]);
    expect(notes.slice(2)).toEqual([TRANSITION_NOTES.recordedByLookup, TRANSITION_NOTES.recordedByLookup]);
  });

  it("keeps it where another executor did the work", () => {
    const notes = presentTransitions(legacy(false)).map((t) => t.note);
    expect(notes.slice(2)).toEqual([TRANSITION_NOTES.notPerformed, TRANSITION_NOTES.notPerformed]);
  });
});
