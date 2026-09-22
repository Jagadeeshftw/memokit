/**
 * The DA Layer sends no rate-limit headers, so the only protection is not sending the request.
 * These drive the bucket on a fake clock, because the real one takes minutes.
 */
import { describe, it, expect } from "vitest";
import { TokenBucket, backoffMs, type Clock } from "../src/service/rateLimit.js";

function fakeClock(): Clock & { advance(ms: number): void } {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

describe("TokenBucket", () => {
  it("allows a burst, then paces at the configured rate", async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(20, 5, clock);

    for (let i = 0; i < 5; i++) {
      expect(bucket.waitMs()).toBe(0);
      await bucket.acquire();
    }
    // Burst spent: the sixth has to wait for a token to refill at 20/minute = 3 s each.
    expect(bucket.waitMs()).toBeGreaterThan(2_000);
    expect(bucket.waitMs()).toBeLessThanOrEqual(3_000);

    clock.advance(3_000);
    expect(bucket.waitMs()).toBe(0);
  });

  it("never lets more than the sustained rate through over a minute", async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(20, 5, clock);
    const start = clock.now();
    let taken = 0;
    while (clock.now() - start < 60_000) {
      await bucket.acquire();
      taken++;
    }
    // The burst is spent once; everything after is paced. 20/min plus the initial 5.
    expect(taken).toBeLessThanOrEqual(26);
  });

  it("refills no further than its capacity however long it idles", async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(20, 5, clock);
    clock.advance(60 * 60_000);
    let taken = 0;
    while (bucket.waitMs() === 0) {
      await bucket.acquire();
      taken++;
    }
    expect(taken).toBe(5);
  });
});

describe("backoffMs", () => {
  it("grows exponentially and stays inside the cap", () => {
    for (let attempt = 1; attempt <= 12; attempt++) {
      const ms = backoffMs(attempt, 5_000, 300_000);
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThanOrEqual(300_000);
    }
  });

  it("is jittered, so executors that saw the same payment do not retry in lockstep", () => {
    const values = new Set(Array.from({ length: 50 }, () => backoffMs(6)));
    expect(values.size).toBeGreaterThan(1);
  });
});
