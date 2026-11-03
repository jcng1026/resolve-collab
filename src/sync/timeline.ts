// The session's model of timelines and the operations that change it
// (SPEC §20.2). Like the media pool model: operations set values, applying
// one twice changes nothing, and validateTimelineOp checks everything a peer
// sends before it is applied.
//
// Tracks have no IDs in Resolve, only positions, so they get collab IDs here
// and items point at a track ID: deleting a middle track then can't be
// mistaken for deleting another one. A track's `order` is its 1-based index.

import type { MediaPool } from "./media-pool.ts";
import { MAX_MARKERS_PER_OWNER, type MarkerFields, type MarkerValues, checkMarker, checkMarkerFields } from "./marker.ts";

export type TrackKind = "video" | "audio";
export type ItemKind = "clip" | "textplus" | "title" | "generator" | "transition";

export interface TimelineInfo {
  id: string;
  name: string;
  fps: number;
  width: number;
  height: number;
}

export interface Track {
  id: string;
  timeline: string;
  kind: TrackKind;
  order: number;
  name: string;
  enabled: boolean;
  locked: boolean;
  subType: string; // audio channel layout, e.g. "stereo"; "" for video
}

export interface TextPlus {
  styled: string;
  font: string;
  style: string;
  size: number;
}

export interface Item {
  id: string;
  timeline: string;
  kind: ItemKind;
  track: string; // track ID
  start: number; // frames from the timeline start
  duration: number;
  enabled: boolean;
  color: string;
  name: string;
  // clips
  media?: string; // media pool clip ID
  srcStart?: number;
  link?: string; // shared by linked video and audio items
  speed?: number; // percent
  fadeIn?: number;
  fadeOut?: number;
  props?: Record<string, number | boolean>;
  // titles, generators, transitions
  template?: string; // e.g. "Text", "Solid Color", "Cross Dissolve"
  text?: TextPlus;
  // transitions: which item edge they sit on
  edge?: { item: string; side: "start" | "end" | "cut"; alignment: "left" | "center" | "right" };
}

// A timeline marker (item "") or a marker on an item (SPEC §21.2).
export interface Marker extends MarkerValues {
  id: string;
  timeline: string;
  item: string;
}

export interface Timelines {
  timelines: Record<string, TimelineInfo>;
  tracks: Record<string, Track>;
  items: Record<string, Item>;
  markers: Record<string, Marker>;
}

export type TimelineFields = Partial<Pick<TimelineInfo, "name" | "fps" | "width" | "height">>;
export type TrackFields = Partial<Pick<Track, "order" | "name" | "enabled" | "locked">>;
export type ItemFields = Partial<Omit<Item, "id" | "timeline" | "kind">>;

export type TimelineOp =
  | ({ type: "timeline.create" } & TimelineInfo)
  | ({ type: "timeline.set"; id: string } & TimelineFields)
  | { type: "timeline.delete"; id: string }
  | ({ type: "track.create" } & Track)
  | ({ type: "track.set"; id: string } & TrackFields)
  | { type: "track.delete"; id: string }
  | ({ type: "item.create" } & Item)
  | ({ type: "item.set"; id: string } & ItemFields)
  | { type: "item.delete"; id: string }
  | ({ type: "marker.create" } & Marker)
  | ({ type: "marker.set"; id: string } & MarkerFields)
  | { type: "marker.delete"; id: string };

export function emptyTimelines(): Timelines {
  return { timelines: {}, tracks: {}, items: {}, markers: {} };
}

// The 32 transform/crop/composite/retime keys GetProperties returns (§20.1).
export const ITEM_PROPS = [
  "AnchorPointX", "AnchorPointY", "CompositeEnabled", "CompositeMode", "CropBottom", "CropLeft", "CropRetain", "CropRight",
  "CropSoftness", "CropTop", "CroppingEnabled", "Distortion", "DynamicZoomEase", "DynamicZoomEnabled", "FlipX", "FlipY",
  "LensCorrectionEnabled", "MotionEstimation", "Opacity", "Pan", "Pitch", "ResizeFilter", "RetimeAndScalingEnabled",
  "RetimeProcess", "RotationAngle", "Scaling", "Tilt", "TransformEnabled", "Yaw", "ZoomGang", "ZoomX", "ZoomY",
] as const;
const PROP_SET = new Set<string>(ITEM_PROPS);

