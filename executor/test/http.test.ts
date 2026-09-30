/**
 * The HTTP surface, through a real server on an ephemeral port.
 *
 * What matters here is what a browser on another origin can see. A 429 carries Retry-After,
 * but page script can only read it if the response exposes it: without
 * Access-Control-Expose-Headers, `response.headers.get("retry-after")` is null in a browser even
 * though the header is on the wire.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createHttpServer } from "../src/service/http.js";
import { Store } from "../src/service/store.js";
import { Metrics } from "../src/service/metrics.js";
import { createLogger } from "../src/service/log.js";
import { COSTON2 } from "@memokit/sdk";

const CONTROLLER = "0x0E762EAe8fe53e5247C22E5B52feD7A018150714";
const server = createHttpServer({
  network: COSTON2,
  controller: CONTROLLER,
  provider: null as never,
  store: new Store(join(mkdtempSync(join(tmpdir(), "memokit-http-")), "state.json"), CONTROLLER),
  da: null as never,
  metrics: new Metrics(),
  log: createLogger({ level: "error", sink: () => {} }),
  version: "test",
  receivers: async () => [],
  limits: { perIpPerMinute: 1, perIpBurst: 1, globalPerMinute: 100, maxConcurrentLookups: 1, cacheSeconds: 1 },
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const origin = { headers: { origin: "https://memokit.0xo.in" } };

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("cross-origin headers", () => {
  it("allow any origin and expose Retry-After on an ordinary response", async () => {
    const res = await fetch(`${base}/healthz`, origin);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-expose-headers")).toBe("Retry-After");
  });

  it("expose Retry-After on the 429 itself, which is the response that carries it", async () => {
    // The burst is 1, so the first request above spent it.
    const res = await fetch(`${base}/healthz`, origin);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(res.headers.get("access-control-expose-headers")).toBe("Retry-After");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("carry the same headers on /metrics, which is written by a different code path", async () => {
    const other = createHttpServer({
      network: COSTON2, controller: CONTROLLER, provider: null as never,
      store: new Store(join(mkdtempSync(join(tmpdir(), "memokit-http-")), "state.json"), CONTROLLER),
      da: null as never, metrics: new Metrics(), log: createLogger({ level: "error", sink: () => {} }),
      version: "test", receivers: async () => [],
    });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", () => r()));
    const res = await fetch(`http://127.0.0.1:${(other.address() as AddressInfo).port}/metrics`, origin);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-expose-headers")).toBe("Retry-After");
    await new Promise<void>((r) => other.close(() => r()));
  });
});
