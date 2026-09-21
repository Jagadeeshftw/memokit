/**
 * Determines, empirically, how the FDC message integrity code is constructed for the
 * `XRPPayment` attestation type -- and proves memokit can build one without the verifier.
 *
 * Why this script exists: Flare publishes no developer-hub page for `XRPPayment`, so the
 * request encoding and the MIC are transcribed from the periphery interfaces. Transcription
 * can be wrong in ways that only surface as an unattested request days later. This runs a
 * real XRPL Testnet payment through Flare's own verifier and checks our offline computation
 * against the answer, so the encoder is verified rather than believed.
 *
 * Run: npm run verify:mic -w @memokit/executor
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { encodeMemo, commitmentOf, type Instruction } from "@memokit/sdk";
import { ZeroAddress } from "ethers";
import { SOURCE_ID_TESTNET, NETWORK } from "../config.js";
import { toTransactionId } from "@memokit/sdk";
import { XrplSender } from "@memokit/sdk/xrpl";
import { VerifierClient } from "../fdc/verifier.js";
import {
  MIC_CANDIDATES,
  encodeRequest,
  buildXrpPaymentResponse,
  type MicCandidateName,
  type XrpPaymentResponse,
} from "@memokit/sdk/fdc";

const OUT = resolve(import.meta.dirname, "../../../fixtures/xrppayment-oracle.json");

/** The DA Layer and verifier return numbers as decimal strings; the ABI coder wants bigint. */
function toResponse(raw: Record<string, any>): XrpPaymentResponse {
  const rb = raw.responseBody;
  return {
    attestationType: raw.attestationType,
    sourceId: raw.sourceId,
    votingRound: BigInt(raw.votingRound ?? 0),
    lowestUsedTimestamp: BigInt(raw.lowestUsedTimestamp ?? 0),
    requestBody: {
      transactionId: raw.requestBody.transactionId,
      proofOwner: raw.requestBody.proofOwner ?? ZeroAddress,
    },
    responseBody: {
      blockNumber: BigInt(rb.blockNumber),
      blockTimestamp: BigInt(rb.blockTimestamp),
      sourceAddress: rb.sourceAddress,
      sourceAddressHash: rb.sourceAddressHash,
      receivingAddressHash: rb.receivingAddressHash,
      intendedReceivingAddressHash: rb.intendedReceivingAddressHash,
      spentAmount: BigInt(rb.spentAmount),
      intendedSpentAmount: BigInt(rb.intendedSpentAmount),
      receivedAmount: BigInt(rb.receivedAmount),
      intendedReceivedAmount: BigInt(rb.intendedReceivedAmount),
      hasMemoData: Boolean(rb.hasMemoData),
      firstMemoData: rb.firstMemoData,
      hasDestinationTag: Boolean(rb.hasDestinationTag),
      destinationTag: BigInt(rb.destinationTag ?? 0),
      status: Number(rb.status),
    },
  };
}

