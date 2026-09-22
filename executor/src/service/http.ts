/**
 * The service's HTTP surface: health, metrics, and the status API.
 *
 * `node:http` and a switch. A framework would be more code to audit for a server with four
 * routes, all of them read-only, none of them taking a body.
 *
 * CORS is open because every response is public information that is already on two public
 * chains. There is nothing here to protect; pretending otherwise would only stop the status
 * page from reading it.
 *
 * What *is* protected is the executor. These routes share a process and an upstream budget
 * with the thing that actually moves money, so every route is rate limited per caller, the
 * two routes that are the same answer for everybody are cached for a few seconds, and the one
 * expensive route has a concurrency cap. None of that is about abuse: a status page polling
 * every five seconds across a few hundred readers is enough.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { Metrics } from "./metrics.js";
import type { Store } from "./store.js";
import type { Logger } from "./log.js";
import type { BalanceWatch } from "./balance.js";
import { IpRateLimiter, TinyCache, TokenBucket } from "./rateLimit.js";
import { statusOf, NotFound, type StatusDeps } from "./statusApi.js";

export interface HttpLimits {
  /** Requests per minute per caller. */
  perIpPerMinute: number;
  /** How many a caller may make back to back. */
  perIpBurst: number;
  /** Across every caller, so a forged `x-forwarded-for` cannot multiply the limit. */
  globalPerMinute: number;
  /** `/status` lookups in flight at once. */
  maxConcurrentLookups: number;
  /** Seconds `/instructions` and `/metrics` are reused for. */
  cacheSeconds: number;
}

export const DEFAULT_LIMITS: HttpLimits = {
  // 30/min is one request every two seconds sustained: comfortably above the proposed status
  // page, which polls at 5 s only while a lookup is unfinished, and well under what would
  // matter to the executor.
  perIpPerMinute: 30,
  perIpBurst: 10,
  globalPerMinute: 300,
  // A lookup makes several chain reads. Ten at once is plenty for a page and bounds what the
  // RPC sees from this process no matter how many callers arrive.
  maxConcurrentLookups: 10,
  cacheSeconds: 5,
};

export interface HttpDeps extends StatusDeps {
  metrics: Metrics;
  store: Store;
  log: Logger;
  version: string;
  limits?: HttpLimits;
  /** Absent in read-only mode, where there is no wallet to watch. */
  balance?: BalanceWatch;
  /** Reported by `/healthz` so a stalled loop is visible next to a healthy socket. */
  lastTickAt?: () => number | null;
}

