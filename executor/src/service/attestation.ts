/**
 * Rebuild an attestation request offline, and find its proof if one already exists.
 *
 * The request bytes are a pure function of the XRPL transaction: transaction id, source id and
 * a MIC computed from the ledger record. Nothing about them depends on who asked or when. That
 * is what makes both of the things below possible -- asking "has anyone attested this?" without
 * paying, and reusing a proof somebody else paid for.
 *
 * Shared by the pipeline (which uses it to avoid buying a second attestation) and the status
 * API (which uses it to answer "proved" for instructions this service never touched).
 */
import { Contract, JsonRpcProvider, ZeroAddress } from "ethers";
import type { Network } from "@memokit/sdk";
import {
  DaLayerClient,
  RoundClock,
  buildXrpPaymentResponse,
  computeMic,
  encodeRequest,
  type DaProofResponse,
} from "@memokit/sdk/fdc";

export interface RebuiltRequest {
  transactionId: string;
  abiEncodedRequest: string;
  messageIntegrityCode: string;
}

/** The exact bytes `FdcHub.requestAttestation` was or would be given for this payment. */
export async function rebuildRequest(
  xrplHash: string,
  network: Network,
): Promise<RebuiltRequest | null> {
  const transactionId = "0x" + xrplHash.replace(/^0x/, "").toLowerCase();
  const ledgerTx = await fetchLedgerTransaction(xrplHash, network);
  if (!ledgerTx) return null;

  const expected = buildXrpPaymentResponse(
    ledgerTx as never,
    network.sourceId,
    transactionId,
    ZeroAddress,
  );
  const messageIntegrityCode = computeMic(expected);
  return {
    transactionId,
    messageIntegrityCode,
    abiEncodedRequest: encodeRequest(
      { transactionId, proofOwner: ZeroAddress },
      network.sourceId,
      messageIntegrityCode,
    ),
  };
}

/**
 * Look for an existing proof in a small window of rounds after the XRPL close.
 *
 * Bounded deliberately. The DA Layer is keyed by (round, requestBytes) and allows roughly 20
 * requests a minute with no headers to pace against, so an unbounded search would spend the
 * whole budget answering one question. `null` means "not in the window", never "no proof" --
 * and every action taken on a `null` is idempotent, so guessing low is safe.
 */
const REGISTRY_ABI = ["function getContractAddressByName(string) view returns (address)"];

/**
 * The Relay address, from the Flare Contract Registry.
 *
 * Resolved rather than pinned because the registry is the one address Flare guarantees, and a
 * service meant to run unattended should not carry a constant that Flare can move.
 */
export async function relayAddress(network: Network, provider: JsonRpcProvider): Promise<string> {
  const registry = new Contract(network.contractRegistry, REGISTRY_ABI, provider);
  return await registry.getContractAddressByName("Relay");
}

export async function findProofNearClose(args: {
  abiEncodedRequest: string;
  closedAt: number;
  network: Network;
  provider: JsonRpcProvider;
  da: DaLayerClient;
  rounds?: number;
  /** Pass a resolved Relay address to save a registry lookup per call. */
  relay?: string;
  /** Awaited before each DA request, so callers share one budget. */
  gate?: () => Promise<void>;
}): Promise<{ votingRoundId: number; proof: DaProofResponse } | null> {
  const clock = new RoundClock(
    args.provider,
    args.relay ?? (await relayAddress(args.network, args.provider)),
    args.network.daLayerUrl,
  );
  const fromRound = await clock.roundIdAt(args.closedAt);
  const rounds = args.rounds ?? 3;

  for (let i = 0; i < rounds; i++) {
    if (args.gate) await args.gate();
    const votingRoundId = fromRound + i;
    const { status, body } = await args.da.proofByRequestRound(votingRoundId, args.abiEncodedRequest);
    if (status === 200 && "proof" in body && "response_hex" in body) {
      return { votingRoundId, proof: body as DaProofResponse };
    }
    if (status === 429) {
      throw new Error(`DA Layer rate limit hit searching rounds ${fromRound}..${votingRoundId}`);
    }
  }
  return null;
}

export async function fetchLedgerTransaction(
  hash: string,
  network: Network,
): Promise<unknown | null> {
  const res = await fetch(network.xrpl.jsonRpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "tx",
      params: [{ transaction: hash.replace(/^0x/, "").toUpperCase() }],
    }),
  });
  const body = (await res.json()) as { result?: Record<string, unknown> };
  if (!body.result || body.result.status === "error") return null;
  return body.result;
}
