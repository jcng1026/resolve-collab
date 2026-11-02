import { describe, expect, it } from "vitest";
import { hexToUtf8, joinResultChunks, parseLogLine, stampStateDir, summarize } from "./lib.ts";

const hex = (s: string) => Buffer.from(s, "utf8").toString("hex");

describe("parseLogLine", () => {
  it("reads a probe message from a Resolve log line", () => {
    const line = `[0x00006b20] | Fusion               | ERROR | 2026-11-02 18:25:27,149 | [string "???"]:1: RCFEAS|Stage|${hex("pollLoop")}`;
    expect(parseLogLine(line)).toEqual({ key: "Stage", hex: hex("pollLoop") });
  });

  it("ignores other log lines", () => {
    expect(parseLogLine("[0x0000380c] | Main | INFO | 2026-11-02 18:11:39,723 | Application state changed")).toBeNull();
    expect(parseLogLine('[string "???"]:1: RCFEAS-RATE 7')).toBeNull();
  });
});

describe("hexToUtf8", () => {
  it("decodes UTF-8", () => expect(hexToUtf8(hex("é ok"))).toBe("é ok"));
  it("rejects malformed input", () => {
    expect(() => hexToUtf8("abc")).toThrow();
    expect(() => hexToUtf8("zz")).toThrow();
  });
});

describe("joinResultChunks", () => {
  it("joins chunks in numeric order", () => {
    const full = hex('{"a":1}');
    const keys = new Map([
      ["ResultCount", hex("2")],
      ["Result2", full.slice(6)],
      ["Result1", full.slice(0, 6)],
    ]);
    expect(joinResultChunks(keys)).toBe('{"a":1}');
  });

  it("returns null while a chunk is missing", () => {
    expect(joinResultChunks(new Map([["ResultCount", hex("2")], ["Result1", "00"]]))).toBeNull();
    expect(joinResultChunks(new Map())).toBeNull();
  });
});

describe("summarize", () => {
  it("computes order statistics", () => {
    expect(summarize([5, 1, 3, 2, 4])).toEqual({ count: 5, min: 1, median: 3, p95: 5, max: 5 });
    expect(summarize([])).toBeNull();
  });
});

describe("stampStateDir", () => {
  it("replaces the placeholder", () => {
    expect(stampStateDir("local D = [[__STATE_DIR__]]", "C:\\x")).toBe("local D = [[C:\\x]]");
  });
  it("refuses paths that would end the Lua long string", () => {
    expect(() => stampStateDir("[[__STATE_DIR__]]", "C:\\a]]b")).toThrow();
  });
});
