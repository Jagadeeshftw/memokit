/**
 * The store's job is to make a restart cheap, not to make it correct -- the chain does that.
 * These tests pin the three things that would cost money if they broke: observe never
 * overwrites, transitions keep their timestamps, and a store written for another deployment is
 * refused rather than silently reused.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/service/store.js";

const CONTROLLER = "0x0E762EAe8fe53e5247C22E5B52feD7A018150714";
let dir: string;
const path = () => join(dir, "state.json");

const payment = (id: string) => ({
  xrplHash: id.replace("0x", "").toUpperCase(),
  transactionId: id,
  xrplOwner: "rpnDcUjasCYome3WntkxqQ3gG4wuLXM4WE",
  receivingAddress: "rDfVHUx5SMgw5wwqjvzgFEFCnqW5CCGWyW",
  ledgerIndex: 100,
  closedAt: 1_700_000_000,
  memo: null,
  opcode: null,
  account: null,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memokit-store-"));
});

describe("Store", () => {
  it("observe is idempotent: a re-read payment does not reset its progress", () => {
    const store = new Store(path(), CONTROLLER);
    expect(store.observe(payment("0xaa"))).toBe(true);
    store.update("0xaa", { state: "attesting" });

    expect(store.observe(payment("0xaa"))).toBe(false);
    expect(store.get("0xaa")!.state).toBe("attesting");
  });

  it("survives a restart with every transition and timestamp intact", () => {
    const first = new Store(path(), CONTROLLER);
    first.observe(payment("0xbb"));
    first.update("0xbb", { state: "attesting" }, "requested in round 7");
    first.update("0xbb", { state: "proved" });

    const second = new Store(path(), CONTROLLER);
    const row = second.get("0xbb")!;
    expect(row.state).toBe("proved");
    expect(row.transitions.map((t) => t.state)).toEqual(["seen", "attesting", "proved"]);
    expect(row.transitions[1].note).toBe("requested in round 7");
    expect(row.transitions.every((t) => t.at > 0)).toBe(true);
  });

  it("refuses a state file written for a different controller", () => {
    writeFileSync(
      path(),
      JSON.stringify({ version: 1, controller: "0x98882776ED3CB4b3abB86CceFE2f46C1aAed9E36", instructions: {} }),
    );
    expect(() => new Store(path(), CONTROLLER)).toThrow(/was written for controller/);
  });

  it("pending excludes final states and anything backing off", () => {
    const store = new Store(path(), CONTROLLER);
    store.observe(payment("0x01"));
    store.observe(payment("0x02"));
    store.observe(payment("0x03"));
    store.update("0x02", { state: "executed" });
    store.update("0x03", { nextAttemptAt: Date.now() + 60_000 });

    expect(store.pending().map((i) => i.transactionId)).toEqual(["0x01"]);
    expect(store.pending(Date.now() + 120_000).map((i) => i.transactionId).sort()).toEqual(["0x01", "0x03"]);
  });

  it("records a repeated state once, so elapsed time is not reset by a retry", () => {
    const store = new Store(path(), CONTROLLER);
    store.observe(payment("0xcc"));
    store.update("0xcc", { state: "attesting" });
    store.update("0xcc", { state: "attesting", attempts: 2 });
    expect(store.get("0xcc")!.transitions).toHaveLength(2);
    expect(store.get("0xcc")!.attempts).toBe(2);
  });
});

process.on("exit", () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the tmpdir is the OS's problem now */
  }
});
