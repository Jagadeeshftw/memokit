/**
 * A token bucket for the DA Layer.
 *
 * Flare publishes no rate-limit numbers and the endpoint sends no `Retry-After` or
 * `X-RateLimit-*` headers, so there is nothing to react to: a 429 arrives as a bare status and
 * the only safe response is to have not sent the request. `executor/src/measure/daLayer.ts`
 * measured about 20 requests a minute, so the service paces itself to that from the start
 * rather than discovering it in production.
 *
 * `acquire` waits. It does not throw and it does not drop work: a proof that is not ready now
 * will be ready in a minute, and the instruction is not going anywhere.
 */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    /** Sustained rate. */
    private readonly perMinute: number,
    /** How much of the budget may be spent at once. Defaults to a quarter of a minute's worth. */
    burst = Math.max(1, Math.ceil(perMinute / 4)),
    private readonly clock: Clock = systemClock,
  ) {
    this.capacity = burst;
    this.tokens = burst;
    this.lastRefill = clock.now();
  }

  private readonly capacity: number;

  private refill(): void {
    const now = this.clock.now();
    const gained = ((now - this.lastRefill) / 60_000) * this.perMinute;
    if (gained <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + gained);
    this.lastRefill = now;
  }

  /** Milliseconds until a token is available; 0 when one is available now. */
  waitMs(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.perMinute) * 60_000);
  }

  /** Wait for a token and take it. */
  async acquire(): Promise<void> {
    for (;;) {
      const wait = this.waitMs();
      if (wait === 0) {
        this.tokens -= 1;
        return;
      }
      await this.clock.sleep(wait);
    }
  }

  /**
   * Take a token if one is free, and never wait.
   *
   * The difference between this and {@link acquire} is who is allowed to be delayed. The
   * executor may wait: an instruction that attests a minute later is still executed. A public
   * HTTP request may not -- holding a socket open until a budget refills is how one caller's
   * traffic becomes everyone's latency. So the read paths take a token if there is one and do
   * without if there is not, degrading the answer rather than the service.
   */
  tryAcquire(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** Tokens available right now. Exposed for /metrics, so an operator can see the headroom. */
  available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
}

/**
 * Per-caller rate limiting for the HTTP surface.
 *
 * The status routes share a process with execution, so a flood of public requests is not just
 * a performance problem -- it is upstream budget the executor then does not have. Every route
 * is limited, including the cheap ones, because a request that costs nothing here still costs
 * a socket and a slot in the event loop.
 *
 * Keyed by IP. Behind Railway that means the `x-forwarded-for` client entry, which a caller
 * can forge; this is protection against load, not against a determined attacker, and the
 * budget it defends is refilled by time rather than by trust. A global cap behind it bounds
 * what forged keys can do in aggregate.
 */
export class IpRateLimiter {
  private readonly perIp = new Map<string, TokenBucket>();
  private lastSweep: number;

  constructor(
    private readonly perMinute: number,
    private readonly burst: number,
    /** Total across every caller, so spoofed keys cannot multiply the limit. */
    private readonly global: TokenBucket,
    private readonly clock: Clock = systemClock,
  ) {
    this.lastSweep = clock.now();
  }

  /**
   * @returns null when the request may proceed, or the seconds to put in `Retry-After`.
   */
  check(key: string): { retryAfterSeconds: number; scope: "ip" | "global" } | null {
    this.sweep();

    let bucket = this.perIp.get(key);
    if (!bucket) {
      bucket = new TokenBucket(this.perMinute, this.burst, this.clock);
      this.perIp.set(key, bucket);
    }

    // The global bucket is checked first but only spent if the per-IP one also allows it,
    // so one caller being throttled does not consume everybody else's headroom.
    const globalWait = this.global.waitMs();
    if (globalWait > 0) {
      return { retryAfterSeconds: Math.max(1, Math.ceil(globalWait / 1000)), scope: "global" };
    }
    const wait = bucket.waitMs();
    if (wait > 0) {
      return { retryAfterSeconds: Math.max(1, Math.ceil(wait / 1000)), scope: "ip" };
    }

    bucket.tryAcquire();
    this.global.tryAcquire();
    return null;
  }

  /**
   * Forget buckets that have refilled completely.
   *
   * Without this the map is an unbounded memory leak keyed by attacker-supplied strings. A
   * full bucket carries no information -- a caller with no history and a caller whose history
   * has expired are the same caller -- so dropping it changes nothing.
   */
  private sweep(): void {
    const now = this.clock.now();
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.perIp) {
      if (bucket.available() >= this.burst) this.perIp.delete(key);
    }
  }

  /** Callers currently being tracked. For /metrics. */
  size(): number {
    return this.perIp.size;
  }
}

const SWEEP_INTERVAL_MS = 60_000;

/**
 * A response held for a few seconds and served to everyone who asks again in that time.
 *
 * `/instructions` and `/metrics` are the same answer for every caller and are rebuilt from
 * in-memory state, so the cost of serving them is real but the cost of *recomputing* them per
 * request is waste. A short TTL keeps a status page polling every five seconds honest while
 * flattening a crowd into one computation.
 */
export class TinyCache<T> {
  private entry: { value: T; at: number } | null = null;

  constructor(
    private readonly ttlMs: number,
    private readonly clock: Clock = systemClock,
  ) {}

  /** The cached value, or null when it is missing or stale. */
  get(): T | null {
    if (!this.entry) return null;
    if (this.clock.now() - this.entry.at >= this.ttlMs) return null;
    return this.entry.value;
  }

  set(value: T): T {
    this.entry = { value, at: this.clock.now() };
    return value;
  }

  /** Seconds a caller may reuse this response for, for `Cache-Control: max-age`. */
  get maxAgeSeconds(): number {
    return Math.max(1, Math.round(this.ttlMs / 1000));
  }
}

/**
 * Exponential backoff with full jitter.
 *
 * Jittered because every executor watching the same receiving address sees the same payment at
 * the same moment and would otherwise retry in lockstep, turning one rate limit into a
 * synchronised herd.
 */
export function backoffMs(attempt: number, baseMs = 5_000, capMs = 5 * 60_000): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(Math.random() * ceiling);
}
