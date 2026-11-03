// The fake bridge's timelines (SPEC §20.4), behaving like Resolve as the M4
// probes found it:
//   - items can only be added, deleted or enabled on the current timeline;
//   - an add never overwrites (it is refused when the space is taken);
//   - a move onto occupied space overwrites what was there;
//   - fades set by a command are forgotten by reopen();
//   - creating a timeline makes it current (the command switches back).
// Edits made through the public methods are reported on the next scan, like
// a user's edits; commands update state without being reported back.

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { JsonValue } from "../bridge-protocol/wire.ts";

export interface FakeTrack {
  name: string;
  enabled: boolean;
  locked: boolean;
  subType: string;
}

export interface FakeItem {
  id: string;
  kind: string; // clip, textplus, title, generator, transition, other
  trackKind: "video" | "audio";
  trackIndex: number;
  start: number;
  duration: number;
  enabled: boolean;
  color: string;
  name: string;
  media: string;
  srcStart: number;
  linked: string[];
  speed: number;
  fadeIn: number;
  fadeOut: number;
  props: Record<string, number | boolean>;
  template: string;
  text?: { styled: string; font: string; style: string; size: number };
  alignment?: string;
  apiFades?: boolean; // fades set by a command: lost on reopen
}

export interface FakeTimeline {
  id: string;
  rcId: string;
  name: string;
  fps: number;
  width: number;
  height: number;
  video: FakeTrack[];
  audio: FakeTrack[];
  items: Map<string, FakeItem>;
}

const localId = () => randomBytes(8).toString("hex");
const DEFAULT_PROPS = { ZoomX: 1, ZoomY: 1, Opacity: 100, Pan: 0, Tilt: 0, RotationAngle: 0 };

type C = Record<string, JsonValue>;

export class FakeTimelines {
  readonly timelines = new Map<string, FakeTimeline>();
  current = "";
  // Command types made to fail, to exercise tiers 2 and 3.
  readonly failing = new Set<string>();
  private seen = new Map<string, string>();
  private reported = ""; // the timeline last fully reported
  private readonly hasMedia: (id: string) => boolean;

  constructor(hasMedia: (id: string) => boolean) {
    this.hasMedia = hasMedia;
  }

  // --- the user's edits ---------------------------------------------------------

  addTimeline(name: string, makeCurrent = true): FakeTimeline {
    const t: FakeTimeline = { id: localId(), rcId: "", name, fps: 24, width: 1920, height: 1080,
      video: [{ name: "Video 1", enabled: true, locked: false, subType: "" }],
      audio: [{ name: "Audio 1", enabled: true, locked: false, subType: "stereo" }], items: new Map() };
    this.timelines.set(t.id, t);
    if (makeCurrent || !this.current) this.current = t.id;
    return t;
  }

  timelineByName(name: string): FakeTimeline | undefined {
    return [...this.timelines.values()].find((t) => t.name === name);
  }

  get open(): FakeTimeline | undefined {
    return this.timelines.get(this.current);
  }

  // A clip with linked audio, as dragging footage onto the timeline makes.
  addClip(t: FakeTimeline, media: string, name: string, start: number, duration = 48, trackIndex = 1): FakeItem {
    const v = this.item({ kind: "clip", trackKind: "video", trackIndex, start, duration, name, media });
    const a = this.item({ kind: "clip", trackKind: "audio", trackIndex, start, duration, name, media });
    v.linked = [a.id];
    a.linked = [v.id];
    t.items.set(v.id, v);
    t.items.set(a.id, a);
    return v;
  }

  addItem(t: FakeTimeline, fields: Partial<FakeItem>): FakeItem {
    const it = this.item(fields);
    t.items.set(it.id, it);
    return it;
  }

  itemByName(t: FakeTimeline, name: string, trackKind = "video"): FakeItem | undefined {
    return [...t.items.values()].find((i) => i.name === name && i.trackKind === trackKind);
  }

  // Closing and reopening the project: fades set by scripts are gone.
  reopen(): void {
    for (const t of this.timelines.values()) {
      for (const it of t.items.values()) {
        if (!it.apiFades) continue;
        it.fadeIn = 0;
        it.fadeOut = 0;
        it.apiFades = false;
      }
    }
    this.reported = "";
  }

  private item(fields: Partial<FakeItem>): FakeItem {
    return { id: localId(), kind: "clip", trackKind: "video", trackIndex: 1, start: 0, duration: 48, enabled: true, color: "", name: "",
      media: "", srcStart: 0, linked: [], speed: 100, fadeIn: 0, fadeOut: 0, props: fields.kind === "title" || fields.kind === "generator" ? {} : { ...DEFAULT_PROPS },
      template: "", ...fields };
  }

  // --- reporting --------------------------------------------------------------

  private record(t: FakeTimeline, it: FakeItem): C {
    const { apiFades: _, ...rest } = it;
    return { type: "tl.item", timeline: t.id, ...(structuredClone(rest) as unknown as C) };
  }

