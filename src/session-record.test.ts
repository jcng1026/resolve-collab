import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type SessionRecord, findHostSession, loadRecord, newRecord, saveRecord } from "./session-record.ts";

const id = (n: number) => n.toString(16).padStart(32, "0");

describe("session records (SPEC §22.1)", () => {
  it("round-trips, keyed by session ID", () => {
    const root = mkdtempSync(join(tmpdir(), "rc-rec-"));
    const rec: SessionRecord = { ...newRecord(id(1), "host", "a".repeat(64), "Sam"), project: "p-1", projectName: "Test" };
    rec.members.push({ key: "b".repeat(64), name: "Jo" });
    saveRecord(root, rec);
    expect(loadRecord(root, id(1))).toEqual(rec);
    expect(loadRecord(root, id(2))).toBeUndefined();
  });

  it("finds the host session an open project belongs to: the latest, not ended, not a member's", () => {
    const root = mkdtempSync(join(tmpdir(), "rc-rec-"));
    const host = (n: number, project: string, updated: number, extra: Partial<SessionRecord> = {}) =>
      saveRecord(root, { ...newRecord(id(n), "host", "a".repeat(64), "Sam"), project, projectName: "Test", updated, ...extra });
    host(1, "p-1", 100);
    host(2, "p-1", 300);
    host(3, "p-1", 500, { ended: true });
    saveRecord(root, { ...newRecord(id(4), "member", "c".repeat(64), "Alex"), project: "p-1", projectName: "Test", updated: 900 });
    host(5, "p-2", 999);
    // A session folder from before M6 (no session.json) and a damaged one are skipped.
    mkdirSync(join(root, "56391f8404401d97"), { recursive: true });
    mkdirSync(join(root, id(6)), { recursive: true });
    writeFileSync(join(root, id(6), "session.json"), "{not json");
    expect(findHostSession(root, "p-1")?.id).toBe(id(2));
    expect(findHostSession(root, "p-3")).toBeUndefined();
  });
});
