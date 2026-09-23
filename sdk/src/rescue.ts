/**
 * Classify every XRPL payment an owner has sent to a memokit receiving address, and say what
 * to do about the ones that are not finished.
 *
 * The reason this exists: an instruction crosses two chains and an attestation protocol, and
 * it can stall at any of four places. From the user's side all four look identical -- they
 * paid, and nothing happened. Without a classifier the only honest answer to "where is my
 * money" is "somewhere", which is not an answer.
 *
 * What the user loses differs per state, and the differences are not intuitive, so
 * {@link RESCUE_STATES} states them explicitly rather than leaving them to be inferred.
 */
import { Contract, JsonRpcProvider } from "ethers";
import { keccak256 } from "ethers";
import { decodeMemo, decodeInstruction, encodeMemo, fromXrplMemoData } from "./memo.js";
import { Opcode, type Memo } from "./types.js";
import type { Network } from "./networks.js";

/** Where an XRPL payment has got to. */
export type InstructionState =
  /** Executed on Flare. Final. */
  | "executed"
  /** Retired by a 0xE0 memo without dispatch. Final. */
  | "retired"
  /** Seen on XRPL; no attestation request submitted yet. */
  | "awaiting-attestation"
  /** Attested and a proof is available; nobody has delivered it. */
  | "attested-not-executed"
  /** Delivery was attempted and reverted. The proof is still usable. */
  | "execution-failed"
  /** The proof validity window has passed. Nothing can deliver it now. Final. */
  | "expired"
  /** Not a memokit instruction: no memo, or a memo this codec does not recognise. */
  | "not-an-instruction";

export interface ClassifiedPayment {
  xrplHash: string;
  /** 0x-prefixed lowercase, as FDC keys attestations. */
  transactionId: string;
  ledgerIndex: number;
  /** Unix seconds of the XRPL close. */
  closedAt: number;
  /** Raw memo bytes, or null when the payment carried none. */
  memo: string | null;
  decodedMemo: Memo | null;
  state: InstructionState;
  /** Populated for execute opcodes whose payload we can see. */
  nonce: bigint | null;
  /** The account's on-chain nonce when the classification was made. */
  accountNonce: bigint;
  /** Seconds until the proof validity window closes; negative once expired. */
  validitySecondsRemaining: number;
  /** Why the classifier landed here, in one line. */
  reason: string;
  /** What to do next, or null when the state is final. */
  rescue: RescuePlan | null;
}

export interface RescuePlan {
  /** What the user has to do. */
  action:
    | "wait"
    | "request-attestation"
    | "submit-proof"
    | "retry-execution"
    | "send-rescue-memo"
    | "nothing-possible";
  /** A memo to carry in a fresh XRPL payment, when the rescue is on-chain. */
  memo: string | null;
  /** Human-readable, one line. */
  summary: string;
  /** What the user is out of pocket if they do nothing. */
  loss: string;
}

/**
 * What is actually lost in each state, if the user walks away.
 *
 * Three different things can be lost and they are easy to conflate:
 *
 *   carrier payment  the XRP sent to the receiving address to carry the memo. Always spent
 *                    the moment the XRPL payment validates. Never recoverable, in any state,
 *                    including the successful one -- it is the postage.
 *   attestation fee  paid in FLR by whoever submitted the request. On Coston2 it is 1000 wei;
 *                    on mainnet 20 FLR, plus about 0.054 FLR of gas at 650 gwei -- read from
 *                    chain on 2026-09-23, see docs/fdc-fees.md for the block and how to re-read
 *                    it. An unconfirmed request is BURNT, not refunded.
 *   the instruction  the calls never happen.
 *
 * The account's assets are never at risk in any stalled state: they have not moved.
 */
export const RESCUE_STATES: Record<InstructionState, { final: boolean; loss: string }> = {
  executed: { final: true, loss: "Carrier payment only. The instruction did what it said." },
  retired: {
    final: true,
    loss: "Carrier payment, plus the carrier payment of the 0xE0 memo that retired it. The instruction never ran.",
  },
  "awaiting-attestation": {
    final: false,
    loss: "Nothing yet. Anyone can still request the attestation; the window has not closed.",
  },
  "attested-not-executed": {
    final: false,
    loss: "Nothing yet, and the attestation fee is already sunk whoever delivers it. Anyone can submit the proof, including the owner.",
  },
  "execution-failed": {
    final: false,
    loss: "Nothing on chain: a failed execution reverts, so the transaction id is not consumed, the nonce did not move, and the same proof can be delivered again once the cause is gone. Only gas was spent, by the executor who tried.",
  },
  expired: {
    final: true,
    loss: "Carrier payment and the attestation fee, if one was paid. The instruction can never run. The account's assets are untouched -- re-sign the same instruction in a fresh payment.",
  },
  "not-an-instruction": {
    final: true,
    loss: "Carrier payment. memokit will never act on this payment; it carries no memo it understands.",
  },
};

