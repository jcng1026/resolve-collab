import { describe, expect, it } from "vitest";
import { type LocalMarker, matchMarkers, tagOf } from "./marker.ts";
import { type MediaPool, applyOp, emptyPool, validateOp, validatePool } from "./media-pool.ts";
import { type Mode, frameClashes, reconcile, resolveWith } from "./reconcile.ts";
import { groupLinked, reconcileTimelines, timelineDomain } from "./timeline-reconcile.ts";
import { type Marker, type TimelineOp, type Timelines, applyTimelineOp, emptyTimelines, validateTimelineOp, validateTimelines } from "./timeline.ts";

const id = (n: number) => n.toString(16).padStart(32, "0");
let next = 5000;
const newId = () => id(next++);

const values = { frame: 10, duration: 1, color: "Blue", name: "Cut here", note: "" };

function timelines(): Timelines {
  const m = emptyTimelines();
  m.timelines[id(1)] = { id: id(1), name: "Edit", fps: 24, width: 1920, height: 1080 };
  m.tracks[id(11)] = { id: id(11), timeline: id(1), kind: "video", order: 1, name: "", enabled: true, locked: false, subType: "" };
  m.items[id(30)] = { id: id(30), timeline: id(1), kind: "title", track: id(11), start: 0, duration: 48, enabled: true, color: "", name: "Text", template: "Text" };
  m.markers[id(40)] = { id: id(40), timeline: id(1), item: "", ...values };
  m.markers[id(41)] = { id: id(41), timeline: id(1), item: id(30), ...values, frame: 5 };
  return m;
}

function pool(): MediaPool {
  const p = emptyPool();
  p.clips[id(20)] = { id: id(20), name: "a.mp4", bin: "root", color: "", flags: [], meta: {}, file: null };
  p.markers[id(50)] = { id: id(50), clip: id(20), ...values };
  return p;
}

const edit = <M>(m: M, fn: (m: M) => void): M => {
  const copy = structuredClone(m);
  fn(copy);
  return copy;
};

describe("marker model", () => {
  it("checks timeline and item markers", () => {
    const m = timelines();
    const ok = (op: Partial<Marker> & { type: string }) => validateTimelineOp(m, emptyPool(), op);
    const base = { type: "marker.create", id: id(42), timeline: id(1), item: "", ...values, frame: 11 };
    expect(ok(base)).toBeNull();
    expect(ok({ ...base, item: id(30) })).toBeNull();
    expect(ok({ ...base, item: id(99) })).toBe("unknown item");
    expect(ok({ ...base, timeline: id(99) })).toBe("unknown timeline");
    expect(ok({ ...base, color: "Orange" })).toBe("bad color");
    expect(ok({ ...base, frame: -1 })).toBe("bad frame");
    expect(ok({ ...base, duration: 0 })).toBe("bad duration");
    expect(ok({ ...base, note: "x".repeat(10_001) })).toBe("bad note");
    expect(ok({ ...base, name: "naïve 🎬\nline" })).toBeNull();
    const { note: _, ...noNote } = base;
    expect(ok(noNote)).toBe("missing note");
    expect(ok({ type: "marker.set", id: id(40), color: "Red" })).toBeNull();
    expect(ok({ type: "marker.set", id: id(99), color: "Red" })).toBe("unknown marker");
  });

  it("deletes markers with their item, track or timeline", () => {
    const item = timelines();
    applyTimelineOp(item, { type: "item.delete", id: id(30) });
    expect(Object.keys(item.markers)).toEqual([id(40)]);
    const track = timelines();
    applyTimelineOp(track, { type: "track.delete", id: id(11) });
    expect(Object.keys(track.markers)).toEqual([id(40)]);
    const timeline = timelines();
    applyTimelineOp(timeline, { type: "timeline.delete", id: id(1) });
    expect(timeline.markers).toEqual({});
  });

  it("checks pool clip markers and deletes them with their clip or bin", () => {
    const p = pool();
    expect(validateOp(p, { type: "poolmarker.create", id: id(51), clip: id(20), ...values, frame: 11 })).toBeNull();
    expect(validateOp(p, { type: "poolmarker.create", id: id(51), clip: id(99), ...values })).toBe("unknown clip");
    applyOp(p, { type: "clip.delete", id: id(20) });
    expect(p.markers).toEqual({});
    const inBin = pool();
    inBin.bins[id(2)] = { id: id(2), name: "Footage", parent: "root" };
    inBin.clips[id(20)]!.bin = id(2);
    applyOp(inBin, { type: "bin.delete", id: id(2) });
    expect(inBin.markers).toEqual({});
  });

  it("accepts saved models from before markers, and checks markers in whole models", () => {
    const { markers: _t, ...oldTimelines } = timelines();
    expect(validateTimelines(oldTimelines, emptyPool())?.markers).toEqual({});
    expect(Object.keys(validateTimelines(timelines(), emptyPool())!.markers)).toHaveLength(2);
    const bad = edit(timelines(), (m) => { m.markers[id(40)]!.color = "Orange"; });
    expect(validateTimelines(bad, emptyPool())).toBeNull();
    const { markers: _p, ...oldPool } = pool();
    expect(validatePool(oldPool)?.markers).toEqual({});
    expect(Object.keys(validatePool(pool())!.markers)).toEqual([id(50)]);
  });
});

