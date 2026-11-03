// One ResolveCollab session on this PC (SPEC §19.3, §20): connects the
// bridge, the peers, and the media pool and timeline syncs. The host orders
// every change; members propose to the host and apply its commits in order.
//
// Peer messages (all JSON, all checked before use):
//   host → peer    welcome    { host, state }          on connect, or when asked
//   member → host  propose    { op, proposal }
//   host → all     commit     { commit }
//   host → member  refused    { proposal, error }
//   member → host  want-state                         after a gap in commits
//   anyone → peer  want-drt   { request, timeline }    tier 3: a copy of a timeline
//   peer → asker   drt        { request, part, parts, data } or { request, error }

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JsonValue } from "./bridge-protocol/wire.ts";
import type { BridgeClient } from "./bridge/bridge-client.ts";
import { type Commit, HostLog, MemberLog, type SessionState } from "./sync/host-log.ts";
import { type Fingerprint, newId } from "./sync/media-pool.ts";
import { type BridgeResult, MediaPoolSync } from "./sync/media-pool-sync.ts";
import type { Answer, Conflict } from "./sync/reconcile.ts";
import { type SessionModel, type SessionOp, validateModel } from "./sync/session-model.ts";
import { TimelineSync } from "./sync/timeline-sync.ts";
import type { PeerLink } from "./peer/peer-link.ts";

export interface SessionOptions {
  role: "host" | "member";
  bridge: BridgeClient;
  peers: PeerLink;
  storeDir: string; // per-session state files
  backupsDir: string;
  ask: (conflicts: Conflict[]) => Promise<Map<string, Answer>>;
  confirm: (question: string) => Promise<boolean>;
  fingerprint: (path: string) => Promise<Fingerprint | null>;
  findFile: (file: Fingerprint, dirs: string[]) => Promise<string | null>;
  log: (message: string) => void;
  forceTier?: 1 | 2 | 3;
  userBusy?: () => boolean; // see TimelineSyncOptions
}

type Message = Record<string, JsonValue>;

const DRT_CHUNK = 256 * 1024; // base64 characters per message
const DRT_MAX_PARTS = 200; // ~50 MB
const DRT_TIMEOUT_MS = 30_000;

interface DrtRequest {
  parts: string[];
  resolve: (data: Buffer | null) => void;
  timer: NodeJS.Timeout;
}

// The timeline an operation belongs to, looked up before it is applied.
function timelineOf(op: SessionOp, model: SessionModel): string | undefined {
  if (op.type.startsWith("timeline.")) return op.id;
  if (op.type.startsWith("track.")) return model.timelines.tracks[op.id]?.timeline ?? (op as { timeline?: string }).timeline;
  if (op.type.startsWith("item.")) return model.timelines.items[op.id]?.timeline ?? (op as { timeline?: string }).timeline;
  return undefined;
}

export class Session {
  readonly sync: MediaPoolSync;
  readonly timelines: TimelineSync;
  private readonly options: SessionOptions;
  private readonly host: HostLog | undefined;
  private readonly member = new MemberLog();
  private hostId: string | undefined;
  private saveTimer: NodeJS.Timeout | undefined;
  private readonly hostStore: string;
  private readonly lastAuthor = new Map<string, string>(); // timeline → peer who last changed it
  private readonly drtRequests = new Map<string, DrtRequest>();

  constructor(options: SessionOptions) {
    this.options = options;
    const { bridge, peers, role, log } = options;
    this.hostStore = join(options.storeDir, "host-log.json");
    if (role === "host") this.host = new HostLog(this.loadHost());

    const send = (command: { type: string } & Record<string, JsonValue>) => bridge.send(command) as Promise<BridgeResult>;
    this.sync = new MediaPoolSync({
      me: peers.id,
      send,
      propose: (op, proposal) => this.propose(op, proposal),
      ask: options.ask,
      fingerprint: options.fingerprint,
      findFile: options.findFile,
      backup: () => this.backup(),
      log,
      store: join(options.storeDir, `${role}.json`),
    });
    const sync = this.sync;
    this.timelines = new TimelineSync({
      me: peers.id,
      send,
      propose: (op, proposal) => this.propose(op, proposal),
      ask: options.ask,
      confirm: options.confirm,
      backup: () => this.backup(),
      media: { get ready() { return sync.ready; }, get project() { return sync.projectId; }, collab: (l) => sync.mediaCollab(l), local: (c) => sync.mediaLocal(c) },
      log,
      store: join(options.storeDir, `${role}-timelines.json`),
      ...(options.forceTier ? { forceTier: options.forceTier } : {}),
      swap: (timeline, local) => this.swap(timeline, local),
      ...(options.userBusy ? { userBusy: options.userBusy } : {}),
    });
    if (this.host) this.reset(this.host.model);

    bridge.on("hello", (hello: Message) => log(`bridge connected: ${hello.product} ${hello.version ?? ""}`));
    // A bridge that was already running sent its state before we were
    // listening; ask for it again.
    bridge.on("attached", () => {
      log("bridge connected (already running)");
      void bridge.send({ type: "mp.snapshot" });
    });
    bridge.on("alive", (alive: boolean) => {
      if (!alive) log("Sync paused: start Workspace > Scripts > ResolveCollab in Resolve");
    });
    bridge.on("error", (error: JsonValue) => log(`bridge error: ${JSON.stringify(error)}`));
    bridge.on("event", (event: Message) => this.bridgeEvent(event));
    peers.on("peer", (id: string) => this.peerJoined(id));
    peers.on("peer-left", (id: string) => {
      log(`peer ${id} left`);
      if (id !== this.hostId) return;
      log("Offline: the host is unreachable; your changes will be merged when it's back.");
      // The host gets a new peer ID when it restarts; accept its next welcome.
      // (Until M6 anyone with the invite code is trusted.)
      this.hostId = undefined;
    });
    peers.on("message", (message: JsonValue, from: string) => {
      if (typeof message === "object" && message !== null && !Array.isArray(message)) void this.peerMessage(message, from);
    });
  }

