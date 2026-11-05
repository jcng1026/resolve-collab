// One ResolveCollab session on this PC (SPEC §19.3, §20, §22): connects the
// bridge, the peers, and the media pool and timeline syncs. The host lets
// people in and orders every change; members propose to the host and apply
// its commits in order.
//
// Peer messages (all JSON, all checked before use). The host sends session
// data only to members it has let in:
//   member → host  join       { name, code }            on connect, again until answered
//   host → member  waiting                              the host is being asked
//   host → member  refused-join { blocked, old-code? }
//   host → member  welcome    { session, host, state }  once let in, or when asked
//   member → host  propose    { op, proposal, base }    base: the seq it was made on (§23.1)
//   host → members commit     { commit }
//   host → member  refused    { proposal, error }
//   member → host  want-state                         after a gap in commits
//   host → members closing                             the host closed its companion
//   host → members ended                               ended for good
//   host → member  removed                             this PC was removed
//   anyone → peer  want-drt   { request, timeline }    tier 3: a copy of a timeline
//   peer → asker   drt        { request, part, parts, data } or { request, error }

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JsonValue } from "./bridge-protocol/wire.ts";
import { buildWarning } from "./bridge/bridge-build.ts";
import type { BridgeClient } from "./bridge/bridge-client.ts";
import type { PeerLink } from "./peer/peer-link.ts";
import { type SessionRecord, findHostSession, isSessionId, loadRecord, newRecord, saveRecord, sessionDir } from "./session-record.ts";
import { type Commit, HostLog, MemberLog, type SessionState } from "./sync/host-log.ts";
import { type Fingerprint, newId } from "./sync/media-pool.ts";
import { type BridgeResult, MediaPoolSync } from "./sync/media-pool-sync.ts";
import type { Answer, Conflict } from "./sync/reconcile.ts";
import { type SessionModel, type SessionOp, validateModel } from "./sync/session-model.ts";
import { TimelineSync } from "./sync/timeline-sync.ts";

export type Approval = "yes" | "no" | "block";

export interface SessionOptions {
  role: "host" | "member";
  bridge: BridgeClient;
  peers: PeerLink;
  storeDir: string; // every session's state, by session ID (SPEC §22.1)
  backupsDir: string;
  name: string; // this person's name
  // Host: reopen the session the project open in Resolve belongs to, rather
  // than start a new one (SPEC §22.2).
  resume?: boolean;
  // Host: is this PC let in? Asked once per PC per session (SPEC §22.3).
  approve?: (name: string, peer: string) => Promise<Approval>;
  // Member: how long to wait for a host whose connection dropped (SPEC §22.4).
  graceMs?: number;
  // The session is over on this PC: closed, ended, removed, or not found.
  onEnded?: (why: string) => void;
  ask: (conflicts: Conflict[]) => Promise<Map<string, Answer>>;
  confirm: (question: string) => Promise<boolean>;
  fingerprint: (path: string) => Promise<Fingerprint | null>;
  findFile: (file: Fingerprint, dirs: string[]) => Promise<string | null>;
  log: (message: string) => void;
  forceTier?: 1 | 2 | 3;
  userBusy?: () => boolean; // see TimelineSyncOptions
  // The build of the bridge this companion was installed with: a bridge in
  // Resolve reporting another one is out of date (bridge-build.ts).
  bridgeBuild?: string;
}

type Message = Record<string, JsonValue>;

const DRT_CHUNK = 256 * 1024; // base64 characters per message
const DRT_MAX_PARTS = 200; // ~50 MB
const DRT_TIMEOUT_MS = 30_000;
const GRACE_MS = 10 * 60_000;
const JOIN_AGAIN_MS = 3000;

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

const cleanName = (v: JsonValue | undefined) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, "").slice(0, 40).trim() : "") || "someone";

export class Session {
  // Made once the session is known: at once for a new host session, when the
  // open project is reported for a resumed one, when let in for a member.
  sync!: MediaPoolSync;
  timelines!: TimelineSync;
  record: SessionRecord | undefined;
  private readonly options: SessionOptions;
  private host: HostLog | undefined;
  private readonly member = new MemberLog();
  private hostId: string | undefined;
  private saveTimer: NodeJS.Timeout | undefined;
  private hostStore = "";
  private readonly lastAuthor = new Map<string, string>(); // timeline → peer who last changed it
  private readonly drtRequests = new Map<string, DrtRequest>();
  private project: { id: string; name: string } | undefined; // open in Resolve, as last reported
  private readonly connected = new Set<string>();
  // Host: members let in and connected now (short ID → name), and PCs being asked about.
  private readonly admitted = new Map<string, string>();
  private readonly asking = new Set<string>();
  private approvals: Promise<void> = Promise.resolve();
  // Member.
  private joining = false;
  private joinTimer: NodeJS.Timeout | undefined;
  private graceTimer: NodeJS.Timeout | undefined;
  private told = new Set<string>();
  private freshProject = false;
  private over = false;

