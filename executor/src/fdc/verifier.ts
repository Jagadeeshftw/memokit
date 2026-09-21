import { ATTESTATION_TYPE_XRP_PAYMENT } from "@memokit/sdk";
import { b32, type XrpPaymentRequestBody } from "@memokit/sdk/fdc";
import { VERIFIER } from "../config.js";

/**
 * Client for Flare's verifier servers.
 *
 * NOT on memokit's critical path, by design. The verifier is API-keyed and Flare-operated;
 * depending on it would put a revocable credential between a user and their own funds.
 * `fdc/encode.ts` does the same work offline. This client exists so we can check that the
 * offline implementation agrees with Flare's -- an oracle for tests, not a dependency.
 */
export class VerifierClient {
  constructor(
    private readonly baseUrl: string = VERIFIER.testnet,
    private readonly apiKey: string = VERIFIER.publicApiKey,
  ) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": this.apiKey },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`verifier ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return JSON.parse(text) as T;
  }

  private requestPayload(requestBody: XrpPaymentRequestBody, sourceId: string) {
    return {
      attestationType: b32(ATTESTATION_TYPE_XRP_PAYMENT),
      sourceId: b32(sourceId),
      requestBody,
    };
  }

  /** Flare's own ABI-encoded request, including the MIC it computed. */
  async prepareRequest(
    requestBody: XrpPaymentRequestBody,
    sourceId: string,
  ): Promise<{ status: string; abiEncodedRequest?: string }> {
    return this.post(
      `/verifier/xrp/${ATTESTATION_TYPE_XRP_PAYMENT}/prepareRequest`,
      this.requestPayload(requestBody, sourceId),
    );
  }

  /** The response Flare's attestation clients would produce for this transaction. */
  async prepareResponse(
    requestBody: XrpPaymentRequestBody,
    sourceId: string,
  ): Promise<{ status: string; response?: Record<string, unknown> }> {
    return this.post(
      `/verifier/xrp/${ATTESTATION_TYPE_XRP_PAYMENT}/prepareResponse`,
      this.requestPayload(requestBody, sourceId),
    );
  }

  /** Flare's MIC for this transaction. The value our offline encoder must reproduce. */
  async mic(
    requestBody: XrpPaymentRequestBody,
    sourceId: string,
  ): Promise<{ status: string; messageIntegrityCode?: string }> {
    return this.post(
      `/verifier/xrp/${ATTESTATION_TYPE_XRP_PAYMENT}/mic`,
      this.requestPayload(requestBody, sourceId),
    );
  }
}
