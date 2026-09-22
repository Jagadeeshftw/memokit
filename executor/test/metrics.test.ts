import { describe, it, expect } from "vitest";
import { Metrics } from "../src/service/metrics.js";

describe("Metrics", () => {
  it("keeps label sets apart and renders them in Prometheus form", () => {
    const m = new Metrics();
    m.describe("memokit_executor_races_total", "Races, by outcome");
    m.inc("memokit_executor_races_total", { outcome: "won" });
    m.inc("memokit_executor_races_total", { outcome: "lost-after-submit" }, 2);
    m.set("memokit_executor_pending", 3);

    expect(m.value("memokit_executor_races_total", { outcome: "won" })).toBe(1);
    expect(m.value("memokit_executor_races_total", { outcome: "lost-after-submit" })).toBe(2);

    const text = m.render();
    expect(text).toContain("# HELP memokit_executor_races_total Races, by outcome");
    expect(text).toContain('memokit_executor_races_total{outcome="won"} 1');
    expect(text).toContain("memokit_executor_pending 3");
    expect(text).toMatch(/memokit_executor_uptime_seconds \d+/);
  });

  it("is order-independent in labels, so the same series is never split in two", () => {
    const m = new Metrics();
    m.inc("x", { a: "1", b: "2" });
    m.inc("x", { b: "2", a: "1" });
    expect(m.value("x", { a: "1", b: "2" })).toBe(2);
  });

  it("escapes a label value that would otherwise break the format", () => {
    const m = new Metrics();
    m.inc("x", { reason: 'a "quoted" \\ thing' });
    expect(m.render()).toContain('x{reason="a \\"quoted\\" \\\\ thing"} 1');
  });
});
