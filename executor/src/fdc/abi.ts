import { AbiCoder, encodeBytes32String } from "ethers";

/**
 * ABI shapes for the FDC `XRPPayment` attestation type.
 *
 * Transcribed from `@flarenetwork/flare-periphery-contracts/coston2/IXRPPayment.sol` at the
 * pinned version. Flare publishes no developer-hub page for this type, so this transcription
 * is checked against the live verifier in `measure/micOracle.ts` rather than trusted.
 */
export const REQUEST_BODY_ABI = "tuple(bytes32 transactionId, address proofOwner)";

export const RESPONSE_BODY_ABI = [
  "tuple(",
  "uint64 blockNumber,",
  "uint64 blockTimestamp,",
  "string sourceAddress,",
  "bytes32 sourceAddressHash,",
  "bytes32 receivingAddressHash,",
  "bytes32 intendedReceivingAddressHash,",
  "int256 spentAmount,",
  "int256 intendedSpentAmount,",
  "int256 receivedAmount,",
  "int256 intendedReceivedAmount,",
  "bool hasMemoData,",
  "bytes firstMemoData,",
  "bool hasDestinationTag,",
  "uint256 destinationTag,",
  "uint8 status",
  ")",
].join(" ");

export const REQUEST_ABI = [
  "tuple(",
  "bytes32 attestationType,",
  "bytes32 sourceId,",
  "bytes32 messageIntegrityCode,",
  `${REQUEST_BODY_ABI} requestBody`,
  ")",
].join(" ");

export const RESPONSE_ABI = [
  "tuple(",
  "bytes32 attestationType,",
  "bytes32 sourceId,",
  "uint64 votingRound,",
  "uint64 lowestUsedTimestamp,",
  `${REQUEST_BODY_ABI} requestBody,`,
  `${RESPONSE_BODY_ABI} responseBody`,
  ")",
].join(" ");

export const coder = AbiCoder.defaultAbiCoder();

export const b32 = (s: string) => encodeBytes32String(s);

export interface XrpPaymentRequestBody {
  transactionId: string;
  proofOwner: string;
}

export interface XrpPaymentResponseBody {
  blockNumber: bigint;
  blockTimestamp: bigint;
  sourceAddress: string;
  sourceAddressHash: string;
  receivingAddressHash: string;
  intendedReceivingAddressHash: string;
  spentAmount: bigint;
  intendedSpentAmount: bigint;
  receivedAmount: bigint;
  intendedReceivedAmount: bigint;
  hasMemoData: boolean;
  firstMemoData: string;
  hasDestinationTag: boolean;
  destinationTag: bigint;
  status: number;
}

export interface XrpPaymentResponse {
  attestationType: string;
  sourceId: string;
  votingRound: bigint;
  lowestUsedTimestamp: bigint;
  requestBody: XrpPaymentRequestBody;
  responseBody: XrpPaymentResponseBody;
}