export function createHttpServer(deps: HttpDeps): Server {
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const limiter = new IpRateLimiter(
    limits.perIpPerMinute,
    limits.perIpBurst,
    new TokenBucket(limits.globalPerMinute, Math.ceil(limits.globalPerMinute / 4)),
  );
  const instructionsCache = new Map<string, TinyCache<unknown>>();
  const metricsCache = new TinyCache<string>(limits.cacheSeconds * 1000);
  const inFlight = { lookups: 0 };

  deps.metrics.describe("memokit_executor_http_requests_total", "HTTP requests, by route and outcome");
  deps.metrics.describe("memokit_executor_http_throttled_total", "Requests refused with 429, by scope");

  return createServer((req, res) => {
    handle(req, res, deps, limits, limiter, instructionsCache, metricsCache, inFlight).catch((error) => {
      deps.log.error("http handler threw", { error: (error as Error).message });
      send(res, 500, { error: "internal error" });
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpDeps,
  limits: HttpLimits,
  limiter: IpRateLimiter,
  instructionsCache: Map<string, TinyCache<unknown>>,
  metricsCache: TinyCache<string>,
  inFlight: { lookups: number },
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const route = routeName(path);

  if (req.method === "OPTIONS") return void send(res, 204, null);
  if (req.method !== "GET") {
    deps.metrics.inc("memokit_executor_http_requests_total", { route, outcome: "method" });
    return void send(res, 405, { error: "GET only" });
  }

  const throttled = limiter.check(callerKey(req));
  if (throttled) {
    deps.metrics.inc("memokit_executor_http_throttled_total", { scope: throttled.scope });
    deps.metrics.inc("memokit_executor_http_requests_total", { route, outcome: "throttled" });
    return void send(
      res,
      429,
      {
        error: "too many requests",
        retryAfterSeconds: throttled.retryAfterSeconds,
        // Said out loud, because a reader of a status page deserves to know why it is being
        // asked to wait: the executor's budget is not a resource the page may spend.
        why: "these routes share a process and an upstream rate limit with the executor",
      },
      { "retry-after": String(throttled.retryAfterSeconds) },
    );
  }

  if (path === "/healthz") {
    deps.metrics.inc("memokit_executor_http_requests_total", { route, outcome: "ok" });
    const balance = deps.balance?.current();
    const lastTick = deps.lastTickAt?.() ?? null;
    return void send(res, 200, {
      ok: true,
      version: deps.version,
      uptimeSeconds: Math.round((Date.now() - deps.metrics.startedAt) / 1000),
      pending: deps.store.pending().length,
      tracked: deps.store.all().length,
      controller: deps.store.controller,
      lastTickSecondsAgo: lastTick === null ? null : Math.round((Date.now() - lastTick) / 1000),
      // Present only when there is a wallet. A read-only deployment has no balance to report
      // and saying "0" would be a lie about a service that is working exactly as intended.
      ...(balance
        ? {
            executor: {
              address: balance.address,
              balanceFlr: balance.flr,
              balanceWei: balance.wei.toString(),
              lowBalance: balance.low,
              readingAgeSeconds: deps.balance?.ageSeconds() ?? null,
              ...(balance.error ? { balanceReadError: balance.error } : {}),
            },
          }
        : {}),
    });
  }

  if (path === "/metrics") {
    deps.metrics.inc("memokit_executor_http_requests_total", { route, outcome: "ok" });
    const cached = metricsCache.get() ?? metricsCache.set(renderMetrics(deps, limiter));
    res.writeHead(200, {
      "content-type": "text/plain; version=0.0.4",
      "access-control-allow-origin": "*",
      "cache-control": `public, max-age=${metricsCache.maxAgeSeconds}`,
    });
    return void res.end(cached);
  }

  // The status page's list view. Newest first, because that is the only order anyone reads it
  // in, and bounded because an unbounded list endpoint is a denial of service with extra steps.
  if (path === "/instructions") {
    const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 50) || 50);
    const state = url.searchParams.get("state");
    const key = `${limit}:${state ?? ""}`;
    let cache = instructionsCache.get(key);
    if (!cache) {
      cache = new TinyCache<unknown>(limits.cacheSeconds * 1000);
      // Bounded: `limit` is clamped and `state` is one of a handful, but the key is built from
      // user input, so it is capped rather than trusted.
      if (instructionsCache.size < 64) instructionsCache.set(key, cache);
    }
    const body = cache.get() ?? cache.set(listInstructions(deps.store, limit, state));
    deps.metrics.inc("memokit_executor_http_requests_total", { route, outcome: "ok" });
    return void send(res, 200, body, { "cache-control": `public, max-age=${cache.maxAgeSeconds}` });
  }

  const status = path.match(/^\/status\/([^/]+)$/);
  if (status) {
    // A lookup reads the chain several times. The cap is what stops a crowd from turning into
    // a burst of RPC calls that the executor is then queued behind.
    if (inFlight.lookups >= limits.maxConcurrentLookups) {
      deps.metrics.inc("memokit_executor_http_throttled_total", { scope: "lookup-concurrency" });
      deps.metrics.inc("memokit_executor_http_requests_total", { route, outcome: "throttled" });
      return void send(
        res,
        429,
        { error: "too many lookups in flight", retryAfterSeconds: 2 },
        { "retry-after": "2" },
      );
    }
    inFlight.lookups++;
    try {
      const body = await statusOf(decodeURIComponent(status[1]), deps);
      deps.metrics.inc("memokit_executor_http_requests_total", { route, outcome: "ok" });
      return void send(res, 200, body);
    } catch (error) {
      if (error instanceof NotFound) {
        deps.metrics.inc("memokit_executor_http_requests_total", { route, outcome: "not-found" });
        return void send(res, 404, { error: error.message });
      }
      deps.metrics.inc("memokit_executor_http_requests_total", { route, outcome: "error" });
      throw error;
    } finally {
      inFlight.lookups--;
    }
  }

  deps.metrics.inc("memokit_executor_http_requests_total", { route, outcome: "not-found" });
  send(res, 404, {
    error: "no such route",
    routes: ["/healthz", "/metrics", "/instructions?limit=&state=", "/status/{xrplHash}"],
  });
}

function listInstructions(store: Store, limit: number, state: string | null) {
  const rows = store
    .all()
    .filter((i) => (state ? i.state === state : true))
    .sort((a, b) => b.closedAt - a.closedAt)
    .slice(0, limit)
    .map((i) => ({
      xrplHash: i.xrplHash,
      transactionId: i.transactionId,
      state: i.state,
      xrplOwner: i.xrplOwner,
      account: i.account,
      opcode: i.opcode,
      closedAt: i.closedAt,
      transitions: i.transitions,
      executedBy: i.execution ? (i.execution.byUs ? "this-executor" : "another-executor") : null,
      executeTx: i.execution?.txHash || null,
      skipReason: i.skipReason ?? null,
    }));
  return { count: rows.length, instructions: rows };
}

function renderMetrics(deps: HttpDeps, limiter: IpRateLimiter): string {
  const balance = deps.balance?.current();
  if (balance) {
    // Wei does not fit a float without loss, so the gauge is in whole FLR -- the number an
    // operator sets an alert on -- and the exact value stays in /healthz.
    deps.metrics.set("memokit_executor_balance_flr", Number(balance.flr));
    deps.metrics.set("memokit_executor_balance_low", balance.low ? 1 : 0);
  }
  deps.metrics.set("memokit_executor_http_tracked_callers", limiter.size());
  return deps.metrics.render();
}

/**
 * Who to count this request against.
 *
 * Behind Railway every request arrives from the platform's proxy, so the socket address is
 * useless and `x-forwarded-for`'s first entry is the caller. It is client-supplied and can be
 * forged, which is why the global bucket sits behind the per-IP one: forging the key spreads
 * one caller across many buckets but does not raise the total.
 */
function callerKey(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = raw?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

/** A bounded label. The raw path would let a caller invent metric series at will. */
function routeName(path: string): string {
  if (path === "/healthz" || path === "/metrics" || path === "/instructions") return path;
  if (/^\/status\/[^/]+$/.test(path)) return "/status";
  return "other";
}

function send(
  res: ServerResponse,
  code: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  const headers: Record<string, string> = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "cache-control": "no-store",
    ...extra,
  };
  if (body === null) return void res.writeHead(code, headers).end();
  headers["content-type"] = "application/json";
  res.writeHead(code, headers);
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
}