  scan(emit: (payload: JsonValue) => void, full = false): void {
    const list = { type: "tl.list", current: this.current,
      timelines: [...this.timelines.values()].map((t) => ({ id: t.id, rcId: t.rcId, name: t.name, fps: t.fps, width: t.width, height: t.height })) };
    const report = (key: string, payload: C) => {
      const encoded = JSON.stringify(payload);
      if (this.seen.get(key) === encoded) return false;
      this.seen.set(key, encoded);
      emit(payload);
      return true;
    };
    report("list", list);
    const t = this.open;
    if (!t) return;
    if (full || this.reported !== t.id) {
      for (const key of [...this.seen.keys()]) if (key !== "list") this.seen.delete(key);
      emit({ type: "tl.reset", timeline: t.id });
    }
    report("tracks", { type: "tl.tracks", timeline: t.id, video: t.video as unknown as JsonValue, audio: t.audio as unknown as JsonValue });
    const present = new Set<string>();
    for (const it of t.items.values()) {
      present.add(`item:${it.id}`);
      report(`item:${it.id}`, this.record(t, it));
    }
    for (const key of [...this.seen.keys()]) {
      if (!key.startsWith("item:") || present.has(key)) continue;
      this.seen.delete(key);
      emit({ type: "tl.gone", timeline: t.id, id: key.slice(5) });
    }
    if (full || this.reported !== t.id) {
      this.reported = t.id;
      emit({ type: "tl.synced", timeline: t.id });
    }
  }

  // Marks an item as already reported in its current state.
  private keep(t: FakeTimeline, it: FakeItem): C {
    const r = this.record(t, it);
    this.seen.set(`item:${it.id}`, JSON.stringify(r));
    return r;
  }

  // Marks the tracks as reported, and returns them for the command's result.
  private keepTracks(t: FakeTimeline): C {
    const record = { type: "tl.tracks", timeline: t.id, video: t.video, audio: t.audio };
    this.seen.set("tracks", JSON.stringify(record));
    return structuredClone(record) as unknown as C;
  }

  // --- commands -----------------------------------------------------------------

  private overlaps(t: FakeTimeline, kind: string, index: number, start: number, end: number, except?: string): FakeItem[] {
    return [...t.items.values()].filter((o) => o.id !== except && o.kind !== "transition" && o.trackKind === kind && o.trackIndex === index && o.start < end && start < o.start + o.duration);
  }

