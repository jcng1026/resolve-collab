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
import { MediaManager } from "./media/manager.ts";
import { type Spot, type Track as ScreenTrack, cleanSpot } from "./layout.ts";
import { Activity, type Line, MAX_LINES, cleanLine, describe as describeChange } from "./activity.ts";
import { Notices, fieldName } from "./notices.ts";
import type { PeerLink } from "./peer/peer-link.ts";
import { type Person, type Presence, cleanPeople, cleanPresence, colorAt } from "./presence.ts";
import { type SessionRecord, findHostSession, isSessionId, loadRecord, newRecord, saveRecord, sessionDir } from "./session-record.ts";
import { type Commit, HostLog, MemberLog, type SessionState } from "./sync/host-log.ts";
import { type Fingerprint, newId } from "./sync/media-pool.ts";
import { type BridgeResult, MediaPoolSync } from "./sync/media-pool-sync.ts";
import { type Answer, type Conflict, EXISTS, fieldKey, mediaPoolDomain } from "./sync/reconcile.ts";
import { type SessionModel, type SessionOp, validateModel } from "./sync/session-model.ts";
import { timelineDomain } from "./sync/timeline-reconcile.ts";
import { TimelineSync } from "./sync/timeline-sync.ts";
import { History, type Step, followsClipColor, inverseOf } from "./undo.ts";

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
  // The people or anyone's presence changed (SPEC §8); read people().
  onPeople?: () => void;
  // A chat or change line is new or updated (SPEC §24.3); read lines().
  onLine?: (line: Line) => void;
  // Someone's ghost cursor moved or went (SPEC §24.6); read pointers().
  onPointers?: () => void;
  // Missing media changed (SPEC §25); read media.
  onMedia?: () => void;
  // Where this PC keeps the proxies it makes for others (SPEC §25.3).
  proxiesDir?: string;
  // Something only this PC should show in its history: the host unreachable or back (SPEC §24.5).
  onNote?: (text: string, tone?: "good" | "bad") => void;
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
  // This app's version, compared with the others' (SPEC §26.1).
  version?: string;
}

type Message = Record<string, JsonValue>;

type Purpose = "edit" | "undo" | "redo";
const POOL_KINDS = ["bin", "clip", "poolmarker"];

// An operation's fields as the syncs key them: "clip:<id>:color", "clip:<id>:meta:Scene", "item:<id>:prop:ZoomX".
function fieldKeysOf(op: SessionOp): string[] {
  const o = op as unknown as Record<string, unknown>;
  const kind = op.type.slice(0, op.type.indexOf("."));
  const id = String(o.id);
  const keys: string[] = [];
  for (const [field, value] of Object.entries(o)) {
    if (field === "type" || field === "id") continue;
    if ((field === "meta" || field === "props") && value && typeof value === "object" && !Array.isArray(value)) {
      for (const k of Object.keys(value)) keys.push(fieldKey(kind, id, `${field === "meta" ? "meta" : "prop"}:${k}`));
    } else {
      keys.push(fieldKey(kind, id, field));
    }
  }
  return keys;
}

