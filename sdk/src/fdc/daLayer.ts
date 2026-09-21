import { COSTON2 } from "../networks.js";

/**
 * Data Availability Layer client.
 *
 * The one off-chain service memokit genuinely needs, and the one that does not ask for a key.
 * Flare describes the public endpoint as rate-limited without publishing numbers, so
 * `executor/src/measure/daLayer.ts` measures them instead of trusting the docs.
 */
export interface DaProofResponse {
  /** Merkle proof for the attestation, ready to hand to the contract. */
  proof: string[];
  /**
   * `abi.encode(Response)`. The `-raw` endpoint returns the encoding rather than a JSON
   * object; `fdc/encode.ts::decodeResponseHex` turns it into a typed response.
   */
  response_hex: string;
  attestation_type: string;
}

export class DaLayerClient {
  constructor(private readonly baseUrl: string = COSTON2.daLayerUrl) {}

  /**
   * Fetch the Merkle proof for a request in a finalised voting round.
   * @returns The proof, or null when the round has no such request (yet).
   */
  async proofByRequestRound(
    votingRoundId: number,
    abiEncodedRequest: string,
  ): Promise<{ status: number; body: DaProofResponse | { error?: string } }> {
    const res = await fetch(`${this.baseUrl}/api/v1/fdc/proof-by-request-round-raw`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ votingRoundId, requestBytes: abiEncodedRequest }),
    });
    const text = await res.text();
    let body: DaProofResponse | { error?: string };
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text.slice(0, 300) };
    }
    return { status: res.status, body };
  }

  /**
   * Poll until the proof is available.
   * @param deadlineMs Absolute wall-clock deadline.
   * @param intervalMs Gap between attempts.
   */
  async waitForProof(
    votingRoundId: number,
    abiEncodedRequest: string,
    deadlineMs: number,
    intervalMs = 5_000,
  ): Promise<DaProofResponse> {
    let lastStatus = 0;
    let lastBody = "";
    while (Date.now() < deadlineMs) {
      const { status, body } = await this.proofByRequestRound(votingRoundId, abiEncodedRequest);
      if (status === 200 && "proof" in body && "response_hex" in body) {
        return body;
      }
      lastStatus = status;
      lastBody = JSON.stringify(body).slice(0, 200);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(
      `DA Layer produced no proof for round ${votingRoundId} before the deadline ` +
        `(last: HTTP ${lastStatus} ${lastBody})`,
    );
  }

  /**
   * Search a bounded window of voting rounds for a proof of `abiEncodedRequest`.
   *
   * The DA Layer is keyed by (votingRoundId, requestBytes), not by XRPL transaction, so
   * "does a proof exist for this payment" cannot be asked directly. The round an attestation
   * landed in is decided by when somebody submitted the *request*, which is not recorded
   * anywhere the classifier can cheaply read: `eth_getLogs` on the public Coston2 RPC is
   * capped at 30 blocks, so scanning for the `AttestationRequest` event is not an option
   * either.
   *
   * So this scans forward from the round covering the XRPL close. In practice an executor
   * submits within a round or two. The window is bounded and small because the DA Layer
   * allows roughly 20 requests per minute with no rate-limit headers to back off against
   * (measured in Phase 1), and a classifier that burns the budget is worse than one that
   * occasionally answers "not yet".
   *
   * A negative answer therefore means "no proof in the scanned window", not "no proof". The
   * rescue built on it -- request an attestation -- is idempotent, so guessing low is safe.
   *
   * @param fromRound First round to try, normally the one covering the XRPL close.
   * @param rounds How many consecutive rounds to try.
   */
  async findProofNear(
    abiEncodedRequest: string,
    fromRound: number,
    rounds = 8,
  ): Promise<{ votingRoundId: number; proof: DaProofResponse } | null> {
    for (let i = 0; i < rounds; i++) {
      const votingRoundId = fromRound + i;
      const { status, body } = await this.proofByRequestRound(votingRoundId, abiEncodedRequest);
      if (status === 200 && "proof" in body && "response_hex" in body) {
        return { votingRoundId, proof: body as DaProofResponse };
      }
      if (status === 429) {
        // Out of budget. Reporting "not found" here would be a lie by omission.
        throw new Error(
          `DA Layer rate limit hit while searching rounds ${fromRound}..${votingRoundId}`,
        );
      }
    }
    return null;
  }
}
