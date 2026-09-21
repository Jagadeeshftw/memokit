// The minimal public API.
//
//   build      prepareInstruction, encodeMemo, encodeInstruction, commitmentOf
//   attest     requestAttestation, waitForProof
//   execute    submit
//
// Sending the XRPL payment is `@memokit/sdk/xrpl` (needs the `xrpl` package). Anything lower
// level -- MIC construction, the FDC ABI, the response builder -- is `@memokit/sdk/fdc`.
export * from "./types.js";
export * from "./memo.js";
export * from "./networks.js";
export * from "./deadline.js";
export {
  prepareInstruction,
  requestAttestation,
  waitForProof,
  submit,
  fetchXrplTransaction,
  toTransactionId,
  CONTROLLER_ABI,
  type PreparedInstruction,
  type AttestationRequest,
  type AttestedProof,
} from "./flow.js";
