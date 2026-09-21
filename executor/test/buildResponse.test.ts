import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ZeroAddress } from "ethers";
import { buildXrpPaymentResponse, UnsupportedPaymentError } from "../src/fdc/buildResponse.js";
import { computeMic } from "../src/fdc/encode.js";
import { SOURCE_ID_TESTNET } from "../src/config.js";

/**
 * Offline proof that memokit needs no verifier.
 *
 * `measure/micOracle.ts` captured a real XRPL Testnet payment, Flare's own attestation
 * response for it, and Flare's own MIC. This rebuilds the response from the raw ledger
 * record and asserts it matches field for field -- so the verifier is a test oracle, never
 * a runtime dependency.
 */
const oracle = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../fixtures/xrppayment-oracle.json"), "utf8"),
);

const built = buildXrpPaymentResponse(
  oracle.rawXrplTransaction,
  SOURCE_ID_TESTNET,
  oracle.transactionId,
  ZeroAddress,
);

describe("buildXrpPaymentResponse", () => {
  it("reproduces Flare's MIC from ledger data alone", () => {
    expect(computeMic(built)).toEqual(oracle.flareMic);
    expect(oracle.offlineMicMatches).toBe(true);
  });

  it.each([
    "blockNumber",
    "blockTimestamp",
    "sourceAddress",
    "sourceAddressHash",
    "receivingAddressHash",
    "intendedReceivingAddressHash",
    "spentAmount",
    "intendedSpentAmount",
    "receivedAmount",
    "intendedReceivedAmount",
    "hasMemoData",
    "firstMemoData",
    "hasDestinationTag",
    "destinationTag",
    "status",
  ])("matches the verifier on responseBody.%s", (field) => {
    const ours = (built.responseBody as Record<string, unknown>)[field];
    const theirs = (oracle.rawResponse.responseBody as Record<string, unknown>)[field];
    expect(String(ours).toLowerCase()).toEqual(String(theirs).toLowerCase());
  });

  /**
   * rippled API v2 renames `Amount` to `DeliverMax` in `tx_json`. Reading the wrong one
   * yields intendedReceivedAmount = 0 and a MIC Flare will never match -- an attestation
   * request that is simply never confirmed, with no error anywhere. This caught it once.
   */
  it("reads DeliverMax when Amount is absent", () => {
    const { Amount, ...withoutAmount } = oracle.rawXrplTransaction;
    const viaDeliverMax = buildXrpPaymentResponse(
      { ...withoutAmount, DeliverMax: Amount ?? oracle.rawXrplTransaction.DeliverMax },
      SOURCE_ID_TESTNET,
      oracle.transactionId,
    );
    expect(viaDeliverMax.responseBody.intendedReceivedAmount).toEqual(
      built.responseBody.intendedReceivedAmount,
    );
    expect(viaDeliverMax.responseBody.intendedReceivedAmount).toBeGreaterThan(0n);
  });

  it("rejects a transaction with no metadata", () => {
    const { meta, metaData, ...noMeta } = oracle.rawXrplTransaction;
    expect(() =>
      buildXrpPaymentResponse(noMeta, SOURCE_ID_TESTNET, oracle.transactionId),
    ).toThrow(UnsupportedPaymentError);
  });

  it("flags a destination tag when one is present", () => {
    const tagged = buildXrpPaymentResponse(
      { ...oracle.rawXrplTransaction, DestinationTag: 42 },
      SOURCE_ID_TESTNET,
      oracle.transactionId,
    );
    expect(tagged.responseBody.hasDestinationTag).toBe(true);
    expect(tagged.responseBody.destinationTag).toEqual(42n);
  });
});
