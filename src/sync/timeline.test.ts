import { describe, expect, it } from "vitest";
import { HostLog } from "./host-log.ts";
import { type MediaPool, ROOT, emptyPool } from "./media-pool.ts";
import { validateModel } from "./session-model.ts";
import { type Item, type TimelineOp, type Timelines, applyTimelineOp, emptyTimelines, validateTimelineOp, validateTimelines } from "./timeline.ts";

const id = (n: number) => n.toString(16).padStart(32, "0");
const HASH = "a".repeat(64);

function pool(): MediaPool {
  const p = emptyPool();
  p.clips[id(100)] = { id: id(100), name: "a.mp4", bin: ROOT, color: "", flags: [], meta: {}, file: { name: "a.mp4", size: 1, hash: HASH } };
  return p;
}

function clipItem(n: number, extra: Partial<Item> = {}): Item {
  return { id: id(n), timeline: id(1), kind: "clip", track: id(11), start: 0, duration: 48, enabled: true, color: "", name: "a.mp4",
    media: id(100), srcStart: 0, speed: 100, fadeIn: 0, fadeOut: 0, props: { ZoomX: 1 }, ...extra };
}

// Timeline 1 with V1 (11), V2 (12), V3 (13) and A1 (21); a clip on V1, one on V3.
function model(): Timelines {
  const m = emptyTimelines();
  m.timelines[id(1)] = { id: id(1), name: "Edit", fps: 24, width: 1920, height: 1080 };
  const track = (n: number, kind: "video" | "audio", order: number) => {
    m.tracks[id(n)] = { id: id(n), timeline: id(1), kind, order, name: "", enabled: true, locked: false, subType: kind === "audio" ? "stereo" : "" };
  };
  track(11, "video", 1);
  track(12, "video", 2);
  track(13, "video", 3);
  track(21, "audio", 1);
  m.items[id(30)] = clipItem(30);
  m.items[id(31)] = clipItem(31, { track: id(13), start: 100 });
  return m;
}

const check = (op: unknown, m = model()) => validateTimelineOp(m, pool(), op);

