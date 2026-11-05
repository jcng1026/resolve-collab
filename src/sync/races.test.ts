// First to the host wins (SPEC §23.1): the host's race rule.

import { describe, expect, it } from "vitest";
import { type Commit, HostLog } from "./host-log.ts";
import { ROOT, emptyPool } from "./media-pool.ts";
import type { SessionModel, SessionOp } from "./session-model.ts";
import { emptyTimelines } from "./timeline.ts";

const id = (n: number) => n.toString(16).padStart(32, "0");
const HASH = "a".repeat(64);

// A clip in a bin; a timeline with a track, an item using the clip and a marker on the item.
function start(): HostLog {
  const pool = emptyPool();
  pool.bins[id(1)] = { id: id(1), name: "Footage", parent: ROOT };
  pool.clips[id(10)] = { id: id(10), name: "a.mp4", bin: id(1), color: "", flags: [], meta: {}, file: { name: "a.mp4", size: 1, hash: HASH } };
  const t = emptyTimelines();
  t.timelines[id(20)] = { id: id(20), name: "Edit", fps: 24, width: 1920, height: 1080 };
  t.tracks[id(21)] = { id: id(21), timeline: id(20), kind: "video", order: 1, name: "", enabled: true, locked: false, subType: "" };
  t.items[id(30)] = { id: id(30), timeline: id(20), kind: "clip", track: id(21), start: 0, duration: 48, enabled: true, color: "", name: "a.mp4",
    media: id(10), srcStart: 0, speed: 100, fadeIn: 0, fadeOut: 0, props: {} };
  t.markers[id(40)] = { id: id(40), timeline: id(20), item: id(30), frame: 5, duration: 1, color: "Blue", name: "m", note: "" };
  const model: SessionModel = { pool, timelines: t };
  return new HostLog({ seq: 10, model });
}

const commit = (r: ReturnType<HostLog["propose"]>) => {
  if ("error" in r) throw new Error(`refused: ${r.error}`);
  return r as Commit;
};

