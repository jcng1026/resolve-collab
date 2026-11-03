// Runs the bridge's pure functions under Resolve's own LuaJIT (fuscript) and
// checks them against the TypeScript side of the wire format.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { encodeInboxFolders, readyFolder } from "../src/bridge-protocol/wire.ts";

const FUSCRIPT = "C:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\fuscript.exe";
const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), "ResolveCollab.lua").replaceAll("\\", "/");

// Each case is evaluated in Lua as `function(M, input) ... end`; the result
// (or the error) comes back as JSON.
function runLua(cases: { body: string; input: string }[]): { ok: boolean; value?: unknown; error?: string }[] {
  const lua = [
    `local M = loadfile([[${BRIDGE}]])("test")`,
    ...cases.map(
      (c, i) => `do
        local f = function(M, input) ${c.body} end
        local ok, v = pcall(f, M, [==[${c.input}]==])
        print("CASE ${i} " .. M.hex(M.jencode(ok and { ok = true, value = v } or { ok = false, error = tostring(v) })))
      end`,
    ),
  ].join("\n");
  const file = join(mkdtempSync(join(tmpdir(), "rc-lua-")), "cases.lua");
  writeFileSync(file, lua);
  const out = execFileSync(FUSCRIPT, ["-l", "lua", file], { encoding: "utf8" });
  return cases.map((_, i) => {
    const line = out.split(/\r?\n/).find((l) => l.startsWith(`CASE ${i} `));
    if (!line) throw new Error(`case ${i} produced no output:\n${out}`);
    return JSON.parse(Buffer.from(line.slice(`CASE ${i} `.length), "hex").toString("utf8"));
  });
}

const roundTrip = "return M.jdecode(input)";

