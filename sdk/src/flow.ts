import { Contract, Interface, ZeroAddress, type ContractTransactionReceipt, type Signer } from "ethers";
import type { Network } from "./networks.js";
import { COSTON2 } from "./networks.js";
import type { Instruction } from "./types.js";
import { Opcode } from "./types.js";
import { commitmentOf, encodeInstruction, encodeMemo } from "./memo.js";
import { buildXrpPaymentResponse } from "./fdc/buildResponse.js";
import { computeMic, encodeRequest, decodeResponseHex, toProofTuple } from "./fdc/encode.js";
import type { XrpPaymentResponse } from "./fdc/abi.js";
import { DaLayerClient } from "./fdc/daLayer.js";
import { RoundClock } from "./fdc/rounds.js";

/**
 * The high-level path, in the order a user meets it:
 *
 *   prepareInstruction -> (send the XRPL payment) -> requestAttestation -> waitForProof -> submit
 *
 * Nothing here calls Flare's verifier. The attestation request and its message integrity code
 * are built from the XRPL ledger record (`fdc/buildResponse.ts`), so the only services on the
 * path are the XRPL server you read from, the Flare RPC you write to, and the DA Layer (which
 * needs no key).
 */

// --- 1. build the instruction ----------------------------------------------------------

export interface PreparedInstruction {
  /** The preimage. Keep it: `submit` needs it, the memo carries only its hash. */
  payload: string;
  /** keccak256 of `payload`, the value the memo commits to. */
  commitment: string;
  /** The memo to send in the XRPL payment (hex, 0x-prefixed, 42 bytes). */
  memo: string;
}

/**
 * Hash an instruction and wrap it in a 0xFC memo.
 *
 * The memo commits to the instruction by hash, so the same 42 bytes cover a payload of any
 * size, and whoever calls `execute` cannot change what runs: fee token, fee amount, deadline
 * and every call are inside the hashed bytes.
 */
export function prepareInstruction(instruction: Instruction, options: { walletId?: number } = {}): PreparedInstruction {
  const commitment = commitmentOf(instruction);
  const memo = encodeMemo({
    kind: "execCommit",
    opcode: Opcode.ExecCommit,
    walletId: options.walletId ?? 1,
    executorFee: 0n, // reserved: the fee lives in the instruction
    commitment,
  });
  return { payload: encodeInstruction(instruction), commitment, memo };
}

// --- 2. request the attestation --------------------------------------------------------

const REGISTRY_ABI = ["function getContractAddressByName(string) view returns (address)"];
const FDC_HUB_ABI = ["function requestAttestation(bytes) payable"];
const FEE_CONFIG_ABI = ["function getRequestFee(bytes) view returns (uint256)"];

/** `"0x" + hash`, lowercase: how FDC identifies an XRPL transaction. */
export const toTransactionId = (xrplHash: string) => "0x" + xrplHash.replace(/^0x/, "").toLowerCase();

/** Read a validated transaction back from an XRPL server, retrying while it propagates. */
export async function fetchXrplTransaction(
  xrplHash: string,
  network: Network = COSTON2,
  attempts = 10,
): Promise<Record<string, unknown>> {
  let last = "";
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(network.xrpl.jsonRpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "tx", params: [{ transaction: xrplHash, binary: false }] }),
    });
    const body = (await res.json()) as { result?: Record<string, unknown> };
    const result = body.result;
    if (result && result.validated === true) {
      // API v1 returns the transaction flat; v2 nests it in `tx_json`. Accept both.
      return { ...((result.tx_json as object) ?? {}), ...result };
    }
    last = JSON.stringify(result ?? body).slice(0, 200);
    await new Promise((r) => setTimeout(r, 1_500));
  }
  throw new Error(`XRPL transaction ${xrplHash} not validated on ${network.xrpl.jsonRpc} (last: ${last})`);
}

export interface AttestationRequest {
  transactionId: string;
  /** What FdcHub was sent, and what `waitForProof` looks the proof up by. */
  abiEncodedRequest: string;
  /** The MIC committed in the request: keccak256(abi.encode(expectedResponse, "Flare")). */
  messageIntegrityCode: string;
  votingRoundId: number;
  feeWei: bigint;
  /** The `requestAttestation` transaction. */
  txHash: string;
  blockNumber: number;
  /** The response reconstructed from the ledger, before FDC has said anything. */
  expectedResponse: XrpPaymentResponse;
}

/**
 * Ask FDC to attest an XRPL payment. Pays the request fee from `signer`.
 * @param signer   A Flare signer with a provider. Pays the fee; any account will do.
 * @param xrplHash Hash of the payment already validated on XRPL.
 */
