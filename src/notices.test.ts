// Notice wording and acting once (SPEC §23.1).

import { describe, expect, it } from "vitest";
import { Notices } from "./notices.ts";
import type { Conflict } from "./sync/reconcile.ts";

const field = (label: string, f: string, mine: unknown, theirs: unknown): Conflict =>
  ({ key: `clip:${label}:${f}`, kind: "field", item: "clip", id: label, label, field: f, mine, theirs });

describe("notices", () => {
  it("words one change, several, and a marker clash; reapply holds what to send", () => {
    const notices = new Notices();
    const one = notices.raced([field("a.mp4", "color", "Red", "Blue")], () => "Alex")!;
    expect(one.text).toBe('[1] Alex changed the colour of "a.mp4" at the same moment, so your change was undone.  reapply 1 = send yours again');
    expect(one.changes).toEqual([{ item: "clip", id: "a.mp4", fields: { color: "Red" } }]);

    const many = notices.raced([field("a.mp4", "meta:Scene", "1", "2"), field("b.mp4", "name", "x", "y")], (c) => (c.id === "a.mp4" ? "Alex" : "Sam"))!;
    expect(many.text).toBe('[2] Others changed the Scene of "a.mp4" and the name of "b.mp4" at the same moment, so your changes were undone.  reapply 2 = send yours again');

    const clash: Conflict = { key: "k", kind: "clash", item: "marker", id: "m1", label: "", mine: { id: "m1", frame: 12 }, theirs: { id: "m2", frame: 12 }, mineOps: [{ type: "marker.delete", id: "m2" }] };
    const c = notices.raced([clash], () => undefined)!;
    expect(c.text).toMatch(/^\[3\] someone changed the marker on frame 12 at the same moment/);
    expect(c.ops).toEqual([{ type: "marker.delete", id: "m2" }]);

    expect(notices.take(1, "restore")).toBeUndefined(); // not that kind
    expect(notices.take(1, "reapply")).toBe(one);
    expect(notices.take(1, "reapply")).toBeUndefined(); // once
    expect(notices.raced([], () => "x")).toBeUndefined();
  });
});
