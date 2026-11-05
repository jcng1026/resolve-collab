// Runs the media pool reconciler against the bridge (SPEC §19.5, §19.6):
// keeps Resolve's state as reported by the bridge, runs a reconcile pass
// whenever something changes, sends proposals, carries out bridge commands,
// and asks the user about conflicts during catch-up.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JsonValue } from "../bridge-protocol/wire.ts";
import type { Commit } from "./host-log.ts";
import { type LocalBin, type LocalClip, type LocalState, type MarkerSpot, identify } from "./identify.ts";
import { POOL_TAG, localMarkers, markerFailure, markerValues, tagOf } from "./marker.ts";
import { type Clip, type Fingerprint, type MediaPool, type Op, type PoolMarker, ROOT, applyOp, newId } from "./media-pool.ts";
import { type Answer, type Conflict, EXISTS, fieldKey, frameClashes, itemKey, mediaPoolDomain, overwriteMessage, reconcile, resolveConflicts } from "./reconcile.ts";

export interface BridgeResult {
  ok: boolean;
  error?: string;
  records?: JsonValue[]; // fresh mp.bin / mp.clip records of touched items
  gone?: JsonValue[]; // { kind, id } of items the command removed
  [key: string]: JsonValue | undefined;
}

export interface MediaPoolSyncOptions {
  me: string; // this peer's ID, to recognise our own commits
  send: (command: { type: string } & Record<string, JsonValue>) => Promise<BridgeResult>;
  // `base`: the session state's seq the change was made on (SPEC §23.1);
  // `keep`: it comes from a "Keep mine" answer (SPEC §23.3).
  propose: (op: Op, proposal: string, base?: number, keep?: boolean) => void;
  // The seq of the session state this sync sees now.
  seq?: () => number;
  // Live races the session won, from one pass (SPEC §23.1); logged when absent.
  overwritten?: (conflicts: Conflict[]) => void;
  ask: (conflicts: Conflict[]) => Promise<Map<string, Answer>>;
  fingerprint: (path: string) => Promise<Fingerprint | null>;
  findFile: (file: Fingerprint, searchDirs: string[]) => Promise<string | null>;
  backup: () => Promise<boolean>;
  // False while there's nothing of this PC's own to protect (a project just made for a first join).
  backupNeeded?: () => boolean;
  log: (message: string) => void;
  store?: string; // JSON file for base, bin map and missing list
}

interface Pending {
  value: unknown;
  at: number;
  proposal: string;
}

export interface MissingClip {
  id: string;
  name: string;
  file: Fingerprint | null;
}

const PENDING_EXPIRE_MS = 10_000;


export class MediaPoolSync {
  readonly local: LocalState = { bins: new Map(), clips: new Map() };
  readonly missing = new Map<string, MissingClip>();
  base: MediaPool | null = null;
  binMap = new Map<string, string>();
  projectId: string | undefined; // the Resolve project this session syncs
  paused = false; // another project is open (SPEC §9.2)
  private projectName = ""; // for telling the user which project to open
  private session: MediaPool | null = null;
  private markerSpots = new Map<string, MarkerSpot>();
  private readonly gaveUp = new Map<string, string>(); // markers that couldn't be placed, with the value tried
  private bridgeSynced = false;
  private catchUp = true;
  private readonly pending = new Map<string, Pending>();
  private basedOn: number | undefined; // seq of the session state last compared (SPEC §23.1)
  private readonly busy = new Set<string>();
  private readonly fingerprints = new Map<string, Fingerprint | null>();
  private readonly fingerprinting = new Set<string>();
  private running = false;
  private again = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly options: MediaPoolSyncOptions;

  constructor(options: MediaPoolSyncOptions) {
    this.options = options;
    this.load();
  }

  // --- for timeline sync: media pool clips by local and collab ID -------------

  // True once Resolve's media pool has been read for the session's project.
  get ready(): boolean {
    return this.bridgeSynced && !this.paused && this.session !== null;
  }

  mediaCollab(localId: string): string | undefined {
    return this.local.clips.get(localId)?.rcId || undefined;
  }

  mediaLocal(collabId: string): string | undefined {
    return this.localClip(collabId);
  }