describe("racing edits (SPEC §23.1)", () => {
  it("the later change to the same property loses; a different property is kept", () => {
    const log = start();
    // Both made their change on state 10, before seeing the other's.
    commit(log.propose({ type: "clip.set", id: id(10), color: "Blue" }, "sam", { base: 10 }));
    const late = log.propose({ type: "clip.set", id: id(10), color: "Red" }, "jo", { proposal: "p1", base: 10 });
    expect(late).toEqual({ error: "raced", lost: ["color"] });
    expect(log.model.pool.clips[id(10)]!.color).toBe("Blue");

    const mixed = commit(log.propose({ type: "clip.set", id: id(10), color: "Red", name: "b.mp4" }, "jo", { proposal: "p2", base: 10 }));
    expect(mixed.op).toEqual({ type: "clip.set", id: id(10), name: "b.mp4" });
    expect(mixed.lost).toEqual(["color"]);
    expect(log.model.pool.clips[id(10)]).toMatchObject({ color: "Blue", name: "b.mp4" });
  });

  it("a change made after seeing the other's wins (reapply), and the same person never races themself", () => {
    const log = start();
    const first = commit(log.propose({ type: "clip.set", id: id(10), color: "Blue" }, "sam", { base: 10 }));
    commit(log.propose({ type: "clip.set", id: id(10), color: "Red" }, "jo", { base: first.seq }));
    expect(log.model.pool.clips[id(10)]!.color).toBe("Red");
    commit(log.propose({ type: "clip.set", id: id(10), color: "Green" }, "jo", { base: 10 })); // jo again, quick edits
    expect(log.model.pool.clips[id(10)]!.color).toBe("Green");
    // No base (an older companion, or the host's own when it's up to date): no check.
    commit(log.propose({ type: "clip.set", id: id(10), color: "Pink" }, "alex"));
    expect(log.model.pool.clips[id(10)]!.color).toBe("Pink");
  });

  it("a delete loses to a change to the object, or to anything it holds", () => {
    const log = start();
    commit(log.propose({ type: "marker.set", id: id(40), name: "renamed" }, "sam", { base: 10 }));
    // The marker is on the item, on the track, on the timeline: deleting any of them loses.
    for (const op of [
      { type: "marker.delete", id: id(40) },
      { type: "item.delete", id: id(30) },
      { type: "track.delete", id: id(21) },
      { type: "timeline.delete", id: id(20) },
    ] as SessionOp[]) {
      expect(log.propose(op, "jo", { base: 10 })).toEqual({ error: "raced", lost: ["*"] });
    }
    expect(log.model.timelines.markers[id(40)]).toBeDefined();
    // A clip's change protects its bin; a delete made after seeing it goes through.
    const c = commit(log.propose({ type: "clip.set", id: id(10), color: "Blue" }, "sam", { base: 10 }));
    expect(log.propose({ type: "bin.delete", id: id(1) }, "jo", { base: 10 })).toEqual({ error: "raced", lost: ["*"] });
    commit(log.propose({ type: "bin.delete", id: id(1) }, "jo", { base: c.seq }));
    expect(log.model.pool.clips[id(10)]).toBeUndefined();
  });

  it("an unrelated change doesn't stop a delete, and a new marker protects what it's on", () => {
    const log = start();
    commit(log.propose({ type: "timeline.set", id: id(20), name: "Other" }, "sam", { base: 10 }));
    commit(log.propose({ type: "marker.delete", id: id(40) }, "jo", { base: 10 })); // the timeline's name isn't the marker
    expect(log.model.timelines.markers[id(40)]).toBeUndefined();
    commit(log.propose({ type: "marker.create", id: id(41), timeline: id(20), item: id(30), frame: 9, duration: 1, color: "Red", name: "", note: "" }, "sam", { base: 12 }));
    expect(log.propose({ type: "item.delete", id: id(30) }, "jo", { base: 12 })).toEqual({ error: "raced", lost: ["*"] });
  });

  it("counts each metadata key and item property as a property of its own", () => {
    const log = start();
    commit(log.propose({ type: "clip.set", id: id(10), meta: { Scene: "1" } }, "sam", { base: 10 }));
    const r = commit(log.propose({ type: "clip.set", id: id(10), meta: { Scene: "2", Take: "3" } }, "jo", { base: 10 }));
    expect(r.op).toEqual({ type: "clip.set", id: id(10), meta: { Take: "3" } });
    expect(r.lost).toEqual(["meta:Scene"]);
    commit(log.propose({ type: "item.set", id: id(30), props: { ZoomX: 2 } }, "sam", { base: 10 }));
    commit(log.propose({ type: "item.set", id: id(30), props: { Pan: 5 } }, "jo", { base: 10 })); // another property: kept
    expect(log.model.timelines.items[id(30)]!.props).toEqual({ ZoomX: 2, Pan: 5 });
  });

  it("a Keep mine says whose values it replaced, as they were (SPEC §23.3)", () => {
    const log = start();
    commit(log.propose({ type: "clip.set", id: id(10), color: "Blue", meta: { Scene: "4" } }, "sam", { base: 10 }));
    // Jo comes back, has seen Sam's values, and keeps hers.
    const kept = commit(log.propose({ type: "clip.set", id: id(10), color: "Red", meta: { Scene: "1", Take: "2" } }, "jo", { base: 11, keep: true }));
    expect(kept.replaced).toEqual([{ author: "sam", key: "color", value: "Blue" }, { author: "sam", key: "meta:Scene", value: "4" }]);
    // Her own earlier value, or a plain later edit, replaces nobody's.
    expect(commit(log.propose({ type: "clip.set", id: id(10), color: "Green" }, "jo", { base: 12, keep: true })).replaced).toBeUndefined();
    expect(commit(log.propose({ type: "clip.set", id: id(10), color: "Pink" }, "alex", { base: 13 })).replaced).toBeUndefined();
  });

  it("names the author in the commit", () => {
    const log = start();
    expect(commit(log.propose({ type: "clip.set", id: id(10), color: "Blue" }, "sam", { base: 10, name: "Sam" })).name).toBe("Sam");
  });
});
