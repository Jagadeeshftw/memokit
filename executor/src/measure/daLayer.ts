/**
 * Measures the two DA Layer properties Phase 0 left as prose.
 *
 * Phase 0 recorded "Flare's docs describe a rate-limited public endpoint but publish no
 * numbers" and left end-to-end latency unmeasured. Both are load-bearing: the DA Layer is
 * the only off-chain service on memokit's critical path, so its limits are our limits.
 *
 * The probe is deliberately bounded -- it stops at the first 429 and caps total requests --
 * because this is a shared public endpoint, not a load-test target.
 *
 * Run: npm run measure:da -w @memokit/executor
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DA_LAYER } from "../config.js";

const OUT = resolve(import.meta.dirname, "../../../fixtures/measurements/da-layer.json");

const BASE = DA_LAYER.coston2;
const LATEST_ROUND = `${BASE}/api/v0/fsp/latest-voting-round`;

/** Hard ceiling on requests this script will ever send, across all phases. */
const TOTAL_REQUEST_BUDGET = 260;
let spent = 0;

interface Hit {
  status: number;
  ms: number;
  retryAfter: string | null;
  rateLimitHeaders: Record<string, string>;
}

async function hit(url: string, init?: RequestInit): Promise<Hit> {
  if (++spent > TOTAL_REQUEST_BUDGET) {
    throw new Error("request budget exhausted; refusing to send more");
  }
  const started = performance.now();
  const res = await fetch(url, init);
  await res.arrayBuffer();
  const ms = performance.now() - started;

  const rateLimitHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (/rate|limit|retry|throttl/i.test(k)) rateLimitHeaders[k] = v;
  });
  return { status: res.status, ms, retryAfter: res.headers.get("retry-after"), rateLimitHeaders };
}

function summarise(hits: Hit[]) {
  const ok = hits.filter((h) => h.status === 200).length;
  const limited = hits.filter((h) => h.status === 429).length;
  const other = hits.length - ok - limited;
  const times = hits.map((h) => h.ms).sort((a, b) => a - b);
  const pct = (p: number) => (times.length ? +times[Math.floor((times.length - 1) * p)].toFixed(1) : null);
  return {
    sent: hits.length,
    ok,
    rateLimited: limited,
    otherStatus: other,
    statusCounts: hits.reduce<Record<number, number>>((acc, h) => {
      acc[h.status] = (acc[h.status] ?? 0) + 1;
      return acc;
    }, {}),
    latencyMs: { p50: pct(0.5), p90: pct(0.9), max: times.length ? +times[times.length - 1].toFixed(1) : null },
  };
}

/** Fire requests one after another until a 429 appears or the cap is reached. */
async function sequentialBurst(max: number) {
  const hits: Hit[] = [];
  for (let i = 0; i < max; i++) {
    const h = await hit(LATEST_ROUND);
    hits.push(h);
    if (h.status === 429) {
      return { ...summarise(hits), firstRateLimitedAtRequest: i + 1, headers: h.rateLimitHeaders };
    }
  }
  return { ...summarise(hits), firstRateLimitedAtRequest: null, headers: {} };
}

/**
 * Wait until the limiter lets us through again, and report how long that took.
 * This is what turns "429 after N requests" into an actual rate: N per window.
 */
async function waitForRecovery(maxSeconds: number): Promise<number | null> {
  const started = Date.now();
  while ((Date.now() - started) / 1000 < maxSeconds) {
    await new Promise((r) => setTimeout(r, 5_000));
    const res = await fetch(LATEST_ROUND);
    spent++;
    await res.arrayBuffer();
    if (res.status === 200) {
      return Math.round((Date.now() - started) / 1000);
    }
  }
  return null;
}

/** Fire requests all at once, to separate a per-second limit from a concurrency limit. */
async function concurrentBurst(n: number) {
  const hits = await Promise.all(Array.from({ length: n }, () => hit(LATEST_ROUND)));
  const limited = hits.find((h) => h.status === 429);
  return { ...summarise(hits), headers: limited?.rateLimitHeaders ?? {} };
}

/**
 * How far behind wall-clock the newest finalised round is. This is the floor on how long a
 * user waits between an XRPL payment and a usable proof, independent of anything we control.
 */
async function roundFinalisationLag(samples: number, gapMs: number) {
  const observations: Array<{ at: string; roundId: number; startTs: number; lagSeconds: number }> = [];
  for (let i = 0; i < samples; i++) {
    const res = await fetch(LATEST_ROUND);
    spent++;
    if (res.ok) {
      const body = (await res.json()) as { voting_round_id?: number; start_timestamp?: number };
      const roundId = body.voting_round_id ?? -1;
      const startTs = body.start_timestamp ?? 0;
      observations.push({
        at: new Date().toISOString(),
        roundId,
        startTs,
        lagSeconds: Math.round(Date.now() / 1000) - startTs,
      });
    } else {
      await res.arrayBuffer();
    }
    if (i < samples - 1) await new Promise((r) => setTimeout(r, gapMs));
  }
  const lags = observations.map((o) => o.lagSeconds);
  return {
    observations,
    lagSeconds: lags.length
      ? { min: Math.min(...lags), max: Math.max(...lags), mean: +(lags.reduce((a, b) => a + b, 0) / lags.length).toFixed(1) }
      : null,
  };
}

async function main() {
  console.log(`DA Layer: ${BASE}`);

  console.log("\n1. unauthenticated access");
  const anon = await hit(LATEST_ROUND);
  console.log(`   GET latest-voting-round without any key -> HTTP ${anon.status} in ${anon.ms.toFixed(0)}ms`);

  console.log("\n2. sequential burst (stops at first 429, max 120)");
  const sequential = await sequentialBurst(120);
  console.log(`   ${JSON.stringify(sequential)}`);

  console.log("\n   waiting for the limiter to release...");
  const recoverySeconds = await waitForRecovery(180);
  console.log(`   recovered after ~${recoverySeconds ?? ">180"}s`);

  console.log("\n3. concurrent burst (30 at once, from a released limiter)");
  const concurrent = await concurrentBurst(30);
  console.log(`   ${JSON.stringify(concurrent)}`);

  console.log("\n   waiting for the limiter to release again...");
  const recoverySeconds2 = await waitForRecovery(180);
  console.log(`   recovered after ~${recoverySeconds2 ?? ">180"}s`);

  console.log("\n4. round finalisation lag (12 samples, 10s apart)");
  const lag = await roundFinalisationLag(12, 10_000);
  console.log(`   ${JSON.stringify(lag.lagSeconds)}`);

  const result = {
    note: "Generated by executor/src/measure/daLayer.ts against the live Coston2 DA Layer.",
    capturedAt: new Date().toISOString(),
    endpoint: BASE,
    requiresApiKey: anon.status === 401 || anon.status === 403,
    unauthenticatedStatus: anon.status,
    sequentialBurst: sequential,
    recoverySecondsAfterSequential: recoverySeconds,
    concurrentBurst: concurrent,
    recoverySecondsAfterConcurrent: recoverySeconds2,
    roundFinalisation: lag,
    totalRequestsSent: spent,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(result, null, 2) + "\n");
  console.log(`\nwrote ${OUT} (sent ${spent} requests)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
