import { describe, expect, it } from "vitest";
import type { Input } from "./reconcile.ts";
import { groupLinked, reconcileTimelines } from "./timeline-reconcile.ts";
import { type Item, type TimelineOp, type Timelines, emptyTimelines } from "./timeline.ts";

const id = (n: number) => n.toString(16).padStart(32, "0");

function clip(n: number, start: number, extra: Partial<Item> = {}): Item {
  return { id: id(n), timeline: id(1), kind: "clip", track: id(11), start, duration: 48, enabled: true, color: "", name: `c${n}`,
    media: id(100), srcStart: 0, speed: 100, fadeIn: 0, fadeOut: 0, props: { ZoomX: 1, Opacity: 100 }, ...extra };
}

// Timeline 1 with V1 (11) and three clips side by side.
function model(): Timelines {
  const m = emptyTimelines();
  m.timelines[id(1)] = { id: id(1), name: "Edit", fps: 24, width: 1920, height: 1080 };
  m.tracks[id(11)] = { id: id(11), timeline: id(1), kind: "video", order: 1, name: "", enabled: true, locked: false, subType: "" };
  m.items[id(30)] = clip(30, 0);
  m.items[id(31)] = clip(31, 48);
  m.items[id(32)] = clip(32, 96);
  return m;
}

function edit(m: Timelines, fn: (m: Timelines) => void): Timelines {
  const copy = structuredClone(m);
  fn(copy);
  return copy;
}

function run(changes: Partial<Input<Timelines>> & { local: Timelines; session: Timelines }) {
  return reconcileTimelines({ base: model(), mode: "live", pending: new Map(), busy: new Set(), ...changes });
}

describe("timeline reconciler", () => {
  it("proposes a local trim and applies a session move", () => {
    const local = edit(model(), (m) => { m.items[id(30)]!.duration = 40; });
    const session = edit(model(), (m) => { m.items[id(32)]!.start = 200; });
    const plan = run({ local, session });
    expect(plan.propose).toEqual([{ type: "item.set", id: id(30), duration: 40 }]);
    expect(plan.apply).toEqual([{ type: "item.set", id: id(32), start: 200 }]);
    expect(plan.base.items[id(30)]!.duration).toBe(48); // agreed once committed
  });

  it("sends only the properties that changed", () => {
    const local = edit(model(), (m) => { m.items[id(31)]!.props!.ZoomX = 1.5; });
    const plan = run({ local, session: model() });
    expect(plan.propose).toEqual([{ type: "item.set", id: id(31), props: { ZoomX: 1.5 } }]);
  });

  it("puts back a fade Resolve forgot on reopen, but syncs one removed live", () => {
    const base = edit(model(), (m) => { m.items[id(30)]!.fadeIn = 12; });
    const local = model(); // fade gone after reopen
    const catchUp = run({ base, local, session: base, mode: "catch-up" });
    expect(catchUp.propose).toEqual([]);
    expect(catchUp.apply).toEqual([{ type: "item.set", id: id(30), fadeIn: 12 }]);
    const live = run({ base, local, session: base, mode: "live" });
    expect(live.propose).toEqual([{ type: "item.set", id: id(30), fadeIn: 0 }]);
  });

  it("applies a ripple rightmost first so no clip lands on a neighbour", () => {
    const session = edit(model(), (m) => { for (const n of [30, 31, 32]) m.items[id(n)]!.start += 48; });
    const plan = run({ local: model(), session });
    expect(plan.apply.map((op) => (op as { id: string }).id)).toEqual([id(32), id(31), id(30)]);
    const left = edit(model(), (m) => { for (const n of [31, 32]) m.items[id(n)]!.start -= 48; delete m.items[id(30)]; });
    const plan2 = run({ local: model(), session: left });
    expect(plan2.apply.map((op) => op.type + ":" + (op as { id: string }).id)).toEqual([`item.delete:${id(30)}`, `item.set:${id(31)}`, `item.set:${id(32)}`]);
  });

  it("orders a batch: creates parent-first, deletes before adds, transitions last, covered deletes dropped", () => {
    const session = edit(model(), (m) => {
      m.tracks[id(12)] = { id: id(12), timeline: id(1), kind: "video", order: 2, name: "", enabled: true, locked: false, subType: "" };
      m.items[id(40)] = clip(40, 0, { track: id(12) });
      m.items[id(41)] = { id: id(41), timeline: id(1), kind: "transition", track: id(12), start: 0, duration: 12, enabled: true, color: "",
        name: "Cross Dissolve", template: "Cross Dissolve", edge: { item: id(40), side: "start", alignment: "right" } };
      delete m.items[id(32)];
    });
    const plan = run({ local: model(), session });
    expect(plan.apply.map((op: TimelineOp) => op.type)).toEqual(["track.create", "item.delete", "item.create", "item.create"]);
    expect((plan.apply[3] as { kind: string }).kind).toBe("transition");

    const gone = edit(model(), (m) => { delete m.tracks[id(11)]; m.items = {}; });
    expect(run({ local: model(), session: gone }).apply).toEqual([{ type: "track.delete", id: id(11) }]);
  });

  it("asks in catch-up when both sides changed the same field", () => {
    const local = edit(model(), (m) => { m.items[id(31)]!.start = 60; });
    const session = edit(model(), (m) => { m.items[id(31)]!.start = 70; });
    const plan = run({ local, session, mode: "catch-up" });
    expect(plan.conflicts).toEqual([expect.objectContaining({ item: "item", id: id(31), field: "start", mine: 60, theirs: 70 })]);
  });

  it("asks once for linked video and audio that conflict the same way", () => {
    const linked = (m: Timelines) => {
      m.tracks[id(12)] = { id: id(12), timeline: id(1), kind: "audio", order: 1, name: "", enabled: true, locked: false, subType: "" };
      m.items[id(40)] = clip(40, 0, { track: id(12), link: id(30) });
      delete m.items[id(40)]!.props; // audio has no transform properties
      m.items[id(30)]!.link = id(30);
    };
    const base = edit(model(), linked);
    const local = edit(base, (m) => { m.items[id(30)]!.duration = 30; m.items[id(40)]!.duration = 30; m.items[id(31)]!.duration = 30; });
    const session = edit(base, (m) => { m.items[id(30)]!.duration = 40; m.items[id(40)]!.duration = 40; m.items[id(31)]!.duration = 40; });
    const plan = run({ base, local, session, mode: "catch-up" });
    expect(plan.conflicts).toHaveLength(3);
    const groups = groupLinked(plan.conflicts, local, session);
    expect(groups.map((g) => g.map((c) => c.id).sort())).toEqual(expect.arrayContaining([[id(30), id(40)], [id(31)]]));
    expect(groups).toHaveLength(2);
    // Different values on the two halves are two questions.
    const apart = edit(local, (m) => { m.items[id(40)]!.duration = 20; });
    expect(groupLinked(run({ base, local: apart, session, mode: "catch-up" }).conflicts, apart, session)).toHaveLength(3);
  });
});