export async function requestAttestation(args: {
  signer: Signer;
  xrplHash: string;
  network?: Network;
}): Promise<AttestationRequest> {
  const network = args.network ?? COSTON2;
  const provider = args.signer.provider;
  if (!provider) throw new Error("requestAttestation: the signer needs a provider");

  const transactionId = toTransactionId(args.xrplHash);
  const ledgerTx = await fetchXrplTransaction(args.xrplHash, network);
  const expectedResponse = buildXrpPaymentResponse(ledgerTx as never, network.sourceId, transactionId, ZeroAddress);
  const messageIntegrityCode = computeMic(expectedResponse);
  const abiEncodedRequest = encodeRequest({ transactionId, proofOwner: ZeroAddress }, network.sourceId, messageIntegrityCode);

  const registry = new Contract(network.contractRegistry, REGISTRY_ABI, provider);
  const [hubAddress, feeConfigAddress]: [string, string] = await Promise.all([
    registry.getContractAddressByName("FdcHub"),
    registry.getContractAddressByName("FdcRequestFeeConfigurations"),
  ]);
  const feeWei: bigint = await new Contract(feeConfigAddress, FEE_CONFIG_ABI, provider).getRequestFee(abiEncodedRequest);

  const tx = await new Contract(hubAddress, FDC_HUB_ABI, args.signer).requestAttestation(abiEncodedRequest, { value: feeWei });
  const receipt: ContractTransactionReceipt = await tx.wait();

  const relayAddress: string = await registry.getContractAddressByName("Relay");
  const votingRoundId = await new RoundClock(provider, relayAddress, network.daLayerUrl).roundIdOfBlock(receipt.blockNumber);

  return {
    transactionId,
    abiEncodedRequest,
    messageIntegrityCode,
    votingRoundId,
    feeWei,
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    expectedResponse,
  };
}

// --- 3. poll for the proof -------------------------------------------------------------

export interface AttestedProof {
  /** The argument `MemoController.execute` takes as `proof`: `[merkleProof, response]`. */
  proof: unknown[];
  /** The response FDC actually attested (decoded). */
  response: XrpPaymentResponse;
  /** The raw Merkle path, for logs and traces. */
  merkleProof: string[];
}

/**
 * Wait for the DA Layer to publish the proof for `request`.
 *
 * Expect about 150 s from the XRPL payment: most of it is FDC's voting round finalising, which
 * is a property of the protocol's cadence, not something polling faster shortens. The DA Layer
 * rate-limits (about 20 requests a minute measured), so the default interval is 10 s.
 *
 * Also checks that the attested memo is the memo that was sent, because a proof for a
 * different payment would otherwise fail only later, on chain.
 */
export async function waitForProof(args: {
  request: Pick<AttestationRequest, "abiEncodedRequest" | "votingRoundId" | "expectedResponse">;
  network?: Network;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<AttestedProof> {
  const network = args.network ?? COSTON2;
  const da = new DaLayerClient(network.daLayerUrl);
  const raw = await da.waitForProof(
    args.request.votingRoundId,
    args.request.abiEncodedRequest,
    Date.now() + (args.timeoutMs ?? 15 * 60_000),
    args.intervalMs ?? 10_000,
  );
  const response = decodeResponseHex(raw.response_hex);
  const sent = args.request.expectedResponse.responseBody.firstMemoData;
  if (response.responseBody.firstMemoData.toLowerCase() !== sent.toLowerCase()) {
    throw new Error(`attested memo ${response.responseBody.firstMemoData} != sent memo ${sent}`);
  }
  return { proof: toProofTuple(raw.proof, response), response, merkleProof: raw.proof };
}

// --- 4. submit -------------------------------------------------------------------------

/**
 * `IXRPPayment.Proof` is `(bytes32[] merkleProof, Response data)` -- one level of tuple, not
 * two. An extra pair of parentheses here fails only at call time, with "array is wrong length".
 */
export const CONTROLLER_ABI = [
  "function execute((bytes32[],(bytes32,bytes32,uint64,uint64,(bytes32,address),(uint64,uint64,string,bytes32,bytes32,bytes32,int256,int256,int256,int256,bool,bytes,bool,uint256,uint8))) proof, bytes data) payable",
  "function nonceOf(address) view returns (uint256)",
  "function computeAccountAddress(string) view returns (address)",
  "function accountOf(string) view returns (address)",
  "function isXrplTransactionConsumed(bytes32) view returns (bool)",
];
export const controllerInterface = new Interface(CONTROLLER_ABI);

/**
 * Deliver the proof and the preimage to the controller.
 *
 * Callable by anyone: the caller is paid the instruction's fee, and cannot alter what runs.
 * @returns The receipt; a revert throws, and leaves the transaction id unconsumed and the
 *          account's nonce unchanged, so the same proof can be resubmitted.
 */
export async function submit(args: {
  signer: Signer;
  controller: string;
  proof: unknown[];
  payload: string;
  /** Native value forwarded to the account for the calls to spend. Usually omitted. */
  value?: bigint;
}): Promise<ContractTransactionReceipt> {
  const c = new Contract(args.controller, CONTROLLER_ABI, args.signer);
  const tx = await c.execute(args.proof, args.payload, { value: args.value ?? 0n });
  return (await tx.wait()) as ContractTransactionReceipt;
}
