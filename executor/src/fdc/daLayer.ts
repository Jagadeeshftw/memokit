import { DA_LAYER } from "../config.js";

/**
 * Data Availability Layer client.
 *
 * The one off-chain service memokit genuinely needs, and the one that does not ask for a key.
 * Flare describes the public endpoint as rate-limited without publishing numbers, so
 * `measure/daLayer.ts` measures them instead of trusting the docs.
 */
export interface DaProofResponse {
  /** Merkle proof for the attestation, ready to hand to the contract. */
  proof: string[];
  /** The attestation response, as the DA Layer serialises it. */
  response: Record<string, unknown>;
}

export class DaLayerClient {
  constructor(private readonly baseUrl: string = DA_LAYER.coston2) {}

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
      if (status === 200 && "proof" in body) {
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
}
