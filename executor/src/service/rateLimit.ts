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
