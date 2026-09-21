/**
 * Builds the ABI-encoded `IXRPPayment.Proof` a fork test hands to `MemoController.execute`.
 *
 * SIMULATED VERIFICATION. The response is built exactly as production builds it -- by the SDK's
 * `buildXrpPaymentResponse` from an XRPL ledger record -- but the record is a *template* (the real
 * Coston2 capture in fixtures/xrppayment-oracle.json) with the sender, destination, memo, hash
 * and close time substituted, and the Merkle proof is empty. Nothing here was attested by FDC, so
 * the fork tests mock `FdcVerification.verifyXRPPayment` to return true. The real, attested path
 * is Phase 1's Coston2 trace (fixtures/measurements/e2e-trace-*.json); what this script buys is
 * that every *other* field the contract reads -- source id, status, timestamp, hashes, memo bytes,
 * no destination tag -- comes from the same code that runs in production, not from a hand-written
 * Solidity struct.
 *
 * Usage (called by vm.ffi):
 *   forkProof.ts <senderXrplAddress> <receivingXrplAddress> <memoHex> <txIdHex> <closeTimeUnix> [sourceId]
 * Prints one line: 0x-prefixed ABI encoding of (bytes32[] merkleProof, Response data).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildXrpPaymentResponse, coder, RESPONSE_ABI, toProofTuple } from "../src/fdc/index.js";

const [sender, receiving, memo, txId, closeTime, sourceId = "XRP"] = process.argv.slice(2);
if (!sender || !receiving || !memo || !txId || !closeTime) {
  console.error("usage: forkProof.ts <sender> <receiving> <memoHex> <txIdHex> <closeTimeUnix> [sourceId]");
  process.exit(2);
}

const oracle = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../fixtures/xrppayment-oracle.json"), "utf8"));
const template = oracle.rawXrplTransaction;

const ledgerTx = {
  ...template,
  Account: sender,
  Destination: receiving,
  Memos: [{ Memo: { MemoData: memo.replace(/^0x/, "").toUpperCase() } }],
  hash: txId.replace(/^0x/, "").toUpperCase(),
  close_time_iso: new Date(Number(closeTime) * 1000).toISOString().replace(".000Z", "Z"),
  validated: true,
};

const response = buildXrpPaymentResponse(ledgerTx, sourceId, txId.toLowerCase());
const proof = toProofTuple([], response);
process.stdout.write(coder.encode([`tuple(bytes32[] merkleProof, ${RESPONSE_ABI} data)`], [proof]));
