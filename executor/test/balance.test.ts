/**
 * A drained executor keeps polling, keeps classifying and fails only where it costs money.
 * From outside that looks healthy, which is why the balance is a health field and why these
 * tests care most about the case where the read itself fails.
 */
import { describe, it, expect } from "vitest";
import {
  BalanceWatch,
  DEFAULT_LOW_BALANCE_WEI,
  MEASURED_INSTRUCTION_COST_WEI,
} from "../src/service/balance.js";

const ADDRESS = "0x8848d8578756A1110161eEB32E868Be1415F2cD7";
const providerWith = (balances: Array<bigint | Error>) => {
  let i = 0;
  return {
    async getBalance() {
      const next = balances[Math.min(i++, balances.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    },
  } as never;
};

describe("BalanceWatch", () => {
  it("flags a balance below the mark and not one above it", async () => {
    const low = await new BalanceWatch(providerWith([10n ** 17n]), ADDRESS).refresh();
    expect(low.low).toBe(true);
    expect(low.flr).toBe("0.1");

    const fine = await new BalanceWatch(providerWith([5n * 10n ** 18n]), ADDRESS).refresh();
    expect(fine.low).toBe(false);
    expect(fine.flr).toBe("5.0");
  });

  it("sets the default mark at about eight instructions, using the measured cost", () => {
    expect(DEFAULT_LOW_BALANCE_WEI).toBe(2n * 10n ** 18n);
    // The reason the mark is not 1 C2FLR: at 650 gwei that is four instructions, which is an
    // alarm that fires with nothing left to spend.
    const instructions = DEFAULT_LOW_BALANCE_WEI / MEASURED_INSTRUCTION_COST_WEI;
    expect(instructions).toBe(8n);
  });

  it("does not turn a failed read into a zero balance", async () => {
    const watch = new BalanceWatch(providerWith([3n * 10n ** 18n, new Error("RPC down")]), ADDRESS);
    await watch.refresh();
    const afterFailure = await watch.refresh();

    // Reporting 0 here would fire the alarm this exists to make meaningful.
    expect(afterFailure.wei).toBe(3n * 10n ** 18n);
    expect(afterFailure.low).toBe(false);
    expect(afterFailure.error).toMatch(/RPC down/);
  });

  it("says it does not know when the very first read fails", async () => {
    const reading = await new BalanceWatch(providerWith([new Error("boom")]), ADDRESS).refresh();
    expect(reading.flr).toBe("unknown");
    expect(reading.low).toBe(false);
    expect(reading.error).toMatch(/boom/);
  });

  it("ages its reading, so a stale one can be recognised", async () => {
    const watch = new BalanceWatch(providerWith([3n * 10n ** 18n]), ADDRESS);
    expect(watch.ageSeconds()).toBeNull();
    await watch.refresh();
    expect(watch.ageSeconds()).toBe(0);
    expect(watch.ageSeconds(Date.now() + 90_000)).toBe(90);
  });
});