const CONTROLLER_ABI = [
  "function nonceOf(address) view returns (uint256)",
  "function isXrplTransactionConsumed(bytes32) view returns (bool)",
  "function isIgnored(address,bytes32) view returns (bool)",
  "function computeAccountAddress(string) view returns (address)",
  "function validityDurationSeconds() view returns (uint64)",
  "function receivingAddresses() view returns (string[])",
];

/**
 * The on-chain facts the classifier needs.
 *
 * An interface rather than a Contract so the state machine can be driven through every state
 * in a unit test without a node. The default implementation reads the real controller.
 */
export interface ChainView {
  accountFor(xrplOwner: string): Promise<string>;
  nonceOf(account: string): Promise<bigint>;
  isConsumed(transactionId: string): Promise<boolean>;
  isIgnored(account: string, transactionId: string): Promise<boolean>;
  validityDurationSeconds(): Promise<number>;
}

/** Reads the facts from a deployed memokit controller. */
export function controllerView(controllerAddress: string, provider: JsonRpcProvider): ChainView {
  const c = new Contract(controllerAddress, CONTROLLER_ABI, provider);
  return {
    accountFor: (owner) => c.computeAccountAddress(owner),
    nonceOf: (account) => c.nonceOf(account),
    isConsumed: (id) => c.isXrplTransactionConsumed(id),
    isIgnored: (account, id) => c.isIgnored(account, id),
    validityDurationSeconds: async () => Number(await c.validityDurationSeconds()),
  };
}

export interface ClassifyOptions {
  network: Network;
  controller: string;
  /** The XRPL address that owns the account. */
  xrplOwner: string;
  provider?: JsonRpcProvider;
  /** Overrides the receiving addresses read from the controller. */
  receivingAddresses?: string[];
  /** How many recent XRPL transactions to scan. */
  limit?: number;
  /**
   * Whether a proof exists for a transaction. Injected so the classifier stays testable and
   * does not hard-code a DA Layer client; the CLI passes a real one.
   */
  hasProof?: (transactionId: string, closedAt: number) => Promise<boolean>;
  /** Overrides the chain reader. Used by tests; the CLI leaves it unset. */
  chain?: ChainView;
  /** Overrides the wall clock, in unix seconds. Used by tests. */
  now?: number;
  /**
   * The committed preimage for a `0xFC` memo, if the caller has it.
   *
   * A commit memo carries only a hash, so the instruction's nonce -- the thing that decides
   * whether it can still execute -- is invisible from the ledger alone. Supplying the payload
   * upgrades those payments from "attested, nobody delivered" to a real verdict. Without it
   * the classifier does not guess: it reports what it can see and says so.
   *
   * The preimage is checked against the memo's commitment before it is trusted.
   */
  payloadFor?: (transactionId: string) => Promise<string | undefined> | string | undefined;
}

/** One XRPL payment, as the classifier needs to see it. */
export interface XrplPaymentRecord {
  hash: string;
  ledgerIndex: number;
  closedAt: number;
  destination: string;
  memo: string | null;
  /**
   * The XRPL address that sent it, when the caller knows it.
   *
   * Optional because the classifier is always called for a known owner and does not need it;
   * an executor watching a receiving address discovers owners this way, so the fetcher fills
   * it in.
   */
  sender?: string;
}

/**
 * Classify a set of XRPL payments.
 *
 * Separated from fetching so the state machine can be tested exhaustively without a ledger.
 */
