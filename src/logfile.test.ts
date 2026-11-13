// The companion's log files (SPEC §26.1): one per day, kept 14 days.

import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { logToFiles } from "./logfile.ts";

const original = { log: console.log, error: console.error };
afterEach(() => Object.assign(console, original));

it("writes what's printed to today's file and deletes files older than 14 days", () => {
  const dir = mkdtempSync(join(tmpdir(), "rc-logs-"));
  const old = join(dir, "companion-2026-10-01.log");
  writeFileSync(old, "old\n");
  const longAgo = new Date("2026-10-01T12:00:00");
  utimesSync(old, longAgo, longAgo);
  writeFileSync(join(dir, "notes.txt"), "not ours");
  const now = new Date("2026-11-13T21:00:00");
  logToFiles(dir, () => now);
  console.log("13:45:36.158  joined %s", "PC 2");
  console.error("a problem");
  expect(readFileSync(join(dir, "companion-2026-11-13.log"), "utf8")).toBe("13:45:36.158  joined PC 2\na problem\n");
  expect(existsSync(old)).toBe(false);
  expect(existsSync(join(dir, "notes.txt"))).toBe(true);
});
