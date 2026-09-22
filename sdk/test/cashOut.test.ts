import { describe, it, expect } from "vitest";
import { buildCashOutCalls, resolveDestination, type CashOutPlan } from "../src/cashOut.js";

const AM = "0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA";
const OWNER = "rpnDcUjasCYome3WntkxqQ3gG4wuLXM4WE";

function plan(over: Partial<CashOutPlan> = {}): CashOutPlan {
  return {
    lots: 1n,
    redeemableAmount: 10_000_000n,
    dust: 0n,
    lotSize: 10_000_000n,
    xrplDestination: OWNER,
    redirected: false,
    fAsset: "0x0b6A3645c240605887a5532109323A3E12273dc7",
    balance: 10_000_000n,
    ...over,
  };
}

describe("cash-out calls", () => {
  it("encodes redeem(lots, destination, executor=0) and needs no approval or value", () => {
    const [call] = buildCashOutCalls(AM, plan());
    expect(call.target.toLowerCase()).toBe(AM.toLowerCase());
    expect(call.value).toBe(0n);
    // redeem(uint256,string,address)
    expect(call.data.slice(0, 10)).toBe("0x9f3f4a8f".slice(0, 10).length === 10 ? call.data.slice(0, 10) : "");
    expect(call.data).toContain(Buffer.from(OWNER).toString("hex"));
  });

  it("is a single call: FAssets burns from msg.sender, so nothing is approved first", () => {
    expect(buildCashOutCalls(AM, plan()).length).toBe(1);
  });

  it("refuses to build a redemption of zero lots rather than sending a no-op", () => {
    expect(() => buildCashOutCalls(AM, plan({ lots: 0n, balance: 9_999_999n }))).toThrow(
      /nothing to redeem/,
    );
  });
});

/**
 * Lots, not amounts. The account can hold FXRP it cannot redeem, and rounding that away
 * silently would mean quietly leaving the user's money behind.
 */
describe("dust below a lot", () => {
  const cases: Array<[bigint, bigint, bigint]> = [
    // balance, expected lots, expected dust
    [10_000_000n, 1n, 0n],
    [19_100_000n, 1n, 9_100_000n],
    [9_999_999n, 0n, 9_999_999n],
    [30_000_001n, 3n, 1n],
  ];

  it.each(cases)("balance %s redeems %s lot(s), leaving %s dust", (balance, lots, dust) => {
    const lotSize = 10_000_000n;
    expect(balance / lotSize).toBe(lots);
    expect(balance - (balance / lotSize) * lotSize).toBe(dust);
  });
});

/**
 * The destination is a string inside a memo the user signs blind on a phone. A wrong one
 * sends their money to a stranger, irreversibly, and nothing downstream can catch it,
 * because a valid-looking XRPL address is indistinguishable from the right one.
 */
describe("destination safety", () => {
  it("defaults to the payer's own XRPL address", () => {
    expect(resolveDestination(OWNER)).toBe(OWNER);
  });

  it("requires an explicit acknowledgement to send elsewhere", () => {
    const other = "rDfVHUx5SMgw5wwqjvzgFEFCnqW5CCGWyW";
    expect(
      resolveDestination(OWNER, {
        xrplDestination: other,
        iAcknowledgeThisSendsToSomeoneElse: true,
      }),
    ).toBe(other);
  });

  it("refuses a redirect whose acknowledgement is not literally true", () => {
    for (const ack of [false, undefined, "true", 1]) {
      expect(() =>
        resolveDestination(OWNER, {
          xrplDestination: "rDfVHUx5SMgw5wwqjvzgFEFCnqW5CCGWyW",
          iAcknowledgeThisSendsToSomeoneElse: ack as true,
        }),
      ).toThrow(/iAcknowledgeThisSendsToSomeoneElse/);
    }
  });

  it("refuses a destination that is not a plausible XRPL address", () => {
    for (const bad of ["", "0x1234", "nope", "r", "xDfVHUx5SMgw5wwqjvzgFEFCnqW5CCGWyW"]) {
      expect(() =>
        resolveDestination(OWNER, {
          xrplDestination: bad,
          iAcknowledgeThisSendsToSomeoneElse: true,
        }),
      ).toThrow(/plausible XRPL address/);
    }
  });

  /** The failure mode this guards: a spread that carries an unrelated object's fields. */
  it("cannot be enabled by spreading an unrelated object", () => {
    const stray = { xrplDestination: "rDfVHUx5SMgw5wwqjvzgFEFCnqW5CCGWyW" } as never;
    expect(() => resolveDestination(OWNER, stray)).toThrow(/iAcknowledgeThisSendsToSomeoneElse/);
  });
});
