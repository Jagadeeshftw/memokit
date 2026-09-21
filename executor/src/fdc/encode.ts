import { keccak256, concat, toUtf8Bytes } from "ethers";
import {
  coder,
  b32,
  REQUEST_ABI,
  RESPONSE_ABI,
  type XrpPaymentRequestBody,
  type XrpPaymentResponse,
} from "./abi.js";
import { ATTESTATION_TYPE_XRP_PAYMENT } from "../config.js";

/**
 * Offline construction of an FDC attestation request.
 *
 * Flare's verifier will do this for you, but it is API-keyed and Flare-operated, so keeping it
 * off the critical path is a deliberate choice: everything here is pure computation over data
 * we already hold. `measure/micOracle.ts` checks the result against the verifier so the
 * independence is proven rather than assumed.
 */

/** Salt appended before hashing, per the FDC message-integrity-code construction. */
export const MIC_SALT = "Flare";

/**
 * Candidate MIC constructions.
 *
 * Flare documents the MIC loosely and publishes nothing at all for `XRPPayment`, so rather
 * than guess once and hope, we enumerate the plausible constructions and let the live
 * verifier pick the winner (see `measure/micOracle.ts`). Once identified, {@link computeMic}
 * uses it directly; the others stay as documentation of what was ruled out.
 */
export const MIC_CANDIDATES = {
  /** keccak(abi.encode(response) ++ "Flare"), votingRound zeroed. */
  zeroRoundSaltAppended: (response: XrpPaymentResponse) =>
    keccak256(concat([encodeResponse({ ...response, votingRound: 0n }), toUtf8Bytes(MIC_SALT)])),
  /** keccak(abi.encode(response) ++ "Flare"), votingRound left as returned. */
  keepRoundSaltAppended: (response: XrpPaymentResponse) =>
    keccak256(concat([encodeResponse(response), toUtf8Bytes(MIC_SALT)])),
  /** keccak(abi.encode(response, "Flare")), votingRound zeroed. */
  zeroRoundSaltEncoded: (response: XrpPaymentResponse) =>
    keccak256(
      coder.encode([RESPONSE_ABI, "string"], [toTuple({ ...response, votingRound: 0n }), MIC_SALT]),
    ),
  /** keccak(abi.encode(response)), votingRound zeroed, no salt. */
  zeroRoundNoSalt: (response: XrpPaymentResponse) =>
    keccak256(encodeResponse({ ...response, votingRound: 0n })),
} as const;

export type MicCandidateName = keyof typeof MIC_CANDIDATES;

/**
 * The construction confirmed against the live verifier.
 * @see docs/fdc-xrppayment.md and PHASE1.md for the evidence.
 */
export const CONFIRMED_MIC_CANDIDATE: MicCandidateName = "zeroRoundSaltEncoded";

function toTuple(response: XrpPaymentResponse): unknown[] {
  const r = response.responseBody;
  return [
    response.attestationType,
    response.sourceId,
    response.votingRound,
    response.lowestUsedTimestamp,
    [response.requestBody.transactionId, response.requestBody.proofOwner],
    [
      r.blockNumber,
      r.blockTimestamp,
      r.sourceAddress,
      r.sourceAddressHash,
      r.receivingAddressHash,
      r.intendedReceivingAddressHash,
      r.spentAmount,
      r.intendedSpentAmount,
      r.receivedAmount,
      r.intendedReceivedAmount,
      r.hasMemoData,
      r.firstMemoData,
      r.hasDestinationTag,
      r.destinationTag,
      r.status,
    ],
  ];
}

/** ABI-encode a full attestation response. */
export function encodeResponse(response: XrpPaymentResponse): string {
  return coder.encode([RESPONSE_ABI], [toTuple(response)]);
}

/** Message integrity code for a response, using the confirmed construction. */
export function computeMic(response: XrpPaymentResponse): string {
  return MIC_CANDIDATES[CONFIRMED_MIC_CANDIDATE](response);
}

/**
 * ABI-encode the attestation request submitted to `FdcHub.requestAttestation`.
 * @param messageIntegrityCode MIC of the response we expect; the zero hash when probing.
 */
export function encodeRequest(
  requestBody: XrpPaymentRequestBody,
  sourceId: string,
  messageIntegrityCode: string,
): string {
  return coder.encode(
    [REQUEST_ABI],
    [
      [
        b32(ATTESTATION_TYPE_XRP_PAYMENT),
        b32(sourceId),
        messageIntegrityCode,
        [requestBody.transactionId, requestBody.proofOwner],
      ],
    ],
  );
}

export const ZERO_HASH = "0x" + "00".repeat(32);
