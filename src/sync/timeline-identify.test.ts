import { describe, expect, it } from "vitest";
import { type LocalItem, type LocalTrack, type TimelineIdentifyInput, type TrackLists, identifyTimelineState, trackName } from "./timeline-identify.ts";
import { type Timelines, emptyTimelines } from "./timeline.ts";

const id = (n: number) => n.toString(16).padStart(32, "0");
let next = 1000;
const newId = () => id(next++);

const track = (name = ""): LocalTrack => ({ name, enabled: true, locked: false, subType: "" });

function local(n: number, trackIndex: number, start: number, extra: Partial<LocalItem> = {}): LocalItem {
  return { id: `L${n}`, kind: "clip", trackKind: "video", trackIndex, start, duration: 48, enabled: true, color: "", name: "a.mp4", media: "P1", linked: [], srcStart: 0, speed: 100, fadeIn: 0, fadeOut: 0, ...extra };
}

function input(extra: Partial<TimelineIdentifyInput>): TimelineIdentifyInput {
  return {
    timelines: [{ id: "T1", rcId: id(1), name: "Edit", fps: 24, width: 1920, height: 1080 }],
    current: "T1",
    tracks: { video: [track(), track(), track()], audio: [] },
    items: [],
    markers: [],
    session: emptyTimelines(),
    previous: null,
    itemMap: new Map(),
    trackMap: new Map(),
    media: (l) => (l === "P1" ? id(100) : undefined),
    newId,
    ...extra,
  };
}

