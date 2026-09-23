/**
 * The status API publishes a different vocabulary from the classifier's, so the mapping
 * between them is the thing most likely to drift. These pin it, and pin the elapsed-time
 * arithmetic that makes a 150 s wait legible rather than mysterious.
 */
import { describe, it, expect } from "vitest";
import { RESCUE_STATES, type InstructionState } from "@memokit/sdk";
import { toStatusState, elapsedByState } from "../src/service/statusApi.js";
import { FINAL, type Transition } from "../src/service/store.js";

describe("classifier state to published state", () => {
  it("maps every classifier state, with no gaps", () => {
    const states = Object.keys(RESCUE_STATES) as InstructionState[];
    for (const s of states) {
      expect(toStatusState(s, false)).toBeTruthy();
    }
    expect(states).toHaveLength(7);
  });

  it("splits 'awaiting attestation' on whether anybody has paid for one", () => {
    expect(toStatusState("awaiting-attestation", false)).toBe("seen");
    expect(toStatusState("awaiting-attestation", true)).toBe("attesting");
  });

  it("keeps the classifier's finality: every final verdict maps to a final published state", () => {
    for (const [state, meta] of Object.entries(RESCUE_STATES)) {
      if (!meta.final) continue;
      expect(FINAL.has(toStatusState(state as InstructionState, false))).toBe(true);
    }
  });

  it("does not report a retired instruction as executed", () => {
    expect(toStatusState("retired", false)).toBe("rescued");
    expect(toStatusState("executed", false)).toBe("executed");
  });
});

describe("elapsedByState", () => {
  const at = (s: string, seconds: number): Transition => ({ state: s as never, at: seconds * 1000 });

  it("measures each state up to the next transition, and the last one up to now", () => {
    const elapsed = elapsedByState([at("seen", 0), at("attesting", 10), at("proved", 110)], 120_000);
    expect(elapsed).toEqual({ seen: 10, attesting: 100, proved: 10 });
  });

  it("sums a state entered more than once", () => {
    const elapsed = elapsedByState(
      [at("seen", 0), at("failed", 10), at("proved", 20), at("failed", 30)],
      40_000,
    );
    expect(elapsed.failed).toBe(20);
  });

  it("stops the clock at a final state, so a finished instruction is not shown as waiting", () => {
    // The deployed service returned "executed: 33430" nine hours after an instruction
    // finished. That is how long ago it ended, not a duration anything spent.
    const elapsed = elapsedByState(
      [at("seen", 0), at("attesting", 5), at("proved", 150), at("executed", 154)],
      154_000 + 33_430_000,
    );
    expect(elapsed).toEqual({ seen: 5, attesting: 145, proved: 4 });
    expect(elapsed).not.toHaveProperty("executed");
  });

  it("keeps counting a non-final state that is still in progress", () => {
    const elapsed = elapsedByState([at("seen", 0), at("attesting", 5)], 100_000);
    expect(elapsed).toEqual({ seen: 5, attesting: 95 });
  });

  it("never reports negative time when a clock runs backwards", () => {
    const elapsed = elapsedByState([at("seen", 100)], 0);
    expect(elapsed.seen).toBe(0);
  });
});
