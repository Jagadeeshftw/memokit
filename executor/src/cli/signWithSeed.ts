/**
 * `memokit sign-with-seed` -- a stand-in for a wallet, for demos and dry runs.
 *
 *   npm run sign-with-seed -w @memokit/executor -- fixtures/measurements/signing/<commitment>.json
 *
 * Takes the unsigned payment `npm run sign` wrote, fills in Sequence, Fee and LastLedgerSequence
 * the way a wallet would, signs it with XRPL_SEED from the environment, and submits it.
 *
 * It exists because the QR `sign` prints uses a convention no wallet reads, and the one wallet
 * that could be driven properly -- Xaman, via `--xaman` -- needs developer credentials. It is not
 * how a memokit user signs. A user's key never leaves their wallet; this reads a seed from a file.
 * Use it where a real wallet is not available, and say so.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client, Wallet, type Payment } from "xrpl";
import { COSTON2 } from "@memokit/sdk";

const REPO = resolve(import.meta.dirname, "../../..");

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) throw new Error("usage: npm run sign-with-seed -w @memokit/executor -- <path to the .json that `sign` wrote>");
  const seed = process.env.XRPL_SEED;
  if (!seed) throw new Error("XRPL_SEED is not set. Load it with: set -a && . ./.env && set +a");

  const { unsigned } = JSON.parse(readFileSync(resolve(REPO, path), "utf8")) as { unsigned: Record<string, unknown> };
  const wallet = Wallet.fromSeed(seed);
  if (wallet.address !== unsigned.Account) {
    // A different signer is a different memokit account, and the instruction names this one.
    throw new Error(`XRPL_SEED is for ${wallet.address}, but this payment is from ${unsigned.Account}`);
  }

  const client = new Client(process.env.XRPL_WS ?? COSTON2.xrpl.websocket);
  await client.connect();
  try {
    const prepared = await client.autofill(unsigned as unknown as Payment);
    console.log(`signing as ${wallet.address}  (a stand-in for a wallet: the seed is read from the environment)`);
    console.log(`  autofilled  Sequence ${prepared.Sequence}, Fee ${prepared.Fee} drops, LastLedgerSequence ${prepared.LastLedgerSequence}`);
    const signed = wallet.sign(prepared);
    const result = await client.submitAndWait(signed.tx_blob);
    const outcome = (result.result.meta as { TransactionResult?: string } | undefined)?.TransactionResult;
    console.log(`  submitted   ${result.result.hash}`);
    console.log(`  result      ${outcome} in ledger ${result.result.ledger_index}`);
    if (outcome !== "tesSUCCESS") throw new Error(`the XRPL rejected the payment: ${outcome}`);
    console.log(`\nfollow it:   curl -s https://memokit-executor-production.up.railway.app/status/${result.result.hash}`);
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