// Limits keep one peer from bloating everyone's project.
const MAX_NAME = 255;
const MAX_FRAMES = 100_000_000;
const MAX_TRACKS = 200;
const MAX_TEXT = 4096;

const isId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{32}$/.test(v);
const isName = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_NAME && !/[\u0000-\u001f]/.test(v);
const isLabel = (v: unknown): v is string => typeof v === "string" && v.length <= MAX_NAME && !/[\u0000-\u001f]/.test(v);
const isColor = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z ]{0,32}$/.test(v);
const isTemplate = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9 +._()-]{1,64}$/.test(v);
const isFrame = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_FRAMES;
const isLength = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_FRAMES;
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function checkTimelineFields(o: TimelineFields): string | null {
  if (o.name !== undefined && !isName(o.name)) return "bad name";
  if (o.fps !== undefined && !(isNumber(o.fps) && o.fps > 0 && o.fps <= 1000)) return "bad fps";
  for (const k of ["width", "height"] as const) {
    if (o[k] !== undefined && !(Number.isInteger(o[k]) && o[k]! >= 16 && o[k]! <= 32768)) return `bad ${k}`;
  }
  return null;
}

function checkTrackFields(o: TrackFields): string | null {
  if (o.order !== undefined && !(Number.isInteger(o.order) && o.order >= 1 && o.order <= MAX_TRACKS)) return "bad order";
  if (o.name !== undefined && !isLabel(o.name)) return "bad name";
  if (o.enabled !== undefined && !isBool(o.enabled)) return "bad enabled";
  if (o.locked !== undefined && !isBool(o.locked)) return "bad locked";
  return null;
}

function checkProps(v: unknown): string | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "bad props";
  for (const [k, x] of Object.entries(v)) {
    if (!PROP_SET.has(k) || !(isNumber(x) || isBool(x))) return `bad prop ${k}`;
  }
  return null;
}

function checkText(v: unknown): string | null {
  const t = v as TextPlus;
  if (typeof t !== "object" || t === null) return "bad text";
  if (typeof t.styled !== "string" || t.styled.length > MAX_TEXT) return "bad text";
  if (!isLabel(t.font) || !isLabel(t.style) || !(isNumber(t.size) && t.size >= 0 && t.size <= 10)) return "bad text";
  return null;
}

// Checks item fields against the model: the track exists on the same
// timeline and has the right kind, and the media exists. `anyMedia` accepts
// a well-formed media ID that isn't in the pool (a whole model from a peer
// may hold items whose clip was deleted from the pool; Resolve keeps those).
function checkItemFields(model: Timelines, pool: MediaPool, timeline: string, kind: ItemKind, o: ItemFields, anyMedia = false): string | null {
  if (o.track !== undefined) {
    const track = model.tracks[o.track];
    if (!track || track.timeline !== timeline) return "unknown track";
    if (kind !== "clip" && track.kind !== "video") return "wrong track kind"; // only clips go on audio tracks
  }
  if (o.start !== undefined && !isFrame(o.start)) return "bad start";
  if (o.duration !== undefined && !isLength(o.duration)) return "bad duration";
  if (o.enabled !== undefined && !isBool(o.enabled)) return "bad enabled";
  if (o.color !== undefined && !isColor(o.color)) return "bad color";
  if (o.name !== undefined && !isLabel(o.name)) return "bad name";
  if (o.media !== undefined && (kind !== "clip" || !(pool.clips[o.media] || (anyMedia && isId(o.media))))) return "unknown media";
  if (o.srcStart !== undefined && !isFrame(o.srcStart)) return "bad srcStart";
  if (o.link !== undefined && o.link !== "" && !isId(o.link)) return "bad link";
  if (o.speed !== undefined && !(isNumber(o.speed) && o.speed > 0 && o.speed <= 100_000)) return "bad speed";
  for (const k of ["fadeIn", "fadeOut"] as const) if (o[k] !== undefined && !isFrame(o[k])) return `bad ${k}`;
  if (o.props !== undefined) return checkProps(o.props);
  if (o.template !== undefined && !isTemplate(o.template)) return "bad template";
  if (o.text !== undefined && (kind !== "textplus" || checkText(o.text))) return "bad text";
  if (o.edge !== undefined) {
    const e = o.edge;
    if (kind !== "transition" || typeof e !== "object" || e === null || !model.items[e.item]) return "bad edge";
    if (!["start", "end", "cut"].includes(e.side) || !["left", "center", "right"].includes(e.alignment)) return "bad edge";
  }
  return null;
}

