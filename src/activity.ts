// The session's activity (SPEC §24.3): chat messages and one line per change,
// kept by the host (the last 500), sent to anyone who joins or rejoins.
// Quick changes in a row by the same person to the same thing merge into one
// line, and a linked video and audio pair counts as one thing.

import type { SessionModel, SessionOp } from "./sync/session-model.ts";

export const MAX_LINES = 500;
export const MERGE_MS = 10_000; // quick changes in a row become one line
export const MAX_CHAT = 2000;

export interface Change {
  name: string; // the property, in words ("start", "colour")
  from: string;
  to: string;
}

export interface Line {
  id: number;
  kind: "chat" | "change";
  at: number; // ms since 1970
  author: string; // peer ID
  name: string; // the author's name
  text: string; // chat: the message; change: one line, "moved Interview_03 on V1"
  changes: Change[]; // change: old → new per property
  // Where clicking it takes you (SPEC §24.3): a timeline and a frame on it.
  timeline?: string;
  frame?: number;
}

const kindOf = (op: SessionOp) => op.type.slice(0, op.type.indexOf("."));
const verbOf = (op: SessionOp) => op.type.slice(op.type.indexOf(".") + 1);
type Rec = Record<string, unknown>;

const FIELD: Record<string, string> = {
  color: "colour", name: "name", bin: "bin", flags: "flags", start: "start", duration: "length", track: "track", enabled: "on/off",
  srcStart: "source start", speed: "speed", fadeIn: "fade in", fadeOut: "fade out", frame: "frame", note: "note", order: "order",
  locked: "lock", parent: "bin", text: "text", fps: "frame rate", width: "width", height: "height",
};

// shortcut: frames are shown from a 01:00:00:00 start, Resolve's default; read the timeline's real start once the bridge reports it.
export function timecode(frames: number, fps: number): string {
  const f = Math.max(0, Math.round(fps)) || 24;
  const total = Math.round(frames) + 3600 * f;
  const two = (n: number) => String(Math.floor(n)).padStart(2, "0");
  return `${two(total / (3600 * f))}:${two((total / (60 * f)) % 60)}:${two((total / f) % 60)}:${two(total % f)}`;
}

function table(model: SessionModel, kind: string): Record<string, Rec> {
  const t: Record<string, unknown> = {
    bin: model.pool.bins, clip: model.pool.clips, poolmarker: model.pool.markers,
    timeline: model.timelines.timelines, track: model.timelines.tracks, item: model.timelines.items, marker: model.timelines.markers,
  };
  return (t[kind] ?? {}) as Record<string, Rec>;
}

// How a thing is named in a line: "Interview_03", "track V2", "the marker “Fix audio”".
function labelOf(kind: string, e: Rec | undefined, created = false): string {
  const name = String(e?.name ?? "");
  const q = (n: string) => `“${n}”`;
  switch (kind) {
    case "track": return `track ${(e as { kind?: string } | undefined)?.kind === "audio" ? "A" : "V"}${String((e as { order?: number } | undefined)?.order ?? "")}`;
    case "marker":
    case "poolmarker": return name ? `${created ? "a" : "the"} marker ${q(name)}` : `${created ? "a" : "the"} marker`;
    case "timeline": return `${created ? "a" : "the"} timeline ${q(name)}`;
    case "bin": return `${created ? "a" : "the"} bin ${q(name)}`;
    default: return name || kind;
  }
}

