/**
 * Fetch the XRPL payments an owner sent to a memokit receiving address.
 *
 * Kept apart from the classifier so the state machine stays testable without a ledger, and so
 * a caller with its own indexer can supply records from anywhere.
 */
import { Client } from "xrpl";
import type { Network } from "./networks.js";
import type { XrplPaymentRecord } from "./rescue.js";

/** Seconds between the Unix epoch and the Ripple epoch. */
const RIPPLE_EPOCH_OFFSET = 946_684_800;

export interface FetchOptions {
  network: Network;
  /** The XRPL address that owns the account. */
  xrplOwner: string;
  /** Only payments to these destinations are returned. */
  receivingAddresses: string[];
  /** Ledger entries to scan back through. */
  limit?: number;
  /** Reuse an existing connection rather than opening one. */
  client?: Client;
}

/**
 * Payments from `xrplOwner` to any of `receivingAddresses`, newest first.
 *
 * Only validated `Payment` transactions with a `tesSUCCESS` result are returned: anything
 * else never reached the receiving address, so there is nothing for memokit to act on and
 * nothing for the classifier to say.
 */
export async function fetchPaymentsToReceivers(
  options: FetchOptions,
): Promise<XrplPaymentRecord[]> {
  const owned = options.client;
  const client = owned ?? new Client(options.network.xrpl.websocket);
  if (!owned) await client.connect();

  try {
    const wanted = new Set(options.receivingAddresses);
    const response = await client.request({
      command: "account_tx",
      account: options.xrplOwner,
      limit: options.limit ?? 100,
      ledger_index_min: -1,
      ledger_index_max: -1,
    } as never);

    const rows = (response as { result: { transactions?: unknown[] } }).result.transactions ?? [];
    const out: XrplPaymentRecord[] = [];

    for (const row of rows as Array<Record<string, any>>) {
      const tx = row.tx_json ?? row.tx ?? {};
      const meta = row.meta ?? row.metaData ?? {};
      if (tx.TransactionType !== "Payment") continue;
      if (row.validated === false) continue;
      if (meta.TransactionResult !== "tesSUCCESS") continue;
      if (!wanted.has(tx.Destination)) continue;

      const memos = tx.Memos ?? [];
      const memoData: string | undefined = memos[0]?.Memo?.MemoData;

      out.push({
        hash: row.hash ?? tx.hash ?? row.tx_json?.hash,
        ledgerIndex: Number(row.ledger_index ?? tx.ledger_index ?? 0),
        closedAt: resolveClosedAt(row, tx),
        destination: tx.Destination,
        memo: memoData && memoData.length > 0 ? memoData : null,
      });
    }

    return out.sort((a, b) => b.ledgerIndex - a.ledgerIndex);
  } finally {
    if (!owned) await client.disconnect();
  }
}

function resolveClosedAt(row: Record<string, any>, tx: Record<string, any>): number {
  if (typeof row.close_time_iso === "string") {
    return Math.floor(new Date(row.close_time_iso).getTime() / 1000);
  }
  const date = row.date ?? tx.date;
  if (typeof date === "number") return date + RIPPLE_EPOCH_OFFSET;
  return 0;
}
