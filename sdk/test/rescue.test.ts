/**
 * Failure injection for the rescue classifier.
 *
 * Every state an instruction can stall in is driven deliberately here, and the rescue the
 * classifier proposes is checked -- not just that it proposes one, but that the memo it
 * builds is the right opcode with the right target, and that the loss it reports matches
 * what is actually lost.
 *
 * The chain reader is injected, so each state is reached by construction rather than by
 * arranging a real stall.
 */
import { describe, it, expect } from "vitest";
import {
  classifyPayments,
  buildNonceAtLeastMemo,
  buildRetireMemo,
  buildReplaceFeeMemo,
  RESCUE_STATES,
  type ChainView,
  type XrplPaymentRecord,
  type InstructionState,
} from "../src/rescue.js";
import { encodeMemo, encodeInstruction, commitmentOf, decodeMemo, toXrplMemoData } from "../src/memo.js";
import { COSTON2 } from "../src/networks.js";
import { Opcode, ZERO_ADDRESS, type Instruction } from "../src/types.js";

const OWNER = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe";
const ACCOUNT = "0x823d7dAe9e087D4c96225DE6385376a990067d4e";
const RECEIVING = "rEyj8nsHLdgt79KJWzXR5BgF7ZbaohbXwq";
const VALIDITY = 86_400;
const NOW = 1_800_000_000;

function instruction(nonce: bigint): Instruction {
  return {
    sender: ACCOUNT,
    nonce,
    feeToken: ZERO_ADDRESS,
    feeAmount: 0n,
    calls: [{ target: "0x2222222222222222222222222222222222222222", value: 0n, data: "0x" }],
  };
}

/** An inline (0xFD) memo, so the classifier can read the nonce straight out of it. */
function inlineMemo(nonce: bigint): string {
  return encodeMemo({
    kind: "execInline",
    opcode: Opcode.ExecInline,
    walletId: 1,
    executorFee: 0n,
    instruction: instruction(nonce),
  });
}

function commitMemo(nonce: bigint): string {
  return encodeMemo({
    kind: "execCommit",
    opcode: Opcode.ExecCommit,
    walletId: 1,
    executorFee: 0n,
    commitment: commitmentOf(instruction(nonce)),
  });
}

function payment(hash: string, memo: string | null, ageSeconds = 60): XrplPaymentRecord {
  return {
    hash,
    ledgerIndex: 1,
    closedAt: NOW - ageSeconds,
    destination: RECEIVING,
    memo: memo ? toXrplMemoData(memo) : null,
  };
}

interface ChainState {
  accountNonce?: bigint;
  consumed?: Set<string>;
  ignored?: Set<string>;
}

function chain(state: ChainState = {}): ChainView {
  return {
    accountFor: async () => ACCOUNT,
    nonceOf: async () => state.accountNonce ?? 0n,
    isConsumed: async (id) => (state.consumed ?? new Set()).has(id.toLowerCase()),
    isIgnored: async (_a, id) => (state.ignored ?? new Set()).has(id.toLowerCase()),
    validityDurationSeconds: async () => VALIDITY,
  };
}

async function classify(
  payments: XrplPaymentRecord[],
  state: ChainState = {},
  hasProof = false,
) {
  return classifyPayments(payments, {
    network: COSTON2,
    controller: "0x0000000000000000000000000000000000000001",
    xrplOwner: OWNER,
    chain: chain(state),
    now: NOW,
    hasProof: async () => hasProof,
  });
}

const HASH_A = "AAAA000000000000000000000000000000000000000000000000000000000001";
const ID_A = "0x" + HASH_A.toLowerCase();

describe("state: executed", () => {
  it("is final and reports only the carrier payment as spent", async () => {
    const [r] = await classify([payment(HASH_A, commitMemo(0n))], {
      consumed: new Set([ID_A]),
    });
    expect(r.state).toBe("executed");
    expect(r.rescue).toBeNull();
    expect(RESCUE_STATES.executed.final).toBe(true);
    expect(RESCUE_STATES.executed.loss).toMatch(/carrier payment/i);
  });
});

describe("state: retired", () => {
  it("is distinguished from executed by the ignore flag", async () => {
    const [r] = await classify([payment(HASH_A, commitMemo(0n))], {
      consumed: new Set([ID_A]),
      ignored: new Set([ID_A]),
    });
    expect(r.state).toBe("retired");
    expect(r.rescue).toBeNull();
    expect(RESCUE_STATES.retired.loss).toMatch(/never ran/i);
  });
});

describe("state: awaiting-attestation", () => {
  it("needs no XRPL payment: anyone can request the attestation", async () => {
    const [r] = await classify([payment(HASH_A, commitMemo(0n))], {}, false);
    expect(r.state).toBe("awaiting-attestation");
    expect(r.rescue?.action).toBe("request-attestation");
    expect(r.rescue?.memo).toBeNull();
    expect(r.rescue?.loss).toMatch(/nothing yet/i);
    expect(r.validitySecondsRemaining).toBeGreaterThan(0);
  });
});