describe("timeline operations", () => {
  it("refuses malformed or impossible operations", () => {
    expect(check({ type: "timeline.create", id: "x", name: "T", fps: 24, width: 1920, height: 1080 })).toMatch(/id/);
    expect(check({ type: "timeline.create", id: id(2), name: "T", fps: 24 })).toMatch(/settings/);
    expect(check({ type: "timeline.set", id: id(1), fps: -1 })).toMatch(/fps/);
    expect(check({ type: "track.create", id: id(14), timeline: id(9), kind: "video", order: 4, name: "", enabled: true, locked: false, subType: "" })).toMatch(/timeline/);
    expect(check({ type: "track.create", id: id(14), timeline: id(1), kind: "subtitle", order: 4, name: "", enabled: true, locked: false, subType: "" })).toMatch(/kind/);
    expect(check({ ...clipItem(32, { track: id(99) }), type: "item.create" })).toMatch(/track/);
    expect(check({ ...clipItem(32, { media: id(999) }), type: "item.create" })).toMatch(/media/);
    expect(check({ ...clipItem(32, { duration: 0 }), type: "item.create" })).toMatch(/duration/);
    expect(check({ ...clipItem(32, { props: { DeleteEverything: 1 } }), type: "item.create" })).toMatch(/prop/);
    expect(check({ type: "item.create", id: id(32), timeline: id(1), kind: "title", track: id(21), start: 0, duration: 48, enabled: true, color: "", name: "Text", template: "Text" })).toMatch(/track kind/);
    expect(check({ type: "item.set", id: id(30), text: { styled: "x", font: "Arial", style: "Regular", size: 0.1 } })).toMatch(/text/); // clips have no text
    expect(check({ type: "item.create", id: id(32), timeline: id(1), kind: "transition", track: id(11), start: 0, duration: 12, enabled: true, color: "", name: "Cross Dissolve", template: "Cross Dissolve", edge: { item: id(77), side: "start", alignment: "right" } })).toMatch(/edge/);
    expect(check({ type: "item.set", id: id(30), template: "<script>" })).toMatch(/template/);
    expect(check({ type: "item.delete", id: id(77) })).toBeNull(); // already gone is fine
    expect(check({ type: "rm.rf" })).toMatch(/unknown/);
  });

  it("accepts a Text+ title with its text, and a transition on an existing item", () => {
    const m = model();
    const plus: TimelineOp = { type: "item.create", id: id(40), timeline: id(1), kind: "textplus", track: id(12), start: 200, duration: 300, enabled: true,
      color: "", name: "Text+", template: "Text+", text: { styled: "Hello ü", font: "Open Sans", style: "Regular", size: 0.12 } };
    expect(validateTimelineOp(m, pool(), plus)).toBeNull();
    applyTimelineOp(m, plus);
    const tr: TimelineOp = { type: "item.create", id: id(41), timeline: id(1), kind: "transition", track: id(11), start: 0, duration: 12, enabled: true,
      color: "", name: "Cross Dissolve", template: "Cross Dissolve", edge: { item: id(30), side: "start", alignment: "right" } };
    expect(validateTimelineOp(m, pool(), tr)).toBeNull();
  });

  it("deletes a middle track with its items and moves the tracks above down", () => {
    const m = model();
    m.items[id(32)] = clipItem(32, { track: id(12) });
    m.items[id(41)] = { id: id(41), timeline: id(1), kind: "transition", track: id(12), start: 36, duration: 12, enabled: true, color: "",
      name: "Cross Dissolve", template: "Cross Dissolve", edge: { item: id(32), side: "end", alignment: "left" } };
    applyTimelineOp(m, { type: "track.delete", id: id(12) });
    expect(m.tracks[id(12)]).toBeUndefined();
    expect(m.tracks[id(13)]!.order).toBe(2);
    expect(m.tracks[id(21)]!.order).toBe(1); // audio untouched
    expect(m.items[id(32)]).toBeUndefined();
    expect(m.items[id(41)]).toBeUndefined(); // its transition went with it
    expect(m.items[id(31)]!.track).toBe(id(13)); // still on the same track, now V2
  });

  it("cascades a timeline delete and is idempotent", () => {
    const m = model();
    const set: TimelineOp = { type: "item.set", id: id(30), start: 24, props: { ZoomX: 1.5, Opacity: 50 } };
    applyTimelineOp(m, set);
    const once = structuredClone(m);
    applyTimelineOp(m, set);
    expect(m).toEqual(once);
    applyTimelineOp(m, { type: "timeline.delete", id: id(1) });
    expect(m).toEqual(emptyTimelines());
  });

  it("checks a whole model from a peer, keeping clips whose media left the pool", () => {
    const m = model();
    m.items[id(32)] = clipItem(32, { media: id(555) }); // clip deleted from the pool since
    expect(validateTimelines(m, pool())).toEqual(m);
    const bad = model();
    bad.items[id(33)] = clipItem(33, { media: id(555), start: -5 });
    expect(validateTimelines(bad, pool())).toBeNull();
  });
});

describe("session model", () => {
  it("routes operations to the media pool or the timelines", () => {
    const host = new HostLog();
    expect(host.propose({ type: "timeline.create", id: id(1), name: "Edit", fps: 24, width: 1920, height: 1080 }, "h")).toMatchObject({ seq: 1 });
    expect(host.propose({ type: "bin.create", id: id(2), name: "Footage", parent: ROOT }, "h")).toMatchObject({ seq: 2 });
    expect(Object.keys(host.model.timelines.timelines)).toEqual([id(1)]);
    expect(Object.keys(host.model.pool.bins)).toContain(id(2));
  });

  it("accepts a saved M3 log, which held the media pool alone", () => {
    const old = emptyPool();
    old.bins[id(2)] = { id: id(2), name: "Footage", parent: ROOT };
    expect(validateModel(old)).toEqual({ pool: old, timelines: emptyTimelines() });
    expect(validateModel({ pool: old, timelines: { timelines: { x: { id: "x" } } } })).toBeNull();
  });
});