describe("marker reconciling", () => {
  const run = (local: Timelines, session: Timelines) =>
    reconcileTimelines({ base: timelines(), local, session, mode: "live", pending: new Map(), busy: new Set() });

  it("syncs a moved and recoloured marker as one change", () => {
    const local = edit(timelines(), (m) => { Object.assign(m.markers[id(40)]!, { frame: 30, color: "Red" }); });
    const plan = run(local, timelines());
    expect(plan.propose).toEqual([{ type: "marker.set", id: id(40), frame: 30, color: "Red" }]);
  });

  it("creates markers after their item and deletes them first", () => {
    const session = edit(timelines(), (m) => {
      m.items[id(31)] = { ...m.items[id(30)]!, id: id(31), start: 100 };
      m.markers[id(43)] = { id: id(43), timeline: id(1), item: id(31), ...values };
      delete m.markers[id(40)];
    });
    const types = run(timelines(), session).apply.map((op) => op.type);
    expect(types).toEqual(["marker.delete", "item.create", "marker.create"]);
  });

  it("leaves out a marker delete its item's delete covers", () => {
    const local = edit(timelines(), (m) => applyTimelineOp(m, { type: "item.delete", id: id(30) }));
    expect(run(local, timelines()).propose).toEqual([{ type: "item.delete", id: id(30) } satisfies TimelineOp]);
  });

  it("syncs pool clip markers the same way", () => {
    const local = edit(pool(), (p) => { p.markers[id(50)]!.note = "keep"; p.markers[id(51)] = { id: id(51), clip: id(20), ...values, frame: 99 }; });
    const plan = reconcile({ base: pool(), local, session: pool(), mode: "live", pending: new Map(), busy: new Set() });
    expect(plan.propose).toEqual([
      { type: "poolmarker.set", id: id(50), note: "keep" },
      { type: "poolmarker.create", id: id(51), clip: id(20), ...values, frame: 99 },
    ]);
  });
});

describe("marker identity", () => {
  const session = [{ id: id(40), ...values }, { id: id(41), ...values, frame: 20 }];
  const owners: Record<string, string> = { [id(40)]: "tl", [id(41)]: "tl" };
  const ownerOf = (x: string) => owners[x];
  const local = (frame: number, tag: string, extra: Partial<LocalMarker> = {}): LocalMarker => ({ ...values, frame, tag, ...extra });

  it("knows a marker by its ID, even after it was moved and recoloured", () => {
    const [m] = matchMarkers([local(77, tagOf(id(40)), { color: "Red" })], "tl", session, ownerOf, new Set(), newId);
    expect(m).toMatchObject({ id: id(40), retag: false });
  });

  it("gives a copy on another owner a new ID, and tags it", () => {
    const [m] = matchMarkers([local(10, tagOf(id(40)))], "copy", session, ownerOf, new Set(), newId);
    expect(m!.id).not.toBe(id(40));
    expect(m!.retag).toBe(true);
  });

  it("matches an untagged marker by place and values, else makes it new", () => {
    const out = matchMarkers([local(20, ""), local(10, "", { name: "other" })], "tl", session, ownerOf, new Set(), newId);
    expect(out[0]).toMatchObject({ id: id(41), retag: true });
    expect([id(40), id(41)]).not.toContain(out[1]!.id);
  });

  it("never overwrites another tool's customData, matching by frame instead", () => {
    const [m] = matchMarkers([local(10, "their-data", { color: "Red" })], "tl", session, ownerOf, new Set(), newId);
    expect(m).toMatchObject({ id: id(40), retag: false });
  });

  it("gives one ID out once", () => {
    const claimed = new Set<string>();
    const out = matchMarkers([local(10, tagOf(id(40))), local(11, tagOf(id(40)))], "tl", session, ownerOf, claimed, newId);
    expect(out.map((m) => m.id)[0]).toBe(id(40));
    expect(out[1]!.id).not.toBe(id(40));
  });
});