describe("timeline identification", () => {
  it("keeps the right tracks when a middle track is deleted", () => {
    const trackMap = new Map<string, TrackLists>([[id(1), { video: [id(11), id(12), id(13)], audio: [] }]]);
    const itemMap = new Map([["L1", id(30)], ["L3", id(31)]]);
    const previous: Timelines = emptyTimelines();
    previous.items[id(30)] = { id: id(30), timeline: id(1), kind: "clip", track: id(11), start: 0, duration: 48, enabled: true, color: "", name: "" };
    previous.items[id(31)] = { id: id(31), timeline: id(1), kind: "clip", track: id(13), start: 0, duration: 48, enabled: true, color: "", name: "" };
    // V2 deleted: the clip that was on V3 is now on V2.
    const out = identifyTimelineState(input({ tracks: { video: [track(), track()], audio: [] }, items: [local(1, 1, 0), local(3, 2, 0)], trackMap, itemMap, previous }));
    expect(trackMap.get(id(1))!.video).toEqual([id(11), id(13)]);
    expect(out.model.tracks[id(13)]!.order).toBe(2);
    expect(out.model.items[id(31)]!.track).toBe(id(13));
  });

  it("maps a timeline seen for the first time onto the session's tracks and items (first join)", () => {
    const session = emptyTimelines();
    session.timelines[id(1)] = { id: id(1), name: "Edit", fps: 24, width: 1920, height: 1080 };
    session.tracks[id(11)] = { id: id(11), timeline: id(1), kind: "video", order: 1, name: "", enabled: true, locked: false, subType: "" };
    session.items[id(30)] = { id: id(30), timeline: id(1), kind: "clip", track: id(11), start: 96, duration: 48, enabled: true, color: "", name: "a.mp4", media: id(100) };
    const itemMap = new Map<string, string>();
    const out = identifyTimelineState(input({ timelines: [{ id: "T1", rcId: "", name: "Edit", fps: 24, width: 1920, height: 1080 }], tracks: { video: [track()], audio: [] },
      items: [local(1, 1, 96), local(2, 1, 0)], session, itemMap }));
    expect(out.links).toEqual([{ local: "T1", rcId: id(1) }]);
    expect(itemMap.get("L1")).toBe(id(30)); // same spot: the same item
    expect(itemMap.get("L2")).not.toBe(id(30)); // new
  });

  it("gives a copied timeline with a duplicate rcId a new collab ID", () => {
    const out = identifyTimelineState(input({ timelines: [
      { id: "T1", rcId: id(1), name: "Edit", fps: 24, width: 1920, height: 1080 },
      { id: "T2", rcId: id(1), name: "Edit copy", fps: 24, width: 1920, height: 1080 },
    ] }));
    expect(out.links).toHaveLength(1);
    expect(out.links[0]!.local).toBe("T2");
    expect(Object.keys(out.model.timelines)).toHaveLength(2);
  });

  it("links video and audio, waits for unlinked media, and finds transition edges", () => {
    const items = [
      local(1, 1, 0, { linked: ["L2"] }),
      local(2, 1, 0, { trackKind: "audio", linked: ["L1"] }),
      local(3, 1, 48, { media: "P9" }), // its pool clip isn't linked yet
      { ...local(4, 1, 0), kind: "transition" as const, media: "", duration: 12, alignment: "right" as const, template: "Cross Dissolve" },
      { ...local(5, 1, 48), kind: "other" as const, media: "" },
    ];
    const out = identifyTimelineState(input({ tracks: { video: [track()], audio: [track()] }, items }));
    const all = Object.values(out.model.items);
    const kindOf = (track: string) => out.model.tracks[track]!.kind;
    const v = all.find((i) => i.kind === "clip" && kindOf(i.track) === "video")!;
    const a = all.find((i) => i.kind === "clip" && kindOf(i.track) === "audio")!;
    expect(v.link).toBe(a.link);
    expect(v.link).not.toBe("");
    expect(out.notReady.size).toBe(1);
    const tr = Object.values(out.model.items).find((i) => i.kind === "transition")!;
    expect(tr.edge).toEqual({ item: v.id, side: "start", alignment: "right" });
    expect(out.unsupported.map((u) => u.id)).toEqual(["L5"]);
  });

  it("finds a transition's edge from where it sits, whatever alignment Resolve reports", () => {
    const items = [
      local(1, 1, 0),
      { ...local(2, 1, 0), kind: "transition" as const, media: "", duration: 12, alignment: "center" as const, template: "Cross Dissolve" },
    ];
    const out = identifyTimelineState(input({ tracks: { video: [track()], audio: [] }, items }));
    const clipId = Object.values(out.model.items).find((i) => i.kind === "clip")!.id;
    expect(Object.values(out.model.items).find((i) => i.kind === "transition")!.edge).toEqual({ item: clipId, side: "start", alignment: "right" });
  });

  it("skips a transition whose clip was just deleted, without calling it unsupported", () => {
    const items = [{ ...local(1, 1, 96), kind: "transition" as const, media: "", duration: 24, alignment: "right" as const, template: "Cross Dissolve" }];
    const out = identifyTimelineState(input({ tracks: { video: [track()], audio: [] }, items }));
    expect(Object.values(out.model.items)).toEqual([]);
    expect(out.unsupported).toEqual([]);
  });

  it("leaves an already synced item alone when it can't be identified for a moment", () => {
    const itemMap = new Map([["L1", id(30)]]);
    const out = identifyTimelineState(input({ tracks: { video: [track()], audio: [] }, items: [{ ...local(1, 1, 0), kind: "other" as const }], itemMap }));
    expect(out.notReady.has(id(30))).toBe(true);
    expect(out.unsupported).toEqual([]);
  });

  it("matches items that came back with new local IDs to the session by position", () => {
    const session = emptyTimelines();
    session.timelines[id(1)] = { id: id(1), name: "Edit", fps: 24, width: 1920, height: 1080 };
    session.tracks[id(11)] = { id: id(11), timeline: id(1), kind: "video", order: 1, name: "", enabled: true, locked: false, subType: "" };
    session.items[id(30)] = { id: id(30), timeline: id(1), kind: "clip", track: id(11), start: 0, duration: 48, enabled: true, color: "", name: "a.mp4", media: id(100) };
    const itemMap = new Map([["OLD", id(30)]]); // the item's old local ID, now gone
    const trackMap = new Map<string, TrackLists>([[id(1), { video: [id(11)], audio: [] }]]);
    identifyTimelineState(input({ tracks: { video: [track()], audio: [] }, items: [local(9, 1, 0)], session, itemMap, trackMap }));
    expect(itemMap.get("L9")).toBe(id(30));
  });

  it("treats Resolve's default track names as no name", () => {
    expect(trackName("video", 2, "Video 2")).toBe("");
    expect(trackName("video", 2, "Video 3")).toBe("Video 3");
    expect(trackName("audio", 1, "Dialogue")).toBe("Dialogue");
  });
});
