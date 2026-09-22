/**
 * The XRPL Payment that carries an instruction, unsigned.
 *
 * This is the last piece needed for memokit to be usable by somebody who does not run a script:
 * a transaction they can sign in the wallet that already holds their key, instead of pasting a
 * seed into ours. Everything else the SDK builds is either read-only or signed on Flare; this
 * is the one artefact a human has to approve.
 *
 * Deliberately **partially specified**. `Sequence`, `Fee` and `LastLedgerSequence` are left out
 * for the signing wallet to fill in, because they depend on the ledger at the moment of signing
 * and a value computed here would be stale by the time anyone scanned it. Every XRPL signer
 * autofills them; Xaman does it server-side.
 *
 * What is NOT left out is the memo, the destination and the amount. Those are the instruction.
 */
import type { Memo } from "./types.js";
import { encodeMemo, toXrplMemoData } from "./memo.js";

/** An XRPL Payment as a wallet expects to receive it, before autofill and before signing. */
export interface UnsignedPayment {
  TransactionType: "Payment";
  Account: string;
  Destination: string;
  /** Drops, as a decimal string. XRPL rejects a number here. */
  Amount: string;
  Memos: Array<{ Memo: { MemoData: string } }>;
  /** Present only when the caller asked for one. memokit itself needs no destination tag. */
  DestinationTag?: number;
}

export interface UnsignedPaymentArgs {
  /** The XRPL address that owns the memokit account: the signer. */
  owner: string;
  /** A registered memokit receiving address. */
  destination: string;
  /** The carrier amount, in drops. It is postage, not funding. */
  drops?: string;
  /** The memo, already encoded, or the memo object to encode. */
  memo: string | Memo;
  destinationTag?: number;
}

/**
 * The carrier amount.
 *
 * 1 XRP. It is not a fee and it does not fund anything -- memokit never spends it, and it is
 * the operator of the receiving address who ends up with it. It exists because an XRPL Payment
 * has to move something. See PHASE1.md for why the receiving address is a registry entry
 * rather than a per-user tag.
 */
export const CARRIER_DROPS = "1000000";

export function buildUnsignedPayment(args: UnsignedPaymentArgs): UnsignedPayment {
  const memoData =
    typeof args.memo === "string"
      ? toXrplMemoData(args.memo)
      : toXrplMemoData(encodeMemo(args.memo));

  const payment: UnsignedPayment = {
    TransactionType: "Payment",
    Account: args.owner,
    Destination: args.destination,
    Amount: args.drops ?? CARRIER_DROPS,
    Memos: [{ Memo: { MemoData: memoData } }],
  };
  if (args.destinationTag !== undefined) payment.DestinationTag = args.destinationTag;
  return payment;
}

/**
 * What a signer still has to supply, named rather than left as an absence.
 *
 * Returned alongside the transaction so a caller rendering it to a human can say "your wallet
 * will fill these in" instead of the human wondering what is missing.
 */
export const AUTOFILLED_BY_THE_WALLET = [
  "Sequence — the signer's next account sequence number",
  "Fee — the XRPL network fee, a few drops",
  "LastLedgerSequence — the ledger after which the transaction can no longer be included",
  "SigningPubKey and TxnSignature — produced by signing",
] as const;

/**
 * A `xrpl.to` / wallet deep link for the payment.
 *
 * XRPL has no universal signing URI the way EVM chains have EIP-681, so this is the one thing
 * here that is a convention rather than a standard: the transaction is JSON, base64url'd into
 * a fragment. A wallet that does not understand it loses nothing -- the JSON is also printed --
 * and Xaman, which is the one most people have, is driven through its own payload API instead
 * (see `executor/src/xaman.ts`), because a Xaman deep link has to be created server-side.
 */
export function toDataUri(payment: UnsignedPayment): string {
  const json = JSON.stringify(payment);
  const b64 = Buffer.from(json, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `xrpl:tx?json=${b64}`;
}
