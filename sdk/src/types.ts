/**
 * memokit wire format types.
 *
 * The header is byte-identical to Flare Smart Accounts' memo header. See
 * `contracts/libraries/MemoCodec.sol` for the authoritative table; these two must agree,
 * and `test/MemoCodecConformance.t.sol` proves that they do against shared fixtures.
 */

/** Opcodes memokit implements. */
export const Opcode = {
  /** Execute an instruction carried inline in the memo. */
  ExecInline: 0xfd,
  /** Execute an instruction supplied out-of-band, committed to by hash. */
  ExecCommit: 0xfc,
  /** Retire a stuck transaction id without dispatching its memo. */
  Ignore: 0xe0,
  /** Advance the account's instruction nonce. */
  SetNonce: 0xe1,
  /** Override the executor fee for a specific transaction id. */
  ReplaceFee: 0xe2,
  /**
   * Advance the nonce to at least a target. Idempotent and monotonic.
   *
   * The race-free counterpart to {@link Opcode.SetNonce}: 0xE1 needs an exact value chosen at
   * signing time and reverts if anything else moved the nonce during the ~150 s the memo takes
   * to land, so the rescue for a stuck queue can fail precisely because the queue unstuck
   * itself. 0xFB says "be at least N", which cannot go stale.
   */
  NonceAtLeast: 0xfb,
} as const;

export type OpcodeValue = (typeof Opcode)[keyof typeof Opcode];

/** Reserved for future memokit opcodes; encoding one is rejected. */
export const RESERVED_OPCODES = [0xf8, 0xf9, 0xfa] as const;

/** Opcodes owned by Flare Smart Accounts. memokit never emits these. */
export const FSA_OPCODES = [0xff, 0xfe, 0xd0, 0xd1] as const;

export const HEADER_LENGTH = 10;
export const LENGTH_WORD = 42;
export const LENGTH_WORD_FEE = 50;

/**
 * XRPL caps the whole serialised Memos array at 1024 bytes. With a single MemoData and no
 * MemoType/MemoFormat, roughly 1019 bytes of payload survive serialisation.
 */
export const XRPL_MEMO_BUDGET_BYTES = 1019;

/** One call in a user operation. */
export interface Call {
  target: string;
  value: bigint;
  data: string;
}

/** The instruction an account executes. */
export interface Instruction {
  /** Must equal the personal account derived from the XRPL sender. */
  sender: string;
  /** Must equal the account's current on-chain nonce. */
  nonce: bigint;
  /**
   * Token the executor is paid in -- normally whatever the calls move, so the account never
   * has to hold a second asset. Ignored when `feeAmount` is zero. Committed to by the same
   * hash as the calls, so no executor can change it.
   */
  feeToken: string;
  /**
   * Executor fee in `feeToken` base units, paid only after every call has succeeded. Zero
   * means no fee. If the calls leave the account unable to pay it, the whole execution reverts.
   */
  feeAmount: bigint;
  calls: Call[];
  /**
   * Assertions evaluated after every call, before the fee is paid. A failure reverts the whole
   * execution, so the XRPL transaction is not consumed and the proof can be resubmitted.
   * Optional and defaults to none, but an instruction whose target can fail softly should
   * always carry one -- see the Kinetic note in PHASE3.md.
   */
  postConditions?: PostCondition[];
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Mirrors `PostConditions.MAX_POST_CONDITIONS`. */
export const MAX_POST_CONDITIONS = 32;

/**
 * What a post-condition asserts. Values must match `IPostConditions.Kind`.
 *
 * Post-conditions exist because Phase 2 found that Compound-family markets report most
 * failures as a nonzero return value rather than a revert, so a call can "succeed" while doing
 * nothing. A post-condition states what the instruction was *for*, separately from how it was
 * done, and lives inside the committed payload where no executor can weaken it.
 */
export enum PostConditionKind {
  Erc20BalanceAtLeast = 0,
  Erc20DeltaAtLeast = 1,
  NativeBalanceAtLeast = 2,
  NativeDeltaAtLeast = 3,
  FtsoRateAtLeast = 4,
}

/** One assertion, evaluated after all calls and before the executor is paid. */
export interface PostCondition {
  kind: PostConditionKind;
  /** ERC-20 for token kinds, the OUTPUT token for `FtsoRateAtLeast`, unset for native kinds. */
  token: string;
  /** Whose balance is measured. Any address, so a payout can assert each recipient was paid. */
  subject: string;
  /** Absolute floor, or minimum delta, in base units. Unused by `FtsoRateAtLeast`. */
  threshold: bigint;
  /** ABI-encoded {@link FtsoBound} for `FtsoRateAtLeast`; `"0x"` otherwise. */
  extra?: string;
}

/**
 * Bounds a realised swap rate against an FTSOv2 feed at execution time.
 *
 * Feed decimals are deliberately absent: they are read from the feed on chain, because they
 * vary by feed *and by network* (USDT/USD is 6 decimals on Coston2 and 5 on Flare mainnet).
 * Token decimals are here, because they are a property of the token, not of the oracle.
 */
export interface FtsoBound {
  /** bytes21 FTSOv2 feed id for the input token, e.g. `XRP/USD`. */
  feedIdIn: string;
  /** bytes21 FTSOv2 feed id for the output token. */
  feedIdOut: string;
  decimalsIn: number;
  decimalsOut: number;
  amountIn: bigint;
  /** How far below the oracle rate the fill may land, in basis points. */
  maxDeviationBps: number;
  /** Reject if either feed is staler than this, in seconds. */
  maxFeedAgeSeconds: bigint;
}

/** Fields every memo carries. */
export interface MemoHeader {
  opcode: number;
  walletId: number;
  /**
   * Header bytes 2..9. RESERVED: the executor fee lives in the payload now, so the contract
   * rejects any non-zero value. The field keeps its place and width so the header stays
   * byte-compatible with Flare's. {@link encodeMemo} refuses non-zero unless told otherwise.
   */
  executorFee: bigint;
}

/** Zero address: the `feeToken` of an instruction that pays no fee. */
export const NO_FEE_TOKEN = "0x0000000000000000000000000000000000000000";

export type Memo =
  | ({ kind: "execInline" } & MemoHeader & { instruction: Instruction })
  | ({ kind: "execCommit" } & MemoHeader & { commitment: string })
  | ({ kind: "ignore" } & MemoHeader & { targetTransactionId: string })
  | ({ kind: "setNonce" } & MemoHeader & { newNonce: bigint })
  | ({ kind: "nonceAtLeast" } & MemoHeader & { targetNonce: bigint })
  | ({ kind: "replaceFee" } & MemoHeader & { targetTransactionId: string; newFee: bigint });
