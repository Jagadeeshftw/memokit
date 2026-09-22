/**
 * Discover instructions: every XRPL payment arriving at a receiving address.
 *
 * Polling, not a websocket subscription. A subscription misses everything that happened while
 * the process was down, and this service is expected to be restarted; a poll that always looks
 * a little further back than it needs to is the version that survives a deploy. The store
 * discards the duplicates it re-reads, so over-reading costs one comparison.
 *
 * The receiving addresses come from the controller, not from configuration, because the
 * controller is where they are authoritative -- an operator who edits an env var does not
 * change which addresses the contract accepts.
 */
import { Contract, JsonRpcProvider } from "ethers";
import { Client } from "xrpl";
import { fetchIncomingPayments, type Network, type XrplPaymentRecord } from "@memokit/sdk";
import type { Logger } from "./log.js";
import type { Metrics } from "./metrics.js";
import type { Store } from "./store.js";

const RECEIVERS_ABI = ["function receivingAddresses() view returns (string[])"];
const RECEIVERS_TTL_MS = 60_000;

export class Watcher {
  private client: Client | null = null;
  /** Highest ledger index seen per receiving address, so each poll asks for less. */
  private readonly seenTo = new Map<string, number>();
  private cachedReceivers: { value: string[]; at: number } | null = null;

  constructor(
    private readonly deps: {
      network: Network;
      controller: string;
      provider: JsonRpcProvider;
      store: Store;
      log: Logger;
      metrics: Metrics;
      backfillLimit: number;
      /** Pinned addresses; when null they are read from the controller on every resolve. */
      receivingAddresses: string[] | null;
    },
  ) {}

  /**
   * The registered receiving addresses, cached for a minute.
   *
   * They change about never -- adding one is an owner transaction -- and this is called on
   * every tick and every status request, so reading the chain each time buys nothing and
   * spends a request. The cache is also the failure handling: a transient RPC blip served the
   * last known answer instead of taking the status API down with it, which is exactly what
   * happened the first time this ran against live Coston2.
   */
  async receivers(): Promise<string[]> {
    if (this.deps.receivingAddresses) return this.deps.receivingAddresses;
    const fresh = this.cachedReceivers && Date.now() - this.cachedReceivers.at < RECEIVERS_TTL_MS;
    if (fresh) return this.cachedReceivers!.value;

    try {
      const c = new Contract(this.deps.controller, RECEIVERS_ABI, this.deps.provider);
      const value: string[] = await c.receivingAddresses();
      this.cachedReceivers = { value, at: Date.now() };
      return value;
    } catch (error) {
      if (!this.cachedReceivers) throw error;
      this.deps.log.warn("could not refresh the receiving addresses; using the cached set", {
        error: (error as Error).message,
        ageSeconds: Math.round((Date.now() - this.cachedReceivers.at) / 1000),
      });
      return this.cachedReceivers.value;
    }
  }

  private async connected(): Promise<Client> {
    if (this.client?.isConnected()) return this.client;
    this.client = new Client(this.deps.network.xrpl.websocket);
    await this.client.connect();
    return this.client;
  }

  /** One sweep. Returns how many payments were new. */
  async poll(): Promise<number> {
    const client = await this.connected();
    const receivers = await this.receivers();
    this.deps.metrics.set("memokit_executor_receiving_addresses", receivers.length);

    let discovered = 0;
    for (const receiver of receivers) {
      let payments: XrplPaymentRecord[];
      try {
        payments = await fetchIncomingPayments({
          network: this.deps.network,
          receivingAddress: receiver,
          limit: this.deps.backfillLimit,
          client,
        });
      } catch (e) {
        this.deps.metrics.inc("memokit_executor_errors_total", { stage: "watch" });
        this.deps.log.warn("could not read the ledger", { receiver, error: (e as Error).message });
        continue;
      }

      for (const p of payments) {
        if (!p.sender) continue;
        const isNew = this.deps.store.observe({
          xrplHash: p.hash,
          transactionId: "0x" + p.hash.toLowerCase(),
          xrplOwner: p.sender,
          receivingAddress: receiver,
          ledgerIndex: p.ledgerIndex,
          closedAt: p.closedAt,
          memo: p.memo,
          opcode: null,
          account: null,
        });
        if (isNew) {
          discovered++;
          this.deps.metrics.inc("memokit_executor_payments_seen_total");
          this.deps.log.info("new payment", {
            txid: "0x" + p.hash.toLowerCase(),
            owner: p.sender,
            ledger: p.ledgerIndex,
            hasMemo: p.memo !== null,
          });
        }
        const high = this.seenTo.get(receiver) ?? 0;
        if (p.ledgerIndex > high) this.seenTo.set(receiver, p.ledgerIndex);
      }
    }
    return discovered;
  }

  async close(): Promise<void> {
    if (this.client?.isConnected()) await this.client.disconnect();
    this.client = null;
  }
}