  // Returns the result, or undefined for a command that isn't about timelines.
  apply(c: C): C | undefined {
    const type = String(c.type);
    if (!/^(tl|track|item)\./.test(type)) return undefined;
    if (this.failing.has(type)) return { ok: false, error: "refused" };
    const t = this.timelines.get(String(c.timeline ?? c.id));
    switch (type) {
      case "tl.create": {
        const before = this.current;
        const created = this.addTimeline(String(c.name));
        Object.assign(created, { rcId: String(c.rcId), fps: Number(c.fps), width: Number(c.width), height: Number(c.height) });
        this.current = before || created.id;
        return { ok: true, id: created.id };
      }
      case "tl.link":
        if (!t) return { ok: false, error: "unknown-timeline" };
        t.rcId = String(c.rcId);
        return { ok: true };
      case "tl.set":
        if (!t) return { ok: false, error: "unknown-timeline" };
        for (const k of ["name", "fps", "width", "height"] as const) if (c[k] !== undefined) (t as unknown as C)[k] = c[k]!;
        return { ok: true };
      case "tl.delete":
        if (!t) return { ok: true };
        this.timelines.delete(t.id);
        if (this.current === t.id) this.current = [...this.timelines.keys()][0] ?? "";
        return { ok: true };
      case "tl.export":
        if (!t) return { ok: false, error: "unknown-timeline" };
        writeFileSync(String(c.path), JSON.stringify({ ...t, items: [...t.items.values()] }));
        return { ok: true };
      case "tl.swap": {
        if (!t) return { ok: false, error: "unknown-timeline" };
        const copy = JSON.parse(readFileSync(String(c.path), "utf8")) as FakeTimeline & { items: FakeItem[] };
        // An imported copy: every item gets a new ID; linked ones stay linked.
        const ids = new Map(copy.items.map((it) => [it.id, localId()]));
        t.items = new Map(copy.items.map((it) => {
          const fresh = { ...it, id: ids.get(it.id)!, linked: it.linked.map((l) => ids.get(l)!).filter(Boolean), apiFades: true };
          return [fresh.id, fresh];
        }));
        t.video = copy.video;
        t.audio = copy.audio;
        if (this.current === t.id) this.reported = "";
        return { ok: true, id: t.id };
      }
    }
    if (!t) return { ok: false, error: "unknown-timeline" };
    const current = t.id === this.current;
    switch (type) {
      case "track.add": {
        if (!current) return { ok: false, error: "not-current" };
        const kind = c.kind === "audio" ? "audio" : "video";
        t[kind].push({ name: String(c.name || `${kind === "video" ? "Video" : "Audio"} ${t[kind].length + 1}`), enabled: c.enabled !== false, locked: c.locked === true, subType: String(c.subType ?? "") });
        return { ok: true, tracks: this.keepTracks(t) };
      }
      case "track.set": {
        const kind = c.kind === "audio" ? "audio" : "video";
        const track = t[kind][Number(c.index) - 1];
        if (!track) return { ok: false, error: "unknown-track" };
        if (c.name !== undefined && c.name !== "") track.name = String(c.name);
        if (c.enabled !== undefined) track.enabled = c.enabled === true;
        if (c.locked !== undefined) track.locked = c.locked === true;
        return { ok: true, tracks: this.keepTracks(t) };
      }
      case "track.delete": {
        const kind = c.kind === "audio" ? "audio" : "video";
        const index = Number(c.index);
        if (!t[kind][index - 1]) return { ok: false, error: "unknown-track" };
        t[kind].splice(index - 1, 1);
        const gone: string[] = [];
        for (const it of [...t.items.values()]) {
          if (it.trackKind !== kind) continue;
          if (it.trackIndex === index) {
            t.items.delete(it.id);
            gone.push(it.id);
          } else if (it.trackIndex > index) {
            it.trackIndex--;
          }
        }
        return { ok: true, gone, tracks: this.keepTracks(t), records: [...t.items.values()].map((it) => this.keep(t, it)) };
      }
      case "item.add": {
        if (!current) return { ok: false, error: "not-current" };
        const kind = String(c.kind);
        const trackKind = c.trackKind === "audio" ? "audio" : "video";
        const index = Number(c.trackIndex);
        if (!t[trackKind][index - 1]) return { ok: false, error: "unknown-track" };
        if (kind === "clip" && !this.hasMedia(String(c.media))) return { ok: false, error: "media-missing" };
        const start = Number(c.start);
        const duration = Number(c.duration);
        if (kind !== "transition" && this.overlaps(t, trackKind, index, start, start + duration).length) return { ok: false, error: "occupied" };
        const it = this.item({
          kind, trackKind, trackIndex: index, start, duration, enabled: c.enabled !== false, color: String(c.color ?? ""), name: String(c.name ?? ""),
          media: String(c.media ?? ""), srcStart: Number(c.srcStart ?? 0), speed: Number(c.speed ?? 100), template: String(c.template ?? ""),
          fadeIn: Number(c.fadeIn ?? 0), fadeOut: Number(c.fadeOut ?? 0), apiFades: Number(c.fadeIn ?? 0) > 0 || Number(c.fadeOut ?? 0) > 0,
        });
        if (c.props) it.props = { ...it.props, ...(c.props as Record<string, number | boolean>) };
        if (c.text) it.text = c.text as unknown as NonNullable<FakeItem["text"]>;
        if (kind === "transition") it.alignment = String((c.edge as C | undefined)?.alignment ?? "center");
        t.items.set(it.id, it);
        return { ok: true, id: it.id, records: [this.keep(t, it)] };
      }
      case "item.set": {
        const it = t.items.get(String(c.id));
        if (!it) return { ok: false, error: "unknown-item" };
        if (c.enabled !== undefined && !current) return { ok: false, error: "not-current" };
        const gone: string[] = [];
        if (c.start !== undefined || c.trackIndex !== undefined) {
          const start = Number(c.start ?? it.start);
          const index = Number(c.trackIndex ?? it.trackIndex);
          const duration = Number(c.duration ?? it.duration);
          // A move onto occupied space overwrites what was there.
          for (const o of this.overlaps(t, it.trackKind, index, start, start + duration, it.id)) {
            t.items.delete(o.id);
            gone.push(o.id);
          }
          it.start = start;
          it.trackIndex = index;
        }
        if (c.duration !== undefined) it.duration = Number(c.duration);
        if (c.srcStart !== undefined) it.srcStart = Number(c.srcStart);
        for (const k of ["enabled", "color", "name", "speed", "template"] as const) if (c[k] !== undefined) (it as unknown as C)[k] = c[k]!;
        if (c.fadeIn !== undefined || c.fadeOut !== undefined) {
          it.fadeIn = Number(c.fadeIn ?? it.fadeIn);
          it.fadeOut = Number(c.fadeOut ?? it.fadeOut);
          it.apiFades = true;
        }
        if (c.props) it.props = { ...it.props, ...(c.props as Record<string, number | boolean>) };
        if (c.text) it.text = c.text as unknown as NonNullable<FakeItem["text"]>;
        return { ok: true, gone, records: [this.keep(t, it)] };
      }
      case "item.delete": {
        if (!current) return { ok: false, error: "not-current" };
        const it = t.items.get(String(c.id));
        if (!it) return { ok: true };
        t.items.delete(it.id);
        for (const o of t.items.values()) o.linked = o.linked.filter((l) => l !== it.id);
        this.seen.delete(`item:${it.id}`);
        return { ok: true, gone: [it.id] };
      }
      case "item.link": {
        const ids = (Array.isArray(c.ids) ? c.ids : []).map(String).filter((i) => t.items.has(i));
        for (const i of ids) t.items.get(i)!.linked = c.linked === false ? [] : ids.filter((o) => o !== i);
        return { ok: true, records: ids.map((i) => this.keep(t, t.items.get(i)!)) };
      }
      default:
        return { ok: false, error: "unknown-command" };
    }
  }
}
