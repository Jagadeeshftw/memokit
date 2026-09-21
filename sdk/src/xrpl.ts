import { Client, Wallet, type Payment } from "xrpl";
import { COSTON2, type Network } from "./networks.js";
import { toXrplMemoData } from "./memo.js";
import { XRPL_MEMO_BUDGET_BYTES } from "./types.js";

/**
 * Sending the XRPL payment. This is the only module that needs the `xrpl` package, so it is a
 * separate entry point (`@memokit/sdk/xrpl`): code that only encodes memos and submits proofs
 * does not have to install it.
 *
 * Two constraints from Phase 0 are enforced here rather than discovered at settlement time:
 * exactly one memo, and no destination tag. The second is a real front-running vector -- a
 * third party who buys the tag upstream can race the user -- and the contract asserts it on
 * chain, so sending one would burn the payment.
 */
export class XrplSender {
  private client?: Client;

  constructor(private readonly websocket: string = COSTON2.xrpl.websocket) {}

  async connect(): Promise<Client> {
    if (!this.client?.isConnected()) {
      this.client = new Client(this.websocket);
      await this.client.connect();
    }
    return this.client;
  }

  async disconnect(): Promise<void> {
    if (this.client?.isConnected()) await this.client.disconnect();
  }

  /** Create and fund a Testnet account from the public faucet. Testnet only. */
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
    if (byteLength > XRPL_MEMO_BUDGET_BYTES) {
      throw new Error(
        `memo is ${byteLength} bytes; XRPL rejects a Memos array over ~${XRPL_MEMO_BUDGET_BYTES}`,
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
      // DestinationTag deliberately omitted: see the module comment.
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

/**
 * One-shot convenience: connect, send, disconnect.
 * @param drops Amount in drops (1 XRP = 1,000,000). The amount is not the instruction's value;
 *              it only has to be a valid payment to a registered receiving address.
 */
export async function sendMemoPayment(args: {
  network?: Network;
  wallet: Wallet;
  destination: string;
  drops: string;
  memo: string;
}): Promise<{ hash: string; ledgerIndex: number; validated: boolean }> {
  const sender = new XrplSender((args.network ?? COSTON2).xrpl.websocket);
  try {
    return await sender.sendMemoPayment(args.wallet, args.destination, args.drops, args.memo);
  } finally {
    await sender.disconnect();
  }
}