export async function classifyPayments(
  payments: XrplPaymentRecord[],
  options: ClassifyOptions,
): Promise<ClassifiedPayment[]> {
  const chain =
    options.chain ??
    controllerView(
      options.controller,
      options.provider ?? new JsonRpcProvider(options.network.rpc),
    );

  const account = await chain.accountFor(options.xrplOwner);
  const accountNonce = await chain.nonceOf(account);
  const validityDuration = await chain.validityDurationSeconds();
  const now = options.now ?? Math.floor(Date.now() / 1000);

  const out: ClassifiedPayment[] = [];
  for (const p of payments) {
    out.push(
      await classifyOne(p, {
        chain,
        account,
        accountNonce,
        validityDuration,
        now,
        hasProof: options.hasProof,
        payloadFor: options.payloadFor,
      }),
    );
  }
  return out;
}

interface ClassifyContext {
  chain: ChainView;
  account: string;
  accountNonce: bigint;
  validityDuration: number;
  now: number;
  hasProof?: (transactionId: string, closedAt: number) => Promise<boolean>;
  payloadFor?: (transactionId: string) => Promise<string | undefined> | string | undefined;
}

async function classifyOne(
  p: XrplPaymentRecord,
  ctx: ClassifyContext,
): Promise<ClassifiedPayment> {
  const transactionId = "0x" + p.hash.replace(/^0x/, "").toLowerCase();
  const memo = p.memo ? fromXrplMemoData(p.memo) : null;
  const validitySecondsRemaining = p.closedAt + ctx.validityDuration - ctx.now;

  const base = {
    xrplHash: p.hash,
    transactionId,
    ledgerIndex: p.ledgerIndex,
    closedAt: p.closedAt,
    memo,
    accountNonce: ctx.accountNonce,
    validitySecondsRemaining,
  };

  let decodedMemo: Memo | null = null;
  let nonce: bigint | null = null;
  if (memo) {
    try {
      decodedMemo = decodeMemo(memo);
      if (decodedMemo.kind === "execInline") {
        nonce = decodedMemo.instruction.nonce;
      } else if (decodedMemo.kind === "execCommit" && ctx.payloadFor) {
        // Only trust a supplied preimage if it is the one the memo committed to.
        const payload = await ctx.payloadFor(transactionId);
        if (payload && keccak256(payload).toLowerCase() === decodedMemo.commitment.toLowerCase()) {
          nonce = decodeInstruction(payload).nonce;
        }
      }
    } catch {
      decodedMemo = null;
    }
  }

  if (!memo || !decodedMemo) {
    return {
      ...base,
      decodedMemo,
      nonce,
      state: "not-an-instruction",
      reason: memo ? "memo is not a memokit instruction" : "payment carries no memo",
      rescue: {
        action: "nothing-possible",
        memo: null,
        summary: "memokit will never act on this payment.",
        loss: RESCUE_STATES["not-an-instruction"].loss,
      },
    };
  }

  // Consumed is the one unambiguous on-chain fact: it is set only by a completed execution
  // (or a 0xE0 retirement), and a failed execution reverts the mark with everything else.
  const consumed = await ctx.chain.isConsumed(transactionId);
  if (consumed) {
    const wasIgnored = await ctx.chain.isIgnored(ctx.account, transactionId);
    const state: InstructionState = wasIgnored ? "retired" : "executed";
    return {
      ...base,
      decodedMemo,
      nonce,
      state,
      reason: "the transaction id is marked consumed on chain",
      rescue: null,
    };
  }

  if (validitySecondsRemaining <= 0) {
    return {
      ...base,
      decodedMemo,
      nonce,
      state: "expired",
      reason: `proof validity window closed ${-validitySecondsRemaining}s ago`,
      rescue: expiredRescue(decodedMemo, ctx),
    };
  }

  const proved = ctx.hasProof ? await ctx.hasProof(transactionId, p.closedAt) : false;
  if (!proved) {
    return {
      ...base,
      decodedMemo,
      nonce,
      state: "awaiting-attestation",
      reason: "no proof available from the DA Layer yet",
      rescue: {
        action: "request-attestation",
        memo: null,
        summary:
          "Request the attestation and wait one FDC round (~150 s). No XRPL payment needed.",
        loss: RESCUE_STATES["awaiting-attestation"].loss,
      },
    };
  }

  // A proof exists and the id is not consumed. Either nobody delivered it, or somebody tried
  // and it reverted. The chain does not distinguish these -- a reverted execution leaves no
  // trace -- so the honest classification depends on whether the instruction *can* succeed.
  const blocked = nonce !== null && nonce !== ctx.accountNonce;
  if (blocked) {
    return {
      ...base,
      decodedMemo,
      nonce,
      state: "execution-failed",
      reason: `instruction is bound to nonce ${nonce} but the account is at ${ctx.accountNonce}`,
      rescue: nonceRescue(nonce!, ctx.accountNonce),
    };
  }

  return {
    ...base,
    decodedMemo,
    nonce,
    state: "attested-not-executed",
    reason:
      nonce === null && decodedMemo.kind === "execCommit"
        ? "a proof is available and the transaction id is not consumed; the memo is a commitment, so the nonce is not visible without the preimage"
        : "a proof is available and the transaction id is not consumed",
    rescue: {
      action: "submit-proof",
      memo: null,
      summary:
        "Deliver the proof. Anyone can, including the owner; no XRPL payment is needed. If it reverts, the reason is in the revert data and nothing is lost.",
      loss: RESCUE_STATES["attested-not-executed"].loss,
    },
  };
}