async function main() {
  const xrpl = new XrplSender(NETWORK.xrpl.websocket);
  const verifier = new VerifierClient();

  console.log("funding two XRPL Testnet accounts from the public faucet...");
  const sender = await xrpl.fundedWallet();
  const receiver = await xrpl.fundedWallet();
  console.log(`  sender   ${sender.address}`);
  console.log(`  receiver ${receiver.address}`);

  // A realistic memokit memo: 0xFC, 42 bytes, committing to an instruction.
  const instruction: Instruction = {
    sender: "0x1111111111111111111111111111111111111111",
    nonce: 0n,
    feeToken: "0x0000000000000000000000000000000000000000",
    feeAmount: 0n,
    calls: [{ target: "0x2222222222222222222222222222222222222222", value: 0n, data: "0xdeadbeef" }],
  };
  const memo = encodeMemo({
    kind: "execCommit",
    opcode: 0xfc,
    walletId: 1,
    executorFee: 0n,
    commitment: commitmentOf(instruction),
  });
  console.log(`memo (${(memo.length - 2) / 2} bytes): ${memo}`);

  console.log("sending XRPL Testnet payment...");
  const sent = await xrpl.sendMemoPayment(sender, receiver.address, "1000000", memo);
  console.log(`  hash ${sent.hash}  ledger ${sent.ledgerIndex}  validated ${sent.validated}`);

  const transactionId = toTransactionId(sent.hash);
  const requestBody = { transactionId, proofOwner: ZeroAddress };

  // The verifier indexes with a lag; retry until the transaction is visible.
  let response: XrpPaymentResponse | undefined;
  let rawResponse: Record<string, any> | undefined;
  for (let attempt = 1; attempt <= 30; attempt++) {
    const prepared = await verifier.prepareResponse(requestBody, SOURCE_ID_TESTNET);
    if (prepared.status === "VALID" && prepared.response) {
      rawResponse = prepared.response as Record<string, any>;
      response = toResponse(rawResponse);
      console.log(`  verifier indexed the transaction after ${attempt} attempt(s)`);
      break;
    }
    console.log(`  attempt ${attempt}: ${prepared.status}`);
    await new Promise((r) => setTimeout(r, 4_000));
  }
  if (!response || !rawResponse) throw new Error("verifier never indexed the transaction");

  // Pull the raw ledger record so the offline response builder can be checked against
  // Flare's answer field by field.
  const client = await xrpl.connect();
  const rawTx = (await client.request({
    command: "tx",
    transaction: sent.hash,
  } as never)) as { result: Record<string, any> };
  const ledgerTx = { ...(rawTx.result.tx_json ?? {}), ...rawTx.result };

  const micResult = await verifier.mic(requestBody, SOURCE_ID_TESTNET);
  const flareMic = micResult.messageIntegrityCode;
  if (!flareMic) throw new Error(`verifier returned no MIC: ${JSON.stringify(micResult)}`);

  console.log(`\nFlare's MIC:  ${flareMic}`);
  console.log("offline candidates:");
  const results: Record<string, { mic: string; matches: boolean }> = {};
  let winner: MicCandidateName | undefined;
  for (const [name, fn] of Object.entries(MIC_CANDIDATES)) {
    let mic: string;
    try {
      mic = fn(response);
    } catch (e) {
      mic = `ERROR: ${(e as Error).message}`;
    }
    const matches = mic === flareMic;
    if (matches) winner = name as MicCandidateName;
    results[name] = { mic, matches };
    console.log(`  ${matches ? "MATCH" : "     "}  ${name.padEnd(26)} ${mic}`);
  }

  // Independently check the encoded request, using Flare's own MIC so that a mismatch here
  // is unambiguously about the request encoding rather than the MIC.
  const prepared = await verifier.prepareRequest(requestBody, SOURCE_ID_TESTNET);
  const ours = encodeRequest(requestBody, SOURCE_ID_TESTNET, flareMic);
  const requestMatches = prepared.abiEncodedRequest?.toLowerCase() === ours.toLowerCase();
  console.log(`\nencoded request matches verifier: ${requestMatches}`);
  if (!requestMatches) {
    console.log(`  verifier: ${prepared.abiEncodedRequest}`);
    console.log(`  ours:     ${ours}`);
  }

  // The real prize: can we build the response ourselves, with no verifier at all?
  const ourResponse = buildXrpPaymentResponse(
    ledgerTx as never,
    SOURCE_ID_TESTNET,
    transactionId,
    ZeroAddress,
  );
  const ourMic = MIC_CANDIDATES[winner ?? "zeroRoundSaltEncoded"](ourResponse);
  const offlineMicMatches = ourMic === flareMic;
  console.log(`\noffline-built response reproduces Flare's MIC: ${offlineMicMatches}`);
  if (!offlineMicMatches) {
    console.log("  field differences vs the verifier's response:");
    for (const [k, v] of Object.entries(ourResponse.responseBody)) {
      const theirs = (rawResponse.responseBody as Record<string, unknown>)[k];
      const same = String(v).toLowerCase() === String(theirs).toLowerCase();
      if (!same) console.log(`    ${k}: ours=${v} theirs=${theirs}`);
    }
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        note: "Generated by executor/src/measure/micOracle.ts against live XRPL Testnet + Flare verifier.",
        capturedAt: new Date().toISOString(),
        xrplTransactionHash: sent.hash,
        transactionId,
        memo,
        flareMic,
        winningCandidate: winner ?? null,
        candidates: results,
        abiEncodedRequestMatches: requestMatches,
        offlineMicMatches,
        offlineResponse: ourResponse,
        rawXrplTransaction: ledgerTx,
        verifierAbiEncodedRequest: prepared.abiEncodedRequest ?? null,
        rawResponse,
      },
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ) + "\n",
  );
  console.log(`\nwrote ${OUT}`);
  console.log(winner ? `\nCONFIRMED MIC CONSTRUCTION: ${winner}` : "\nNO CANDIDATE MATCHED");
  console.log(
    offlineMicMatches
      ? "VERIFIER-FREE PATH CONFIRMED: request and MIC computed from ledger data alone."
      : "VERIFIER-FREE PATH NOT YET CONFIRMED (see field differences above).",
  );

  await xrpl.disconnect();
  if (!winner) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