describe("two markers on one frame (SPEC §21.5)", () => {
  const owner = (m: Marker) => `${m.timeline}/${m.item}`;
  const mine = { id: id(60), timeline: id(1), item: "", ...values, frame: 70, color: "Green", name: "mine" };
  const theirs = { id: id(61), timeline: id(1), item: "", ...values, frame: 70, color: "Red", name: "theirs" };
  const plan = (local: Timelines, session: Timelines, mode: Mode) => {
    const p = reconcileTimelines({ base: timelines(), local, session, mode, pending: new Map(), busy: new Set() });
    frameClashes(timelineDomain, "marker", p, local, session, mode, owner);
    return p;
  };

  it("is refused by the host, on the same owner only", () => {
    const m = edit(timelines(), (x) => { x.markers[id(61)] = theirs; });
    expect(validateTimelineOp(m, emptyPool(), { type: "marker.create", ...mine })).toBe("occupied");
    expect(validateTimelineOp(m, emptyPool(), { type: "marker.create", ...mine, item: id(30) })).toBeNull();
    expect(validateTimelineOp(m, emptyPool(), { type: "marker.set", id: id(40), frame: 70 })).toBe("occupied");
    expect(validateTimelineOp(m, emptyPool(), { type: "marker.set", id: id(61), frame: 70, color: "Blue" })).toBeNull(); // itself
    // Whole models (saved before this rule) aren't checked for it.
    const both = edit(m, (x) => { x.markers[id(60)] = mine; });
    expect(Object.keys(validateTimelines(both, emptyPool())!.markers)).toHaveLength(4);
    const p = edit(pool(), (x) => { x.markers[id(51)] = { id: id(51), clip: id(20), ...values, frame: 10, name: "other" }; });
    expect(validateOp(pool(), { type: "poolmarker.create", id: id(51), clip: id(20), ...values })).toBe("occupied");
    expect(validatePool(p)).not.toBeNull();
  });

  it("asks the returning person in catch-up, and either answer leaves one marker for everyone", () => {
    const local = edit(timelines(), (x) => { x.markers[id(60)] = mine; });
    const session = edit(timelines(), (x) => { x.markers[id(61)] = theirs; });
    const p = plan(local, session, "catch-up");
    expect(p.propose).toEqual([]);
    expect(p.apply).toEqual([]);
    expect(p.conflicts).toEqual([expect.objectContaining({ kind: "clash", item: "marker", id: id(60), label: "mine",
      mine: expect.objectContaining({ color: "Green" }), theirs: expect.objectContaining({ color: "Red" }) })]);
    const key = p.conflicts[0]!.key;
    const keepMine = resolveWith(timelineDomain, p.conflicts, new Map([[key, "mine"]]), local, session);
    expect(keepMine.propose.map((o) => `${o.type} ${o.id}`)).toEqual([`marker.delete ${id(61)}`, `marker.create ${id(60)}`]);
    expect(keepMine.apply).toEqual([]);
    const keepTheirs = resolveWith(timelineDomain, p.conflicts, new Map([[key, "theirs"]]), local, session);
    expect(keepTheirs.propose).toEqual([]);
    expect(keepTheirs.apply.map((o) => `${o.type} ${o.id}`)).toEqual([`marker.delete ${id(60)}`, `marker.create ${id(61)}`]);
  });

  it("lets the session win live, and moves a marker back that was moved onto the other", () => {
    const local = edit(timelines(), (x) => { x.markers[id(60)] = mine; });
    const session = edit(timelines(), (x) => { x.markers[id(61)] = theirs; });
    const live = plan(local, session, "live");
    expect(live.propose).toEqual([]);
    expect(live.apply.map((o) => `${o.type} ${o.id}`)).toEqual([`marker.delete ${id(60)}`, `marker.create ${id(61)}`]);
    expect(live.overwritten).toEqual([expect.objectContaining({ kind: "clash", id: id(60) })]);
    // Moving an existing marker (40, at frame 10) onto theirs.
    const moved = edit(timelines(), (x) => { x.markers[id(40)]!.frame = 70; });
    const both = edit(session, () => {});
    const p = plan(moved, both, "live");
    expect(p.propose).toEqual([]);
    expect(p.apply).toEqual(expect.arrayContaining([{ type: "marker.set", id: id(40), frame: 10 }]));
  });

  it("asks once for a linked video and audio pair", () => {
    const linked = (x: Timelines) => {
      x.tracks[id(12)] = { id: id(12), timeline: id(1), kind: "audio", order: 1, name: "", enabled: true, locked: false, subType: "" };
      x.items[id(31)] = { ...x.items[id(30)]!, id: id(31), track: id(12), link: id(30) };
      x.items[id(30)]!.link = id(30);
    };
    const base = edit(timelines(), linked);
    const local = edit(base, (x) => {
      x.markers[id(62)] = { ...mine, id: id(62), item: id(30) };
      x.markers[id(63)] = { ...mine, id: id(63), item: id(31) };
    });
    const session = edit(base, (x) => {
      x.markers[id(64)] = { ...theirs, id: id(64), item: id(30) };
      x.markers[id(65)] = { ...theirs, id: id(65), item: id(31) };
    });
    const p = reconcileTimelines({ base, local, session, mode: "catch-up", pending: new Map(), busy: new Set() });
    frameClashes(timelineDomain, "marker", p, local, session, "catch-up", owner);
    expect(p.conflicts).toHaveLength(2);
    expect(groupLinked(p.conflicts, local, session)).toHaveLength(1);
  });
});