// Returns why op can't be applied, or null when it can. Deleting something
// already gone is allowed (a no-op), since deletes cascade.
export function validateTimelineOp(model: Timelines, pool: MediaPool, op: unknown, anyMedia = false): string | null {
  const o = op as TimelineOp;
  if (typeof o !== "object" || o === null) return "not an object";
  switch (o.type) {
    case "timeline.create":
      if (!isId(o.id) || model.timelines[o.id]) return "bad or existing timeline id";
      if (!isName(o.name)) return "bad name";
      return checkTimelineFields(o) ?? (o.fps === undefined || o.width === undefined || o.height === undefined ? "missing settings" : null);
    case "timeline.set":
      if (!isId(o.id) || !model.timelines[o.id]) return "unknown timeline";
      return checkTimelineFields(o);
    case "timeline.delete":
      return isId(o.id) ? null : "bad timeline id";
    case "track.create": {
      if (!isId(o.id) || model.tracks[o.id]) return "bad or existing track id";
      if (!model.timelines[o.timeline]) return "unknown timeline";
      if (o.kind !== "video" && o.kind !== "audio") return "bad kind";
      if (!isLabel(o.subType)) return "bad subType";
      const count = Object.values(model.tracks).filter((t) => t.timeline === o.timeline).length;
      if (count >= MAX_TRACKS) return "too many tracks";
      return checkTrackFields(o) ?? (o.order === undefined || o.enabled === undefined || o.locked === undefined || o.name === undefined ? "missing fields" : null);
    }
    case "track.set":
      if (!isId(o.id) || !model.tracks[o.id]) return "unknown track";
      return checkTrackFields(o);
    case "track.delete":
      return isId(o.id) ? null : "bad track id";
    case "item.create": {
      if (!isId(o.id) || model.items[o.id]) return "bad or existing item id";
      if (!model.timelines[o.timeline]) return "unknown timeline";
      if (!["clip", "textplus", "title", "generator", "transition"].includes(o.kind)) return "bad kind";
      for (const k of ["track", "start", "duration", "enabled", "color", "name"] as const) if (o[k] === undefined) return `missing ${k}`;
      if (o.kind === "clip" && o.media === undefined) return "missing media";
      if (o.kind === "transition" && o.edge === undefined) return "missing edge";
      return checkItemFields(model, pool, o.timeline, o.kind, o, anyMedia);
    }
    case "item.set": {
      const item = isId(o.id) ? model.items[o.id] : undefined;
      if (!item) return "unknown item";
      return checkItemFields(model, pool, item.timeline, item.kind, o);
    }
    case "item.delete":
      return isId(o.id) ? null : "bad item id";
    case "marker.create": {
      if (!isId(o.id) || model.markers[o.id]) return "bad or existing marker id";
      if (!model.timelines[o.timeline]) return "unknown timeline";
      if (o.item !== "" && model.items[o.item]?.timeline !== o.timeline) return "unknown item";
      const count = Object.values(model.markers).filter((m) => m.timeline === o.timeline && m.item === o.item).length;
      if (count >= MAX_MARKERS_PER_OWNER) return "too many markers";
      return checkMarker(o);
    }
    case "marker.set":
      if (!isId(o.id) || !model.markers[o.id]) return "unknown marker";
      return checkMarkerFields(o);
    case "marker.delete":
      return isId(o.id) ? null : "bad marker id";
    default:
      return "unknown op";
  }
}

