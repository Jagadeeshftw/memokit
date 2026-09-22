/**
 * The policy is the only thing standing between an operator and working for free, or for a
 * token that does not exist. Every refusal below is deliberate, so each one is pinned.
 */
import { describe, it, expect } from "vitest";
import { evaluate, parseMinimums, type FeePolicyConfig } from "../src/service/feePolicy.js";

const FXRP = "0x0b6A3645c240605887a5532109323A3E12273dc7";
const OTHER = "0x1234567890123456789012345678901234567890";

const policy = (over: Partial<FeePolicyConfig> = {}): FeePolicyConfig => ({
  minimumByToken: { [FXRP.toLowerCase()]: 100_000n },
  relayRescues: true,
  unknownPayload: "wait",
  ...over,
});

describe("fee policy", () => {
  it("accepts a fee at or above the minimum in a listed token", () => {
    expect(evaluate(policy(), 0xfd, { token: FXRP, amount: 100_000n }).work).toBe(true);
    expect(evaluate(policy(), 0xfd, { token: FXRP, amount: 999_999n }).work).toBe(true);
  });

  it("declines a fee below the minimum", () => {
    const v = evaluate(policy(), 0xfd, { token: FXRP, amount: 99_999n });
    expect(v.work).toBe(false);
    expect(v.reason).toMatch(/below the 100000 minimum/);
  });

  it("declines an unlisted token rather than guessing what it is worth", () => {
    const v = evaluate(policy(), 0xfd, { token: OTHER, amount: 10n ** 30n });
    expect(v.work).toBe(false);
    expect(v.reason).toMatch(/not on the accepted list/);
  });

  it("declines a zero fee: a valid instruction, but not an executor's job", () => {
    expect(evaluate(policy(), 0xfd, { token: FXRP, amount: 0n }).reason).toMatch(/nothing in it/);
  });

  it("relays rescue memos unpaid when the operator has opted in, and not otherwise", () => {
    expect(evaluate(policy(), 0xe1, null).work).toBe(true);
    expect(evaluate(policy({ relayRescues: false }), 0xe1, null).work).toBe(false);
    for (const opcode of [0xe0, 0xe1, 0xe2, 0xfb]) {
      expect(evaluate(policy(), opcode, null).work).toBe(true);
    }
  });

  it("cannot work a commit memo without its preimage, and says which kind of refusal that is", () => {
    expect(evaluate(policy(), 0xfc, null).reason).toMatch(/not supplied yet/);
    expect(evaluate(policy({ unknownPayload: "skip" }), 0xfc, null).reason).toMatch(/not supplied$/);
  });

  it("declines a payment with no memokit memo at all", () => {
    expect(evaluate(policy(), null, null).reason).toBe("no memokit memo");
  });

  it("parses MIN_FEE and checksums addresses so a typo fails at startup", () => {
    expect(parseMinimums(`${FXRP}:100000, ${OTHER}:5`)).toEqual({
      [FXRP.toLowerCase()]: 100_000n,
      [OTHER.toLowerCase()]: 5n,
    });
    expect(parseMinimums(undefined)).toEqual({});
    expect(() => parseMinimums("not-an-address:1")).toThrow();
    expect(() => parseMinimums(`${FXRP}`)).toThrow(/token:amount/);
  });
});
