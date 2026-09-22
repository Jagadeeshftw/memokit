/**
 * The open executor: a long-running service anyone can run.
 *
 * It watches the memokit receiving addresses on XRPL, builds attestation requests offline,
 * pays for them, waits for the Data Availability Layer, simulates, and submits `execute`. It
 * is paid the instruction's committed fee, in the asset the instruction moves.
 *
 *   npm run service -w @memokit/executor
 *
 * Three properties it is built around, all of them consequences of the measurements rather
 * than of taste:
 *
 *   **Idempotent across restarts.** State is persisted after every stage, and every stage is
 *   safe to repeat. The chain is the real guard -- an XRPL transaction id is consumable once --
 *   so a lost state file costs money, never correctness.
 *
 *   **Racing is normal.** Other executors are watching the same addresses. Every submission is
 *   simulated first, and a lost race is logged as an ordinary outcome, not an error. See
 *   RACE_COST_NOTE in pipeline.ts for what losing actually costs.
 *
 *   **Paced, not reactive.** The DA Layer sends no rate-limit headers, so there is nothing to
 *   back off against after the fact. The budget is spent through one token bucket at the
 *   measured ~20 requests a minute.
 */
import { JsonRpcProvider, Wallet, formatEther } from "ethers";
import { readFileSync, existsSync } from "node:fs";
import { DaLayerClient } from "@memokit/sdk/fdc";
import { loadConfig, MissingConfig, type ServiceConfig } from "./config.js";
import { createLogger } from "./log.js";
import { Metrics } from "./metrics.js";
import { Store } from "./store.js";
import { TokenBucket } from "./rateLimit.js";
import { Watcher } from "./watcher.js";
import { advance, type PipelineDeps } from "./pipeline.js";
import { controllerChain } from "./chain.js";
import { createHttpServer } from "./http.js";

const VERSION = "0.1.0";

export async function main(): Promise<void> {
  let config: ServiceConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof MissingConfig) {
      console.error(error.message);
      process.exit(2);
    }
    throw error;
  }

  const log = createLogger({ level: config.logLevel, base: { service: "memokit-executor" } });
  const metrics = new Metrics();
  describeMetrics(metrics);

  const provider = new JsonRpcProvider(config.network.rpc);
  const wallet = config.readOnly ? null : new Wallet(config.privateKey, provider);
  const store = new Store(config.statePath, config.controller);
  const da = new DaLayerClient(config.network.daLayerUrl);
  const bucket = new TokenBucket(config.daRequestsPerMinute);

  const watcher = new Watcher({
    network: config.network,
    controller: config.controller,
    provider,
    store,
    log,
    metrics,
    backfillLimit: config.backfillLimit,
    receivingAddresses: config.receivingAddresses,
  });

  const deps: PipelineDeps | null = wallet && {
    network: config.network,
    provider,
    chain: controllerChain({ controller: config.controller, provider, wallet, network: config.network }),
    store,
    policy: config.policy,
    da,
    bucket,
    log,
    metrics,
    maxAttempts: config.maxAttempts,
    dryRun: config.dryRun,
    payloadFor: payloadLookup(config.payloadsPath),
  };

  const balance = wallet ? await provider.getBalance(wallet.address) : 0n;
  log.info("starting", {
    version: VERSION,
    mode: config.readOnly ? "read-only (watch and serve, never sign)" : "executor",
    controller: config.controller,
    executor: wallet?.address ?? null,
    balance: wallet ? formatEther(balance) : null,
    receivers: await watcher.receivers(),
    acceptedFeeTokens: Object.keys(config.policy.minimumByToken),
    relayRescues: config.policy.relayRescues,
    dryRun: config.dryRun,
    tracked: store.all().length,
  });
  // Not fatal: the operator may be topping it up, and a service that exits on a low balance
  // cannot be the thing that tells them.
  if (wallet && balance === 0n) {
    log.warn("executor balance is zero: it can pay for nothing until funded");
  }

  let server: ReturnType<typeof createHttpServer> | null = null;
  if (config.httpPort !== null) {
    server = createHttpServer({
      network: config.network,
      controller: config.controller,
      provider,
      store,
      da,
      metrics,
      log,
      version: VERSION,
      receivers: () => watcher.receivers(),
    });
    server.listen(config.httpPort, () => log.info("http listening", { port: config.httpPort }));
  }

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down", { signal });
    server?.close();
    await watcher.close();
    // Nothing needs draining: every stage persists before it returns, so the worst an abrupt
    // stop loses is the current poll.
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));

  for (;;) {
    if (stopping) return;
    const started = Date.now();
    try {
      const discovered = await watcher.poll();
      const pending = store.pending();
      metrics.set("memokit_executor_pending", pending.length);
      if (discovered > 0 || pending.length > 0) {
        log.debug("tick", { discovered, pending: pending.length });
      }
      if (deps) {
        for (const instruction of pending) {
          if (stopping) return;
          await advance(instruction, deps);
        }
      }
      metrics.inc("memokit_executor_ticks_total");
      metrics.set("memokit_executor_last_tick_seconds", Math.round(Date.now() / 1000));
    } catch (error) {
      metrics.inc("memokit_executor_errors_total", { stage: "tick" });
      log.error("tick failed", { error: (error as Error).message });
    }
    const elapsed = Date.now() - started;
    await new Promise((r) => setTimeout(r, Math.max(1_000, config.pollIntervalMs - elapsed)));
  }
}

/**
 * Preimages for `0xFC` commit memos.
 *
 * A commit memo carries only a hash, and `execute` takes the preimage as an argument, so an
 * executor that does not have it cannot run the instruction at all -- not "will not", cannot.
 * This is the plainest way to supply them: a JSON file of transaction id to payload, re-read
 * on every lookup so an operator can add one without a restart.
 */
function payloadLookup(path: string | null): (transactionId: string) => string | undefined {
  if (!path) return () => undefined;
  return (transactionId: string) => {
    if (!existsSync(path)) return undefined;
    try {
      const map = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
      const key = Object.keys(map).find((k) => k.toLowerCase() === transactionId.toLowerCase());
      return key ? map[key] : undefined;
    } catch {
      return undefined;
    }
  };
}

function describeMetrics(m: Metrics): void {
  m.describe("memokit_executor_payments_seen_total", "XRPL payments discovered at a receiving address");
  m.describe("memokit_executor_attestations_requested_total", "Attestation requests this service paid for");
  m.describe("memokit_executor_attestations_reused_total", "Proofs found that somebody else paid for");
  m.describe("memokit_executor_proofs_total", "Proofs that became available");
  m.describe("memokit_executor_executions_total", "Instructions executed by this service");
  m.describe("memokit_executor_races_total", "Races, by outcome: won, lost, lost-before-start");
  m.describe("memokit_executor_declined_total", "Instructions the fee policy declined");
  m.describe("memokit_executor_rate_limited_total", "Times an upstream rate limit was hit");
  m.describe("memokit_executor_errors_total", "Errors, by pipeline stage");
  m.describe("memokit_executor_pending", "Instructions not yet in a final state");
}

// Only run when invoked directly, so the tests can import the pieces.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
