/**
 * The unsigned payment is the one artefact a human approves, so what it contains and what it
 * deliberately omits are both load-bearing.
 */
import { describe, it, expect } from "vitest";
import { Opcode } from "../src/types.js";
import { encodeMemo, toXrplMemoData, fromXrplMemoData, decodeMemo } from "../src/memo.js";
import {
  buildUnsignedPayment,
  toDataUri,
  CARRIER_DROPS,
  AUTOFILLED_BY_THE_WALLET,
} from "../src/unsignedPayment.js";

const OWNER = "rpnDcUjasCYome3WntkxqQ3gG4wuLXM4WE";
const RECEIVER = "rDfVHUx5SMgw5wwqjvzgFEFCnqW5CCGWyW";
const memo = encodeMemo({
  kind: "nonceAtLeast",
  opcode: Opcode.NonceAtLeast,
  walletId: 1,
  executorFee: 0n,
  targetNonce: 7n,
});

describe("buildUnsignedPayment", () => {
  it("carries the memo a wallet will sign, byte for byte", () => {
    const payment = buildUnsignedPayment({ owner: OWNER, destination: RECEIVER, memo });
    const carried = payment.Memos[0].Memo.MemoData;
    expect(carried).toBe(toXrplMemoData(memo));
    expect(decodeMemo(fromXrplMemoData(carried))).toMatchObject({ opcode: Opcode.NonceAtLeast });
  });

  it("leaves Sequence, Fee and LastLedgerSequence to the wallet", () => {
    const payment = buildUnsignedPayment({ owner: OWNER, destination: RECEIVER, memo });
    expect(payment).not.toHaveProperty("Sequence");
    expect(payment).not.toHaveProperty("Fee");
    expect(payment).not.toHaveProperty("LastLedgerSequence");
    expect(AUTOFILLED_BY_THE_WALLET.length).toBe(4);
  });

  it("states the amount as a string, because XRPL rejects a number", () => {
    const payment = buildUnsignedPayment({ owner: OWNER, destination: RECEIVER, memo });
    expect(payment.Amount).toBe(CARRIER_DROPS);
    expect(typeof payment.Amount).toBe("string");
  });

  it("omits DestinationTag unless one was asked for: memokit needs none", () => {
    expect(buildUnsignedPayment({ owner: OWNER, destination: RECEIVER, memo })).not.toHaveProperty(
      "DestinationTag",
    );
    expect(
      buildUnsignedPayment({ owner: OWNER, destination: RECEIVER, memo, destinationTag: 42 }).DestinationTag,
    ).toBe(42);
  });

  it("accepts a memo object as well as encoded bytes, and produces the same payment", () => {
    const fromObject = buildUnsignedPayment({
      owner: OWNER,
      destination: RECEIVER,
      memo: { kind: "nonceAtLeast", opcode: Opcode.NonceAtLeast, walletId: 1, executorFee: 0n, targetNonce: 7n },
    });
    expect(fromObject).toEqual(buildUnsignedPayment({ owner: OWNER, destination: RECEIVER, memo }));
  });
});

describe("toDataUri", () => {
  it("round trips the transaction through the fragment", () => {
    const payment = buildUnsignedPayment({ owner: OWNER, destination: RECEIVER, memo });
    const uri = toDataUri(payment);
    expect(uri.startsWith("xrpl:tx?json=")).toBe(true);

    const b64 = uri.slice("xrpl:tx?json=".length).replace(/-/g, "+").replace(/_/g, "/");
    expect(JSON.parse(Buffer.from(b64, "base64").toString("utf8"))).toEqual(payment);
  });

  it("encodes url-safe, so the payload survives a QR and a deep link unescaped", () => {
    const uri = toDataUri(buildUnsignedPayment({ owner: OWNER, destination: RECEIVER, memo }));
    const encoded = uri.slice("xrpl:tx?json=".length);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(encodeURIComponent(encoded)).toBe(encoded);
  });
});
