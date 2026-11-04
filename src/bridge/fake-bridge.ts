// In-process stand-in for the Lua bridge, speaking the same wire format
// (SPEC §18.1) through a log file and an inbox folder. Used by tests and by
// the one-PC end-to-end check. Its media pool behaves like the real bridge's
// (SPEC §19.4): edits made through the methods below are reported on the
// next scan, and commands update the pool without being reported back.

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { type JsonValue, decodeInbox, readyFolder } from "../bridge-protocol/wire.ts";
import { type FakeMarker, type FakeTimeline, FakeTimelines, applyMarkerCommand } from "./fake-timelines.ts";

export interface FakeClip {
  timeline: string;
  track: number;
  start: number;
  end: number;
  srcStart: number;
  srcEnd: number;
  media: { name: string; path: string; frames: number };
}

export interface FakeBin {
  id: string;
  name: string;
  parent: string;
}

export interface FakePoolClip {
  id: string;
  rcId: string;
  name: string;
  bin: string;
  color: string;
  flags: string[];
  meta: Record<string, string>;
  path: string;
  markers: FakeMarker[];
}

const localId = () => randomBytes(8).toString("hex");

// The string fields commands carry; checked by the fake as the bridge would.
type Command = Record<"id" | "parent" | "name" | "bin" | "path" | "rcId" | "color", string> & Record<string, JsonValue>;

export class FakeBridge {
  readonly id = randomBytes(4).toString("hex");
  readonly clips: FakeClip[] = [];
  readonly media = new Set<string>();
  readonly bins = new Map<string, FakeBin>();
  readonly poolClips = new Map<string, FakePoolClip>();
  readonly rootId = localId();
  readonly commands: Record<string, JsonValue>[] = [];
  project = { id: "fake-project", name: "Fake Project" };
  build = ""; // reported like the real bridge's stamped build (bridge-build.ts)
  readonly timelines = new FakeTimelines((id) => this.poolClips.has(id), () => this.project.id, (id) => this.poolClips.get(id)?.markers ?? []);
  private readonly seen = new Map<string, string>(); // "bin:<id>" → last reported encoding
  private readonly projectTimelines = new Map<string, {
    timelines: Map<string, FakeTimeline>; current: string; bins: Map<string, FakeBin>; clips: Map<string, FakePoolClip>;
  }>();
  readonly projectNames = new Set<string>(["Fake Project"]);
  private poolProject = ""; // the project the media pool was last reported for
  private lastHandled = 0;
  private timer: NodeJS.Timeout | undefined;
  private readonly logPath: string;
  private readonly inboxDir: string;

  constructor(logPath: string, inboxDir: string) {
    this.logPath = logPath;
    this.inboxDir = inboxDir;
    this.bins.set(this.rootId, { id: this.rootId, name: "Master", parent: "" });
  }

