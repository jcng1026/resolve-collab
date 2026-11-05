// The inverse of every kind of operation puts the session back as it was
// (SPEC §23.2), and the history keeps 100 steps on disk.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, emptyPool } from "./sync/media-pool.ts";
import { type SessionModel, type SessionOp, applySessionOp, cloneModel, validateSessionOp } from "./sync/session-model.ts";
import { emptyTimelines } from "./sync/timeline.ts";
import { History, MAX_STEPS, inverseOf } from "./undo.ts";

const id = (n: number) => n.toString(16).padStart(32, "0");
const HASH = "a".repeat(64);

// Bins 1 > 2, a clip in bin 2 with a pool marker; a timeline with V1, V2,
// a clip on V2 with a marker, a dissolve on it, and a ruler marker.
function model(): SessionModel {
  const pool = emptyPool();
  pool.bins[id(1)] = { id: id(1), name: "Footage", parent: ROOT };
  pool.bins[id(2)] = { id: id(2), name: "Day 1", parent: id(1) };
  pool.clips[id(10)] = { id: id(10), name: "a.mp4", bin: id(2), color: "", flags: [], meta: { Scene: "1" }, file: { name: "a.mp4", size: 1, hash: HASH } };
  pool.markers[id(11)] = { id: id(11), clip: id(10), frame: 3, duration: 1, color: "Red", name: "p", note: "" };
  const t = emptyTimelines();
  t.timelines[id(20)] = { id: id(20), name: "Edit", fps: 24, width: 1920, height: 1080 };
  t.tracks[id(21)] = { id: id(21), timeline: id(20), kind: "video", order: 1, name: "", enabled: true, locked: false, subType: "" };
  t.tracks[id(22)] = { id: id(22), timeline: id(20), kind: "video", order: 2, name: "", enabled: true, locked: false, subType: "" };
  t.tracks[id(23)] = { id: id(23), timeline: id(20), kind: "video", order: 3, name: "top", enabled: true, locked: false, subType: "" };
  t.items[id(30)] = { id: id(30), timeline: id(20), kind: "clip", track: id(22), start: 0, duration: 48, enabled: true, color: "", name: "a.mp4",
    media: id(10), srcStart: 0, speed: 100, fadeIn: 0, fadeOut: 0, props: { ZoomX: 1 } };
  t.items[id(31)] = { id: id(31), timeline: id(20), kind: "transition", track: id(22), start: 36, duration: 12, enabled: true, color: "", name: "Cross Dissolve",
    template: "Cross Dissolve", edge: { item: id(30), side: "end", alignment: "center" } };
  t.markers[id(40)] = { id: id(40), timeline: id(20), item: id(30), frame: 5, duration: 1, color: "Blue", name: "m", note: "" };
  t.markers[id(41)] = { id: id(41), timeline: id(20), item: "", frame: 100, duration: 1, color: "Green", name: "ruler", note: "" };
  return { pool, timelines: t };
}

// Applies op, then its inverse (each checked as the host would), and expects the start.
function roundTrip(op: SessionOp, start = model()): void {
  expect(validateSessionOp(start, op)).toBeNull();
  const inverse = inverseOf(start, op);
  const m = cloneModel(start);
  applySessionOp(m, op);
  expect(m).not.toEqual(start);
  for (const back of inverse) {
    expect(validateSessionOp(m, back)).toBeNull();
    applySessionOp(m, back);
  }
  expect(m).toEqual(start);
}

describe("inverse operations (SPEC §23.2)", () => {
  it("undoes changes, including a metadata key that wasn't set and item properties", () => {
    roundTrip({ type: "clip.set", id: id(10), color: "Blue", name: "b.mp4" });
    roundTrip({ type: "clip.set", id: id(10), meta: { Scene: "2", Take: "4" } });
    roundTrip({ type: "item.set", id: id(30), start: 10, props: { ZoomX: 2 } });
    roundTrip({ type: "marker.set", id: id(40), frame: 9, color: "Red" });
    roundTrip({ type: "bin.set", id: id(2), parent: ROOT, name: "Day 2" });
    roundTrip({ type: "track.set", id: id(23), name: "renamed", enabled: false });
    roundTrip({ type: "timeline.set", id: id(20), name: "Cut 2" });
    roundTrip({ type: "poolmarker.set", id: id(11), note: "n" });
  });

  it("undoes creates", () => {
    roundTrip({ type: "marker.create", id: id(42), timeline: id(20), item: "", frame: 7, duration: 1, color: "Red", name: "", note: "" });
    roundTrip({ type: "bin.create", id: id(3), name: "New", parent: ROOT });
    roundTrip({ type: "timeline.create", id: id(50), name: "Two", fps: 24, width: 1920, height: 1080 });
  });

  it("undoes deletes with everything that went with them, and what they shifted", () => {
    roundTrip({ type: "marker.delete", id: id(41) });
    roundTrip({ type: "item.delete", id: id(30) }); // its marker too
    roundTrip({ type: "track.delete", id: id(22) }); // its items and their markers; V3 moved down
    roundTrip({ type: "timeline.delete", id: id(20) });
    roundTrip({ type: "clip.delete", id: id(10) }); // its pool marker
    roundTrip({ type: "bin.delete", id: id(1) }); // the bin inside, the clip, its marker
  });
});

describe("history (SPEC §23.2)", () => {
  it("keeps the last 100 steps, clears redo on a fresh change, and survives a restart", () => {
    const file = join(mkdtempSync(join(tmpdir(), "rc-undo-")), "undo.json");
    const h = new History(file);
    for (let i = 0; i < MAX_STEPS + 5; i++) h.push({ forward: [{ type: "clip.delete", id: id(i) }], inverse: [] }, true);
    expect(h.undo).toHaveLength(MAX_STEPS);
    expect((h.undo[0]!.forward[0] as { id: string }).id).toBe(id(5));
    h.redo.push(h.undo.pop()!);
    h.save();
    const again = new History(file);
    expect(again.undo).toHaveLength(MAX_STEPS - 1);
    expect(again.redo).toHaveLength(1);
    again.push({ forward: [], inverse: [] }, true);
    expect(again.redo).toEqual([]);
  });
});
