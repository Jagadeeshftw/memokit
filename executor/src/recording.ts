/**
 * Where a script writes the record of a live run.
 *
 * The committed traces under fixtures/ are evidence: the claim ledger cites them by name. A script
 * that wrote to a fixed path would silently replace that evidence with whatever the latest run
 * happened to do, so every run gets a new, timestamped file instead, and the write refuses to
 * replace one that exists.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** `<dir>/<stem>-<UTC time>.json`, e.g. `cash-out-trace-2026-10-01T09-12-03-123Z.json`. */
export function newRecordingPath(dir: string, stem: string, now: Date = new Date()): string {
  return resolve(dir, `${stem}-${now.toISOString().replace(/[:.]/g, "-")}.json`);
}

/** Write a new recording. Throws rather than overwrite an existing file. */
export function writeNewRecording(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { flag: "wx" });
}
