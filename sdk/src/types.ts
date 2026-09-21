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
} as const;

export type OpcodeValue = (typeof Opcode)[keyof typeof Opcode];

/** Reserved for future memokit opcodes; encoding one is rejected. */
export const RESERVED_OPCODES = [0xf8, 0xf9, 0xfa, 0xfb] as const;

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
  calls: Call[];
}

/** Fields every memo carries. */
export interface MemoHeader {
  opcode: number;
  walletId: number;
  executorFee: bigint;
}

export type Memo =
  | ({ kind: "execInline" } & MemoHeader & { instruction: Instruction })
  | ({ kind: "execCommit" } & MemoHeader & { commitment: string })
  | ({ kind: "ignore" } & MemoHeader & { targetTransactionId: string })
  | ({ kind: "setNonce" } & MemoHeader & { newNonce: bigint })
  | ({ kind: "replaceFee" } & MemoHeader & { targetTransactionId: string; newFee: bigint });
