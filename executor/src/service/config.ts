/**
 * The service's configuration, and a startup check that names what is missing.
 *
 * Every value is read once, here, and validated before anything connects. A service that
 * discovers a missing variable forty minutes in, halfway through an instruction, has already
 * cost somebody money.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getAddress } from "ethers";
import { COSTON2 as SDK_COSTON2, type Network } from "@memokit/sdk";
import { parseMinimums, type FeePolicyConfig } from "./feePolicy.js";
import { DEFAULT_LIMITS, type HttpLimits } from "./http.js";
import { DEFAULT_LOW_BALANCE_WEI } from "./balance.js";
import type { Level } from "./log.js";

export interface ServiceConfig {
  network: Network;
  controller: string;
  /** Receiving addresses to watch. Read from the controller when not pinned here. */
  receivingAddresses: string[] | null;
  privateKey: string;
  policy: FeePolicyConfig;
  statePath: string;
  /** Preimages for `0xFC` commit memos, keyed by transaction id. */
  payloadsPath: string | null;
  pollIntervalMs: number;
  /** Sustained DA Layer requests per minute. Measured at about 20. */
  daRequestsPerMinute: number;
  /** How far back to look on a cold start. */
  backfillLimit: number;
  /** Give up on an instruction after this many failed attempts at the same stage. */
  maxAttempts: number;
  httpPort: number | null;
  /** Per-caller and global limits on the HTTP surface. */
  httpLimits: HttpLimits;
  /**
   * Below this, `/healthz` and `/metrics` flag the executor as low on funds.
   *
   * A wei value rather than a friendly unit because it is compared against a balance, and a
   * unit conversion in a threshold is a place for an order-of-magnitude mistake to hide.
   */
  lowBalanceWei: string;
  logLevel: Level;
  /** Print what would happen and submit nothing. */
  dryRun: boolean;
  /**
   * Watch and serve the status API, but never sign anything.
   *
   * The status API is useful to people who are not executors -- a wallet, a support desk, the
   * status page -- and asking them for a funded Flare key to answer "where is my instruction"
   * would be absurd. In this mode no key is needed and none is read.
   */
  readOnly: boolean;
}

export class MissingConfig extends Error {
  constructor(readonly missing: string[]) {
    super(
      `The executor service cannot start. Missing or invalid:\n` +
        missing.map((m) => `  - ${m}`).join("\n") +
        `\n\nSee executor/DEPLOY.md for what each one is.`,
    );
    this.name = "MissingConfig";
  }
}

const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new MissingConfig([`${name} is "${raw}", which is not a number`]);
  return n;
};

export function loadConfig(env = process.env): ServiceConfig {
  const missing: string[] = [];
  const repo = resolve(import.meta.dirname, "../../..");

  const readOnly = env.READ_ONLY === "1";
  const privateKey = env.PRIVATE_KEY ?? "";
  if (!privateKey && !readOnly) {
    missing.push("PRIVATE_KEY — the Flare EOA that pays attestation fees and gas (or set READ_ONLY=1)");
  }

  // The controller address comes from the deployment file unless pinned, so the common case
  // needs no configuration at all and the uncommon one is explicit.
  let controller = env.MEMOKIT_CONTROLLER ?? "";
  if (!controller) {
    const path = resolve(repo, env.DEPLOYMENT_FILE ?? "fixtures/deployment.json");
    if (existsSync(path)) {
      controller = (JSON.parse(readFileSync(path, "utf8")) as { diamond: string }).diamond;
    } else {
      missing.push(`MEMOKIT_CONTROLLER — no address given and ${path} does not exist`);
    }
  }

  let policy: FeePolicyConfig;
  try {
    policy = {
      minimumByToken: parseMinimums(env.MIN_FEE),
      relayRescues: (env.RELAY_RESCUES ?? "true") !== "false",
      unknownPayload: env.UNKNOWN_PAYLOAD === "skip" ? "skip" : "wait",
    };
  } catch (e) {
    missing.push(`MIN_FEE — ${(e as Error).message}`);
    policy = { minimumByToken: {}, relayRescues: true, unknownPayload: "wait" };
  }

  if (!readOnly && Object.keys(policy.minimumByToken).length === 0 && !policy.relayRescues) {
    // Not fatal on its own, but a service configured this way will decline everything, and
    // silently doing nothing is the worst way for that to be discovered.
    missing.push(
      "MIN_FEE — empty, and RELAY_RESCUES=false. The service would decline every instruction",
    );
  }

  if (missing.length > 0) throw new MissingConfig(missing);

  return {
    network: {
      ...SDK_COSTON2,
      rpc: env.COSTON2_RPC ?? SDK_COSTON2.rpc,
      daLayerUrl: env.DA_LAYER_URL ?? SDK_COSTON2.daLayerUrl,
      xrpl: {
        ...SDK_COSTON2.xrpl,
        jsonRpc: env.XRPL_RPC ?? SDK_COSTON2.xrpl.jsonRpc,
        websocket: env.XRPL_WS ?? SDK_COSTON2.xrpl.websocket,
      },
    },
    controller: getAddress(controller),
    receivingAddresses: env.RECEIVING_ADDRESSES
      ? env.RECEIVING_ADDRESSES.split(",").map((s) => s.trim()).filter(Boolean)
      : null,
    privateKey,
    policy,
    statePath: resolve(repo, env.STATE_FILE ?? ".executor-state.json"),
    payloadsPath: env.PAYLOADS_FILE ? resolve(repo, env.PAYLOADS_FILE) : null,
    pollIntervalMs: num("POLL_INTERVAL_MS", 15_000),
    daRequestsPerMinute: num("DA_REQUESTS_PER_MINUTE", 20),
    backfillLimit: num("BACKFILL_LIMIT", 50),
    maxAttempts: num("MAX_ATTEMPTS", 8),
    // Read-only exists to serve the API, so it defaults the port on rather than off.
    httpPort: env.HTTP_PORT ? num("HTTP_PORT", 8080) : readOnly ? 8080 : null,
    httpLimits: {
      perIpPerMinute: num("RATE_LIMIT_PER_IP_PER_MINUTE", DEFAULT_LIMITS.perIpPerMinute),
      perIpBurst: num("RATE_LIMIT_PER_IP_BURST", DEFAULT_LIMITS.perIpBurst),
      globalPerMinute: num("RATE_LIMIT_GLOBAL_PER_MINUTE", DEFAULT_LIMITS.globalPerMinute),
      maxConcurrentLookups: num("MAX_CONCURRENT_LOOKUPS", DEFAULT_LIMITS.maxConcurrentLookups),
      cacheSeconds: num("CACHE_SECONDS", DEFAULT_LIMITS.cacheSeconds),
    },
    lowBalanceWei: env.LOW_BALANCE_WEI ?? DEFAULT_LOW_BALANCE_WEI.toString(),
    logLevel: (env.LOG_LEVEL as Level) ?? "info",
    dryRun: env.DRY_RUN === "1",
    readOnly,
  };
}