  stop(): void {
    this.sync.stop();
    this.timelines.stop();
    for (const r of this.drtRequests.values()) {
      clearTimeout(r.timer);
      r.resolve(null);
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveHost();
    }
  }

  // --- bridge -------------------------------------------------------------------

  private bridgeEvent(event: Message): void {
    const type = typeof event.type === "string" ? event.type : "";
    if (type.startsWith("mp.")) {
      this.sync.bridgeEvent(event);
      // Timeline clips refer to media pool clips.
      this.timelines.schedule();
    } else if (type.startsWith("tl.")) {
      this.timelines.bridgeEvent(event);
    }
  }

  private async backup(): Promise<boolean> {
    mkdirSync(this.options.backupsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const result = await this.options.bridge.send({ type: "project.backup", path: join(this.options.backupsDir, `backup-${stamp}.drp`) });
    if (result.ok) this.options.log(`backup saved: ${result.path}`);
    return result.ok;
  }

  // --- ordering -----------------------------------------------------------------

  private propose(op: SessionOp, proposal: string): void {
    if (this.host) {
      this.commitLocally(op, this.options.peers.id, proposal);
    } else if (this.hostId) {
      this.options.peers.sendTo(this.hostId, { type: "propose", op: op as unknown as JsonValue, proposal });
    }
    // No host yet: the proposal expires and is made again after the welcome.
  }

  private commitLocally(op: unknown, author: string, proposal: string | undefined): void {
    const host = this.host!;
    const timeline = typeof (op as SessionOp)?.type === "string" ? timelineOf(op as SessionOp, host.model) : undefined;
    const result = host.propose(op, author, proposal);
    if ("error" in result) {
      if (author === this.options.peers.id) this.refused(proposal ?? "", result.error);
      else this.options.peers.sendTo(author, { type: "refused", proposal: proposal ?? "", error: result.error });
      return;
    }
    if (timeline) this.lastAuthor.set(timeline, author);
    this.options.peers.send({ type: "commit", commit: result as unknown as JsonValue });
    this.changed(host.model, result);
    this.scheduleHostSave();
  }

  private reset(model: SessionModel): void {
    this.sync.sessionReset(model.pool);
    this.timelines.sessionReset(model.timelines);
  }

  private changed(model: SessionModel, commit: Commit): void {
    this.sync.sessionChanged(model.pool, commit);
    this.timelines.sessionChanged(model.timelines, commit);
  }

  private refused(proposal: string, error: string): void {
    this.sync.refused(proposal, error);
    this.timelines.refused(proposal);
  }

  private peerJoined(id: string): void {
    this.options.log(`peer ${id} connected`);
    if (this.host) this.options.peers.sendTo(id, { type: "welcome", host: this.options.peers.id, state: this.host.state() as unknown as JsonValue });
  }

  private async peerMessage(message: Message, from: string): Promise<void> {
    switch (message.type) {
      case "propose":
        if (this.host && typeof message.proposal === "string") this.commitLocally(message.op, from, message.proposal);
        return;
      case "want-state":
        if (this.host) this.peerJoined(from);
        return;
      case "welcome": {
        if (this.host || (this.hostId && this.hostId !== from)) return;
        const state = message.state as unknown as SessionState;
        const model = validateModel(state?.model);
        if (!Number.isSafeInteger(state?.seq) || !model) {
          this.options.log(`ignored a malformed session state from ${from}`);
          return;
        }
        if (!this.hostId) this.options.log(`joined the session hosted by ${from}`);
        this.hostId = from;
        this.member.reset({ seq: state.seq, model });
        this.reset(this.member.model);
        return;
      }
      case "commit": {
        if (from !== this.hostId) return;
        const commit = message.commit as unknown as Commit;
        if (typeof commit?.seq !== "number" || typeof commit.op?.type !== "string") return;
        const timeline = timelineOf(commit.op, this.member.model);
        const outcome = this.member.receive(commit);
        if (outcome === "applied") {
          if (timeline && typeof commit.author === "string") this.lastAuthor.set(timeline, commit.author);
          this.changed(this.member.model, commit);
        } else if (outcome === "gap") {
          this.options.peers.sendTo(from, { type: "want-state" });
        }
        return;
      }
      case "refused":
        if (from === this.hostId && typeof message.proposal === "string") this.refused(message.proposal, String(message.error));
        return;
      case "want-drt":
        if (typeof message.request === "string" && typeof message.timeline === "string") await this.sendDrt(message.request, message.timeline, from);
        return;
      case "drt":
        this.receiveDrt(message);
        return;
    }
  }

  // --- tier 3: timeline swap (SPEC §20.6) ----------------------------------------

  private isId = (v: string) => /^[0-9a-f]{32}$/.test(v);

  // Asks the peer who last changed the timeline (so has it open and up to
  // date) for a .drt copy, and has the bridge swap it in.
  private async swap(timeline: string, local: string): Promise<boolean> {
    const peer = this.lastAuthor.get(timeline);
    if (!peer || peer === this.options.peers.id) {
      this.options.log("no other PC has a newer copy of this timeline to swap in");
      return false;
    }
    const request = newId();
    const data = await new Promise<Buffer | null>((resolve) => {
      const timer = setTimeout(() => {
        this.drtRequests.delete(request);
        resolve(null);
      }, DRT_TIMEOUT_MS);
      this.drtRequests.set(request, { parts: [], resolve, timer });
      this.options.peers.sendTo(peer, { type: "want-drt", request, timeline });
    });
    if (!data) {
      this.options.log("couldn't get a copy of the timeline from the other PC");
      return false;
    }
    const path = join(this.options.storeDir, `swap-${timeline}.drt`);
    mkdirSync(this.options.storeDir, { recursive: true });
    writeFileSync(path, data);
    const name = this.host?.model.timelines.timelines[timeline]?.name ?? this.member.model.timelines.timelines[timeline]?.name ?? "";
    const result = await this.options.bridge.send({ type: "tl.swap", id: local, path, rcId: timeline, name });
    rmSync(path, { force: true });
    if (!result.ok) this.options.log(`Resolve couldn't swap in the timeline (${result.error})`);
    return result.ok;
  }

  private async sendDrt(request: string, timeline: string, to: string): Promise<void> {
    const local = this.isId(timeline) ? this.timelines.localTimelineOf(timeline) : undefined;
    if (!local) {
      this.options.peers.sendTo(to, { type: "drt", request, error: "no such timeline here" });
      return;
    }
    const path = join(this.options.storeDir, `export-${timeline}.drt`);
    mkdirSync(this.options.storeDir, { recursive: true });
    const result = await this.options.bridge.send({ type: "tl.export", id: local, path });
    if (!result.ok || !existsSync(path)) {
      this.options.peers.sendTo(to, { type: "drt", request, error: String(result.error ?? "export failed") });
      return;
    }
    const data = readFileSync(path).toString("base64");
    rmSync(path, { force: true });
    const parts = Math.max(1, Math.ceil(data.length / DRT_CHUNK));
    if (parts > DRT_MAX_PARTS) {
      this.options.peers.sendTo(to, { type: "drt", request, error: "timeline too large" });
      return;
    }
    for (let i = 0; i < parts; i++) {
      this.options.peers.sendTo(to, { type: "drt", request, part: i + 1, parts, data: data.slice(i * DRT_CHUNK, (i + 1) * DRT_CHUNK) });
    }
  }

  private receiveDrt(message: Message): void {
    const r = typeof message.request === "string" ? this.drtRequests.get(message.request) : undefined;
    if (!r) return;
    const finish = (data: Buffer | null) => {
      clearTimeout(r.timer);
      this.drtRequests.delete(message.request as string);
      r.resolve(data);
    };
    if (typeof message.error === "string") return finish(null);
    const { part, parts, data } = message;
    if (!Number.isInteger(part) || !Number.isInteger(parts) || (parts as number) < 1 || (parts as number) > DRT_MAX_PARTS || (part as number) < 1 || (part as number) > (parts as number)) return finish(null);
    if (typeof data !== "string" || data.length > DRT_CHUNK || !/^[A-Za-z0-9+/=]*$/.test(data)) return finish(null);
    r.parts[(part as number) - 1] = data;
    if (r.parts.filter((p) => p !== undefined).length === parts) finish(Buffer.from(r.parts.join(""), "base64"));
  }

  // --- host state ---------------------------------------------------------------

  private scheduleHostSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.saveHost();
    }, 500);
  }

  // The saved log, checked like a state from a peer (and accepting the M3
  // format, which held the media pool alone).
  private loadHost(): SessionState | undefined {
    if (!existsSync(this.hostStore)) return undefined;
    const saved = JSON.parse(readFileSync(this.hostStore, "utf8")) as SessionState;
    const model = validateModel(saved?.model);
    if (!Number.isSafeInteger(saved?.seq) || !model) throw new Error(`unreadable session log: ${this.hostStore}`);
    return { seq: saved.seq, model };
  }

  private saveHost(): void {
    if (!this.host) return;
    mkdirSync(dirname(this.hostStore), { recursive: true });
    writeFileSync(`${this.hostStore}.tmp`, JSON.stringify(this.host.state()));
    renameSync(`${this.hostStore}.tmp`, this.hostStore);
  }
}

