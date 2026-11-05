// Activity lines (SPEC §24.3): wording, old → new, merging, the 500-line limit.

import { describe, expect, it } from "vitest";
import { Activity, MAX_LINES, cleanLine, describe as describeOp, timecode } from "./activity.ts";
import { ROOT, emptyPool } from "./sync/media-pool.ts";
import { type SessionModel, type SessionOp, applySessionOp } from "./sync/session-model.ts";
import { emptyTimelines } from "./sync/timeline.ts";

const id = (n: number) => n.toString(16).padStart(32, "0");

// A clip; a 24 fps timeline with V1, V2, A1, and a linked video/audio pair on V1/A1.
function model(): SessionModel {
  const pool = emptyPool();
  pool.clips[id(10)] = { id: id(10), name: "a.mp4", bin: ROOT, color: "", flags: [], meta: {}, file: null };
  const t = emptyTimelines();
  t.timelines[id(20)] = { id: id(20), name: "Edit", fps: 24, width: 1920, height: 1080 };
  t.tracks[id(21)] = { id: id(21), timeline: id(20), kind: "video", order: 1, name: "", enabled: true, locked: false, subType: "" };
  t.tracks[id(22)] = { id: id(22), timeline: id(20), kind: "video", order: 2, name: "", enabled: true, locked: false, subType: "" };
  t.tracks[id(23)] = { id: id(23), timeline: id(20), kind: "audio", order: 1, name: "", enabled: true, locked: false, subType: "stereo" };
  const clip = { timeline: id(20), kind: "clip" as const, start: 240, duration: 48, enabled: true, color: "", name: "a.mp4", media: id(10), srcStart: 0, link: "L1" };
  t.items[id(30)] = { id: id(30), track: id(21), ...clip };
  t.items[id(31)] = { id: id(31), track: id(23), ...clip };
  return { pool, timelines: t };
}

describe("describing a change", () => {
  it("says what changed in words, with old → new", () => {
    const m = model();
    expect(describeOp(m, { type: "item.set", id: id(30), start: 288, track: id(22) })).toMatchObject({
      text: "moved a.mp4 on V1",
      changes: [{ name: "start", from: "01:00:10:00", to: "01:00:12:00" }, { name: "track", from: "V1", to: "V2" }],
      timeline: id(20), frame: 288,
    });
    expect(describeOp(m, { type: "clip.set", id: id(10), color: "Blue" })).toMatchObject({ text: "recoloured a.mp4", changes: [{ name: "colour", from: "none", to: "Blue" }] });
    expect(describeOp(m, { type: "item.set", id: id(30), duration: 40 }).text).toBe("trimmed a.mp4 on V1");
    expect(describeOp(m, { type: "marker.create", id: id(40), timeline: id(20), item: "", frame: 10, duration: 1, color: "Red", name: "Fix audio", note: "" }).text).toBe("added a marker “Fix audio” on Edit");
    expect(describeOp(m, { type: "item.delete", id: id(31) }).text).toBe("deleted a.mp4 on A1");
    expect(describeOp(m, { type: "timeline.set", id: id(20), name: "Cut 2" })).toMatchObject({ text: "renamed the timeline “Edit”", changes: [{ name: "name", from: "Edit", to: "Cut 2" }] });
  });

  it("writes timecode from the frame", () => {
    expect(timecode(0, 24)).toBe("01:00:00:00");
    expect(timecode(24 * 61 + 5, 24)).toBe("01:01:01:05");
  });
});

describe("activity lines", () => {
  it("merges only one action's pieces: a drag and a linked pair, not a recolour then a move", () => {
    const a = new Activity();
    const m = model();
    const apply = (op: SessionOp, who = "jo", at = 1000) => {
      const line = a.change(m, op, who, who === "jo" ? "Jo" : "Sam", at);
      applySessionOp(m, op);
      return line;
    };
    apply({ type: "item.set", id: id(30), start: 288 });
    apply({ type: "item.set", id: id(31), start: 288 }, "jo", 1100); // its audio half
    apply({ type: "item.set", id: id(30), start: 300 }, "jo", 2000); // dragged on
    expect(a.lines).toHaveLength(1);
    expect(a.lines[0]!.changes).toEqual([{ name: "start", from: "01:00:10:00", to: "01:00:12:12" }]);
    apply({ type: "clip.set", id: id(10), color: "Blue" }, "sam", 2500); // someone else
    apply({ type: "item.set", id: id(30), start: 310 }, "jo", 2000 + 20_000); // later: a new line
    apply({ type: "item.set", id: id(30), color: "Pink" }, "jo", 22_500); // the same clip, another action: a new line
    expect(a.lines.map((l) => `${l.name}: ${l.text}`)).toEqual(["Jo: moved a.mp4 on V1", "Sam: recoloured a.mp4", "Jo: moved a.mp4 on V1", "Jo: recoloured a.mp4 on V1"]);
    expect(a.event("jo", "Jo", "Jo joined", "good")).toMatchObject({ kind: "event", text: "Jo joined", tone: "good" });
    a.chat("jo", "Jo", "  looks good  ", 30_000);
    expect(a.lines.at(-1)).toMatchObject({ kind: "chat", text: "looks good" });
    expect(a.chat("jo", "Jo", "   ")).toBeUndefined();
  });

  it("keeps the last 500 lines and carries on numbering after a restart", () => {
    const a = new Activity();
    for (let i = 0; i < MAX_LINES + 10; i++) a.chat("jo", "Jo", `m${i}`);
    expect(a.lines).toHaveLength(MAX_LINES);
    expect(a.lines[0]!.text).toBe("m10");
    const again = new Activity(a.lines);
    expect(again.chat("jo", "Jo", "next")!.id).toBe(a.lines.at(-1)!.id + 1);
  });

  it("checks lines from the host", () => {
    const ok = { id: 3, kind: "change", at: 1, author: "abcd1234", name: "Jo", text: "moved a.mp4", changes: [{ name: "start", from: "a", to: "b" }], timeline: id(20), frame: 4 };
    expect(cleanLine({ ...ok, extra: "<script>" })).toEqual(ok);
    expect(cleanLine({ ...ok, kind: "html" })).toBeUndefined();
    expect(cleanLine({ ...ok, changes: [{ name: 1 }] })).toBeUndefined();
  });
});
