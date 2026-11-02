import { describe, expect, it } from "vitest";
import { INBOX_CHUNK_BYTES, WireError, decodeInbox, encodeInboxFolders, parseInboxFolder, parseLogLine } from "./wire.ts";

const hex = (s: string) => Buffer.from(s, "utf8").toString("hex");

describe("parseLogLine", () => {
  it("reads a bridge message out of a Resolve log line", () => {
    const line = `[0x6b20] | Fusion | ERROR | 2026-11-02 18:25:27,149 | [string "???"]:1: RC|a1b2c3d4|EVT|${hex('{"type":"clip.added"}')}`;
    expect(parseLogLine(line)).toEqual({ bridgeId: "a1b2c3d4", kind: "EVT", payload: { type: "clip.added" } });
  });

  it("ignores unrelated lines and unknown kinds", () => {
    expect(parseLogLine("[0x1] | Main | INFO | Application state changed")).toBeNull();
    expect(parseLogLine(`RC|a1b2c3d4|NOPE|${hex("1")}`)).toBeNull();
    expect(parseLogLine("RCFEAS|Stage|00")).toBeNull();
  });
});

describe("inbox folders", () => {
  it("round-trips a small message in one folder", () => {
    const names = encodeInboxFolders(7, { type: "clip.append", start: 86400 });
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^00000007\.001\.001\.[0-9a-f]+$/);
    expect(decodeInbox(names)).toEqual([{ seq: 7, message: { type: "clip.append", start: 86400 } }]);
  });

  it("splits long messages and reassembles them in any order, including multi-byte text", () => {
    const message = { path: `C:\\media\\${"é".repeat(150)}.mp4` };
    const names = encodeInboxFolders(42, message);
    expect(names.length).toBeGreaterThan(1);
    for (const name of names) expect(parseInboxFolder(name)!.hex.length).toBeLessThanOrEqual(INBOX_CHUNK_BYTES * 2);
    expect(decodeInbox([...names].reverse())).toEqual([{ seq: 42, message }]);
  });

  it("holds back incomplete messages and orders complete ones by seq", () => {
    const big = encodeInboxFolders(2, { s: "x".repeat(300) });
    const small = encodeInboxFolders(5, { ok: true });
    expect(decodeInbox([...small, ...big.slice(1)])).toEqual([{ seq: 5, message: { ok: true } }]);
    expect(decodeInbox([...small, ...big]).map((m) => m.seq)).toEqual([2, 5]);
  });

  it("ignores folders that aren't inbox messages", () => {
    expect(decodeInbox(["New folder", "00000001.001.001.zz"])).toEqual([]);
  });

  it("keeps folder names within the Windows path budget", () => {
    const [name] = encodeInboxFolders(99_999_999, { s: "y".repeat(INBOX_CHUNK_BYTES) });
    expect(name!.length).toBeLessThanOrEqual(8 + 1 + 3 + 1 + 3 + 1 + INBOX_CHUNK_BYTES * 2);
  });

  it("rejects bad sequence numbers", () => {
    expect(() => encodeInboxFolders(-1, {})).toThrow(WireError);
    expect(() => encodeInboxFolders(1.5, {})).toThrow(WireError);
  });
});
