// Translates what the bridge reports about timelines (local IDs, tracks by
// position) into the session's terms (collab IDs) (SPEC §20.3).
//
// - Timelines carry their collab ID as `rcId` in their media pool item. One
//   without (new, or a copy that duplicated another's) gets one.
// - Tracks have only positions. Which collab track sits at each position is
//   worked out from where the track's clips went, then names, then order, so
//   deleting a middle track isn't mistaken for deleting the top one.
// - Items map through a saved local → collab table. Unknown items are matched
//   to session items in the same place (first join), or get a new ID.
// Only the current timeline's tracks and items are known; the others keep
// whatever the session says until they are opened.

import { type LocalMarker, markerValues, matchMarkers, tagOf } from "./marker.ts";
import type { Item, ItemKind, TextPlus, Timelines, Track, TrackKind } from "./timeline.ts";
import { emptyTimelines } from "./timeline.ts";

export interface LocalTimeline {
  id: string;
  rcId: string; // "" when none yet
  name: string;
  fps: number;
  width: number;
  height: number;
}

export interface LocalTrack {
  name: string;
  enabled: boolean;
  locked: boolean;
  subType: string;
}

export interface LocalItem {
  id: string;
  kind: ItemKind | "other";
  trackKind: TrackKind;
  trackIndex: number;
  start: number;
  duration: number;
  enabled: boolean;
  color: string;
  name: string;
  media: string; // local media pool clip ID, "" for none
  srcStart?: number;
  linked: string[]; // local IDs of linked items
  speed?: number;
  fadeIn?: number;
  fadeOut?: number;
  props?: Record<string, number | boolean>;
  template?: string;
  text?: TextPlus;
  alignment?: "left" | "center" | "right"; // transitions
  markers?: LocalMarker[];
}

// Where a collab marker is in Resolve (SPEC §21.4): its owner's local ID
// (the timeline's for a timeline marker) and its frame.
export interface TimelineMarkerSpot {
  kind: "timeline" | "item";
  owner: string;
  frame: number;
}

export interface TrackLists {
  video: string[];
  audio: string[];
}

export interface TimelineIdentifyInput {
  timelines: LocalTimeline[]; // in Resolve's order
  current: string; // local ID of the current timeline, "" for none
  tracks: { video: LocalTrack[]; audio: LocalTrack[] } | null;
  items: LocalItem[];
  markers: LocalMarker[]; // the current timeline's own markers
  session: Timelines;
  previous: Timelines | null; // the last identified local model, for where clips were
  itemMap: Map<string, string>; // local item ID → collab ID, updated in place
  trackMap: Map<string, TrackLists>; // timeline collab ID → track collab IDs by position, updated in place
  media: (localClip: string) => string | undefined;
  newId: () => string;
}

export interface TimelineIdentity {
  model: Timelines;
  current: string | undefined; // collab ID of the current timeline
  localTimelines: Map<string, string>; // collab → local
  links: { local: string; rcId: string }[]; // timelines whose rcId must be written
  notReady: Set<string>; // collab IDs of items whose media isn't linked yet
  unsupported: LocalItem[];
  markerSpots: Map<string, TimelineMarkerSpot>; // collab marker ID → where it is
  markerTags: (TimelineMarkerSpot & { tag: string })[]; // customData to write (SPEC §21.3)
}

// Resolve's default track names ("Video 2") follow the position, so they are
// kept as "" (default) rather than synced as names.
export function trackName(kind: TrackKind, index: number, name: string): string {
  return name === `${kind === "video" ? "Video" : "Audio"} ${index}` ? "" : name;
}

function identifyTimelineList(input: TimelineIdentifyInput, out: TimelineIdentity): void {
  const seen = new Set<string>();
  const localRc = new Set(input.timelines.map((t) => t.rcId).filter(Boolean));
  const claimed = new Set<string>();
  for (const t of input.timelines) {
    let id = t.rcId && !seen.has(t.rcId) ? t.rcId : "";
    if (!id) {
      // First join: a session timeline of the same name that no local timeline holds.
      const match = Object.values(input.session.timelines).find((s) => s.name === t.name && !localRc.has(s.id) && !claimed.has(s.id));
      id = match?.id ?? input.newId();
      claimed.add(id);
      out.links.push({ local: t.id, rcId: id });
    }
    seen.add(id);
    out.localTimelines.set(id, t.id);
    out.model.timelines[id] = { id, name: t.name, fps: t.fps, width: t.width, height: t.height };
    if (t.id === input.current) out.current = id;
  }
}