function deleteItem(model: Timelines, id: string): void {
  delete model.items[id];
  for (const m of Object.values(model.markers)) if (m.item === id) delete model.markers[m.id];
  // Transitions sit on an item edge and go with it.
  for (const it of Object.values(model.items)) if (it.edge?.item === id) deleteItem(model, it.id);
}

// Applies a valid op in place.
export function applyTimelineOp(model: Timelines, op: TimelineOp): void {
  switch (op.type) {
    case "timeline.create": {
      const { type: _, ...info } = op;
      model.timelines[op.id] = structuredClone(info);
      return;
    }
    case "timeline.set": {
      const { type: _, id: __, ...fields } = op;
      Object.assign(model.timelines[op.id]!, fields);
      return;
    }
    case "timeline.delete":
      if (!model.timelines[op.id]) return;
      delete model.timelines[op.id];
      for (const t of Object.values(model.tracks)) if (t.timeline === op.id) delete model.tracks[t.id];
      for (const it of Object.values(model.items)) if (it.timeline === op.id) delete model.items[it.id];
      for (const m of Object.values(model.markers)) if (m.timeline === op.id) delete model.markers[m.id];
      return;
    case "track.create": {
      const { type: _, ...track } = op;
      model.tracks[op.id] = structuredClone(track);
      return;
    }
    case "track.set": {
      const { type: _, id: __, ...fields } = op;
      Object.assign(model.tracks[op.id]!, fields);
      return;
    }
    case "track.delete": {
      const track = model.tracks[op.id];
      if (!track) return;
      delete model.tracks[op.id];
      for (const it of Object.values(model.items)) if (it.track === op.id) deleteItem(model, it.id);
      // The tracks above move down one place, as in Resolve.
      for (const t of Object.values(model.tracks)) {
        if (t.timeline === track.timeline && t.kind === track.kind && t.order > track.order) t.order--;
      }
      return;
    }
    case "item.create": {
      const { type: _, ...item } = op;
      model.items[op.id] = structuredClone(item);
      return;
    }
    case "item.set": {
      const { type: _, id: __, props, ...fields } = op;
      const item = model.items[op.id]!;
      Object.assign(item, structuredClone(fields));
      // A set carries only the properties that changed.
      if (props) item.props = { ...item.props, ...props };
      return;
    }
    case "item.delete":
      deleteItem(model, op.id);
      return;
    case "marker.create": {
      const { type: _, ...marker } = op;
      model.markers[op.id] = structuredClone(marker);
      return;
    }
    case "marker.set": {
      const { type: _, id: __, ...fields } = op;
      Object.assign(model.markers[op.id]!, fields);
      return;
    }
    case "marker.delete":
      delete model.markers[op.id];
      return;
  }
}

// Rebuilds a whole model from a peer through validateTimelineOp, held to the
// same checks as single operations. Returns null if any part fails.
export function validateTimelines(input: unknown, pool: MediaPool): Timelines | null {
  const raw = input as Timelines;
  if (typeof raw !== "object" || raw === null) return null;
  const model = emptyTimelines();
  const add = (op: TimelineOp) => {
    if (validateTimelineOp(model, pool, op, true)) return false;
    applyTimelineOp(model, op);
    return true;
  };
  for (const t of Object.values(raw.timelines ?? {})) if (!add({ ...t, type: "timeline.create" })) return null;
  for (const t of Object.values(raw.tracks ?? {})) if (!add({ ...t, type: "track.create" })) return null;
  // Transitions refer to other items, so they come last.
  const items = Object.values(raw.items ?? {});
  for (const it of [...items.filter((i) => i?.kind !== "transition"), ...items.filter((i) => i?.kind === "transition")]) {
    if (!add({ ...it, type: "item.create" } as TimelineOp)) return null;
  }
  // Saved before M5: no markers.
  for (const m of Object.values(raw.markers ?? {})) if (!add({ ...m, type: "marker.create" })) return null;
  return model;
}