describe("state: attested-not-executed", () => {
  it("needs no XRPL payment either: the proof just has to be delivered", async () => {
    const [r] = await classify([payment(HASH_A, commitMemo(0n))], { accountNonce: 0n }, true);
    expect(r.state).toBe("attested-not-executed");
    expect(r.rescue?.action).toBe("submit-proof");
    expect(r.rescue?.memo).toBeNull();
  });
});

describe("state: execution-failed", () => {
  /**
   * The instruction is bound to a nonce the account has not reached. Nothing on chain records
   * the failed attempt -- a revert leaves no trace -- so the classifier infers it from the
   * nonce gap, which is the only durable evidence.
   */
  it("is inferred from a nonce gap and rescued with 0xFB", async () => {
    const [r] = await classify([payment(HASH_A, inlineMemo(5n))], { accountNonce: 2n }, true);
    expect(r.state).toBe("execution-failed");
    expect(r.nonce).toBe(5n);
    expect(r.accountNonce).toBe(2n);
    expect(r.rescue?.action).toBe("send-rescue-memo");

    const memo = decodeMemo(r.rescue!.memo!);
    expect(memo.kind).toBe("nonceAtLeast");
    expect(memo.opcode).toBe(Opcode.NonceAtLeast);
    if (memo.kind === "nonceAtLeast") expect(memo.targetNonce).toBe(5n);
  });

  it("reports that nothing on chain was lost, because the revert unwound it", async () => {
    const [r] = await classify([payment(HASH_A, inlineMemo(5n))], { accountNonce: 2n }, true);
    expect(r.rescue?.loss).toMatch(/not consumed|nonce did not move/i);
  });

  /**
   * The one genuinely unrecoverable shape. Nonces only move forward and the check is
   * equality, so an instruction the account has already passed can never run. Saying so is
   * more useful than proposing a rescue that cannot work.
   */
  it("admits when an instruction is behind the account and cannot be rescued", async () => {
    const [r] = await classify([payment(HASH_A, inlineMemo(1n))], { accountNonce: 4n }, true);
    expect(r.state).toBe("execution-failed");
    expect(r.rescue?.action).toBe("nothing-possible");
    expect(r.rescue?.memo).toBeNull();
    expect(r.rescue?.summary).toMatch(/only move forward/i);
  });
});

describe("state: expired", () => {
  it("is final once the validity window closes", async () => {
    const [r] = await classify([payment(HASH_A, commitMemo(0n), VALIDITY + 10)]);
    expect(r.state).toBe("expired");
    expect(r.validitySecondsRemaining).toBeLessThan(0);
    expect(r.rescue?.action).toBe("nothing-possible");
    expect(r.rescue?.summary).toMatch(/re-sign/i);
  });

  it("still proposes a nonce rescue when later instructions are queued behind it", async () => {
    const [r] = await classify([payment(HASH_A, inlineMemo(3n), VALIDITY + 10)], {
      accountNonce: 3n,
    });
    expect(r.state).toBe("expired");
    // The dead instruction owns nonce 3, so anything signed at 4+ is blocked behind it.
    expect(r.rescue?.action).toBe("send-rescue-memo");
    const memo = decodeMemo(r.rescue!.memo!);
    if (memo.kind === "nonceAtLeast") expect(memo.targetNonce).toBe(4n);
  });

  it("reports the attestation fee as lost, unlike the earlier states", async () => {
    expect(RESCUE_STATES.expired.loss).toMatch(/attestation fee/i);
    expect(RESCUE_STATES["awaiting-attestation"].loss).not.toMatch(/attestation fee.*lost/i);
  });
});

describe("state: not-an-instruction", () => {
  it("classifies a payment with no memo", async () => {
    const [r] = await classify([payment(HASH_A, null)]);
    expect(r.state).toBe("not-an-instruction");
    expect(r.rescue?.action).toBe("nothing-possible");
  });

  it("classifies a memo this codec does not recognise, without throwing", async () => {
    const [r] = await classify([payment(HASH_A, "0xff01" + "00".repeat(40))]);
    expect(r.state).toBe("not-an-instruction");
    expect(r.decodedMemo).toBeNull();
  });

  it("classifies a v1 payload carried inline as unrecognised rather than crashing", async () => {
    // A 0xFD memo whose payload is v1-shaped: decodable as a memo, not as an instruction.
    const v1Body = "0x" + "00".repeat(32);
    const [r] = await classify([payment(HASH_A, "0xfd01" + "00".repeat(8) + v1Body.slice(2))]);
    expect(r.state).toBe("not-an-instruction");
  });
});