  // --- inputs ---------------------------------------------------------------

  bridgeEvent(event: Record<string, JsonValue>): void {
    if (event.type === "mp.reset") {
      this.reset(event.project as { id: string; name: string } | null);
      return;
    }
    if (this.paused) return;
    switch (event.type) {
      case "mp.bin":
      case "mp.clip":
        this.record(event);
        break;
      case "mp.gone":
        (event.kind === "bin" ? this.local.bins : this.local.clips).delete(String(event.id));
        break;
      case "mp.synced":
        this.bridgeSynced = true;
        this.catchUp = true;
        break;
      default:
        return;
    }
    this.schedule();
  }

  // The bridge is about to report everything (it started, or the project
  // changed), then mp.synced.
  // This session's project, when it's known before the bridge reports one
  // (SPEC §22.3: a first join's new project, a rejoin's from last time).
  expectProject(id: string, name: string): void {
    this.projectId = id;
    this.projectName = name;
  }

  private reset(project: { id: string; name: string } | null): void {
    this.local.bins.clear();
    this.local.clips.clear();
    this.bridgeSynced = false;
    const paused = !project || (this.projectId !== undefined && project.id !== this.projectId);
    if (paused && !this.paused) {
      this.options.log(this.projectName ? `Open "${this.projectName}" in Resolve to sync this session; sync is paused until then.`
        : "You switched to another project: sync is paused until you switch back.");
    }
    if (!paused && this.paused) this.options.log(`Back on "${project!.name}": sync resumes.`);
    this.paused = paused;
    if (!paused) this.projectId = project!.id;
  }

  sessionReset(model: MediaPool): void {
    this.session = model;
    this.catchUp = true;
    this.schedule();
  }

  sessionChanged(model: MediaPool, commit?: Commit): void {
    this.session = model;
    if (commit?.author === this.options.me && commit.proposal) this.settle(commit.proposal);
    this.schedule();
  }

  refused(proposal: string, error: string): void {
    // A lost race is told by the comparison that follows (SPEC §23.1).
    if (error !== "raced") this.options.log(`the host refused a change (${error})`);
    this.settle(proposal);
    // Compare again: Resolve still shows the change the host refused.
    this.schedule();
  }

  // The user points to their own copy of a missing file (§10.2 "Locate").
  async locate(idPrefix: string, path: string): Promise<string> {
    const clip = [...this.missing.values()].find((c) => c.id.startsWith(idPrefix));
    if (!clip) return `no missing clip starts with ${idPrefix}`;
    const file = await this.options.fingerprint(path);
    if (!file) return `can't read ${path}: check the path`;
    if (!clip.file || file.size !== clip.file.size || file.hash !== clip.file.hash) {
      return `${path} is not the same file as ${clip.name} (same name, different content)`;
    }
    const target = this.session?.clips[clip.id];
    if (!target) return `${clip.name} is no longer in the session`;
    this.missing.delete(clip.id);
    const result = await this.importClip(target, path);
    this.schedule();
    return result.ok ? `imported ${clip.name}` : `import failed: ${result.error}`;
  }

  schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.pass(), 30);
  }

  stop(): void {
    clearTimeout(this.timer);
  }

  // --- the pass -------------------------------------------------------------

  async pass(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        await this.passOnce();
      } while (this.again);
    } catch (error) {
      this.options.log(`sync pass failed: ${(error as Error).stack ?? error}`);
    } finally {
      this.running = false;
    }
  }

  private async passOnce(): Promise<void> {
    if (!this.bridgeSynced || !this.session || this.paused) return;
    const session = this.session;
    const now = Date.now();
    for (const [key, p] of this.pending) if (now - p.at > PENDING_EXPIRE_MS) this.pending.delete(key);

    const ids = identify({ local: this.local, binMap: this.binMap, session, fingerprint: (p) => this.fingerprintOf(p) });
    for (const link of ids.links) await this.run(`clip:${link.rcId}`, { type: "mp.clip.link", id: link.local, rcId: link.rcId });
    // Linked clips are reconciled on the next pass, once Resolve holds the ID.
    if (ids.links.length) this.again = true;
    this.markerSpots = ids.markerSpots;
    for (const t of ids.markerTags) await this.run(`tag:${t.owner}:${t.frame}`, { type: "marker.tag", owner: { kind: "clip", id: t.owner }, frame: t.frame, tag: t.tag });

    for (const id of Object.keys(ids.model.clips)) this.missing.delete(id);
    const busy = new Set(this.busy);
    // A clip's fingerprint is only needed to propose creating it, and its
    // markers wait for it.
    for (const id of ids.notReady) if (!session.clips[id]) busy.add(itemKey("clip", id));
    for (const m of Object.values(ids.model.markers)) if (busy.has(itemKey("clip", m.clip))) busy.add(itemKey("poolmarker", m.id));
    const pendingValues = new Map([...this.pending].map(([k, p]) => [k, p.value]));
    const mode = this.catchUp ? "catch-up" : "live";
    // What our proposals are based on: the session as compared, right now.
    this.basedOn = this.options.seq?.();
    const plan = reconcile({ base: this.base, local: ids.model, session, mode, pending: pendingValues, busy });
    // Two markers on one frame (SPEC §21.5).
    frameClashes(mediaPoolDomain, "poolmarker", plan, ids.model, session, mode, (m: PoolMarker) => m.clip);

    let { propose, apply } = plan;
    const kept = new Set<unknown>(); // proposals from "Keep mine" answers
    if (plan.conflicts.length) {
      const answers = await this.options.ask(plan.conflicts);
      const resolved = resolveConflicts(plan.conflicts, answers, ids.model, session);
      propose = [...propose, ...resolved.propose];
      for (const op of resolved.propose) kept.add(op);
      apply = [...apply, ...resolved.apply];
    }
    if (this.options.overwritten) {
      if (plan.overwritten.length) this.options.overwritten(plan.overwritten);
    } else {
      for (const c of plan.overwritten) this.options.log(overwriteMessage(c));
    }
    const changesHere = apply.some((op) => op.type !== "clip.create" || !this.missing.has(op.id));
    if (mode === "catch-up" && changesHere && this.options.backupNeeded?.() !== false) {
      this.options.log("catching up: saving a backup of the project first");
      if (!(await this.options.backup())) {
        this.options.log("backup failed, so nothing was changed; will retry");
        this.schedule();
        return;
      }
    }
    if (mode === "catch-up" && (propose.length || apply.length)) {
      this.options.log(`catching up: sending ${propose.length} change(s), applying ${apply.length}`);
    }

    this.base = plan.base;
    this.catchUp = false;
    for (const op of propose) this.sendProposal(op, kept.has(op));
    for (const op of apply) if (await this.applyOp(op, session)) this.agree(op, session);
    this.save();
  }

  // --- proposals --------------------------------------------------------------

  private sendProposal(op: Op, keep = false): void {
    const proposal = newId();
    const at = Date.now();
    const item = op.type.split(".")[0]!;
    if (op.type.endsWith(".set")) {
      for (const [field, value] of Object.entries(op)) {
        if (field === "type" || field === "id") continue;
        if (field === "meta") {
          for (const [key, v] of Object.entries(value as Record<string, string>)) {
            this.pending.set(fieldKey(item, op.id, `meta:${key}`), { value: v, at, proposal });
          }
        } else {
          this.pending.set(fieldKey(item, op.id, field), { value, at, proposal });
        }
      }
    } else {
      this.pending.set(fieldKey(item, op.id, EXISTS), { value: op.type, at, proposal });
    }
    this.options.propose(op, proposal, this.basedOn, keep);
  }

  private settle(proposal: string): void {
    for (const [key, p] of this.pending) if (p.proposal === proposal) this.pending.delete(key);
  }

  // --- applying session changes to Resolve -----------------------------------

  private localBin(collab: string): string | undefined {
    for (const [local, id] of this.binMap) if (id === collab && this.local.bins.has(local)) return local;
    return undefined;
  }

  private localClip(collab: string): string | undefined {
    for (const clip of this.local.clips.values()) if (clip.rcId === collab) return clip.id;
    return undefined;
  }

  // Brings one session change into Resolve. Returns true when Resolve now
  // matches the session for it.
  private async applyOp(op: Op, session: MediaPool): Promise<boolean> {
    const key = itemKey(op.type.split(".")[0]!, op.id);
    switch (op.type) {
      case "bin.create": {
        const parent = this.localBin(op.parent);
        if (!parent) return false;
        const result = await this.run(key, { type: "mp.bin.create", parent, name: op.name });
        const created = (Array.isArray(result.records) ? result.records[0] : undefined) as unknown as LocalBin | undefined;
        if (created) this.binMap.set(created.id, op.id);
        return result.ok;
      }
      case "bin.set": {
        const local = this.localBin(op.id);
        if (!local) return false;
        let ok = true;
        if (op.parent !== undefined) {
          const parent = this.localBin(op.parent);
          ok = !!parent && (await this.run(key, { type: "mp.bin.move", id: local, parent })).ok;
        }
        if (op.name !== undefined) {
          const result = await this.run(key, { type: "mp.bin.rename", id: local, name: op.name });
          const records = (Array.isArray(result.records) ? result.records : []) as Record<string, JsonValue>[];
          const renamed = records.find((r) => r.type === "mp.bin") as unknown as LocalBin | undefined;
          if (renamed) this.binMap.set(renamed.id, op.id);
          ok &&= result.ok;
        }
        return ok;
      }
      case "bin.delete": {
        const local = this.localBin(op.id);
        return !local || (await this.run(key, { type: "mp.bin.delete", id: local })).ok;
      }
      case "clip.create": {
        if (this.missing.has(op.id) || this.localClip(op.id)) return false;
        const clip = session.clips[op.id] ?? op;
        const path = clip.file ? await this.options.findFile(clip.file, this.searchDirs()) : null;
        if (!path) {
          this.missing.set(op.id, { id: op.id, name: clip.name, file: clip.file });
          this.options.log(`missing media: "${clip.name}". If you have it: locate ${op.id.slice(0, 8)} <path to the file>`);
          return false;
        }
        return (await this.importClip(clip, path)).ok;
      }
      case "clip.set": {
        const local = this.localClip(op.id);
        if (!local) return false;
        const { type: _type, id: _id, bin, ...fields } = op;
        const command: Record<string, JsonValue> = { type: "mp.clip.set", id: local, ...(fields as Record<string, JsonValue>) };
        if (bin !== undefined) {
          const localBin = this.localBin(bin);
          if (!localBin) return false;
          command.bin = localBin;
        }
        return (await this.run(key, command as { type: string } & Record<string, JsonValue>)).ok;
      }
      case "clip.delete": {
        const local = this.localClip(op.id);
        return !local || (await this.run(key, { type: "mp.clip.delete", id: local })).ok;
      }
      // Clip markers (SPEC §21.4): a change is the marker added again.
      case "poolmarker.create":
      case "poolmarker.set": {
        const marker = session.markers[op.id];
        const owner = marker && this.localClip(marker.clip);
        if (!marker || !owner) return false;
        const values = { ...markerValues(marker), tag: tagOf(op.id, POOL_TAG) };
        const spot = this.markerSpots.get(op.id);
        if (op.type === "poolmarker.set" && !spot) return false;
        // Not tried again until someone changes it (one per frame: SPEC §21.2).
        const tried = JSON.stringify(marker);
        if (this.gaveUp.get(op.id) === tried) return false;
        const command = spot
          ? { type: "marker.set", owner: { kind: "clip", id: owner }, at: spot.frame, ...values }
          : { type: "marker.add", owner: { kind: "clip", id: owner }, ...values };
        const result = await this.run(key, command, true);
        if (result.ok) this.gaveUp.delete(op.id);
        else if (result.error !== "stopped") { // "stopped": this companion is shutting down
          this.gaveUp.set(op.id, tried);
          this.options.log(markerFailure(marker, String(result.error)));
        }
        return result.ok;
      }
      case "poolmarker.delete": {
        const spot = this.markerSpots.get(op.id);
        return !spot || (await this.run(key, { type: "marker.delete", owner: { kind: "clip", id: spot.owner }, frame: spot.frame })).ok;
      }
    }
  }

  // Resolve now holds the session's value: that is the new agreed base, so a
  // local edit made right after is seen as a local edit.
  private agree(op: Op, session: MediaPool): void {
    this.base ??= mediaPoolDomain.empty();
    const kind = op.type.split(".")[0]!;
    const table = mediaPoolDomain.table(this.base, kind);
    const current = mediaPoolDomain.table(session, kind)[op.id];
    if (op.type.endsWith(".delete") || !current) delete table[op.id];
    else if (op.type.endsWith(".create") || !table[op.id]) table[op.id] = structuredClone(current);
    else applyOp(this.base, op);
  }

  private async importClip(clip: Clip, path: string): Promise<BridgeResult> {
    const bin = this.localBin(clip.bin) ?? this.localBin(ROOT);
    if (!bin) return { ok: false, error: "bin-missing" };
    return this.run(itemKey("clip", clip.id), {
      type: "mp.clip.import", bin, path, rcId: clip.id, name: clip.name, color: clip.color, flags: clip.flags, meta: clip.meta,
    });
  }

  // Folders that hold this PC's other clips: the likeliest places for a file
  // with the same name.
  private searchDirs(): string[] {
    const dirs = new Set<string>();
    for (const clip of this.local.clips.values()) if (clip.path) dirs.add(dirname(clip.path));
    return [...dirs];
  }

  private async run(key: string, command: { type: string } & Record<string, JsonValue>, quiet = false): Promise<BridgeResult> {
    this.busy.add(key);
    try {
      const result = await this.options.send(command);
      // Lua encodes an empty list as {}, so only real arrays are read.
      for (const record of Array.isArray(result.records) ? result.records : []) this.record(record as Record<string, JsonValue>);
      for (const gone of Array.isArray(result.gone) ? result.gone : []) {
        const g = gone as { kind: string; id: string };
        (g.kind === "bin" ? this.local.bins : this.local.clips).delete(g.id);
      }
      if (!result.ok && !quiet) this.options.log(`Resolve couldn't ${command.type} (${result.error})`);
      return result;
    } finally {
      this.busy.delete(key);
    }
  }

  private record(r: Record<string, JsonValue>): void {
    if (r.type === "mp.bin") {
      this.local.bins.set(String(r.id), { id: String(r.id), name: String(r.name), parent: String(r.parent ?? "") });
    } else if (r.type === "mp.clip") {
      const meta: Record<string, string> = {};
      for (const [k, v] of Object.entries((r.meta ?? {}) as Record<string, JsonValue>)) if (typeof v === "string" && v !== "") meta[k] = v;
      const clip: LocalClip = {
        id: String(r.id), rcId: String(r.rcId ?? ""), name: String(r.name), bin: String(r.bin), color: String(r.color ?? ""),
        flags: Array.isArray(r.flags) ? r.flags.map(String) : [], meta, path: String(r.path ?? ""), markers: localMarkers(r.markers),
      };
      this.local.clips.set(clip.id, clip);
    }
  }

  private fingerprintOf(path: string): Fingerprint | null | undefined {
    if (this.fingerprints.has(path)) return this.fingerprints.get(path);
    if (!this.fingerprinting.has(path)) {
      this.fingerprinting.add(path);
      this.options.fingerprint(path)
        .catch(() => null)
        .then((file) => {
          this.fingerprints.set(path, file);
          this.fingerprinting.delete(path);
          this.schedule();
        });
    }
    return undefined;
  }

  // --- saved state -------------------------------------------------------------

  private load(): void {
    const store = this.options.store;
    if (!store || !existsSync(store)) return;
    const saved = JSON.parse(readFileSync(store, "utf8")) as {
      base: MediaPool | null; binMap: [string, string][]; missing: MissingClip[]; projectId?: string;
    };
    this.base = saved.base;
    if (this.base) this.base.markers ??= {}; // saved before M5
    this.projectId = saved.projectId;
    this.binMap = new Map(saved.binMap);
    for (const m of saved.missing) this.missing.set(m.id, m);
  }

  private save(): void {
    const store = this.options.store;
    if (!store) return;
    mkdirSync(dirname(store), { recursive: true });
    const data = { base: this.base, binMap: [...this.binMap], missing: [...this.missing.values()], projectId: this.projectId };
    writeFileSync(`${store}.tmp`, JSON.stringify(data));
    renameSync(`${store}.tmp`, store);
  }
}