const DRT_CHUNK = 256 * 1024; // base64 characters per message
const DRT_MAX_PARTS = 200; // ~50 MB
const DRT_TIMEOUT_MS = 30_000;
const GRACE_MS = 10 * 60_000;
export const IDLE_MS = 5 * 60_000;
const POINTER_MS = 33; // ghost cursors: at most 30 positions a second (SPEC §24.6)
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
  private readonly versionOf = new Map<string, string>(); // a joining PC's app version, "" when it didn't say
  private readonly asking = new Set<string>();
  private approvals: Promise<void> = Promise.resolve();
  // Member.
  private joining = false;
  private joinTimer: NodeJS.Timeout | undefined;
  private graceTimer: NodeJS.Timeout | undefined;
  private told = new Set<string>();
  private freshProject = false;
  // Where everyone is (SPEC §8), by peer ID; a member's people list comes from the host.
  private readonly presenceOf = new Map<string, Presence>();
  private ownPresence: Presence | undefined;
  // When each person last did something (SPEC §24.5: idle after IDLE_MS).
  private readonly lastActive = new Map<string, number>();
  private readonly startedAt = Date.now();
  private lostHost = false;
  // Ghost cursors (SPEC §24.6): where each person's pointer is in their Resolve window, 0–1.
  media: MediaManager | undefined;
  private readonly pointerOf = new Map<string, { x: number; y: number; spot?: Spot }>();
  private pointerSent = 0;
  private pointerNext: { x: number; y: number; spot?: Spot } | null | undefined;
  private pointerTimer: NodeJS.Timeout | undefined;
  // Follow (SPEC §8, §24.3): whose page, timeline and playhead this PC moves with.
  private followed: string | undefined;
  private going = false;
  private goNext: Record<string, JsonValue> | undefined;
  private hostPeople: Person[] = [];
  // Chat and changes (SPEC §24.3): kept by the host, a copy on each member.
  private activity = new Activity();
  private activityStore = "";
  private missedCommits = false; // commits came while joining (SPEC §22.3)
  // Notices to act on with a command (SPEC §23.1, §23.3).
  readonly notices = new Notices();
  // Who last changed each field, as the syncs key them ("clip:<id>:color").
  private readonly fieldAuthors = new Map<string, { id: string; name: string }>();
  // This PC's own steps (SPEC §23.2), and which step each proposal belongs to.
  private history = new History();
  private readonly stepOf = new Map<string, { step: Step; purpose: Purpose; pushed: boolean }>();
  private openStep: { step: Step; purpose: Purpose; pushed: boolean } | undefined;
  private restoreBatch: { name: string; items: { what: string; op: unknown }[] } | undefined;
  private restoreTimer: NodeJS.Timeout | undefined;
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

  // In touch with the session: always for the host, a member while the host answers.
  get inTouch(): boolean {
    return this.host !== undefined || this.hostId !== undefined;
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
    mkdirSync(dir, { recursive: true });
    this.history = new History(join(dir, "undo.json"));
    const onApply = (before: SessionModel, op: SessionOp, author: string, proposal?: string) => this.ownApplied(before, op, author, proposal);
    this.activityStore = join(dir, "activity.json");
    if (this.host) {
      this.activity = new Activity(this.loadActivity());
      this.host.onApply = (before, op, author, proposal) => {
        onApply(before, op, author, proposal);
        this.noteChange(before, op, author);
      };
    }
    this.member.onApply = onApply;
    const send = (command: { type: string } & Record<string, JsonValue>) => bridge.send(command) as Promise<BridgeResult>;
    this.sync = new MediaPoolSync({
      me: peers.id,
      send,
      propose: (op, proposal, base, keep) => this.propose(op, proposal, base, "edit", keep),
      seq: () => this.seq(),
      overwritten: (c) => this.raced(c),
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
      propose: (op, proposal, base, keep) => this.propose(op, proposal, base, "edit", keep),
      seq: () => this.seq(),
      overwritten: (c) => this.raced(c),
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
    const me = peers.id;
    this.media = new MediaManager({
      me,
      store: join(dir, "media.json"),
      proxies: this.options.proxiesDir ?? join(this.options.storeDir, "..", "proxies"),
      project: () => this.record?.projectName || "Project",
      sync,
      fingerprint: this.options.fingerprint,
      send: (peer, m) => peers.sendTo(peer, m as unknown as JsonValue),
      sendLoose: (peer, m) => peers.sendLoose(peer, m as unknown as JsonValue),
      announce: (have) => {
        const message = { type: "media-have", originals: have.originals, proxies: have.proxies };
        if (this.host) this.toMembers({ ...message, id: me });
        else if (this.hostId) peers.sendTo(this.hostId, message);
      },
      online: () => {
        const ids = this.people().filter((p) => p.online && p.id !== me).map((p) => p.id);
        const host = this.host ? me : this.hostId;
        return host && ids.includes(host) ? [host, ...ids.filter((i) => i !== host)] : ids;
      },
      isPerson: (peer) => (this.host ? this.admitted.has(peer) : peer === this.hostId || this.people().some((p) => p.id === peer && p.online)),
      nameOf: (peer) => this.people().find((p) => p.id === peer)?.name ?? "someone",
      log,
      onChange: () => this.options.onMedia?.(),
    });
    if (this.host) this.reset(this.host.model);
  }

  stop(): void {
    this.over = true;
    clearInterval(this.joinTimer);
    clearTimeout(this.graceTimer);
    clearTimeout(this.restoreTimer);
    clearTimeout(this.pointerTimer);
    if (this.begun) {
      this.sync.stop();
      this.timelines.stop();
    }
    this.media?.stop();
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
      if (this.begun) this.event(`${this.options.name} closed the session`, "bad");
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
    if (type === "presence") {
      this.ownPresence = cleanPresence(event);
      this.sharePresence();
      return;
    }
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

  // --- notices (SPEC §23.1) ------------------------------------------------------

  // Remembers who changed which fields, keyed as the syncs key them.
  private noteAuthor(commit: Commit): void {
    const op = commit.op as unknown as Record<string, unknown>;
    const type = String(op.type);
    const kind = type.slice(0, type.indexOf("."));
    const id = String(op.id);
    const who = { id: commit.author, name: commit.name ?? (commit.author === this.options.peers.id ? this.options.name : "someone") };
    if (type.endsWith(".delete")) return;
    if (type.endsWith(".create")) this.fieldAuthors.set(fieldKey(kind, id, EXISTS), who);
    for (const key of fieldKeysOf(commit.op)) this.fieldAuthors.set(key, who);
  }

  // Changes of ours someone else's reached the host before (SPEC §23.1).
  private raced(conflicts: Conflict[]): void {
    const authorOf = (c: Conflict) => (c.kind === "clash"
      ? this.fieldAuthors.get(fieldKey(c.item, (c.theirs as { id: string }).id, EXISTS))
      : this.fieldAuthors.get(c.key))?.name;
    const notice = this.notices.raced(conflicts, authorOf);
    if (notice) this.options.log(notice.text);
  }

  // `reapply <n>`: sends the undone change again, as a new edit.
  reapply(n: number): string {
    const notice = this.notices.take(n, "reapply");
    if (!notice) return `there's no notice ${n} to reapply`;
    const ops = [
      ...notice.changes.map((c) => (POOL_KINDS.includes(c.item) ? mediaPoolDomain.set(c.item, c.id, c.fields) : timelineDomain.set(c.item, c.id, c.fields)) as SessionOp),
      ...(notice.ops as SessionOp[]),
    ];
    for (const op of ops) this.propose(op, newId(), this.seq());
    return `sent again (${ops.length} change${ops.length === 1 ? "" : "s"})`;
  }

  // Someone's "Keep mine" replaced values this PC set last (SPEC §23.3): one
  // notice for what arrives together, with restore <n>.
  private replacedMine(model: SessionModel, commit: Commit): void {
    const mine = (commit.replaced ?? []).filter((r) => r.author === this.options.peers.id);
    if (!mine.length) return;
    const op = commit.op as unknown as Record<string, unknown>;
    const kind = String(op.type).slice(0, String(op.type).indexOf("."));
    const id = String(op.id);
    const inPool = POOL_KINDS.includes(kind);
    const entity: object | undefined = inPool ? mediaPoolDomain.table(model.pool, kind)[id] : timelineDomain.table(model.timelines, kind)[id];
    if (!entity) return;
    const label = inPool ? mediaPoolDomain.label(kind, entity) : timelineDomain.label(kind, entity);
    const timeline = inPool ? undefined : model.timelines.timelines[(entity as { timeline?: string }).timeline ?? ""]?.name;
    const name = commit.name ?? "Someone";
    const batch = this.restoreBatch?.name === name ? this.restoreBatch : (this.restoreBatch = { name, items: [] });
    for (const r of mine) {
      const at = r.key.indexOf(":");
      const restore = at < 0 ? { [r.key]: r.value } : { [r.key.slice(0, at)]: { [r.key.slice(at + 1)]: r.value } };
      const field = at < 0 ? r.key : r.key.startsWith("props:") ? `prop:${r.key.slice(at + 1)}` : r.key;
      batch.items.push({
        what: `${fieldName(field)} on "${label}"${timeline && kind !== "timeline" ? ` (${timeline})` : ""}`,
        op: { type: `${kind}.set`, id, ...restore },
      });
    }
    clearTimeout(this.restoreTimer);
    this.restoreTimer = setTimeout(() => {
      const done = this.restoreBatch;
      this.restoreBatch = undefined;
      const notice = done && this.notices.replaced(done.name, done.items);
      if (notice) this.options.log(notice.text);
    }, 500);
  }

  // `restore <n>`: puts back what someone's Keep mine replaced, as a new edit.
  restore(n: number): string {
    const notice = this.notices.take(n, "restore");
    if (!notice) return `there's no notice ${n} to restore`;
    for (const op of notice.ops as SessionOp[]) this.propose(structuredClone(op), newId(), this.seq());
    return `put yours back (${notice.ops.length} change${notice.ops.length === 1 ? "" : "s"})`;
  }

  // --- undo and redo (SPEC §23.2) -------------------------------------------------

  // One of this PC's own operations, about to be applied: its inverse joins its step.
  private ownApplied(before: SessionModel, op: SessionOp, author: string, proposal?: string): void {
    if (author !== this.options.peers.id || !proposal) return;
    const entry = this.stepOf.get(proposal);
    if (!entry) return;
    this.stepOf.delete(proposal);
    if (entry.purpose === "undo") return; // an undo's step went to the redo list already
    const inverse = inverseOf(before, op);
    // A change that leaves everything as it was (Resolve reporting what the
    // session already has) is nothing to undo.
    if (op.type.endsWith(".set") && inverse.length === 1 && JSON.stringify(inverse[0]) === JSON.stringify(op)) return;
    entry.step.forward.push(structuredClone(op));
    entry.step.inverse.unshift(...inverse);
    if (!entry.pushed) {
      this.history.push(entry.step, entry.purpose === "edit");
      entry.pushed = true;
    }
    this.history.save();
  }

  private get model(): SessionModel {
    return this.host ? this.host.model : this.member.model;
  }

  // Undoes this PC's last own step, asking first if someone has changed it since.
  async undo(): Promise<string> {
    if (!this.begun) return "not in a session yet";
    const step = this.history.undo.at(-1);
    if (!step) return "nothing of yours to undo";
    const { ops, since, gone } = this.check(step.inverse);
    if (since.length) {
      const ok = await this.options.confirm(`${since[0]}${since.length > 1 ? ` (and ${since.length - 1} more)` : ""}. Undo anyway?`);
      if (!ok) return "not undone";
    }
    if (this.history.undo.at(-1) !== step) return "your history changed meanwhile; nothing undone";
    this.history.undo.pop();
    this.history.redo.push(step);
    this.history.save();
    for (const op of ops) this.propose(op, newId(), this.seq(), "undo");
    return `undid your last change${gone ? `; ${gone} part${gone === 1 ? " was" : "s were"} deleted by someone, so left out` : ""}`;
  }

  async redo(): Promise<string> {
    if (!this.begun) return "not in a session yet";
    const step = this.history.redo.pop();
    if (!step) return "nothing to redo";
    this.history.save();
    for (const op of step.forward) this.propose(structuredClone(op), newId(), this.seq(), "redo");
    return "redid your last undone change";
  }

  // Which of an undo's operations still apply, and what others changed since.
  private check(inverse: SessionOp[]): { ops: SessionOp[]; since: string[]; gone: number } {
    const model = this.model;
    const me = this.options.peers.id;
    const ops: SessionOp[] = [];
    const since: string[] = [];
    let gone = 0;
    for (const op of inverse) {
      const kind = op.type.slice(0, op.type.indexOf("."));
      const id = (op as { id: string }).id;
      const inPool = POOL_KINDS.includes(kind);
      const entity: object | undefined = inPool ? mediaPoolDomain.table(model.pool, kind)[id] : timelineDomain.table(model.timelines, kind)[id];
      if (op.type.endsWith(".create")) {
        if (!entity) ops.push(op); // already back (someone re-made it): left out
        continue;
      }
      if (!entity) {
        gone++;
        continue;
      }
      ops.push(op);
      const label = inPool ? mediaPoolDomain.label(kind, entity) : timelineDomain.label(kind, entity);
      const keys = op.type.endsWith(".set") ? fieldKeysOf(op) : [...this.fieldAuthors.keys()].filter((k) => k.startsWith(`${kind}:${id}:`));
      for (const key of keys) {
        const who = this.fieldAuthors.get(key);
        if (who && who.id !== me) {
          const field = key.slice(`${kind}:${id}:`.length);
          since.push(`${who.name} has since changed ${field === EXISTS ? `"${label}"` : `the ${fieldName(field)} of "${label}"`}`);
          break;
        }
      }
    }
    return { ops, since, gone };
  }

  // --- ordering -----------------------------------------------------------------

  // The seq of the session state this PC has (SPEC §23.1).
  private seq(): number {
    return this.host ? this.host.seq : this.member.seq;
  }

  // `purpose`: an edit (a new undo step), or an undo or redo of one (SPEC §23.2).
  private propose(op: SessionOp, proposal: string, base?: number, purpose: Purpose = "edit", keep = false): void {
    this.freshProject = false; // a change of this PC's own: from now on, worth a backup
    if (purpose === "edit" && this.followed && !followsClipColor(op, this.model, () => undefined)) {
      const name = this.people().find((p) => p.id === this.followed)?.name ?? "them";
      this.follow(undefined);
      this.options.log(`stopped following ${name}: you made a change`);
    }
    const localColor = (clip: string) => [...this.sync.local.clips.values()].find((c) => c.rcId === clip)?.color;
    if (purpose !== "edit" || !followsClipColor(op, this.model, localColor)) {
      // Everything proposed in one go (one sync pass, one undo) is one step.
      if (!this.openStep || this.openStep.purpose !== purpose) {
        const open = { step: { forward: [], inverse: [] }, purpose, pushed: false };
        this.openStep = open;
        setImmediate(() => { if (this.openStep === open) this.openStep = undefined; });
      }
      this.stepOf.set(proposal, this.openStep);
      // Proposals that never came back (made with no host) don't pile up.
      if (this.stepOf.size > 5000) this.stepOf.delete(this.stepOf.keys().next().value!);
    }
    if (this.host) {
      this.commitLocally(op, this.options.peers.id, proposal, base, keep);
    } else if (this.hostId) {
      this.options.peers.sendTo(this.hostId, { type: "propose", op: op as unknown as JsonValue, proposal, ...(base !== undefined ? { base } : {}), ...(keep ? { keep } : {}) });
    }
    // No host yet: the proposal expires and is made again after the welcome.
  }

  private commitLocally(op: unknown, author: string, proposal: string | undefined, base?: number, keep = false): void {
    const host = this.host!;
    const timeline = typeof (op as SessionOp)?.type === "string" ? timelineOf(op as SessionOp, host.model) : undefined;
    // A base from the future (or not a number) is ignored: no race check.
    const known = typeof base === "number" && Number.isSafeInteger(base) && base >= 0 && base <= host.seq ? base : undefined;
    const name = author === this.options.peers.id ? this.options.name : this.admitted.get(author);
    const result = host.propose(op, author, { ...(proposal ? { proposal } : {}), ...(known !== undefined ? { base: known } : {}), ...(name ? { name } : {}), keep });
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
    this.noteAuthor(commit);
    this.replacedMine(model, commit);
    this.sync.sessionChanged(model.pool, commit);
    this.timelines.sessionChanged(model.timelines, commit);
  }

  private refused(proposal: string, error: string): void {
    this.stepOf.delete(proposal);
    this.sync.refused(proposal, error);
    this.timelines.refused(proposal, error);
  }

  // --- peers ----------------------------------------------------------------------

  // The code says which opening of the session this PC was invited to (§22.1).
  private joinMessage(): Message {
    return { type: "join", name: this.options.name, code: this.options.peers.code, ...(this.options.version ? { version: this.options.version } : {}) };
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
    this.media?.peerLeft(id);
    const { log } = this.options;
    if (this.host) {
      const name = this.admitted.get(id);
      if (name !== undefined) {
        this.admitted.delete(id);
        this.presenceOf.delete(id);
        this.pointerOf.delete(id);
        if (this.followed === id) this.followed = undefined;
        log(`${name} (${id}) left`);
        this.event(`${name} left`, "bad");
        this.peopleChanged();
      }
      return;
    }
    if (id !== this.hostId) return;
    this.hostId = undefined;
    if (this.over) return;
    log("Offline: the host is unreachable; your changes will be merged when it's back.");
    this.lostHost = true;
    this.options.onNote?.(`${this.record?.hostName ?? "The host"} is unreachable`, "bad");
    clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => {
      this.end(`The host didn't come back within ${Math.round((this.options.graceMs ?? GRACE_MS) / 60_000)} minutes, so the session ended here. `
        + "Your changes are kept on this PC and merged when you rejoin.");
    }, this.options.graceMs ?? GRACE_MS);
  }

  private async peerMessage(message: Message, from: string): Promise<void> {
    if (this.over) return;
    // Media files go straight between PCs (SPEC §25.3); the manager checks who's asking.
    if (typeof message.type === "string" && message.type.startsWith("media-") && message.type !== "media-have") {
      return this.media?.message(from, message as Record<string, unknown>);
    }
    if (this.host) return this.hostMessage(message, from);
    return this.memberMessage(message, from);
  }

  // --- host side ------------------------------------------------------------------

  private async hostMessage(message: Message, from: string): Promise<void> {
    const host = this.host!;
    if (message.type === "join") {
      this.versionOf.set(from, typeof message.version === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(message.version) ? message.version : "");
      return this.joinRequest(cleanName(message.name), from, message.code);
    }
    if (!this.admitted.has(from)) return; // nothing from PCs not let in
    switch (message.type) {
      case "chat":
        if (typeof message.text === "string") this.addLine(this.activity.chat(from, this.admitted.get(from) ?? "someone", message.text));
        return;
      case "pointer": {
        // Only the checked position goes on (security review, docs/security-review.md).
        const kept = this.pointerArrived(from, message);
        if (kept) for (const id of this.admitted.keys()) if (id !== from) this.options.peers.sendTo(id, { type: "pointer", id: from, ...kept });
        return;
      }
      case "media-have": {
        const have = this.media?.haveArrived(from, message as Record<string, unknown>);
        if (have) for (const id of this.admitted.keys()) if (id !== from) this.options.peers.sendTo(id, { type: "media-have", id: from, ...have });
        return;
      }
      case "follow-note":
        if (typeof message.target === "string" && typeof message.on === "boolean") this.followLine(from, message.target, message.on);
        return;
      case "presence": {
        const p = cleanPresence(message);
        if (!p) return;
        this.toMembers({ type: "presence", id: from, ...p });
        this.presenceArrived(from, p);
        return;
      }
      case "propose":
        if (typeof message.proposal === "string") this.commitLocally(message.op, from, message.proposal, message.base as number | undefined, message.keep === true);
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
      // Who's here and where (SPEC §8): a first join is still making its project
      // when later messages arrive, so they come with the welcome.
      people: this.hostList() as unknown as JsonValue,
      lines: this.activity.lines as unknown as JsonValue,
      presence: [...this.presenceOf].map(([id, p]) => ({ id, ...p })) as unknown as JsonValue,
      media: (this.media?.haveList() ?? []) as unknown as JsonValue,
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
    this.event(`${name} ${how === "rejoined" ? "rejoined" : "joined"}`, "good");
    // Different versions may not understand each other fully: a red line for everyone (SPEC §26.1).
    const theirs = this.versionOf.get(id) ?? "";
    const mine = this.options.version;
    if (mine && theirs !== mine) {
      this.event(`${name} is on ${theirs ? `ResolveCollab ${theirs}` : "an older ResolveCollab"} and ${this.record?.hostName ?? "the host"} is on ${mine}: install the same version on both`, "bad");
    }
    this.options.peers.sendTo(id, this.welcome(this.host!));
    this.peopleChanged(); // for everyone else; the newcomer's welcome has it
    this.media?.peerJoined(); // what the host has, for the newcomer too
  }

  // --- presence (SPEC §8) ---------------------------------------------------------

  // Everyone in the session: the host first, then members in the order they first joined.
  people(): Person[] {
    const me = this.options.peers.id;
    const list = this.host ? this.hostList() : this.hostPeople;
    const now = Date.now();
    return list.map((p) => {
      const presence = this.presenceOf.get(p.id) ?? (p.id === me ? this.ownPresence : undefined);
      const idle = p.online && now - (this.lastActive.get(p.id) ?? this.startedAt) > IDLE_MS;
      return { ...p, ...(presence ? { presence } : {}), ...(idle ? { idle } : {}) };
    });
  }

  private hostList(): Person[] {
    const r = this.record;
    const people: Person[] = [{ id: this.options.peers.id, name: this.options.name, color: colorAt(0), online: true }];
    for (const [i, m] of (r?.members ?? []).entries()) {
      const id = m.key.slice(0, 8);
      people.push({ id, name: m.name, color: colorAt(i + 1), online: this.admitted.has(id) });
    }
    return people;
  }

  // Host: tells everyone who's here (on a join, a leave, a removal).
  private peopleChanged(): void {
    if (this.host) this.toMembers({ type: "people", people: this.hostList() as unknown as JsonValue });
    this.options.onPeople?.();
  }

  get following(): string | undefined {
    return this.followed;
  }

  // Follow someone, or stop (undefined): this PC's Resolve moves with theirs.
  follow(id: string | undefined): void {
    const was = this.followed;
    this.followed = id && id !== this.options.peers.id ? id : undefined;
    if (was !== this.followed) this.followNote(this.followed ?? was, this.followed !== undefined);
    const p = this.followed && this.presenceOf.get(this.followed);
    if (p) this.goTo({ page: p.page, timeline: p.timeline, timecode: p.timecode });
    this.options.onPeople?.();
  }

  // --- ghost cursors (SPEC §24.6) ----------------------------------------------------

  // This person's pointer in their Resolve window (0–1), with where it is in
  // the project (SPEC §24.6.1), or null when it's not over Resolve. Sent at
  // most 30 times a second; the newest wins.
  sharePointer(at: { x: number; y: number; spot?: Spot } | null): void {
    if (at === null && this.pointerNext === null) return; // "off" once, not every tick
    this.pointerNext = at;
    if (this.pointerTimer) return;
    const wait = Math.max(0, POINTER_MS - (Date.now() - this.pointerSent));
    this.pointerTimer = setTimeout(() => {
      this.pointerTimer = undefined;
      this.pointerSent = Date.now();
      const p = this.pointerNext;
      if (p === undefined || !this.begun) return;
      const message = p ? { type: "pointer", x: p.x, y: p.y, ...(p.spot ? { spot: p.spot as unknown as JsonValue } : {}) } : { type: "pointer", off: true };
      if (this.host) this.toMembers({ ...message, id: this.options.peers.id });
      else if (this.hostId) this.options.peers.sendTo(this.hostId, message);
    }, wait);
  }

  // The others' pointers, with the page they're on.
  pointers(): { id: string; name: string; color: string; page: string; timeline: string; x: number; y: number; spot?: Spot }[] {
    return this.people().flatMap((p) => {
      const at = this.pointerOf.get(p.id);
      return at && p.id !== this.options.peers.id && p.online ? [{ id: p.id, name: p.name, color: p.color, page: p.presence?.page ?? "", timeline: p.presence?.timeline ?? "", ...at }] : [];
    });
  }

  // A timeline's frame rate and tracks, to read this PC's timeline (SPEC §24.6.1).
  timelineInfo(id: string): { fps: number; tracks: ScreenTrack[] } | undefined {
    if (!this.begun) return undefined;
    const m = this.model.timelines;
    const t = m.timelines[id];
    if (!t) return undefined;
    return { fps: t.fps, tracks: Object.values(m.tracks).filter((k) => k.timeline === id).map((k) => ({ kind: k.kind, order: k.order, name: k.name })) };
  }

  // Returns what was taken from the message, checked (only that is passed on), or undefined.
  private pointerArrived(id: string, message: Message): Message | undefined {
    const x = message.x;
    const y = message.y;
    let kept: Message;
    if (message.off === true) {
      this.pointerOf.delete(id);
      kept = { off: true };
    } else if (typeof x === "number" && typeof y === "number" && x >= 0 && x <= 1 && y >= 0 && y <= 1) {
      const spot = cleanSpot(message.spot);
      this.pointerOf.set(id, spot ? { x, y, spot } : { x, y });
      kept = spot ? { x, y, spot: spot as unknown as JsonValue } : { x, y };
    } else return undefined;
    this.options.onPointers?.();
    return kept;
  }

  // Everyone sees who follows whom (SPEC §24.5); a member's note goes through the host.
  private followNote(target: string | undefined, on: boolean): void {
    if (!target || !this.begun) return;
    if (this.host) this.followLine(this.options.peers.id, target, on);
    else if (this.hostId) this.options.peers.sendTo(this.hostId, { type: "follow-note", target, on });
  }

  private followLine(who: string, target: string, on: boolean): void {
    const people = this.people();
    const a = people.find((p) => p.id === who);
    const b = people.find((p) => p.id === target);
    if (!a || !b || a.id === b.id) return;
    this.addLine(this.activity.event(who, a.name, on ? `${a.name} is following ${b.name}` : `${a.name} stopped following ${b.name}`));
  }

  // Host: a session event for everyone's history.
  private event(text: string, tone?: "good" | "bad"): void {
    if (this.host) this.addLine(this.activity.event(this.options.peers.id, this.options.name, text, tone));
  }

  // Clicking a change line (SPEC §24.3): that timeline, at that frame.
  jumpTo(line: Line): void {
    if (line.timeline) this.goTo({ timeline: line.timeline, ...(line.frame !== undefined ? { frame: line.frame } : {}) });
  }

  // Clicking a timecode in chat: there, on the timeline open now.
  jumpToTimecode(timecode: string): void {
    this.goTo({ timecode });
  }

  // One jump at a time; while one is in flight only the newest waits.
  private goTo(where: Record<string, JsonValue>): void {
    if (this.going) {
      this.goNext = where;
      return;
    }
    this.going = true;
    void this.options.bridge.send({ type: "presence.go", ...where }).finally(() => {
      this.going = false;
      const next = this.goNext;
      this.goNext = undefined;
      if (next) this.goTo(next);
    });
  }

  // A presence arrived: move with it if it's whom this PC follows.
  private presenceArrived(id: string, p: Presence): void {
    this.presenceOf.set(id, p);
    this.lastActive.set(id, Date.now());
    if (id === this.followed) this.goTo({ page: p.page, timeline: p.timeline, timecode: p.timecode });
    this.options.onPeople?.();
  }

  private sharePresence(): void {
    const p = this.ownPresence;
    if (!p || !this.begun) return;
    const me = this.options.peers.id;
    this.lastActive.set(me, Date.now());
    if (this.host) {
      this.presenceOf.set(me, p);
      this.toMembers({ type: "presence", id: me, ...p });
      this.options.onPeople?.();
    } else if (this.hostId) {
      this.options.peers.sendTo(this.hostId, { type: "presence", ...p });
    }
  }

  // Ends the session for good (SPEC §22.2).
  endForGood(): void {
    if (!this.host || !this.record) return;
    this.record.ended = true;
    saveRecord(this.options.storeDir, this.record);
    rmSync(this.activityStore, { force: true }); // chat goes with the session (SPEC §11)
    this.activity = new Activity();
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
      this.presenceOf.delete(id);
      this.event(`${m.name} was removed`, "bad");
      this.peopleChanged();
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
    if (!this.begun || from !== this.hostId) {
      // Missed while still joining (making the project): asked for again once in.
      if (message.type === "commit" || message.type === "people" || message.type === "presence" || message.type === "line" || message.type === "media-have") this.missedCommits = true;
      return; // the rest only from the host
    }
    switch (message.type) {
      case "presence": {
        const p = cleanPresence(message);
        if (!p || typeof message.id !== "string" || message.id === this.options.peers.id) return;
        this.presenceArrived(message.id, p);
        return;
      }
      case "line": {
        const line = cleanLine(message.line);
        if (!line) return;
        const at = this.activity.lines.findIndex((l) => l.id === line.id);
        if (at >= 0) this.activity.lines[at] = line;
        else this.activity = new Activity([...this.activity.lines, line]);
        if (line.kind !== "event") this.lastActive.set(line.author, Date.now());
        this.options.onLine?.(line);
        return;
      }
      case "pointer":
        if (typeof message.id === "string" && message.id !== this.options.peers.id) this.pointerArrived(message.id, message);
        return;
      case "media-have":
        if (typeof message.id === "string" && message.id !== this.options.peers.id) this.media?.haveArrived(message.id, message as Record<string, unknown>);
        return;
      case "people": {
        const people = cleanPeople(message.people);
        if (!people) return;
        this.hostPeople = people;
        for (const id of this.presenceOf.keys()) if (!people.some((x) => x.id === id && x.online)) this.presenceOf.delete(id);
        if (this.followed && !people.some((x) => x.id === this.followed && x.online)) this.followed = undefined;
        this.options.onPeople?.();
        return;
      }
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
        } else if (commit.author === this.options.peers.id && commit.proposal) {
          // Ours, and already in a state we were sent (after a gap or a
          // reconnect): the proposal is settled all the same.
          this.sync.sessionChanged(this.member.model.pool, commit);
          this.timelines.sessionChanged(this.member.model.timelines, commit);
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
    if (this.lostHost) {
      this.lostHost = false;
      this.options.onNote?.(`${this.record!.hostName} is back`, "good");
    }
    this.hostId = from;
    this.member.reset({ seq: state.seq, model });
    this.hostPeople = cleanPeople(message.people) ?? this.hostPeople;
    if (Array.isArray(message.lines)) this.activity = new Activity(message.lines.map(cleanLine).filter((l): l is Line => !!l));
    for (const raw of Array.isArray(message.presence) ? message.presence : []) {
      const p = cleanPresence(raw);
      const id = (raw as { id?: unknown })?.id;
      if (p && typeof id === "string" && id !== this.options.peers.id) this.presenceOf.set(id, p);
    }
    for (const raw of Array.isArray(message.media) ? message.media : []) {
      const id = (raw as { id?: unknown })?.id;
      if (typeof id === "string" && id !== this.options.peers.id) this.media?.haveArrived(id, raw as Record<string, unknown>);
    }
    this.media?.peerJoined(); // what this PC has, now that someone hears
    this.options.onPeople?.();
    this.sharePresence(); // where this person is, now that someone hears
    if (this.missedCommits) {
      this.missedCommits = false;
      this.options.peers.sendTo(from, { type: "want-state" });
    }
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
    if (this.record?.ended) {
      rmSync(this.activityStore, { force: true }); // chat goes when the session is ended for good (SPEC §11)
    } else {
      writeFileSync(`${this.activityStore}.tmp`, JSON.stringify(this.activity.lines));
      renameSync(`${this.activityStore}.tmp`, this.activityStore);
    }
  }

  private loadActivity(): Line[] {
    try {
      const raw = JSON.parse(readFileSync(this.activityStore, "utf8")) as unknown;
      return Array.isArray(raw) ? raw.map(cleanLine).filter((l): l is Line => !!l).slice(-MAX_LINES) : [];
    } catch {
      return []; // none yet, or unreadable: the history starts afresh
    }
  }

  // --- chat and changes (SPEC §24.3) ----------------------------------------------

  lines(): Line[] {
    return this.activity.lines;
  }

  // Sends a chat message (the host adds it to the history and passes it on).
  chat(text: string): void {
    if (!this.begun) return;
    if (this.host) this.addLine(this.activity.chat(this.options.peers.id, this.options.name, text));
    else if (this.hostId) this.options.peers.sendTo(this.hostId, { type: "chat", text: text.slice(0, 2000) });
  }

  // Host: a committed change becomes (or joins) a line, unless it shows nothing
  // new: a no-op, or a timeline clip following its media pool clip's colour.
  private noteChange(before: SessionModel, op: SessionOp, author: string): void {
    if (followsClipColor(op, before, () => undefined)) return;
    const d = describeChange(before, op);
    if (op.type.endsWith(".set") && d.changes.every((c) => c.from === c.to)) return;
    const name = author === this.options.peers.id ? this.options.name : this.admitted.get(author) ?? "someone";
    this.addLine(this.activity.change(before, op, author, name));
  }

  private addLine(line: Line | undefined): void {
    if (!line) return;
    if (line.kind !== "event") this.lastActive.set(line.author, Date.now());
    if (this.host) {
      this.toMembers({ type: "line", line: line as unknown as JsonValue });
      this.scheduleHostSave();
    }
    this.options.onLine?.(line);
  }
}