  start(pollMs = 20): void {
    this.emit("HELLO", { product: "Fake Resolve", studio: false, inbox: this.inboxDir, handled: this.lastHandled, build: this.build });
    this.snapshot();
    this.timer = setInterval(() => this.tick(), pollMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  // --- local edits, as the editor would make them ---------------------------

  addLocalClip(clip: FakeClip): void {
    this.clips.push(clip);
    this.emit("EVT", { type: "clip.added", ...clip } as unknown as JsonValue);
  }

  addBin(name: string, parent = this.rootId): FakeBin {
    const bin = { id: localId(), name, parent };
    this.bins.set(bin.id, bin);
    return bin;
  }

  importClip(path: string, bin = this.rootId): FakePoolClip {
    const clip: FakePoolClip = { id: localId(), rcId: "", name: basename(path), bin, color: "", flags: [], meta: {}, path, markers: [] };
    this.poolClips.set(clip.id, clip);
    return clip;
  }

  deleteBin(id: string): void {
    for (const bin of [...this.bins.values()]) if (bin.parent === id) this.deleteBin(bin.id);
    for (const clip of [...this.poolClips.values()]) if (clip.bin === id) this.poolClips.delete(clip.id);
    this.bins.delete(id);
  }

  clipByName(name: string): FakePoolClip | undefined {
    return [...this.poolClips.values()].find((c) => c.name === name);
  }

  binByName(name: string): FakeBin | undefined {
    return [...this.bins.values()].find((b) => b.name === name);
  }

  // Opening another project in Resolve: each project keeps its own media
  // pool and timelines (a project not seen before is empty). Like the real
  // bridge, the timeline scan reports the switch a moment before the media
  // pool does.
  switchProject(project: { id: string; name: string }): void {
    this.projectTimelines.set(this.project.id, {
      timelines: new Map(this.timelines.timelines), current: this.timelines.current, bins: new Map(this.bins), clips: new Map(this.poolClips),
    });
    const next = this.projectTimelines.get(project.id);
    this.timelines.timelines.clear();
    for (const [k, v] of next?.timelines ?? []) this.timelines.timelines.set(k, v);
    this.timelines.current = next?.current ?? "";
    this.bins.clear();
    for (const [k, v] of next?.bins ?? [[this.rootId, { id: this.rootId, name: "Master", parent: "" }]]) this.bins.set(k, v);
    this.poolClips.clear();
    for (const [k, v] of next?.clips ?? []) this.poolClips.set(k, v);
    this.project = project;
    this.timelines.scan((payload) => this.emit("EVT", payload), true);
    // The real bridge scans the media pool half as often as timelines.
    setTimeout(() => this.snapshot(), 300);
  }

  // --- wire -----------------------------------------------------------------

  private emit(kind: string, payload: JsonValue): void {
    const hex = Buffer.from(JSON.stringify(payload), "utf8").toString("hex");
    appendFileSync(this.logPath, `[0x0] | Fusion | ERROR | fake | [string "???"]:1: RC|${this.id}|${kind}|${hex}\n`);
  }

  private snapshot(): void {
    this.seen.clear();
    this.poolProject = this.project.id;
    this.emit("EVT", { type: "mp.reset", project: this.project });
    this.scan();
    this.emit("EVT", { type: "mp.synced", bins: this.bins.size, clips: this.poolClips.size, project: this.project });
    this.timelines.scan((payload) => this.emit("EVT", payload), true);
  }

  private binRecord(bin: FakeBin): Record<string, JsonValue> {
    return { type: "mp.bin", ...bin };
  }

  private clipRecord(clip: FakePoolClip): Record<string, JsonValue> {
    return { type: "mp.clip", ...clip, flags: [...clip.flags].sort(), meta: { ...clip.meta }, markers: structuredClone(clip.markers) as unknown as JsonValue };
  }

  private keep(key: string, record: Record<string, JsonValue>): Record<string, JsonValue> {
    this.seen.set(key, JSON.stringify(record));
    return record;
  }

  // Reports added, changed and removed items since the last scan. Like the
  // real bridge, never across a project switch: until the switch is reported
  // (mp.reset), another project's pool isn't compared with this one's.
  private scan(): void {
    if (this.poolProject !== this.project.id) {
      this.timelines.scan((payload) => this.emit("EVT", payload));
      return;
    }
    const present = new Set<string>();
    const report = (key: string, record: Record<string, JsonValue>) => {
      present.add(key);
      const encoded = JSON.stringify(record);
      if (this.seen.get(key) !== encoded) {
        this.seen.set(key, encoded);
        this.emit("EVT", record);
      }
    };
    for (const bin of this.bins.values()) report(`bin:${bin.id}`, this.binRecord(bin));
    for (const clip of this.poolClips.values()) report(`clip:${clip.id}`, this.clipRecord(clip));
    for (const key of [...this.seen.keys()]) {
      if (present.has(key)) continue;
      this.seen.delete(key);
      const [kind, id] = key.split(":");
      this.emit("EVT", { type: "mp.gone", kind: kind!, id: id! });
    }
    this.timelines.scan((payload) => this.emit("EVT", payload));
  }

  private tick(): void {
    this.emit("HB", { handled: this.lastHandled, build: this.build });
    // Like the real bridge, list the inbox only once the next message is ready.
    let names: string[] = [];
    if (existsSync(join(this.inboxDir, readyFolder(this.lastHandled + 1)))) {
      try {
        names = readdirSync(this.inboxDir);
      } catch {
        return;
      }
    }
    for (const { seq, message } of decodeInbox(names)) {
      if (seq <= this.lastHandled) continue;
      this.lastHandled = seq;
      this.commands.push(message as Record<string, JsonValue>);
      this.emit("RES", { seq, ...this.apply(message as Record<string, JsonValue>) });
      this.emit("ACK", { seq });
    }
    this.scan();
  }

  private apply(command: Record<string, JsonValue>): Record<string, JsonValue> {
    const timeline = this.timelines.apply(command);
    if (timeline) return timeline;
    const c = command as Command;
    switch (command.type) {
      case "clip.append": {
        const clip = command as unknown as FakeClip;
        if (!this.media.has(clip.media.name)) return { ok: false, error: "media-missing" };
        this.clips.push(clip);
        return { ok: true };
      }
      // A new empty project, opened, as the bridge's CreateProject (SPEC §22.3).
      case "project.create": {
        let name = String(command.name ?? "");
        if (!name) return { ok: false, error: "bad-name" };
        for (let n = 2; this.projectNames.has(name); n++) name = `${String(command.name)} (${n})`;
        this.projectNames.add(name);
        const project = { id: localId(), name };
        this.switchProject(project);
        return { ok: true, id: project.id, name };
      }
      case "project.backup":
        return { ok: true, path: command.path ?? "" };
      case "mp.snapshot":
        this.snapshot();
        return { ok: true };
      case "mp.bin.create": {
        if (!this.bins.has(c.parent)) return { ok: false, error: "unknown-bin" };
        const bin = this.addBin(c.name, c.parent);
        return { ok: true, records: [this.keep(`bin:${bin.id}`, this.binRecord(bin))] };
      }
      case "mp.bin.rename": {
        const old = this.bins.get(c.id);
        if (!old || !old.parent) return { ok: false, error: "unknown-bin" };
        const bin = this.addBin(c.name, old.parent);
        const records = [this.keep(`bin:${bin.id}`, this.binRecord(bin))];
        for (const clip of this.poolClips.values()) {
          if (clip.bin !== old.id) continue;
          clip.bin = bin.id;
          records.push(this.keep(`clip:${clip.id}`, this.clipRecord(clip)));
        }
        for (const sub of this.bins.values()) {
          if (sub.parent !== old.id) continue;
          sub.parent = bin.id;
          records.push(this.keep(`bin:${sub.id}`, this.binRecord(sub)));
        }
        this.bins.delete(old.id);
        this.seen.delete(`bin:${old.id}`);
        return { ok: true, records, gone: [{ kind: "bin", id: old.id }] };
      }
      case "mp.bin.move": {
        const bin = this.bins.get(c.id);
        if (!bin || !this.bins.has(c.parent)) return { ok: false, error: "unknown-bin" };
        bin.parent = c.parent;
        return { ok: true, records: [this.keep(`bin:${bin.id}`, this.binRecord(bin))] };
      }
      case "mp.bin.delete": {
        const before = [...[...this.bins.keys()].map((id) => ["bin", id]), ...[...this.poolClips.keys()].map((id) => ["clip", id])];
        this.deleteBin(c.id);
        const gone: JsonValue[] = [];
        for (const [kind, id] of before as [string, string][]) {
          if (kind === "bin" ? this.bins.has(id) : this.poolClips.has(id)) continue;
          this.seen.delete(`${kind}:${id}`);
          gone.push({ kind, id });
        }
        return { ok: true, gone };
      }
      case "mp.clip.import": {
        if (!this.bins.has(c.bin)) return { ok: false, error: "unknown-bin" };
        if (!existsSync(c.path)) return { ok: false, error: "file-missing" };
        const clip = this.importClip(c.path, c.bin);
        clip.rcId = c.rcId;
        return this.setClip(clip, command);
      }
      case "mp.clip.link": {
        const clip = this.poolClips.get(c.id);
        if (!clip) return { ok: false, error: "unknown-clip" };
        clip.rcId = c.rcId;
        return { ok: true, records: [this.keep(`clip:${clip.id}`, this.clipRecord(clip))] };
      }
      case "mp.clip.set": {
        const clip = this.poolClips.get(c.id);
        if (!clip) return { ok: false, error: "unknown-clip" };
        return this.setClip(clip, command);
      }
      case "mp.clip.delete":
        this.poolClips.delete(c.id);
        this.seen.delete(`clip:${c.id}`);
        return { ok: true, gone: [{ kind: "clip", id: c.id }] };
      case "marker.add":
      case "marker.set":
      case "marker.delete":
      case "marker.tag": {
        const clip = this.poolClips.get(String((command.owner as Record<string, JsonValue> | undefined)?.id));
        if (!clip) return { ok: false, error: "unknown-clip" };
        const result = applyMarkerCommand(clip.markers, command);
        return { ok: result.ok, ...(result.error ? { error: result.error } : {}), records: [this.keep(`clip:${clip.id}`, this.clipRecord(clip))] };
      }
      default:
        return { ok: false, error: "unknown-command" };
    }
  }

  private setClip(clip: FakePoolClip, command: Record<string, JsonValue>): Record<string, JsonValue> {
    const c = command as Command;
    if (c.name !== undefined) clip.name = c.name;
    if (c.color !== undefined) clip.color = c.color;
    if (c.flags !== undefined) clip.flags = [...(c.flags as string[])];
    for (const [k, v] of Object.entries((c.meta ?? {}) as Record<string, string>)) {
      if (v === "") delete clip.meta[k];
      else clip.meta[k] = v;
    }
    if (c.bin !== undefined && command.type === "mp.clip.set") {
      if (!this.bins.has(c.bin)) return { ok: false, error: "unknown-bin" };
      clip.bin = c.bin;
    }
    return { ok: true, records: [this.keep(`clip:${clip.id}`, this.clipRecord(clip))] };
  }
}
