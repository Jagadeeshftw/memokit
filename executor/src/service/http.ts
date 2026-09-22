/**
 * The service's HTTP surface: health, metrics, and the status API.
 *
 * `node:http` and a switch. A framework would be more code to audit for a server with four
 * routes, all of them read-only, none of them taking a body.
 *
 * CORS is open because every response is public information that is already on two public
 * chains. There is nothing here to protect; pretending otherwise would only stop the status
 * page from reading it.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { Metrics } from "./metrics.js";
import type { Store } from "./store.js";
import type { Logger } from "./log.js";
import { statusOf, NotFound, type StatusDeps } from "./statusApi.js";

export interface HttpDeps extends StatusDeps {
  metrics: Metrics;
  store: Store;
  log: Logger;
  version: string;
}

export function createHttpServer(deps: HttpDeps): Server {
  return createServer((req, res) => {
    handle(req, res, deps).catch((error) => {
      deps.log.error("http handler threw", { error: (error as Error).message });
      send(res, 500, { error: "internal error" });
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: HttpDeps): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS") return void send(res, 204, null);
  if (req.method !== "GET") return void send(res, 405, { error: "GET only" });

  if (path === "/healthz") {
    const pending = deps.store.pending().length;
    return void send(res, 200, {
      ok: true,
      version: deps.version,
      uptimeSeconds: Math.round((Date.now() - deps.metrics.startedAt) / 1000),
      pending,
      tracked: deps.store.all().length,
      controller: deps.store.controller,
    });
  }

  if (path === "/metrics") {
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4", "access-control-allow-origin": "*" });
    return void res.end(deps.metrics.render());
  }

  // The status page's list view. Newest first, because that is the only order anyone reads it
  // in, and bounded because an unbounded list endpoint is a denial of service with extra steps.
  if (path === "/instructions") {
    const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 50) || 50);
    const state = url.searchParams.get("state");
    const rows = deps.store
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
    return void send(res, 200, { count: rows.length, instructions: rows });
  }

  const status = path.match(/^\/status\/([^/]+)$/);
  if (status) {
    try {
      return void send(res, 200, await statusOf(decodeURIComponent(status[1]), deps));
    } catch (error) {
      if (error instanceof NotFound) return void send(res, 404, { error: error.message });
      throw error;
    }
  }

  send(res, 404, {
    error: "no such route",
    routes: ["/healthz", "/metrics", "/instructions?limit=&state=", "/status/{xrplHash}"],
  });
}

function send(res: ServerResponse, code: number, body: unknown): void {
  const headers: Record<string, string> = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "cache-control": "no-store",
  };
  if (body === null) return void res.writeHead(code, headers).end();
  headers["content-type"] = "application/json";
  res.writeHead(code, headers);
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
}
