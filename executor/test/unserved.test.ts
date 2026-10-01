/**
 * Two gaps found live on 2026-10-01, driven through the real pipeline against the shared fakes.
 *
 * 1. An unserved attestation. The executor requested an attestation for 231B7917... in round
 *    1470750; the round finalised, and the DA Layer never served a proof for that request. The
 *    executor kept polling round 1470750, so the instruction would have waited out its 24-hour
 *    window. Now: after a grace period for DA lag it requests again in a later round, a bounded
 *    number of times, logging each one, and parks the instruction as `stuck` when the bound runs out.
 *
 * 2. A superseded nonce. A later instruction then used 231B7917...'s nonce, so it could never run,
 *    yet the dry-run executor would still have paid for its attestation. Now: an instruction whose
 *    nonce the account has passed is parked as `stuck` before anything is spent on it.
 */
import { describe, it, expect } from "vitest";
import { advance, DEFAULT_REATTESTATIONS, DEFAULT_UNSERVED_GRACE_MS } from "../src/service/pipeline.js";
import { createLogger } from "../src/service/log.js";
import { controllerInterface } from "@memokit/sdk";
import type { ExecutorChain } from "../src/service/chain.js";
import { harness, inlineInstruction } from "./harness.js";

/** A harness whose clock the test drives, whose log it reads, and whose rounds count up. */
function unservedHarness(over: Partial<ExecutorChain> = {}) {
  let round = 1470750;
  const finalised = new Set<number>();
  const h = harness({
    requestAttestation: async () => {
      h.chain.calls.push("requestAttestation");
      return { txHash: `0xreq${round}`, votingRoundId: round++, abiEncodedRequest: "0xabi", feeWei: 1000n };
    },
    isRoundFinalized: async (r) => finalised.has(r),
    ...over,
  });
  const lines: Record<string, unknown>[] = [];
  h.deps.log = createLogger({ level: "debug", sink: (l) => lines.push(JSON.parse(l)) });
  const clock = { t: 1_790_797_533_000 };
  h.deps.now = () => clock.t;
  h.proofReady.value = false; // the DA Layer answers "not found", as it did for 231B7917...
  const row = (id: string) => h.store.get(id)!;
  const step = async (id: string, advanceMs = 0) => {
    clock.t += advanceMs;
    await advance(row(id), h.deps);
    return row(id);
  };
  return { h, lines, clock, finalised, row, step, requests: () => h.chain.calls.filter((c) => c === "requestAttestation").length };
}

