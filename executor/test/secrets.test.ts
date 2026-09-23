/**
 * The deployed executor is a machine on the public internet. These pin what it must not be
 * holding, and that the check reports names rather than values -- a guard that leaks the thing
 * it guards is worse than no guard.
 */
import { describe, it, expect } from "vitest";
import { auditEnvironment, FORBIDDEN_ENV } from "../src/service/secrets.js";

describe("auditEnvironment", () => {
  it("passes an environment holding only what an executor needs", () => {
    const audit = auditEnvironment({ PRIVATE_KEY: "0xabc", MIN_FEE: "0xtoken:1", HTTP_PORT: "8080" });
    expect(audit.clean).toBe(true);
    expect(audit.present).toEqual([]);
  });

  it("catches an XRPL seed, which an executor never needs because it only reads XRPL", () => {
    const audit = auditEnvironment({ PRIVATE_KEY: "0xabc", XRPL_SEED: "sEdSECRET" });
    expect(audit.clean).toBe(false);
    expect(audit.present).toEqual(["XRPL_SEED"]);
  });

  it("reports names only, never values", () => {
    const secret = "sEdVeryMuchASecretValue";
    const audit = auditEnvironment({ XRPL_SEED: secret, XAMAN_API_SECRET: "also-secret" });
    expect(JSON.stringify(audit)).not.toContain(secret);
    expect(JSON.stringify(audit)).not.toContain("also-secret");
    expect(audit.present).toEqual(["XRPL_SEED", "XAMAN_API_SECRET"]);
  });

  it("ignores a variable that is present but empty, which is how a slot is documented", () => {
    expect(auditEnvironment({ XRPL_SEED: "" }).clean).toBe(true);
    expect(auditEnvironment({ XRPL_SEED: "   " }).clean).toBe(true);
  });

  it("covers every name this repo's own .env uses for a seed", () => {
    // The accident being guarded against is a deploy that copies a local environment wholesale,
    // so the list has to match the names that environment actually uses.
    expect(FORBIDDEN_ENV).toContain("XRPL_SEED");
    expect(FORBIDDEN_ENV).toContain("XRPL_RECEIVING_SEED");
    expect(FORBIDDEN_ENV).toContain("XAMAN_API_SECRET");
  });
});