describe.skipIf(!existsSync(FUSCRIPT))("Lua bridge codec (fuscript)", () => {
  it("decodes JSON the way JSON.parse does", () => {
    const samples = [
      '{"type":"clip.append","track":2,"start":86400,"neg":-1.5,"exp":1e3}',
      '{"s":"quote \\" backslash \\\\ slash \\/ tab \\t nl \\n"}',
      '{"u":"caf\\u00e9 \\ud83c\\udfac","raw":"é🎬"}',
      // An empty [] comes back as {}: Lua has one table type for both.
      '{"arr":[1,"two",true,false,{"x":[0]}],"empty":{}}',
      '  [ 1 , 2 ]  ',
    ];
    const results = runLua(samples.map((input) => ({ body: roundTrip, input })));
    results.forEach((result, i) => {
      expect(result.ok, String(result.error)).toBe(true);
      expect(result.value).toEqual(JSON.parse(samples[i]!));
    });
  });

  it("rejects malformed or hostile JSON", () => {
    const bad = ['{"a":1', "[1,]", '"\\x"', "true false", "nil", "os.exit()", "[".repeat(40) + "]".repeat(40)];
    for (const result of runLua(bad.map((input) => ({ body: roundTrip, input })))) {
      expect(result.ok).toBe(false);
    }
  });

  it("decodes inbox folders written by the TypeScript encoder", () => {
    const big = { type: "clip.append", media: { name: `${"é".repeat(120)}.mp4` } };
    const bigNames = encodeInboxFolders(3, big);
    expect(bigNames.length).toBeGreaterThan(1);
    const names = [...bigNames, ...encodeInboxFolders(1, { type: "ping" })].reverse();
    const toPaths = (list: string[]) => JSON.stringify(list.map((n) => `C:\\dev\\inbox\\${n}\\`));
    const [all, newer, partial] = runLua([
      { body: `return M.decodeInbox(M.jdecode(input), 0)`, input: toPaths(names) },
      { body: `return M.decodeInbox(M.jdecode(input), 1)`, input: toPaths(names) },
      { body: `return M.decodeInbox(M.jdecode(input), 0)`, input: toPaths(names.filter((n) => n !== bigNames[0])) },
    ]);
    expect(all!.value).toEqual([
      { seq: 1, message: { type: "ping" } },
      { seq: 3, message: big },
    ]);
    expect(newer!.value).toEqual([{ seq: 3, message: big }]);
    // One part of seq 3 missing: only the complete message comes through.
    expect((partial!.value as { seq: number }[]).map((m) => m.seq)).toEqual([1]);
  });

  it("names the ready folder as the companion does, and decodeInbox ignores it", () => {
    const [name, decoded] = runLua([
      { body: "return M.readyName(tonumber(input))", input: "42" },
      { body: "return M.decodeInbox(M.jdecode(input), 0)", input: JSON.stringify([readyFolder(1), ...encodeInboxFolders(1, { type: "ping" })]) },
    ]);
    expect(name!.value).toBe(readyFolder(42));
    expect(decoded!.value).toEqual([{ seq: 1, message: { type: "ping" } }]);
  });

  it("turns a frame offset into a timecode from the timeline's start", () => {
    const results = runLua([
      { body: `return M.timecode(0, 24, "01:00:00:00")`, input: "" },
      { body: `return M.timecode(1248, 24, "01:00:00:00")`, input: "" },
      { body: `return M.timecode(90000, 23.976, "00:59:59:00")`, input: "" },
      { body: `return M.timecode(25, 25, "10:00:00;00")`, input: "" },
    ]);
    expect(results.map((r) => r!.value)).toEqual(["01:00:00:00", "01:00:52:00", "02:02:29:00", "10:00:01:00"]);
  });

  it("tells item kinds apart as the probes found them", () => {
    const kinds = runLua([
      { body: `return M.itemKind({ type = "video", mediaType = "Video + Audio" })`, input: "" },
      { body: `return M.itemKind({ type = "video", mediaType = "Compound" })`, input: "" },
      { body: `return M.itemKind({ type = "generator", name = "Text" })`, input: "" },
      { body: `return M.itemKind({ type = "generator", name = "Solid Color" })`, input: "" },
      { body: `return M.itemKind({ type = "video", textPlus = true })`, input: "" },
      { body: `return M.itemKind({ type = "transition" })`, input: "" },
      { body: `return M.itemKind({ type = "video" })`, input: "" },
    ]);
    expect(kinds.map((r) => r!.value)).toEqual(["clip", "other", "title", "generator", "textplus", "transition", "other"]);
  });

  it("reads where an item sits, or nothing while Resolve can't say (an item being dropped)", () => {
    const item = (start: string, duration: string, uid = `"u1"`) =>
      `local it = { GetUniqueId = function() return ${uid} end, GetStart = function() return ${start} end, GetDuration = function() return ${duration} end }`;
    const results = runLua([
      { body: `${item("86448", "48")}; local u, s, d = M.placeOf(it, 86400); return { u, s, d }`, input: "" },
      { body: `${item("nil", "48")}; local u, s, d = M.placeOf(it, 86400); return { u or false, s or false, d or false }`, input: "" },
      { body: `${item("86448", "nil")}; local u, s = M.placeOf(it, 86400); return { u or false, s or false }`, input: "" },
      { body: `${item("86448", "48", "nil")}; local u, s = M.placeOf(it, 86400); return { u or false, s or false }`, input: "" },
      // A deleted item's methods can throw.
      { body: `local it = { GetUniqueId = function() error("gone") end }; local u = M.placeOf(it, 0); return u or false`, input: "" },
    ]);
    expect(results.map((r) => r.value)).toEqual([["u1", 48, 48], ["u1", false, false], ["u1", false], [false, false], false]);
  });

  it("picks the synced properties, or nothing when Resolve returned none of them", () => {
    const keys = `{ ZoomX = true, Opacity = true }`;
    const results = runLua([
      { body: `return M.pickProps({ ZoomX = 1.5, Opacity = 100, Other = 3, Name = "x" }, ${keys})`, input: "" },
      { body: `return M.pickProps(nil, ${keys}) or false`, input: "" },
      { body: `return M.pickProps({}, ${keys}) or false`, input: "" },
      { body: `return M.pickProps({ Other = 3 }, ${keys}) or false`, input: "" },
    ]);
    expect(results.map((r) => r.value)).toEqual([{ ZoomX: 1.5, Opacity: 100 }, false, false, false]);
  });

  it("round-trips hex", () => {
    const [result] = runLua([{ body: "return M.unhex(M.hex(input))", input: "héllo|RC|\"x\"" }]);
    expect(result!.value).toBe('héllo|RC|"x"');
  });

  it("encodes object keys sorted, so a record's encoding only changes when it does", () => {
    const [result] = runLua([{ body: "return M.jencode({ zeta = 1, alpha = { b = 2, a = 1 }, mid = 'x' })", input: "" }]);
    expect(result!.value).toBe('{"alpha":{"a":1,"b":2},"mid":"x","zeta":1}');
  });

  it("compiles as a whole, runtime included", () => {
    const [result] = runLua([{ body: `local f, err = loadfile([[${BRIDGE}]]); return f and "ok" or tostring(err)`, input: "" }]);
    expect(result!.value).toBe("ok");
  });
});
