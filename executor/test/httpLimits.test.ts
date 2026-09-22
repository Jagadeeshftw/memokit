/**
 * The status routes share a process and an upstream rate limit with the thing that moves
 * money, so these are not tests about tidy HTTP behaviour -- they are tests that public
 * traffic cannot take what the executor needs.
 */
import { describe, it, expect } from "vitest";
import { IpRateLimiter, TinyCache, TokenBucket, type Clock } from "../src/service/rateLimit.js";

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

describe("IpRateLimiter", () => {
  it("lets a caller burst, then refuses with a Retry-After a client can act on", () => {
    const clock = fakeClock();
    const limiter = new IpRateLimiter(30, 5, new TokenBucket(300, 75, clock), clock);

    for (let i = 0; i < 5; i++) expect(limiter.check("1.1.1.1")).toBeNull();

    const refused = limiter.check("1.1.1.1");
    expect(refused).not.toBeNull();
    expect(refused!.scope).toBe("ip");
    expect(refused!.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused!.retryAfterSeconds).toBeLessThanOrEqual(2);

    clock.advance(refused!.retryAfterSeconds * 1000);
    expect(limiter.check("1.1.1.1")).toBeNull();
  });

  it("throttles one caller without spending anybody else's headroom", () => {
    const clock = fakeClock();
    const limiter = new IpRateLimiter(30, 3, new TokenBucket(300, 75, clock), clock);

    for (let i = 0; i < 3; i++) limiter.check("noisy");
    expect(limiter.check("noisy")).not.toBeNull();
    // A refusal must not have consumed a global token on the noisy caller's behalf.
    for (let i = 0; i < 3; i++) expect(limiter.check("quiet")).toBeNull();
  });

  it("caps the total, so forging the caller key cannot multiply the limit", () => {
    const clock = fakeClock();
    const limiter = new IpRateLimiter(30, 5, new TokenBucket(20, 8, clock), clock);

    let allowed = 0;
    for (let i = 0; i < 200; i++) {
      if (limiter.check(`forged-${i}`) === null) allowed++;
    }
    // Each key is fresh, so per-IP limits never bind; only the global bucket does.
    expect(allowed).toBe(8);
  });

  it("forgets callers whose buckets have refilled, so the map is not an unbounded leak", () => {
    const clock = fakeClock();
    const limiter = new IpRateLimiter(60, 4, new TokenBucket(3000, 750, clock), clock);

    for (let i = 0; i < 50; i++) limiter.check(`caller-${i}`);
    expect(limiter.size()).toBe(50);

    clock.advance(10 * 60_000);
    limiter.check("someone");
    expect(limiter.size()).toBe(1);
  });
});

describe("TokenBucket.tryAcquire", () => {
  it("takes a token when there is one and never waits when there is not", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(20, 3, clock);

    expect(bucket.tryAcquire()).toBe(true);
    expect(bucket.tryAcquire()).toBe(true);
    expect(bucket.tryAcquire()).toBe(true);
    expect(bucket.tryAcquire()).toBe(false);
    expect(clock.now()).toBe(1_000_000);
  });

  it("reports its headroom, so /metrics can show it", () => {
    const bucket = new TokenBucket(20, 4, fakeClock());
    expect(bucket.available()).toBe(4);
    bucket.tryAcquire();
    expect(bucket.available()).toBe(3);
  });
});

describe("the split DA budget", () => {
  it("leaves the executor's share untouched however hard the public share is hammered", () => {
    const clock = fakeClock();
    // The split the service makes: a quarter to public lookups, the rest to the executor.
    const publicShare = 5;
    const executorBucket = new TokenBucket(20 - publicShare, 4, clock);
    const publicBucket = new TokenBucket(publicShare, 3, clock);

    let publicAllowed = 0;
    for (let i = 0; i < 1000; i++) if (publicBucket.tryAcquire()) publicAllowed++;

    expect(publicAllowed).toBe(3);
    // The point of the whole arrangement: the executor can still buy a proof.
    expect(executorBucket.available()).toBe(4);
    expect(executorBucket.tryAcquire()).toBe(true);
  });
});

describe("TinyCache", () => {
  it("serves one computation to everyone who asks inside the window", () => {
    const clock = fakeClock();
    const cache = new TinyCache<number>(5_000, clock);
    let computed = 0;
    const get = () => cache.get() ?? cache.set(++computed);

    expect(get()).toBe(1);
    for (let i = 0; i < 100; i++) get();
    expect(computed).toBe(1);

    clock.advance(5_000);
    expect(get()).toBe(2);
  });

  it("states a max-age a caller can honour", () => {
    expect(new TinyCache(5_000).maxAgeSeconds).toBe(5);
    expect(new TinyCache(200).maxAgeSeconds).toBe(1);
  });
});