function identifyTracks(input: TimelineIdentifyInput, timeline: string, kind: TrackKind, local: LocalTrack[]): string[] {
  const known = input.trackMap.get(timeline)?.[kind];
  const ids: (string | undefined)[] = new Array(local.length).fill(undefined);
  if (!known) {
    // First time this timeline is seen here: the session's tracks by position.
    const session = Object.values(input.session.tracks).filter((t) => t.timeline === timeline && t.kind === kind);
    for (let i = 0; i < local.length; i++) ids[i] = session.find((t) => t.order === i + 1)?.id;
  } else {
    // Where did each known track's clips go?
    const votes = new Map<string, Map<number, number>>();
    for (const it of input.items) {
      if (it.trackKind !== kind) continue;
      const collab = input.itemMap.get(it.id);
      const was = collab && input.previous?.items[collab]?.track;
      if (!was || !known.includes(was)) continue;
      const v = votes.get(was) ?? new Map<number, number>();
      v.set(it.trackIndex, (v.get(it.trackIndex) ?? 0) + 1);
      votes.set(was, v);
    }
    const free = (i: number) => i >= 0 && i < local.length && ids[i] === undefined;
    for (const [track, v] of votes) {
      const [index] = [...v].sort((a, b) => b[1] - a[1])[0]!;
      if (free(index - 1)) ids[index - 1] = track;
    }
    // Tracks without clips: same name first, then in order.
    let rest = known.filter((t) => !ids.includes(t));
    const nameOf = (t: string) => input.previous?.tracks[t]?.name ?? "";
    for (let i = 0; i < local.length; i++) {
      if (ids[i] !== undefined) continue;
      const name = trackName(kind, i + 1, local[i]!.name);
      const byName = name ? rest.find((t) => nameOf(t) === name) : undefined;
      if (byName) {
        ids[i] = byName;
        rest = rest.filter((t) => t !== byName);
      }
    }
    // The rest in their old order. (With empty tracks only, which one was
    // deleted can't be told apart, and it makes no difference to the edit.)
    for (let i = 0; i < local.length && rest.length; i++) {
      if (ids[i] !== undefined) continue;
      ids[i] = rest.shift();
    }
  }
  return ids.map((t) => t ?? input.newId());
}

// Which item edge a transition sits on (SPEC §20.2), from its alignment.
// Found from where the transition sits; Resolve's reported alignment is
// only a first guess (it read "center" for a transition it had reported as
// "right" moments before). The stored alignment follows from the edge found.
function edgeOf(tr: LocalItem, items: LocalItem[], ids: Map<string, string>): Item["edge"] | undefined {
  const near = (a: number, b: number) => Math.abs(a - b) <= 1;
  const same = items.filter((it) => it.kind !== "transition" && it.trackKind === tr.trackKind && it.trackIndex === tr.trackIndex);
  const at = {
    // right: starts where the item starts
    start: () => same.find((it) => near(it.start, tr.start)),
    // left: ends where the item ends
    end: () => same.find((it) => near(it.start + it.duration, tr.start + tr.duration)),
    // center: straddles the cut where the item starts
    cut: () => same.find((it) => near(it.start, tr.start + Math.floor(tr.duration / 2))),
  };
  const guess: "start" | "end" | "cut" = tr.alignment === "right" ? "start" : tr.alignment === "left" ? "end" : "cut";
  for (const side of [guess, ...(["start", "end", "cut"] as const).filter((s) => s !== guess)]) {
    const found = at[side]();
    const item = found && ids.get(found.id);
    if (item) return { item, side, alignment: side === "start" ? "right" : side === "end" ? "left" : "center" };
  }
  return undefined;
}

// A session item of the same kind in the same place, for unknown local items.
function sameSpot(input: TimelineIdentifyInput, timeline: string, track: string, it: LocalItem, media: string | undefined, taken: Set<string>): string | undefined {
  return Object.values(input.session.items).find(
    (s) => s.timeline === timeline && s.track === track && s.kind === it.kind && s.start === it.start && s.duration === it.duration &&
      (it.kind !== "clip" || s.media === media) && !taken.has(s.id),
  )?.id;
}