describe("every state is accounted for", () => {
  const states: InstructionState[] = [
    "executed",
    "retired",
    "awaiting-attestation",
    "attested-not-executed",
    "execution-failed",
    "expired",
    "not-an-instruction",
  ];

  it("has a documented loss for each", () => {
    for (const s of states) {
      expect(RESCUE_STATES[s], s).toBeDefined();
      expect(RESCUE_STATES[s].loss.length, s).toBeGreaterThan(20);
    }
  });

  it("marks exactly the recoverable states as non-final", () => {
    const nonFinal = states.filter((s) => !RESCUE_STATES[s].final);
    expect(nonFinal.sort()).toEqual(
      ["attested-not-executed", "awaiting-attestation", "execution-failed"].sort(),
    );
  });
});

describe("rescue memo builders", () => {
  it("0xFB carries the target nonce and is 42 bytes", () => {
    const memo = buildNonceAtLeastMemo(7n);
    expect((memo.length - 2) / 2).toBe(42);
    const decoded = decodeMemo(memo);
    expect(decoded.opcode).toBe(Opcode.NonceAtLeast);
    if (decoded.kind === "nonceAtLeast") expect(decoded.targetNonce).toBe(7n);
  });

  it("0xE0 carries the target transaction id", () => {
    const decoded = decodeMemo(buildRetireMemo(ID_A));
    expect(decoded.opcode).toBe(Opcode.Ignore);
    if (decoded.kind === "ignore") expect(decoded.targetTransactionId).toBe(ID_A);
  });

  it("0xE2 carries the target and the new fee, and is 50 bytes", () => {
    const memo = buildReplaceFeeMemo(ID_A, 1_234n);
    expect((memo.length - 2) / 2).toBe(50);
    const decoded = decodeMemo(memo);
    if (decoded.kind === "replaceFee") {
      expect(decoded.targetTransactionId).toBe(ID_A);
      expect(decoded.newFee).toBe(1_234n);
    }
  });

  /** Every rescue memo is carried by a fresh XRPL payment, so each costs one more carrier fee. */
  it("all rescue memos fit the XRPL memo budget comfortably", () => {
    for (const memo of [buildNonceAtLeastMemo(1n), buildRetireMemo(ID_A), buildReplaceFeeMemo(ID_A, 1n)]) {
      expect((memo.length - 2) / 2).toBeLessThanOrEqual(50);
    }
  });
});

describe("classification is order-independent and batched", () => {
  it("classifies a mixed batch in one pass", async () => {
    const hashB = "BBBB000000000000000000000000000000000000000000000000000000000002";
    const hashC = "CCCC000000000000000000000000000000000000000000000000000000000003";
    const results = await classify(
      [
        payment(HASH_A, commitMemo(0n)),
        payment(hashB, null),
        payment(hashC, inlineMemo(9n), VALIDITY + 1),
      ],
      { consumed: new Set([ID_A]), accountNonce: 1n },
    );
    expect(results.map((r) => r.state)).toEqual([
      "executed",
      "not-an-instruction",
      "expired",
    ]);
  });
});

describe("commit memos and the preimage", () => {
  it("cannot see the nonce of a 0xFC memo, and says so rather than guessing", async () => {
    const [r] = await classify([payment(HASH_A, commitMemo(9n))], { accountNonce: 0n }, true);
    expect(r.nonce).toBeNull();
    expect(r.state).toBe("attested-not-executed");
    expect(r.reason).toMatch(/not visible without the preimage/);
  });

  it("uses a supplied preimage to reach the real verdict", async () => {
    const payload = encodeInstruction(instruction(9n));
    const rows = await classifyPayments([payment(HASH_A, commitMemo(9n))], {
      network: COSTON2,
      controller: "0x0000000000000000000000000000000000000001",
      xrplOwner: OWNER,
      chain: chain({ accountNonce: 2n }),
      now: NOW,
      hasProof: async () => true,
      payloadFor: async () => payload,
    });
    expect(rows[0].nonce).toBe(9n);
    expect(rows[0].state).toBe("execution-failed");
    expect(rows[0].rescue?.action).toBe("send-rescue-memo");
  });

  it("ignores a preimage that does not match the commitment", async () => {
    const wrong = encodeInstruction(instruction(1n));
    const rows = await classifyPayments([payment(HASH_A, commitMemo(9n))], {
      network: COSTON2,
      controller: "0x0000000000000000000000000000000000000001",
      xrplOwner: OWNER,
      chain: chain({ accountNonce: 2n }),
      now: NOW,
      hasProof: async () => true,
      payloadFor: async () => wrong,
    });
    expect(rows[0].nonce).toBeNull();
    expect(rows[0].state).toBe("attested-not-executed");
  });
});
