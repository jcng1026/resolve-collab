import type { JsonValue } from "../bridge-protocol/wire.ts";

// Markers (SPEC §21.2): what every kind of marker holds and the checks a
// peer's marker must pass. Timeline and item markers live in the timelines
// model, media pool clip markers in the media pool model.

// Resolve's 16 marker colours (docs/resolve-api, MarkerColor).
export const MARKER_COLORS = [
  "Blue", "Cyan", "Green", "Yellow", "Red", "Pink", "Purple", "Fuchsia",
  "Rose", "Lavender", "Sky", "Mint", "Lemon", "Sand", "Cocoa", "Cream",
] as const;
const COLOR_SET = new Set<string>(MARKER_COLORS);

export interface MarkerValues {
  frame: number; // timeline frame for a timeline marker, else the source frame
  duration: number;
  color: string;
  name: string;
  note: string;
}

export type MarkerFields = Partial<MarkerValues>;

export const MARKER_FIELDS = ["frame", "duration", "color", "name", "note"] as const;

// Limits keep one peer from bloating everyone's project.
const MAX_FRAMES = 100_000_000;
const MAX_NAME = 255;
const MAX_NOTE = 10_000;
export const MAX_MARKERS_PER_OWNER = 5000;

const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max && !v.includes("\u0000");

export function checkMarkerFields(o: MarkerFields): string | null {
  if (o.frame !== undefined && !(Number.isInteger(o.frame) && o.frame >= 0 && o.frame <= MAX_FRAMES)) return "bad frame";
  if (o.duration !== undefined && !(Number.isInteger(o.duration) && o.duration >= 1 && o.duration <= MAX_FRAMES)) return "bad duration";
  if (o.color !== undefined && !(typeof o.color === "string" && COLOR_SET.has(o.color))) return "bad color";
  if (o.name !== undefined && !isText(o.name, MAX_NAME)) return "bad name";
  if (o.note !== undefined && !isText(o.note, MAX_NOTE)) return "bad note";
  return null;
}

// For a new marker: every value present and valid.
export function checkMarker(o: MarkerFields): string | null {
  for (const k of MARKER_FIELDS) if (o[k] === undefined) return `missing ${k}`;
  return checkMarkerFields(o);
}

export function markerValues(m: MarkerValues): MarkerValues {
  return { frame: m.frame, duration: m.duration, color: m.color, name: m.name, note: m.note };
}

// --- identity (SPEC §21.3) -----------------------------------------------------

// A marker as the bridge reports it; `tag` is its customData.
export interface LocalMarker extends MarkerValues {
  tag: string;
}

// Timeline and item markers are tagged "rc:<id>", media pool clip markers
// "rc:p:<id>": Resolve copies a pool clip's markers onto every item made from
// it, and those copies must not pass for the pool clip's markers.
export const TIMELINE_TAG = "rc:";
export const POOL_TAG = "rc:p:";
export const tagOf = (id: string, prefix = TIMELINE_TAG) => `${prefix}${id}`;
const idOfTag = (tag: string, prefix: string) =>
  tag.startsWith(prefix) && /^[0-9a-f]{32}$/.test(tag.slice(prefix.length)) ? tag.slice(prefix.length) : undefined;
// customData another tool wrote: never overwritten.
const foreign = (tag: string) => tag !== "" && !tag.startsWith("rc:");

export interface MarkerMatch {
  marker: LocalMarker;
  id: string;
  retag: boolean; // customData must be set to tagOf(id, prefix)
}

// Matches one owner's markers to the session's. `owner` is the owner's
// collab key, `ownerOf` gives a session marker's owner key, and `claimed`
// holds IDs already given out in this pass (shared by all owners).
export function matchMarkers(
  local: LocalMarker[],
  owner: string,
  session: (MarkerValues & { id: string })[],
  ownerOf: (id: string) => string | undefined,
  claimed: Set<string>,
  newId: () => string,
  prefix = TIMELINE_TAG,
): MarkerMatch[] {
  const out: MarkerMatch[] = [];
  const mine = session.filter((s) => ownerOf(s.id) === owner);
  const take = (marker: LocalMarker, id: string) => {
    claimed.add(id);
    out.push({ marker, id, retag: marker.tag !== tagOf(id, prefix) && !foreign(marker.tag) });
  };
  // 1. Its own ID, unless the session has it on another owner (a copy).
  const rest: LocalMarker[] = [];
  for (const marker of local) {
    const id = idOfTag(marker.tag, prefix);
    const elsewhere = id !== undefined && ownerOf(id) !== undefined && ownerOf(id) !== owner;
    if (id && !elsewhere && !claimed.has(id)) take(marker, id);
    else rest.push(marker);
  }
  // 2. A session marker on this owner with the same values; foreign-tagged
  // markers also by frame alone.
  const fresh: LocalMarker[] = [];
  for (const marker of rest) {
    const free = mine.filter((s) => !claimed.has(s.id) && s.frame === marker.frame);
    const match = free.find((s) => same(markerValues(s), markerValues(marker))) ?? (foreign(marker.tag) ? free[0] : undefined);
    if (match) take(marker, match.id);
    else fresh.push(marker);
  }
  // 3. New.
  for (const marker of fresh) take(marker, newId());
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Markers as the bridge reports them (Lua encodes an empty list as {}).
export function localMarkers(raw: JsonValue | undefined): LocalMarker[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => {
    const m = x as Record<string, JsonValue>;
    return { frame: Number(m.frame), duration: Number(m.duration), color: String(m.color ?? ""), name: String(m.name ?? ""),
      note: String(m.note ?? ""), tag: String(m.tag ?? "") };
  });
}

// Said once per marker value that couldn't be placed (SPEC §21.5).
export function markerFailure(marker: MarkerValues, error: string): string {
  const label = marker.name ? `marker "${marker.name}"` : "a marker";
  return error === "occupied"
    ? `${label} from another PC couldn't be placed at frame ${marker.frame}: there's already a marker on that frame here`
    : `${label} from another PC couldn't be placed (${error})`;
}
