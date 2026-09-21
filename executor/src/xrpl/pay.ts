import { Client, Wallet, type Payment } from "xrpl";
import { XRPL_TESTNET } from "../config.js";
import { toXrplMemoData } from "@memokit/sdk";

/**
 * XRPL Testnet helpers for the end-to-end path.
 *
 * Two constraints from Phase 0 are enforced here rather than discovered at settlement time:
 * exactly one memo, and no destination tag. The second is a real front-running vector --
 * a third party who buys the tag upstream can race the user -- and the contract asserts it
 * on chain, so sending one would burn the payment.
 */
export const XRPL_MEMOS_BUDGET_BYTES = 1019;

export class XrplTestnet {
  private client?: Client;

  async connect(): Promise<Client> {
    if (!this.client?.isConnected()) {
      this.client = new Client(XRPL_TESTNET.websocket);
      await this.client.connect();
    }
    return this.client;
  }

  async disconnect(): Promise<void> {
    if (this.client?.isConnected()) await this.client.disconnect();
  }

  /** Create and fund a Testnet account from the public faucet. */
  async fundedWallet(): Promise<Wallet> {
    const client = await this.connect();
    const { wallet } = await client.fundWallet();
    return wallet;
  }

  /**
   * Send a Payment carrying exactly one memo.
   * @returns The transaction hash, uppercase hex, as FDC keys attestations by.
   */
  async sendMemoPayment(
    wallet: Wallet,
    destination: string,
    dropsAmount: string,
    memoHex: string,
  ): Promise<{ hash: string; ledgerIndex: number; validated: boolean }> {
    const memoData = toXrplMemoData(memoHex);
    const byteLength = memoData.length / 2;
    if (byteLength > XRPL_MEMOS_BUDGET_BYTES) {
      throw new Error(
        `memo is ${byteLength} bytes; XRPL rejects a Memos array over ~${XRPL_MEMOS_BUDGET_BYTES}`,
      );
    }

    const client = await this.connect();
    const tx: Payment = {
      TransactionType: "Payment",
      Account: wallet.address,
      Destination: destination,
      Amount: dropsAmount,
      // Exactly one memo, MemoData only. Adding MemoType or MemoFormat costs budget and,
      // on the classic `Payment` attestation, would void the standardPaymentReference.
      Memos: [{ Memo: { MemoData: memoData } }],
      // DestinationTag deliberately omitted: see the class comment.
    };

    const prepared = await client.autofill(tx);
    const signed = wallet.sign(prepared);
    const result = await client.submitAndWait(signed.tx_blob);

    return {
      hash: result.result.hash,
      ledgerIndex: result.result.ledger_index ?? 0,
      validated: result.result.validated ?? false,
    };
  }
}

/** FDC identifies XRPL transactions by their hash, 0x-prefixed and lowercase. */
export const toTransactionId = (hash: string) => "0x" + hash.replace(/^0x/, "").toLowerCase();