describe("an attestation the DA Layer never serves (231B7917...)", () => {
  it("keeps polling while the round is not finalised: that is ordinary waiting", async () => {
    const u = unservedHarness();
    const tx = u.h.seed(inlineInstruction(200_000n).memoData);
    await u.step(tx.transactionId); // requests round 1470750
    for (let i = 0; i < 10; i++) await u.step(tx.transactionId, 30_000);
    expect(u.requests()).toBe(1);
    expect(u.row(tx.transactionId).state).toBe("attesting");
    expect(u.row(tx.transactionId).attestation!.unservedSince).toBeUndefined();
  });

  it("waits out a grace period for DA lag once the round finalises, then requests again in a later round", async () => {
    const u = unservedHarness();
    const tx = u.h.seed(inlineInstruction(200_000n).memoData);
    const id = tx.transactionId;
    await u.step(id);
    expect(u.row(id).attestation!.votingRoundId).toBe(1470750);

    // Round 1470750 finalises; the DA Layer still has nothing for the request.
    u.finalised.add(1470750);
    await u.step(id, 30_000);
    await u.step(id, 60_000);
    expect(u.requests()).toBe(1); // still inside the grace period
    expect(u.row(id).attestation!.unservedSince).toBeDefined();

    await u.step(id, DEFAULT_UNSERVED_GRACE_MS);
    expect(u.requests()).toBe(2);
    const a = u.row(id).attestation!;
    expect(a.votingRoundId).toBe(1470751);
    expect(a.reattempts).toBe(1);
    expect(a.unservedRounds).toEqual([1470750]);
    expect(u.row(id).state).toBe("attesting");

    const warn = u.lines.find((l) => l.msg === "attestation not served; requested again in a later round");
    expect(warn).toMatchObject({ level: "warn", unservedRound: 1470750, newRound: 1470751, retry: 1, of: DEFAULT_REATTESTATIONS });
  });

  it("delivers normally when the later round is served", async () => {
    const u = unservedHarness();
    const tx = u.h.seed(inlineInstruction(200_000n).memoData);
    const id = tx.transactionId;
    await u.step(id);
    u.finalised.add(1470750);
    await u.step(id, 30_000);
    await u.step(id, DEFAULT_UNSERVED_GRACE_MS + 1);
    expect(u.row(id).attestation!.votingRoundId).toBe(1470751);

    u.h.proofReady.value = true;
    await u.step(id, 90_000);
    expect(u.row(id).state).toBe("executed");
    expect(u.row(id).execution!.byUs).toBe(true);
  });

  it("is bounded: after the last re-request goes unserved too, it parks as stuck and pays no more", async () => {
    const u = unservedHarness();
    const tx = u.h.seed(inlineInstruction(200_000n).memoData);
    const id = tx.transactionId;
    await u.step(id);
    for (let i = 0; i <= DEFAULT_REATTESTATIONS; i++) {
      u.finalised.add(u.row(id).attestation!.votingRoundId);
      await u.step(id, 30_000);
      await u.step(id, DEFAULT_UNSERVED_GRACE_MS + 1);
    }
    expect(u.requests()).toBe(1 + DEFAULT_REATTESTATIONS);
    const r = u.row(id);
    expect(r.state).toBe("stuck");
    expect(r.attestation!.unservedRounds).toEqual([1470750, 1470751, 1470752]);
    expect(r.lastError!.message).toMatch(/without serving a proof/);
    expect(u.lines.find((l) => l.msg === "attestation never served; giving up")).toMatchObject({ level: "error" });

    // Nothing more is spent on it.
    await u.step(id, 600_000);
    expect(u.requests()).toBe(1 + DEFAULT_REATTESTATIONS);
  });

  it("does not request again if someone else executed it in the meantime", async () => {
    let consumed = false;
    const u = unservedHarness({ isConsumed: async () => consumed });
    const tx = u.h.seed(inlineInstruction(200_000n).memoData);
    const id = tx.transactionId;
    await u.step(id);
    u.finalised.add(1470750);
    await u.step(id, 30_000);
    consumed = true;
    await u.step(id, DEFAULT_UNSERVED_GRACE_MS + 1);
    expect(u.requests()).toBe(1);
    expect(u.row(id)).toMatchObject({ state: "executed", execution: { byUs: false } });
  });

  it("does not request again if the account has moved past the instruction's nonce: the live case", async () => {
    // Exactly 231B7917...: unserved round, then a later instruction used its nonce.
    let accountNonce = 0n;
    const u = unservedHarness({ nonceOf: async () => accountNonce });
    const tx = u.h.seed(inlineInstruction(200_000n).memoData); // nonce 0
    const id = tx.transactionId;
    await u.step(id);
    u.finalised.add(1470750);
    await u.step(id, 30_000);
    accountNonce = 1n;
    await u.step(id, DEFAULT_UNSERVED_GRACE_MS + 1);
    expect(u.requests()).toBe(1);
    expect(u.row(id).state).toBe("stuck");
    expect(u.row(id).skipReason).toMatch(/superseded: bound to nonce 0, but the account is already at 1/);
  });
});

describe("a superseded nonce", () => {
  it("is parked before the attestation is paid for", async () => {
    const h = harness({ nonceOf: async () => 12n });
    const tx = h.seed(inlineInstruction(200_000n).memoData); // bound to nonce 0
    await advance(tx, h.deps);
    const r = h.store.get(tx.transactionId)!;
    expect(r.state).toBe("stuck");
    expect(r.skipReason).toMatch(/superseded/);
    expect(h.chain.calls).not.toContain("requestAttestation");
    expect(h.metrics.value("memokit_executor_declined_total", { reason: "superseded" })).toBe(1);
  });

  it("is not triggered at the account's current nonce", async () => {
    const h = harness({ nonceOf: async () => 0n });
    const tx = h.seed(inlineInstruction(200_000n).memoData);
    await advance(tx, h.deps);
    expect(h.store.get(tx.transactionId)!.state).toBe("attesting");
  });

  it("is recognised when the simulation reverts with InvalidNonce, instead of retrying to the limit", async () => {
    let accountNonce = 0n;
    const h = harness({
      nonceOf: async () => accountNonce,
      simulate: async () => {
        const e = new Error("execution reverted") as Error & { data: string };
        e.data = controllerInterface.encodeErrorResult("InvalidNonce", [1n, 0n]);
        throw e;
      },
    });
    const tx = h.seed(inlineInstruction(200_000n).memoData);
    await advance(tx, h.deps); // attesting, nonce still 0
    accountNonce = 1n; // another instruction executes first
    await advance(h.store.get(tx.transactionId)!, h.deps);
    const r = h.store.get(tx.transactionId)!;
    expect(r.state).toBe("stuck");
    expect(r.attempts).toBe(0);
    expect(h.chain.calls).not.toContain("execute");
  });
});
