// One ResolveCollab session on this PC (SPEC §19.3): connects the bridge,
// the peers and the media pool sync. The host orders every change; members
// propose to the host and apply its commits in order.
//
// Peer messages (all JSON, all checked before use):
//   host → peer    welcome   { host, state }        on connect, or when asked
//   member → host  propose   { op, proposal }
//   host → all     commit    { commit }
//   host → member  refused   { proposal, error }
//   member → host  want-state                       after a gap in commits
//   anyone → all   op        { op }                 M2 timeline "clip added"

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JsonValue } from "./bridge-protocol/wire.ts";
import type { BridgeClient } from "./bridge/bridge-client.ts";
import { type Commit, HostLog, MemberLog, type SessionState } from "./sync/host-log.ts";
import { type Fingerprint, type Op, validatePool } from "./sync/media-pool.ts";
import { type BridgeResult, MediaPoolSync } from "./sync/media-pool-sync.ts";
import type { Answer, Conflict } from "./sync/reconcile.ts";
import type { PeerLink } from "./peer/peer-link.ts";

export interface SessionOptions {
  role: "host" | "member";
  bridge: BridgeClient;
  peers: PeerLink;
  storeDir: string; // per-session state files
  backupsDir: string;
  ask: (conflicts: Conflict[]) => Promise<Map<string, Answer>>;
  fingerprint: (path: string) => Promise<Fingerprint | null>;
  findFile: (file: Fingerprint, dirs: string[]) => Promise<string | null>;
  log: (message: string) => void;
}

type Message = Record<string, JsonValue>;

export class Session {
  readonly sync: MediaPoolSync;
  private readonly options: SessionOptions;
  private readonly host: HostLog | undefined;
  private readonly member = new MemberLog();
  private hostId: string | undefined;
  private saveTimer: NodeJS.Timeout | undefined;
  private readonly hostStore: string;

  constructor(options: SessionOptions) {
    this.options = options;
    const { bridge, peers, role, log } = options;
    const store = join(options.storeDir, `${role}.json`);
    this.hostStore = join(options.storeDir, "host-log.json");
    if (role === "host") {
      const saved = existsSync(this.hostStore) ? (JSON.parse(readFileSync(this.hostStore, "utf8")) as SessionState) : undefined;
      this.host = new HostLog(saved);
    }

    this.sync = new MediaPoolSync({
      me: peers.id,
      send: (command) => bridge.send(command) as Promise<BridgeResult>,
      propose: (op, proposal) => this.propose(op, proposal),
      ask: options.ask,
      fingerprint: options.fingerprint,
      findFile: options.findFile,
      backup: () => this.backup(),
      log,
      store,
    });
    if (this.host) this.sync.sessionReset(this.host.model);

    bridge.on("hello", (hello: Message) => log(`bridge connected: ${hello.product} ${hello.version ?? ""}`));
    // A bridge that was already running sent its media pool before we were
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
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveHost();
    }
  }

  // --- bridge -------------------------------------------------------------------

  private bridgeEvent(event: Message): void {
    if (typeof event.type === "string" && event.type.startsWith("mp.")) {
      this.sync.bridgeEvent(event);
      return;
    }
    if (event.type === "clip.added") {
      this.options.log(`local clip added: ${JSON.stringify(event.media)} at ${event.start} on V${event.track}; sending to ${this.options.peers.peerCount} peer(s)`);
      this.options.peers.send({ type: "op", op: event });
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

  private propose(op: Op, proposal: string): void {
    if (this.host) {
      this.commitLocally(op, this.options.peers.id, proposal);
    } else if (this.hostId) {
      this.options.peers.sendTo(this.hostId, { type: "propose", op: op as unknown as JsonValue, proposal });
    }
    // No host yet: the proposal expires and is made again after the welcome.
  }

  private commitLocally(op: unknown, author: string, proposal: string | undefined): void {
    const host = this.host!;
    const result = host.propose(op, author, proposal);
    if ("error" in result) {
      if (author === this.options.peers.id) this.sync.refused(proposal ?? "", result.error);
      else this.options.peers.sendTo(author, { type: "refused", proposal: proposal ?? "", error: result.error });
      return;
    }
    this.options.peers.send({ type: "commit", commit: result as unknown as JsonValue });
    this.sync.sessionChanged(host.model, result);
    this.scheduleHostSave();
  }

  private peerJoined(id: string): void {
    this.options.log(`peer ${id} connected`);
    if (this.host) this.options.peers.sendTo(id, { type: "welcome", host: this.options.peers.id, state: this.host.state() as unknown as JsonValue });
  }

  private async peerMessage(message: Message, from: string): Promise<void> {
    switch (message.type) {
      case "op":
        await this.timelineOp(message.op as Message, from);
        return;
      case "propose":
        if (this.host && typeof message.proposal === "string") this.commitLocally(message.op, from, message.proposal);
        return;
      case "want-state":
        if (this.host) this.peerJoined(from);
        return;
      case "welcome": {
        if (this.host || (this.hostId && this.hostId !== from)) return;
        const state = message.state as unknown as SessionState;
        const model = validatePool(state?.model);
        if (!Number.isSafeInteger(state?.seq) || !model) {
          this.options.log(`ignored a malformed session state from ${from}`);
          return;
        }
        if (!this.hostId) this.options.log(`joined the session hosted by ${from}`);
        this.hostId = from;
        this.member.reset({ seq: state.seq, model });
        this.sync.sessionReset(this.member.model);
        return;
      }
      case "commit": {
        if (from !== this.hostId) return;
        const commit = message.commit as unknown as Commit;
        if (typeof commit?.seq !== "number") return;
        const outcome = this.member.receive(commit);
        if (outcome === "applied") this.sync.sessionChanged(this.member.model, commit);
        else if (outcome === "gap") this.options.peers.sendTo(from, { type: "want-state" });
        return;
      }
      case "refused":
        if (from === this.hostId && typeof message.proposal === "string") this.sync.refused(message.proposal, String(message.error));
        return;
    }
  }

  // M2: a clip appended on another PC's current timeline (SPEC §18).
  private async timelineOp(op: Message, from: string): Promise<void> {
    if (op?.type !== "clip.added") return;
    const started = Date.now();
    const result = await this.options.bridge.send({ ...op, type: "clip.append" });
    this.options.log(`peer ${from} added ${JSON.stringify(op.media)} at ${op.start}: ${result.ok ? "applied" : `NOT applied (${result.error})`} in ${Date.now() - started} ms`);
  }

  // --- host state ---------------------------------------------------------------

  private scheduleHostSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.saveHost();
    }, 500);
  }

  private saveHost(): void {
    if (!this.host) return;
    mkdirSync(dirname(this.hostStore), { recursive: true });
    writeFileSync(`${this.hostStore}.tmp`, JSON.stringify(this.host.state()));
    renameSync(`${this.hostStore}.tmp`, this.hostStore);
  }
}
