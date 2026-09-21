import { keccak256, toUtf8Bytes, ZeroAddress } from "ethers";
import { b32, type XrpPaymentResponse } from "./abi.js";
import { ATTESTATION_TYPE_XRP_PAYMENT } from "../networks.js";

/**
 * Reconstructs an FDC `XRPPayment` attestation response from raw XRPL ledger data.
 *
 * This is what lets memokit compute a message integrity code without asking Flare's
 * verifier. The verifier is API-keyed and Flare-operated; a user should not need Flare's
 * permission to move their own funds, so the only thing we take from the verifier is
 * confirmation that this function is correct (`executor/src/measure/micOracle.ts`, and the offline
 * regression in `test/buildResponse.test.ts` which asserts field-for-field equality with a
 * captured verifier response).
 *
 * Every field below is derived from the transaction as the ledger recorded it.
 */

/** Seconds between the Unix epoch and the Ripple epoch (2000-01-01T00:00:00Z). */
export const RIPPLE_EPOCH_OFFSET = 946_684_800;

/** The shape of a validated XRPL `tx` result, narrowed to the fields we consume. */
export interface XrplTransactionResult {
  Account: string;
  Destination: string;
  /**
   * The amount the sender asked to deliver. rippled's API v2 renames this to `DeliverMax`
   * inside `tx_json` while older responses still say `Amount`; both are accepted, because
   * reading the wrong one silently yields a zero `intendedReceivedAmount` and therefore a
   * message integrity code Flare will never match.
   */
  Amount?: string | { value: string };
  DeliverMax?: string | { value: string };
  Fee: string;
  DestinationTag?: number;
  Memos?: Array<{ Memo: { MemoData?: string; MemoType?: string; MemoFormat?: string } }>;
  ledger_index?: number;
  close_time_iso?: string;
  tx_json?: Record<string, unknown>;
  meta?: { TransactionResult?: string; delivered_amount?: string | { value: string } };
  metaData?: { TransactionResult?: string; delivered_amount?: string | { value: string } };
  validated?: boolean;
  date?: number;
}

const hashAddress = (address: string) => keccak256(toUtf8Bytes(address));

function drops(value: string | { value: string } | undefined): bigint {
  if (value === undefined) return 0n;
  if (typeof value === "string") return BigInt(value);
  // Issued currencies are not XRP drops; memokit only handles native XRP payments.
  throw new Error("payment is not denominated in XRP drops");
}

export class UnsupportedPaymentError extends Error {}

/**
 * Build the attestation response FDC would produce for this transaction.
 *
 * @param tx A validated XRPL `Payment`, as returned by the `tx` JSON-RPC method.
 * @param sourceId FDC source id, e.g. `testXRP`.
 * @param transactionId The transaction hash, 0x-prefixed lowercase.
 * @param proofOwner Address authorised to use the proof; zero for an open proof.
 */
export function buildXrpPaymentResponse(
  tx: XrplTransactionResult,
  sourceId: string,
  transactionId: string,
  proofOwner: string = ZeroAddress,
): XrpPaymentResponse {
  const meta = tx.meta ?? tx.metaData;
  if (!meta?.TransactionResult) {
    throw new UnsupportedPaymentError("transaction metadata is missing; is it validated?");
  }

  // FDC reports 0 for a successful payment. Anything else is a failure code; memokit's
  // contract rejects non-zero, so we surface the distinction rather than normalising it.
  const status = meta.TransactionResult === "tesSUCCESS" ? 0 : 1;

  const intendedReceived = drops(tx.Amount ?? tx.DeliverMax);
  const received = meta.delivered_amount !== undefined ? drops(meta.delivered_amount) : intendedReceived;
  const fee = BigInt(tx.Fee);

  // The ledger records what left the sender as amount plus fee.
  const spent = received + fee;
  const intendedSpent = intendedReceived + fee;

  const memos = tx.Memos ?? [];
  const firstMemo = memos[0]?.Memo?.MemoData;
  const hasMemoData = firstMemo !== undefined && firstMemo.length > 0;

  const blockTimestamp = resolveTimestamp(tx);

  return {
    attestationType: b32(ATTESTATION_TYPE_XRP_PAYMENT),
    sourceId: b32(sourceId),
    // Zero for MIC purposes; the attestation providers fill in the real round.
    votingRound: 0n,
    lowestUsedTimestamp: BigInt(blockTimestamp),
    requestBody: { transactionId, proofOwner },
    responseBody: {
      blockNumber: BigInt(tx.ledger_index ?? 0),
      blockTimestamp: BigInt(blockTimestamp),
      sourceAddress: tx.Account,
      sourceAddressHash: hashAddress(tx.Account),
      receivingAddressHash: hashAddress(tx.Destination),
      intendedReceivingAddressHash: hashAddress(tx.Destination),
      spentAmount: spent,
      intendedSpentAmount: intendedSpent,
      receivedAmount: received,
      intendedReceivedAmount: intendedReceived,
      hasMemoData,
      firstMemoData: hasMemoData ? "0x" + firstMemo!.toLowerCase() : "0x",
      hasDestinationTag: tx.DestinationTag !== undefined,
      destinationTag: BigInt(tx.DestinationTag ?? 0),
      status,
    },
  };
}

function resolveTimestamp(tx: XrplTransactionResult): number {
  if (tx.close_time_iso) {
    return Math.floor(new Date(tx.close_time_iso).getTime() / 1000);
  }
  if (typeof tx.date === "number") {
    return tx.date + RIPPLE_EPOCH_OFFSET;
  }
  throw new UnsupportedPaymentError("transaction carries no close time");
}