function nonceRescue(instructionNonce: bigint, accountNonce: bigint): RescuePlan {
  if (instructionNonce < accountNonce) {
    // The account has already moved past this instruction. Nothing can bring it back: the
    // nonce check is equality, and nonces only go up.
    return {
      action: "nothing-possible",
      memo: null,
      summary: `The account is at nonce ${accountNonce} and this instruction is bound to ${instructionNonce}. Nonces only move forward, so it can never execute. Re-sign it at the current nonce.`,
      loss: RESCUE_STATES["expired"].loss,
    };
  }
  return {
    action: "send-rescue-memo",
    memo: buildNonceAtLeastMemo(instructionNonce),
    summary: `The instruction is ahead of the account. Send this 0xFB memo to advance the nonce to ${instructionNonce}, then redeliver the original proof.`,
    loss: RESCUE_STATES["execution-failed"].loss,
  };
}

function expiredRescue(memo: Memo, ctx: ClassifyContext): RescuePlan {
  // An expired instruction never consumed its nonce. The account can only reach nonce N+1 by
  // executing N, so a dead instruction at any nonce the account has NOT yet passed blocks
  // everything signed after it -- including one bound to exactly the current nonce, which is
  // the case that is easy to get wrong.
  if (memo.kind === "execInline" && memo.instruction.nonce >= ctx.accountNonce) {
    return {
      action: "send-rescue-memo",
      memo: buildNonceAtLeastMemo(memo.instruction.nonce + 1n),
      summary: `This payment can never execute, and anything signed after it is blocked behind its nonce. Send this 0xFB memo to step the account past ${memo.instruction.nonce}.`,
      loss: RESCUE_STATES.expired.loss,
    };
  }
  return {
    action: "nothing-possible",
    memo: null,
    summary:
      "The proof window closed. The account's assets never moved, so re-sign the same instruction in a fresh XRPL payment.",
    loss: RESCUE_STATES.expired.loss,
  };
}

/** A 0xFB memo: advance the account's nonce to at least `target`. Idempotent. */
export function buildNonceAtLeastMemo(target: bigint, walletId = 1): string {
  return encodeMemo({
    kind: "nonceAtLeast",
    opcode: Opcode.NonceAtLeast,
    walletId,
    executorFee: 0n,
    targetNonce: target,
  });
}

/** A 0xE0 memo: retire a stuck transaction id without dispatching its memo. */
export function buildRetireMemo(targetTransactionId: string, walletId = 1): string {
  return encodeMemo({
    kind: "ignore",
    opcode: Opcode.Ignore,
    walletId,
    executorFee: 0n,
    targetTransactionId,
  });
}

/** A 0xE2 memo: override the executor fee for a stuck transaction id. */
export function buildReplaceFeeMemo(
  targetTransactionId: string,
  newFee: bigint,
  walletId = 1,
): string {
  return encodeMemo({
    kind: "replaceFee",
    opcode: Opcode.ReplaceFee,
    walletId,
    executorFee: 0n,
    targetTransactionId,
    newFee,
  });
}

/** Decode an instruction payload for display, tolerating anything that is not one. */
export function describePayload(payload: string): string {
  try {
    const i = decodeInstruction(payload);
    return `sender=${i.sender} nonce=${i.nonce} calls=${i.calls.length} conditions=${(i.postConditions ?? []).length}`;
  } catch (e) {
    return `undecodable: ${(e as Error).message}`;
  }
}