export function identifyTimelineState(input: TimelineIdentifyInput): TimelineIdentity {
  const out: TimelineIdentity = {
    model: emptyTimelines(), current: undefined, localTimelines: new Map(), links: [], notReady: new Set(), unsupported: [],
    markerSpots: new Map(), markerTags: [],
  };
  identifyTimelineList(input, out);
  const timeline = out.current;
  if (!timeline || !input.tracks) return out;

  const lists: TrackLists = { video: [], audio: [] };
  for (const kind of ["video", "audio"] as const) {
    const local = input.tracks[kind];
    lists[kind] = identifyTracks(input, timeline, kind, local);
    local.forEach((t, i) => {
      const id = lists[kind][i]!;
      const track: Track = { id, timeline, kind, order: i + 1, name: trackName(kind, i + 1, t.name), enabled: t.enabled, locked: t.locked, subType: t.subType };
      out.model.tracks[id] = track;
    });
  }
  input.trackMap.set(timeline, lists);

  // Collab IDs held by items Resolve still has; an ID whose local item is
  // gone (a swapped-in copy, or Resolve gave the item a new ID) is free to
  // be matched again by position.
  const present = new Set(input.items.map((it) => it.id));
  const taken = new Set([...input.itemMap].filter(([local]) => present.has(local)).map(([, collab]) => collab));
  const ids = new Map<string, string>();
  for (const it of input.items) {
    if (it.kind === "other") {
      // An item synced before that can't be identified now (Resolve reports
      // it differently for a moment) is left alone, never taken as deleted.
      const known = input.itemMap.get(it.id);
      if (known) out.notReady.add(known);
      else out.unsupported.push(it);
      continue;
    }
    const track = lists[it.trackKind][it.trackIndex - 1];
    if (!track) continue;
    const media = it.kind === "clip" ? input.media(it.media) : undefined;
    let id = input.itemMap.get(it.id);
    if (!id) {
      id = sameSpot(input, timeline, track, it, media, taken) ?? input.newId();
      input.itemMap.set(it.id, id);
      taken.add(id);
    }
    ids.set(it.id, id);
    if (it.kind === "clip" && !media) {
      out.notReady.add(id);
      continue;
    }
    const item: Item = { id, timeline, kind: it.kind, track, start: it.start, duration: it.duration, enabled: it.enabled, color: it.color, name: it.name };
    if (it.kind === "clip") {
      item.media = media!;
      item.srcStart = it.srcStart ?? 0;
      item.speed = it.speed ?? 100;
      item.link = "";
    }
    if (it.kind === "clip" || it.kind === "textplus") {
      item.fadeIn = it.fadeIn ?? 0;
      item.fadeOut = it.fadeOut ?? 0;
      if (it.props) item.props = { ...it.props };
    }
    if (it.template !== undefined && it.kind !== "clip") item.template = it.template;
    if (it.text && it.kind === "textplus") item.text = { ...it.text };
    out.model.items[id] = item;
  }
  // Linked video and audio share the smallest collab ID of their group.
  for (const it of input.items) {
    const id = ids.get(it.id);
    const item = id && out.model.items[id];
    if (!item || item.kind !== "clip") continue;
    const group = [id, ...it.linked.map((l) => ids.get(l)).filter((x): x is string => !!x)];
    item.link = group.length > 1 ? group.sort()[0]! : "";
  }
  for (const it of input.items) {
    if (it.kind !== "transition") continue;
    const id = ids.get(it.id)!;
    const edge = edgeOf(it, input.items, ids);
    const item = out.model.items[id];
    // No clip at its edge: its clip was just deleted, and Resolve removes the
    // transition a moment later. Skipped, and not called unsupported.
    if (!edge || !item) {
      delete out.model.items[id];
      if (input.session.items[id]) out.notReady.add(id);
      continue;
    }
    item.edge = edge;
  }
  identifyMarkers(input, timeline, ids, out);
  return out;
}

// Timeline and item markers of the current timeline (SPEC §21.3). A session
// marker's owner is "<timeline>/<item>", so a copy on another timeline (from
// DuplicateTimeline) or on another item (from the pool clip) is a new marker.
function identifyMarkers(input: TimelineIdentifyInput, timeline: string, ids: Map<string, string>, out: TimelineIdentity): void {
  const session = Object.values(input.session.markers);
  const ownerOf = (id: string) => {
    const m = input.session.markers[id];
    return m && `${m.timeline}/${m.item}`;
  };
  const claimed = new Set<string>();
  const add = (kind: "timeline" | "item", owner: string, item: string, markers: LocalMarker[]) => {
    for (const m of matchMarkers(markers, `${timeline}/${item}`, session, ownerOf, claimed, input.newId)) {
      out.model.markers[m.id] = { id: m.id, timeline, item, ...markerValues(m.marker) };
      const spot = { kind, owner, frame: m.marker.frame };
      out.markerSpots.set(m.id, spot);
      if (m.retag) out.markerTags.push({ ...spot, tag: tagOf(m.id) });
    }
  };
  add("timeline", input.current, "", input.markers);
  for (const it of input.items) {
    const id = ids.get(it.id);
    // Markers of an item that isn't in the model wait for it.
    if (id && out.model.items[id] && it.markers?.length) add("item", it.id, id, it.markers);
  }
}