  constructor(options: SessionOptions) {
    this.options = options;
    const { bridge, peers, role, log } = options;
    if (role === "host" && !options.resume) {
      const record = newRecord(newId(), "host", peers.publicKey, options.name);
      saveRecord(options.storeDir, record);
      this.begin(record);
    }

    bridge.on("hello", (hello: Message) => log(`bridge connected: ${hello.product} ${hello.version ?? ""}`));
    let warnedBuild: string | undefined;
    bridge.on("build", (build: string | undefined) => {
      const warning = options.bridgeBuild && buildWarning(options.bridgeBuild, build);
      if (warning && warnedBuild !== String(build)) log(warning);
      warnedBuild = String(build);
    });
    // A bridge that was already running sent its state before we were
    // listening; ask for it again.
    bridge.on("attached", () => {
      log("bridge connected (already running)");
      void bridge.send({ type: "mp.snapshot" });
    });
    let paused = false;
    bridge.on("alive", (alive: boolean) => {
      if (!alive) log("Sync paused: Resolve hasn't answered for 15 s. If ResolveCollab stopped, start Workspace > Scripts > ResolveCollab in Resolve");
      else if (paused) log("Resolve is answering again: sync resumes");
      paused = !alive;
    });
    bridge.on("error", (error: JsonValue) => log(`bridge error: ${JSON.stringify(error)}`));
    bridge.on("event", (event: Message) => this.bridgeEvent(event));
    peers.on("peer", (id: string) => this.peerJoined(id));
    peers.on("peer-left", (id: string) => this.peerLeft(id));
    peers.on("message", (message: JsonValue, from: string) => {
      if (typeof message === "object" && message !== null && !Array.isArray(message)) void this.peerMessage(message, from);
    });
  }

  get begun(): boolean {
    return this.record !== undefined && this.sync !== undefined;
  }

  // The syncs and stores for this session.
  private begin(record: SessionRecord): void {
    this.record = record;
    const { bridge, peers, role, log } = this.options;
    const dir = sessionDir(this.options.storeDir, record.id);
    this.hostStore = join(dir, "host-log.json");
    if (role === "host") this.host = new HostLog(this.loadHost());
    const send = (command: { type: string } & Record<string, JsonValue>) => bridge.send(command) as Promise<BridgeResult>;
    this.sync = new MediaPoolSync({
      me: peers.id,
      send,
      propose: (op, proposal, base) => this.propose(op, proposal, base),
      seq: () => this.seq(),
      ask: this.options.ask,
      fingerprint: this.options.fingerprint,
      findFile: this.options.findFile,
      backup: () => this.backup(),
      backupNeeded: () => !this.freshProject,
      log,
      store: join(dir, `${role}.json`),
    });
    if (record.project) this.sync.expectProject(record.project, record.projectName);
    const sync = this.sync;
    this.timelines = new TimelineSync({
      me: peers.id,
      send,
      propose: (op, proposal, base) => this.propose(op, proposal, base),
      seq: () => this.seq(),
      ask: this.options.ask,
      confirm: this.options.confirm,
      backup: () => this.backup(),
      backupNeeded: () => !this.freshProject,
      media: { get ready() { return sync.ready; }, get project() { return sync.projectId; }, collab: (l) => sync.mediaCollab(l), local: (c) => sync.mediaLocal(c) },
      log,
      store: join(dir, `${role}-timelines.json`),
      ...(this.options.forceTier ? { forceTier: this.options.forceTier } : {}),
      swap: (timeline, local) => this.swap(timeline, local),
      ...(this.options.userBusy ? { userBusy: this.options.userBusy } : {}),
    });
    if (this.host) this.reset(this.host.model);
  }