function show(model: SessionModel, field: string, value: unknown, fps: number): string {
  if (value === undefined || value === "") return field === "color" ? "none" : "—";
  if ((field === "start" || field === "frame") && typeof value === "number") return timecode(value, fps);
  if ((field === "duration" || field === "fadeIn" || field === "fadeOut" || field === "srcStart") && typeof value === "number") return `${value} frames`;
  if (field === "track" && typeof value === "string") return labelOf("track", model.timelines.tracks[value] as Rec | undefined).slice(6);
  if (field === "bin" || field === "parent") return String((model.pool.bins[value as string] as { name?: string } | undefined)?.name ?? value);
  if (field === "enabled" || field === "locked") return value ? "on" : "off";
  if (Array.isArray(value)) return value.join(", ") || "none";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// "moved", "trimmed", "recoloured"… from what a change sets.
function verb(fields: string[]): string {
  const has = (...f: string[]) => f.some((x) => fields.includes(x));
  if (has("start", "track")) return "moved";
  if (has("duration", "srcStart")) return "trimmed";
  if (fields.length === 1 && has("color")) return "recoloured";
  if (fields.length === 1 && has("name")) return "renamed";
  if (has("fadeIn", "fadeOut")) return "changed the fades of";
  if (fields.length === 1 && has("enabled")) return "turned on or off";
  return "changed";
}

// What one change did, with old → new, from the session just before it.
export function describe(before: SessionModel, op: SessionOp): Pick<Line, "text" | "changes" | "timeline" | "frame"> & { key: string } {
  const kind = kindOf(op);
  const o = op as unknown as Rec;
  const id = String(o.id);
  const old = table(before, kind)[id];
  const entity = old ?? o;
  const item = (kind === "item" ? entity : undefined) as { timeline?: string; track?: string; start?: number; link?: string } | undefined;
  const timelineId = kind === "item" || kind === "marker" || kind === "track" ? String((entity as Rec).timeline ?? "") : kind === "timeline" ? id : "";
  const fps = Number((before.timelines.timelines[timelineId] as { fps?: number } | undefined)?.fps ?? 24);
  const verbName = verbOf(op);
  const label = labelOf(kind, entity as Rec, verbName === "create");
  const trackName = item?.track ? labelOf("track", before.timelines.tracks[item.track] as Rec | undefined).slice(6) : "";
  const on = kind === "item" && trackName ? ` on ${trackName}` : kind === "marker" || kind === "track" ? ` on ${before.timelines.timelines[timelineId]?.name ?? "a timeline"}` : "";
  const where = { ...(timelineId ? { timeline: timelineId } : {}), ...(kind === "item" && typeof (item?.start ?? o.start) === "number" ? { frame: Number(o.start ?? item?.start) } : {}), ...(kind === "marker" && typeof ((entity as Rec).frame) === "number" && (entity as Rec).item === "" ? { frame: Number((entity as Rec).frame) } : {}) };
  // A linked video and audio pair is one thing.
  const key = `${kind}:${item?.link || id}`;
  if (verbName === "create") return { text: `added ${label}${on}`, changes: [], key, ...where };
  if (verbName === "delete") return { text: `deleted ${label}${on}`, changes: [], key, ...where };
  const fields = Object.keys(o).filter((f) => f !== "type" && f !== "id");
  const changes: Change[] = [];
  for (const f of fields) {
    if ((f === "meta" || f === "props") && o[f] && typeof o[f] === "object") {
      for (const [k, v] of Object.entries(o[f] as Rec)) changes.push({ name: k, from: show(before, k, ((old?.[f] ?? {}) as Rec)[k], fps), to: show(before, k, v, fps) });
    } else {
      changes.push({ name: FIELD[f] ?? f, from: show(before, f, old?.[f], fps), to: show(before, f, o[f], fps) });
    }
  }
  return { text: `${verb(fields)} ${label}${on}`, changes, key, ...where };
}

export class Activity {
  lines: Line[] = [];
  private nextId = 1;
  private lastKey = new Map<string, { key: string; line: Line }>(); // per author: their last change line

  constructor(lines: Line[] = []) {
    this.lines = lines.slice(-MAX_LINES);
    this.nextId = (this.lines.at(-1)?.id ?? 0) + 1;
  }

  private add(line: Omit<Line, "id">): Line {
    const full = { ...line, id: this.nextId++ };
    this.lines.push(full);
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
    return full;
  }

  chat(author: string, name: string, text: string, at = Date.now()): Line | undefined {
    const t = text.trim().slice(0, MAX_CHAT);
    if (!t) return undefined;
    this.lastKey.delete(author);
    return this.add({ kind: "chat", at, author, name, text: t, changes: [] });
  }

  // A committed change; merges into the author's last line when it's the same
  // thing within MERGE_MS. Returns the line that's new or changed.
  change(before: SessionModel, op: SessionOp, author: string, name: string, at = Date.now()): Line {
    const d = describe(before, op);
    const last = this.lastKey.get(author);
    if (last && last.key === d.key && at - last.line.at <= MERGE_MS && this.lines.includes(last.line)) {
      const line = last.line;
      for (const c of d.changes) {
        const same = line.changes.find((x) => x.name === c.name);
        if (same) same.to = c.to; // the first old value stays
        else line.changes.push(c);
      }
      if (line.changes.length && d.changes.length) line.text = d.text.startsWith("changed") ? line.text : d.text;
      line.at = at;
      return line;
    }
    const line = this.add({ kind: "change", at, author, name, text: d.text, changes: d.changes, ...(d.timeline ? { timeline: d.timeline } : {}), ...(d.frame !== undefined ? { frame: d.frame } : {}) });
    this.lastKey.set(author, { key: d.key, line });
    return line;
  }
}

// A line from the host, checked before use (SPEC §13); undefined if malformed.
export function cleanLine(raw: unknown): Line | undefined {
  const l = raw as Rec | null;
  if (typeof l !== "object" || l === null) return undefined;
  const str = (v: unknown, max: number) => typeof v === "string" && v.length <= max;
  if (!Number.isSafeInteger(l.id) || (l.kind !== "chat" && l.kind !== "change") || !Number.isFinite(l.at)) return undefined;
  if (!str(l.author, 64) || !str(l.name, 40) || !str(l.text, MAX_CHAT + 200) || !Array.isArray(l.changes) || l.changes.length > 200) return undefined;
  for (const c of l.changes as Rec[]) if (!str(c?.name, 100) || !str(c?.from, 300) || !str(c?.to, 300)) return undefined;
  if (l.timeline !== undefined && !str(l.timeline, 64)) return undefined;
  if (l.frame !== undefined && !Number.isFinite(l.frame)) return undefined;
  return {
    id: l.id as number, kind: l.kind, at: l.at as number, author: l.author as string, name: l.name as string, text: l.text as string,
    changes: (l.changes as Change[]).map((c) => ({ name: c.name, from: c.from, to: c.to })),
    ...(l.timeline !== undefined ? { timeline: l.timeline as string } : {}), ...(l.frame !== undefined ? { frame: l.frame as number } : {}),
  };
}
