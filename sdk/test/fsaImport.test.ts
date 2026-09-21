import { describe, it, expect } from "vitest";
import { buildImportReference, decodeImportReference, FSA_INSTRUCTION_FXRP_TRANSFER } from "../src/fsaImport.js";

/**
 * The reference is 32 bytes with no length prefix and no padding, so every field boundary is
 * load-bearing: one byte out and the amount or the recipient is silently wrong, and the money
 * goes somewhere else. These pin the layout against `PaymentReferenceParser`.
 */
describe("FSA import reference", () => {
  const recipient = "0x8F1eD3f5355846008A47ce91Fbc49EE1808d43b1";

  it("lays the fields out exactly where FSA reads them", () => {
    const ref = buildImportReference({ amountDrops: 5_000_000n, recipient, walletId: 7 });
    expect((ref.length - 2) / 2).toBe(32);
    expect(ref.slice(2, 4)).toBe("01"); // byte 0: type 0, command 1
    expect(ref.slice(4, 6)).toBe("07"); // byte 1: wallet id
    // bytes 2..11: uint80 big-endian
    expect(ref.slice(6, 26)).toBe("000000000000004c4b40"); // 10 bytes = 20 hex chars
    // bytes 12..31: the recipient, unpadded
    expect(ref.slice(26).toLowerCase()).toBe(recipient.slice(2).toLowerCase());
  });

  it("round-trips", () => {
    const params = { amountDrops: 123_456_789n, recipient, walletId: 3 };
    const decoded = decodeImportReference(buildImportReference(params));
    expect(decoded.instructionId).toBe(FSA_INSTRUCTION_FXRP_TRANSFER);
    expect(decoded.amountDrops).toBe(params.amountDrops);
    expect(decoded.recipient).toBe(recipient);
    expect(decoded.walletId).toBe(3);
  });

  it("handles the extremes of the uint80 value field", () => {
    const max = (1n << 80n) - 1n;
    expect(decodeImportReference(buildImportReference({ amountDrops: max, recipient })).amountDrops).toBe(max);
    expect(decodeImportReference(buildImportReference({ amountDrops: 1n, recipient })).amountDrops).toBe(1n);
  });

  it("refuses what FSA would reject on chain, before the payment is signed", () => {
    expect(() => buildImportReference({ amountDrops: 0n, recipient })).toThrow(/ValueZero/);
    expect(() => buildImportReference({ amountDrops: 1n << 80n, recipient })).toThrow(/uint80/);
    expect(() =>
      buildImportReference({ amountDrops: 1n, recipient: "0x" + "00".repeat(20) }),
    ).toThrow(/AddressZero/);
    expect(() => buildImportReference({ amountDrops: 1n, recipient, walletId: 256 })).toThrow(/byte/);
  });

  /** A 32-byte memo is exactly what the classic `Payment` attestation needs, and no more. */
  it("is exactly the size the classic Payment attestation requires", () => {
    const ref = buildImportReference({ amountDrops: 1n, recipient });
    expect(Buffer.from(ref.slice(2), "hex").length).toBe(32);
  });

  it("rejects a malformed reference on decode", () => {
    expect(() => decodeImportReference("0x1234")).toThrow(/exactly 32 bytes/);
  });
});