  stop(): void {
    this.over = true;
    clearInterval(this.joinTimer);
    clearTimeout(this.graceTimer);
    if (this.begun) {
      this.sync.stop();
      this.timelines.stop();
    }
    for (const r of this.drtRequests.values()) {
      clearTimeout(r.timer);
      r.resolve(null);
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveHost();
    }
  }

  // Closing the companion: the host tells members the session is closed
  // (SPEC §22.4), then waits a moment for that to go out.
  async close(): Promise<void> {
    if (this.host) {
      this.toMembers({ type: "closing" });
      await new Promise((r) => setTimeout(r, 400));
    }
    this.stop();
  }

  private end(why: string): void {
    if (this.over) return;
    this.over = true;
    this.options.log(why);
    this.options.onEnded?.(why);
  }

  // --- bridge -------------------------------------------------------------------

  private bridgeEvent(event: Message): void {
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "mp.reset") {
      const p = event.project as { id?: unknown; name?: unknown } | null;
      this.project = p && typeof p.id === "string" ? { id: p.id, name: String(p.name ?? "") } : undefined;
      this.projectKnown();
    }
    if (!this.begun) return;
    if (type.startsWith("mp.")) {
      this.sync.bridgeEvent(event);
      // Timeline clips refer to media pool clips.
      this.timelines.schedule();
    } else if (type.startsWith("tl.")) {
      this.timelines.bridgeEvent(event);
    }
  }

  // The host learns which project its session is about: a new session takes
  // the open one; `--resume` looks up the session that project belongs to.
  private projectKnown(): void {
    if (this.options.role !== "host" || !this.project) return;
    if (this.record && !this.record.project) {
      Object.assign(this.record, { project: this.project.id, projectName: this.project.name, updated: Date.now() });
      saveRecord(this.options.storeDir, this.record);
    }
    if (this.record || !this.options.resume) return;
    const found = findHostSession(this.options.storeDir, this.project.id);
    if (!found) {
      this.end(`"${this.project.name}" isn't a session you host (or it was ended for good). Run host to start a new one.`);
      return;
    }
    found.updated = Date.now();
    saveRecord(this.options.storeDir, found);
    this.options.log(`resuming the session for "${found.projectName}"`);
    this.begin(found);
    // Everything again, now that the syncs listen.
    void this.options.bridge.send({ type: "mp.snapshot" });
  }

  private async backup(): Promise<boolean> {
    mkdirSync(this.options.backupsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const result = await this.options.bridge.send({ type: "project.backup", path: join(this.options.backupsDir, `backup-${stamp}.drp`) });
    if (result.ok) this.options.log(`backup saved: ${result.path}`);
    return result.ok;
  }

  // --- ordering -----------------------------------------------------------------

  // The seq of the session state this PC has (SPEC §23.1).
  private seq(): number {
    return this.host ? this.host.seq : this.member.seq;
  }

  private propose(op: SessionOp, proposal: string, base?: number): void {
    this.freshProject = false; // a change of this PC's own: from now on, worth a backup
    if (this.host) {
      this.commitLocally(op, this.options.peers.id, proposal, base);
    } else if (this.hostId) {
      this.options.peers.sendTo(this.hostId, { type: "propose", op: op as unknown as JsonValue, proposal, ...(base !== undefined ? { base } : {}) });
    }
    // No host yet: the proposal expires and is made again after the welcome.
  }

  private commitLocally(op: unknown, author: string, proposal: string | undefined, base?: number): void {
    const host = this.host!;
    const timeline = typeof (op as SessionOp)?.type === "string" ? timelineOf(op as SessionOp, host.model) : undefined;
    // A base from the future (or not a number) is ignored: no race check.
    const known = typeof base === "number" && Number.isSafeInteger(base) && base >= 0 && base <= host.seq ? base : undefined;
    const name = author === this.options.peers.id ? this.options.name : this.admitted.get(author);
    const result = host.propose(op, author, proposal, known, name);
    if ("error" in result) {
      if (author === this.options.peers.id) this.refused(proposal ?? "", result.error);
      else this.options.peers.sendTo(author, { type: "refused", proposal: proposal ?? "", error: result.error });
      return;
    }
    if (timeline) this.lastAuthor.set(timeline, author);
    this.toMembers({ type: "commit", commit: result as unknown as JsonValue });
    this.changed(host.model, result);
    this.scheduleHostSave();
  }

  // Only members let in hear about the session.
  private toMembers(message: JsonValue): void {
    for (const id of this.admitted.keys()) this.options.peers.sendTo(id, message);
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

  // --- peers ----------------------------------------------------------------------

  // The code says which opening of the session this PC was invited to (§22.1).
  private joinMessage(): Message {
    return { type: "join", name: this.options.name, code: this.options.peers.code };
  }

  private peerJoined(id: string): void {
    this.connected.add(id);
    if (this.options.role === "member") {
      this.options.peers.sendTo(id, this.joinMessage());
      // Asked again until someone answers as the host (it may still be starting).
      if (!this.joinTimer && !this.hostId) {
        this.joinTimer = setInterval(() => {
          if (this.hostId || this.over) return;
          for (const peer of this.connected) this.options.peers.sendTo(peer, this.joinMessage());
        }, JOIN_AGAIN_MS);
      }
    }
  }

  private peerLeft(id: string): void {
    this.connected.delete(id);
    const { log } = this.options;
    if (this.host) {
      const name = this.admitted.get(id);
      if (name !== undefined) {
        this.admitted.delete(id);
        log(`${name} (${id}) left`);
      }
      return;
    }
    if (id !== this.hostId) return;
    this.hostId = undefined;
    if (this.over) return;
    log("Offline: the host is unreachable; your changes will be merged when it's back.");
    clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => {
      this.end(`The host didn't come back within ${Math.round((this.options.graceMs ?? GRACE_MS) / 60_000)} minutes, so the session ended here. `
        + "Your changes are kept on this PC and merged when you rejoin.");
    }, this.options.graceMs ?? GRACE_MS);
  }

  private async peerMessage(message: Message, from: string): Promise<void> {
    if (this.over) return;
    if (this.host) return this.hostMessage(message, from);
    return this.memberMessage(message, from);
  }

  // --- host side ------------------------------------------------------------------

  private async hostMessage(message: Message, from: string): Promise<void> {
    const host = this.host!;
    if (message.type === "join") return this.joinRequest(cleanName(message.name), from, message.code);
    if (!this.admitted.has(from)) return; // nothing from PCs not let in
    switch (message.type) {
      case "propose":
        if (typeof message.proposal === "string") this.commitLocally(message.op, from, message.proposal, message.base as number | undefined);
        return;
      case "want-state":
        this.options.peers.sendTo(from, this.welcome(host));
        return;
      case "want-drt":
        if (typeof message.request === "string" && typeof message.timeline === "string") await this.sendDrt(message.request, message.timeline, from);
        return;
      case "drt":
        this.receiveDrt(message);
        return;
    }
  }

  private welcome(host: HostLog): Message {
    const r = this.record!;
    return {
      type: "welcome", host: this.options.peers.id, state: host.state() as unknown as JsonValue,
      session: { id: r.id, hostName: r.hostName, projectName: r.projectName },
    };
  }

  private joinRequest(name: string, from: string, code: JsonValue | undefined): void {
    const record = this.record;
    const key = this.options.peers.keyOf(from);
    // Not before the host knows its project: the joiner's new project is named after it (they ask again).
    if (!record || !record.project || !key || !this.host || this.admitted.has(from) || this.asking.has(from)) return;
    // Only today's code lets anyone in: an old one can still lead here while
    // its announcement lingers on the DHT, and this PC's key is lasting (§22.1).
    if (code !== this.options.peers.code) {
      this.options.peers.sendTo(from, { type: "refused-join", blocked: false, "old-code": true });
      if (!this.told.has(`old-code:${key}`)) this.options.log(`${name} (${from}) used an invite code from an earlier opening, and wasn't let in`);
      this.told.add(`old-code:${key}`);
      return;
    }
    if (record.blocked.some((m) => m.key === key)) {
      this.options.peers.sendTo(from, { type: "refused-join", blocked: true });
      return;
    }
    const known = record.members.find((m) => m.key === key);
    if (known) {
      if (known.name !== name) {
        known.name = name;
        saveRecord(this.options.storeDir, record);
      }
      this.admit(from, name, "rejoined");
      return;
    }
    // One question at a time.
    this.asking.add(from);
    this.options.peers.sendTo(from, { type: "waiting", host: record.hostName });
    this.approvals = this.approvals.then(async () => {
      const answer = this.options.approve ? await this.options.approve(name, from) : "no";
      this.asking.delete(from);
      if (this.over) return;
      if (answer === "yes") {
        record.members.push({ key, name });
        saveRecord(this.options.storeDir, record);
        this.admit(from, name, "joined");
      } else {
        if (answer === "block") {
          record.blocked.push({ key, name });
          saveRecord(this.options.storeDir, record);
        }
        this.options.peers.sendTo(from, { type: "refused-join", blocked: answer === "block" });
        this.options.log(answer === "block" ? `${name} (${from}) is blocked from this session` : `${name} (${from}) wasn't let in`);
      }
    });
  }

  private admit(id: string, name: string, how: string): void {
    this.admitted.set(id, name);
    this.options.log(`${name} (${id}) ${how}`);
    this.options.peers.sendTo(id, this.welcome(this.host!));
  }

  // Ends the session for good (SPEC §22.2).
  endForGood(): void {
    if (!this.host || !this.record) return;
    this.record.ended = true;
    saveRecord(this.options.storeDir, this.record);
    this.toMembers({ type: "ended" });
    setTimeout(() => this.end("The session is ended for good; it can't be resumed."), 400);
  }

  // `members` (SPEC §22.5): who's in, and who's blocked.
  memberList(): string[] {
    const r = this.record;
    if (!this.host || !r) return [];
    const online = new Set([...this.admitted.keys()].map((id) => this.options.peers.keyOf(id)));
    return [
      ...r.members.map((m) => `${m.name} (${m.key.slice(0, 8)})${online.has(m.key) ? " online" : ""}`),
      ...r.blocked.map((m) => `${m.name} (${m.key.slice(0, 8)}) blocked`),
    ];
  }

  private find(list: { key: string; name: string }[], query: string) {
    const q = query.trim().toLowerCase();
    const hits = list.filter((m) => m.name.toLowerCase() === q || (q.length >= 4 && m.key.startsWith(q)));
    return hits.length === 1 ? hits[0] : undefined;
  }

  // `remove <name or short ID>`: disconnects that PC and blocks it.
  remove(query: string): string {
    const r = this.record;
    if (!this.host || !r) return "only the host can remove someone";
    const m = this.find(r.members, query);
    if (!m) return `no single member matches "${query}" (members lists them)`;
    r.members = r.members.filter((x) => x.key !== m.key);
    r.blocked.push(m);
    saveRecord(this.options.storeDir, r);
    const id = m.key.slice(0, 8);
    if (this.admitted.has(id)) {
      this.options.peers.sendTo(id, { type: "removed" });
      this.admitted.delete(id);
      setTimeout(() => this.options.peers.disconnect(id), 400);
    }
    return `${m.name} (${id}) removed and blocked`;
  }

  // `unblock <name or short ID>`: lets a blocked PC ask again.
  unblock(query: string): string {
    const r = this.record;
    if (!this.host || !r) return "only the host can unblock someone";
    const m = this.find(r.blocked, query);
    if (!m) return `no single blocked PC matches "${query}"`;
    r.blocked = r.blocked.filter((x) => x.key !== m.key);
    saveRecord(this.options.storeDir, r);
    return `${m.name} (${m.key.slice(0, 8)}) can ask to join again`;
  }

  // --- member side ----------------------------------------------------------------

  private async memberMessage(message: Message, from: string): Promise<void> {
    const { log } = this.options;
    switch (message.type) {
      case "waiting":
        if (!this.told.has("waiting")) log(`waiting for ${cleanName(message.host)} to let you in`);
        this.told.add("waiting");
        return;
      case "refused-join":
        if (this.hostId) return;
        this.end(message["old-code"] === true
          ? "That invite code is from an earlier opening of the session. Ask the host for the new one."
          : message.blocked === true ? "The host has blocked this PC from the session." : "The host didn't let you in.");
        return;
      case "welcome":
        await this.welcomed(message, from);
        return;
    }
    if (!this.begun || from !== this.hostId) return; // the rest only from the host
    switch (message.type) {
      case "commit": {
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
        if (typeof message.proposal === "string") this.refused(message.proposal, String(message.error));
        return;
      case "closing":
        this.end(`${this.record!.hostName} closed the session. Changes you make now stay on this PC; rejoin with the code ${this.record!.hostName} sends next time.`);
        return;
      case "ended":
      case "removed": {
        const record = this.record!;
        record.ended = true;
        saveRecord(this.options.storeDir, record);
        this.end(message.type === "ended" ? `${record.hostName} ended the session for good.` : `${record.hostName} removed this PC from the session.`);
        return;
      }
      case "want-drt":
        if (typeof message.request === "string" && typeof message.timeline === "string") await this.sendDrt(message.request, message.timeline, from);
        return;
      case "drt":
        this.receiveDrt(message);
        return;
    }
  }

  private async welcomed(message: Message, from: string): Promise<void> {
    const { log } = this.options;
    const key = this.options.peers.keyOf(from);
    const s = message.session as { id?: unknown; hostName?: unknown; projectName?: unknown } | undefined;
    const state = message.state as unknown as SessionState;
    const model = validateModel(state?.model);
    if (!key || !s || !isSessionId(s.id) || !Number.isSafeInteger(state?.seq) || !model) {
      log(`ignored a malformed session state from ${from}`);
      return;
    }
    // The host is the one this PC was let in by before (SPEC §22.3).
    if (this.record && (this.record.id !== s.id || this.record.hostKey !== key)) return;
    let said = false;
    if (!this.record) {
      if (this.joining) return;
      this.joining = true;
      const known = loadRecord(this.options.storeDir, s.id);
      if (known && known.hostKey !== key) {
        this.joining = false;
        if (!this.told.has(`impostor:${key}`)) log(`ignored ${from}: it answered as the host of this session, but it isn't the PC that hosts it`);
        this.told.add(`impostor:${key}`);
        return;
      }
      // Marked over here when this PC was removed. A session ended for good is
      // never hosted again, so a welcome from its host means this PC was
      // unblocked and let in again: back into the project from before (§22.5).
      const letBack = known?.ended === true;
      if (known) known.ended = false;
      const record = known ?? (await this.firstJoin(s.id, key, cleanName(s.hostName as JsonValue), String(s.projectName ?? "")));
      this.joining = false;
      if (!record) return;
      record.updated = Date.now();
      saveRecord(this.options.storeDir, record);
      this.begin(record);
      if (known) {
        log(`${letBack ? "let back in: " : ""}rejoined the session for "${record.projectName}"`);
        said = true; // no "joined" line as well
      }
      // Everything again, now that the syncs listen.
      void this.options.bridge.send({ type: "mp.snapshot" });
    }
    clearTimeout(this.graceTimer);
    clearInterval(this.joinTimer);
    this.joinTimer = undefined;
    if (!this.hostId && !said) log(`joined the session hosted by ${this.record!.hostName} (${from})`);
    this.hostId = from;
    this.member.reset({ seq: state.seq, model });
    this.reset(this.member.model);
  }

  // A first join: a new project, filled by sync (SPEC §22.3). The project open
  // until now is left as it was.
  private async firstJoin(id: string, hostKey: string, hostName: string, projectName: string): Promise<SessionRecord | undefined> {
    const name = `${projectName || "Project"} (collab · hosted by ${hostName})`.slice(0, 200);
    const result = await this.options.bridge.send({ type: "project.create", name });
    if (!result.ok || typeof result.id !== "string") {
      this.end(`Resolve couldn't make a new project for the session (${result.error ?? "no project"}).`);
      return undefined;
    }
    const record = newRecord(id, "member", hostKey, hostName);
    record.project = result.id;
    record.projectName = String(result.name ?? name);
    this.options.log(`made the project "${record.projectName}" for this session`);
    // Only the session's content will be in it until this PC changes something:
    // no backups of it before that (they'd protect nothing).
    this.freshProject = true;
    return record;
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
    const dir = sessionDir(this.options.storeDir, this.record!.id);
    const path = join(dir, `swap-${timeline}.drt`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, data);
    const name = this.host?.model.timelines.timelines[timeline]?.name ?? this.member.model.timelines.timelines[timeline]?.name ?? "";
    const result = await this.options.bridge.send({ type: "tl.swap", id: local, path, rcId: timeline, name });
    rmSync(path, { force: true });
    if (!result.ok) this.options.log(`Resolve couldn't swap in the timeline (${result.error})`);
    return result.ok;
  }

  private async sendDrt(request: string, timeline: string, to: string): Promise<void> {
    const local = this.begun && this.isId(timeline) ? this.timelines.localTimelineOf(timeline) : undefined;
    if (!local) {
      this.options.peers.sendTo(to, { type: "drt", request, error: "no such timeline here" });
      return;
    }
    const dir = sessionDir(this.options.storeDir, this.record!.id);
    const path = join(dir, `export-${timeline}.drt`);
    mkdirSync(dir, { recursive: true });
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
