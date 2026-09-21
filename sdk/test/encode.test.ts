import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ZeroAddress, keccak256 } from "ethers";
import {
  MIC_CANDIDATES,
  CONFIRMED_MIC_CANDIDATE,
  computeMic,
  encodeRequest,
  encodeResponse,
} from "../src/fdc/encode.js";
import type { XrpPaymentResponse } from "../src/fdc/abi.js";
import { SOURCE_ID_TESTNET } from "../src/networks.js";

/**
 * Offline regression for the FDC `XRPPayment` encoding.
 *
 * The values here were captured from live XRPL Testnet and Flare's own verifier by
 * `src/measure/micOracle.ts`. Pinning them means the encoder keeps agreeing with Flare
 * without needing the network -- and, more importantly, that a change to the encoder which
 * would silently produce unattestable requests fails here instead of in production.
 */
const oracle = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../fixtures/xrppayment-oracle.json"), "utf8"),
);

function toResponse(raw: any): XrpPaymentResponse {
  const rb = raw.responseBody;
  return {
    attestationType: raw.attestationType,
    sourceId: raw.sourceId,
    votingRound: BigInt(raw.votingRound),
    lowestUsedTimestamp: BigInt(raw.lowestUsedTimestamp),
    requestBody: { transactionId: raw.requestBody.transactionId, proofOwner: raw.requestBody.proofOwner },
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
      hasMemoData: rb.hasMemoData,
      firstMemoData: rb.firstMemoData,
      hasDestinationTag: rb.hasDestinationTag,
      destinationTag: BigInt(rb.destinationTag),
      status: Number(rb.status),
    },
  };
}

const response = toResponse(oracle.rawResponse);

describe("XRPPayment MIC", () => {
  it("reproduces the MIC Flare's verifier returned", () => {
    expect(computeMic(response)).toEqual(oracle.flareMic);
  });

  it("uses the construction the oracle identified", () => {
    expect(CONFIRMED_MIC_CANDIDATE).toEqual(oracle.winningCandidate);
  });

  /**
   * The salt is an ABI-encoded string parameter, not raw bytes concatenated after the
   * encoding. Those differ, and the difference is invisible until an attestation request
   * is silently never confirmed. Guard the distinction explicitly.
   */
  it("distinguishes an encoded salt from an appended one", () => {
    expect(MIC_CANDIDATES.zeroRoundSaltEncoded(response)).toEqual(oracle.flareMic);
    expect(MIC_CANDIDATES.zeroRoundSaltAppended(response)).not.toEqual(oracle.flareMic);
    expect(MIC_CANDIDATES.zeroRoundNoSalt(response)).not.toEqual(oracle.flareMic);
  });

  it("changes when any response field changes", () => {
    const tweaked = { ...response, responseBody: { ...response.responseBody, receivedAmount: 1n } };
    expect(computeMic(tweaked)).not.toEqual(oracle.flareMic);
  });
});

describe("XRPPayment request encoding", () => {
  it("reproduces the verifier's abiEncodedRequest", () => {
    const ours = encodeRequest(
      { transactionId: oracle.transactionId, proofOwner: ZeroAddress },
      SOURCE_ID_TESTNET,
      oracle.flareMic,
    );
    expect(ours.toLowerCase()).toEqual(oracle.verifierAbiEncodedRequest.toLowerCase());
  });
});

describe("XRPPayment response shape", () => {
  /** The premise of the whole architecture: the full memo comes back, not a 32-byte digest. */
  it("returns the memo verbatim", () => {
    expect(oracle.rawResponse.responseBody.firstMemoData).toEqual(oracle.memo);
  });

  it("returns the source address as a string whose hash matches", () => {
    const { sourceAddress, sourceAddressHash } = oracle.rawResponse.responseBody;
    expect(typeof sourceAddress).toBe("string");
    expect(keccak256(Buffer.from(sourceAddress, "utf8"))).toEqual(sourceAddressHash);
  });

  it("reports the absence of a destination tag", () => {
    expect(oracle.rawResponse.responseBody.hasDestinationTag).toBe(false);
  });

  it("round-trips through the response encoder without throwing", () => {
    expect(() => encodeResponse(response)).not.toThrow();
  });
});
