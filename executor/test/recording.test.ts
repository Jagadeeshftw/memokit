/**
 * The scripts that record live runs (cash-out, e2e, payout, verify:mic) once wrote to fixed paths
 * and replaced the committed evidence the claim ledger cites. These pin that they cannot.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { newRecordingPath, writeNewRecording } from "../src/recording.js";

describe("recordings of live runs", () => {
  it("get a new, timestamped name, never the committed one", () => {
    const dir = mkdtempSync(join(tmpdir(), "memokit-rec-"));
    const a = newRecordingPath(dir, "cash-out-trace", new Date("2026-10-01T09:12:03.123Z"));
    const b = newRecordingPath(dir, "cash-out-trace", new Date("2026-10-01T09:12:03.124Z"));
    expect(basename(a)).toBe("cash-out-trace-2026-10-01T09-12-03-123Z.json");
    expect(a).not.toBe(b);
    for (const stem of ["cash-out-trace", "e2e-trace-vault", "e2e-trace-payout", "xrppayment-oracle"]) {
      expect(basename(newRecordingPath(dir, stem))).not.toBe(`${stem}.json`);
    }
  });

  it("refuse to overwrite a file that exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "memokit-rec-"));
    const path = join(dir, "cash-out-trace.json");
    writeFileSync(path, "committed evidence\n");
    expect(() => writeNewRecording(path, "a new run\n")).toThrow(/EEXIST/);
    expect(readFileSync(path, "utf8")).toBe("committed evidence\n");
  });

  it("write a new file when the name is free", () => {
    const dir = mkdtempSync(join(tmpdir(), "memokit-rec-"));
    const path = newRecordingPath(join(dir, "nested"), "e2e-trace-payout");
    writeNewRecording(path, "{}\n");
    expect(readFileSync(path, "utf8")).toBe("{}\n");
  });
});
