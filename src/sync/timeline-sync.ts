// Runs the timeline reconciler against the bridge (SPEC §20.4–§20.6): keeps
// what the bridge reports about the current timeline, runs a reconcile pass
// whenever something changes, sends proposals, carries out bridge commands,
// and asks the user about conflicts during catch-up.
//
// Only the current timeline can be edited in Resolve, and only it can have
// clips added or deleted by a script, so only it is compared. Changes to
// other timelines stay in the session until that timeline is opened, then
// arrive as a catch-up (SPEC §20.5).
//
// Applying a change uses the best tier that works (SPEC §3.5, §20.6):
//   1 direct API calls; 2 rebuild the item (delete + add); 3 swap the whole
//   timeline for a peer's copy. Tier 3 imports a file made on another PC,
//   which could carry scripts, so it runs only when forced for testing
//   (decision 2026-11-03). `forceTier` makes every eligible change use tier
//   2 or 3, so those paths stay tested.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JsonValue } from "../bridge-protocol/wire.ts";
import type { Commit } from "./host-log.ts";
import { newId } from "./media-pool.ts";
import { type LocalMarker, localMarkers, markerFailure, markerValues, tagOf } from "./marker.ts";
import type { BridgeResult } from "./media-pool-sync.ts";
import { type Answer, type Conflict, EXISTS, fieldKey, frameClashes, itemKey, overwriteMessage, resolveWith } from "./reconcile.ts";
import { type LocalItem, type LocalTimeline, type LocalTrack, type TimelineMarkerSpot, type TrackLists, identifyTimelineState } from "./timeline-identify.ts";
import { groupLinked, reconcileTimelines, timelineDomain } from "./timeline-reconcile.ts";
import { type Item, type Marker, type TimelineOp, type Timelines, applyTimelineOp, emptyTimelines } from "./timeline.ts";

export interface MediaLookup {
  readonly ready: boolean; // the media pool has been read
  readonly project: string | undefined; // the Resolve project the session syncs
  collab(localClip: string): string | undefined;
  local(collabClip: string): string | undefined;
}

export interface TimelineSyncOptions {
  me: string;
  send: (command: { type: string } & Record<string, JsonValue>) => Promise<BridgeResult>;
  propose: (op: TimelineOp, proposal: string) => void;
  ask: (conflicts: Conflict[]) => Promise<Map<string, Answer>>;
  confirm: (question: string) => Promise<boolean>;
  backup: () => Promise<boolean>;
  // False while there's nothing of this PC's own to protect (a project just made for a first join).
  backupNeeded?: () => boolean;
  media: MediaLookup;
  log: (message: string) => void;
  store?: string; // JSON file for base and ID maps
  forceTier?: 1 | 2 | 3;
  // Tier 3: replace this PC's copy of a timeline with a peer's (SPEC §20.6).
  // Resolves to true when the swap was made.
  swap?: (timeline: string, local: string) => Promise<boolean>;
  // True while the user holds the mouse button: they may be dragging in
  // Resolve, so nothing is compared or applied (SPEC §20.5).
  userBusy?: () => boolean;
}

interface Pending {
  value: unknown;
  at: number;
  proposal: string;
}

const PENDING_EXPIRE_MS = 10_000;
// Items waiting for their media pool clip, or for the user to finish an edit
// in Resolve, are retried this often: the clip may be imported by a command,
// which the bridge doesn't report as an event.
const RETRY_MS = 1000;
// Errors that only mean "not now": no rebuild, no warning. "stopped": this
// companion is shutting down.
const TRANSIENT = new Set(["not-current", "user-editing", "unreadable", "stopped"]);

type Command = { type: string } & Record<string, JsonValue>;


export class TimelineSync {
  base: Timelines | null = null;
  readonly itemMap = new Map<string, string>(); // local item ID → collab ID
  readonly trackMap = new Map<string, TrackLists>(); // timeline collab ID → track collab IDs by position
  // What the bridge last reported.
  timelines: LocalTimeline[] = [];
  current = "";
  tracks: { video: LocalTrack[]; audio: LocalTrack[] } | null = null;
  readonly items = new Map<string, LocalItem>();
  readonly markers = new Map<number, LocalMarker>(); // the current timeline's markers by frame
  private markerSpots = new Map<string, TimelineMarkerSpot>(); // from the last pass
  private listed = false;
  private listProject = ""; // the Resolve project the timeline list came from
  private synced = ""; // local ID of the timeline last fully reported
  private session: Timelines | null = null;
  private previous: Timelines | null = null;
  private localTimelines = new Map<string, string>(); // collab → local, from the last pass
  private catchUp = true;
  private readonly pending = new Map<string, Pending>();
  private readonly busy = new Set<string>();
  private readonly warned = new Set<string>();
  private readonly waiting = new Set<string>(); // timelines with changes waiting to be opened
  private readonly failures = new Set<string>(); // failed commands already logged
  // Items that couldn't be added, by collab ID, with the session value tried.
  // They aren't tried again until that value changes, so a failing add can't
  // pile up copies in Resolve.
  private readonly gaveUp = new Map<string, string>();
  private running = false;
  private again = false;
  private timer: NodeJS.Timeout | undefined;
  private retry: NodeJS.Timeout | undefined;
  private retrySoon = false;
  private lastError: JsonValue | undefined; // of the last command run
  private readonly options: TimelineSyncOptions;

  constructor(options: TimelineSyncOptions) {
    this.options = options;
    this.load();
  }

  // --- inputs ---------------------------------------------------------------

  bridgeEvent(event: Record<string, JsonValue>): void {
    switch (event.type) {
      case "tl.list": {
        this.listProject = String(event.project ?? "");
        this.timelines = (Array.isArray(event.timelines) ? event.timelines : []) as unknown as LocalTimeline[];
        const current = String(event.current ?? "");
        if (current !== this.current) {
          this.current = current;
          this.synced = "";
          this.tracks = null;
          this.items.clear();
          this.markers.clear();
        }
        this.listed = true;
        break;
      }
      case "tl.reset":
        if (event.timeline !== this.current) return;
        this.synced = "";
        this.tracks = null;
        this.items.clear();
        this.markers.clear();
        return;
      case "tl.tracks":
        if (event.timeline !== this.current) return;
        this.tracks = { video: (event.video ?? []) as unknown as LocalTrack[], audio: (event.audio ?? []) as unknown as LocalTrack[] };
        break;
      case "tl.item":
        if (event.timeline !== this.current) return;
        this.record(event);
        break;
      case "tl.gone":
        if (event.timeline !== this.current) return;
        this.items.delete(String(event.id));
        break;
      case "tl.marker":
        if (event.timeline !== this.current) return;
        this.record(event);
        break;
      case "tl.marker.gone":
        if (event.timeline !== this.current) return;
        this.markers.delete(Number(event.frame));
        break;
      case "tl.synced":
        if (event.timeline !== this.current) return;
        this.synced = this.current;
        // A full report: after a project open, a timeline switch or a bridge
        // start. Compare as a catch-up (SPEC §20.5).
        this.catchUp = true;
        if (this.waiting.delete(this.collabOf(this.current) ?? "")) this.options.log("applying the changes others made to this timeline");
        break;
      default:
        return;
    }
    this.schedule();
  }

  sessionReset(model: Timelines): void {
    this.session = model;
    this.catchUp = true;
    this.schedule();
  }

  sessionChanged(model: Timelines, commit?: Commit): void {
    this.session = model;
    if (commit?.author === this.options.me && commit.proposal) this.settle(commit.proposal);
    if (commit && commit.author !== this.options.me) this.noteWaiting(commit, model);
    this.schedule();
  }

  refused(proposal: string): void {
    this.settle(proposal);
  }

  schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.pass(), 30);
  }

  stop(): void {
    clearTimeout(this.timer);
    clearTimeout(this.retry);
  }

  // A change to a timeline that isn't open waits until it is (SPEC §20.5).
  private noteWaiting(commit: Commit, model: Timelines): void {
    const op = commit.op as TimelineOp;
    const timeline = op.type.startsWith("item.") ? model.items[op.id]?.timeline ?? (op as Item).timeline
      : op.type.startsWith("track.") ? model.tracks[op.id]?.timeline ?? (op as { timeline?: string }).timeline
      : op.type.startsWith("marker.") ? model.markers[op.id]?.timeline ?? (op as { timeline?: string }).timeline : undefined;
    if (!timeline || timeline === this.collabOf(this.current) || this.waiting.has(timeline)) return;
    this.waiting.add(timeline);
    const name = model.timelines[timeline]?.name ?? "another timeline";
    this.options.log(`changes to "${name}" will be applied when you open it`);
  }

  // Local ID of a timeline by collab ID (for a tier-3 export to a peer).
  localTimelineOf(collab: string): string | undefined {
    return this.localTimelines.get(collab) ?? this.timelines.find((t) => t.rcId === collab)?.id;
  }

  private collabOf(local: string): string | undefined {
    for (const [collab, l] of this.localTimelines) if (l === local) return collab;
    return this.timelines.find((t) => t.id === local)?.rcId || undefined;
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
      this.options.log(`timeline sync pass failed: ${(error as Error).stack ?? error}`);
    } finally {
      this.running = false;
    }
  }

  private async passOnce(): Promise<void> {
    if (!this.session || !this.listed || !this.options.media.ready) return;
    if (this.options.userBusy?.()) return this.retryLater();
    // Another project's timelines are never compared: switching projects
    // must not look like deleting every timeline (SPEC §9.2). The timeline
    // list can report the switch before the media pool does.
    if (this.listProject !== this.options.media.project) return;
    if (this.current && this.synced !== this.current) return;
    const session = this.session;
    const now = Date.now();
    for (const [key, p] of this.pending) if (now - p.at > PENDING_EXPIRE_MS) this.pending.delete(key);

    const ids = identifyTimelineState({
      timelines: this.timelines, current: this.current, tracks: this.tracks, items: [...this.items.values()], markers: [...this.markers.values()],
      session, previous: this.previous, itemMap: this.itemMap, trackMap: this.trackMap, media: (l) => this.options.media.collab(l), newId,
    });
    this.localTimelines = ids.localTimelines;
    for (const link of ids.links) {
      const result = await this.run(`timeline:${link.rcId}`, { type: "tl.link", id: link.local, rcId: link.rcId });
      if (result.ok) this.timelines = this.timelines.map((t) => (t.id === link.local ? { ...t, rcId: link.rcId } : t));
    }
    if (ids.links.length) this.again = true;
    this.warnUnsupported(ids.unsupported, ids.model);
    this.markerSpots = ids.markerSpots;
    for (const t of ids.markerTags) {
      await this.run(`tag:${t.owner}:${t.frame}`, { type: "marker.tag", timeline: this.current, owner: { kind: t.kind, id: t.owner }, frame: t.frame, tag: t.tag });
    }

    const timeline = ids.current;
    const scope = (m: Timelines): Timelines => ({
      timelines: m.timelines,
      tracks: Object.fromEntries(Object.entries(m.tracks).filter(([, t]) => t.timeline === timeline)),
      items: Object.fromEntries(Object.entries(m.items).filter(([, i]) => i.timeline === timeline)),
      markers: Object.fromEntries(Object.entries(m.markers).filter(([, k]) => k.timeline === timeline)),
    });
    const busy = new Set(this.busy);
    for (const id of ids.notReady) busy.add(itemKey("item", id));
    // Markers of an item that's waiting wait with it.
    for (const m of Object.values(session.markers)) if (m.item && busy.has(itemKey("item", m.item))) busy.add(itemKey("marker", m.id));
    const pendingValues = new Map([...this.pending].map(([k, p]) => [k, p.value]));
    const mode = this.catchUp ? "catch-up" : "live";
    const plan = reconcileTimelines({ base: this.base && scope(this.base), local: ids.model, session: scope(session), mode, pending: pendingValues, busy });
    // Two markers on one frame (SPEC §21.5).
    frameClashes(timelineDomain, "marker", plan, ids.model, scope(session), mode, (m: Marker) => `${m.timeline}/${m.item}`);

    let { propose, apply } = plan;
    if (plan.conflicts.length) {
      const groups = groupLinked(plan.conflicts, ids.model, session);
      const answers = await this.options.ask(groups.map((g) => g[0]!));
      for (const g of groups) {
        const answer = answers.get(g[0]!.key);
        if (answer) for (const c of g) answers.set(c.key, answer);
      }
      const resolved = resolveWith(timelineDomain, plan.conflicts, answers, ids.model, scope(session));
      propose = [...propose, ...resolved.propose];
      apply = [...apply, ...resolved.apply];
    }
    for (const c of plan.overwritten) this.options.log(overwriteMessage(c));

    // A timeline deleted here: confirm before deleting it for everyone.
    const keep: TimelineOp[] = [];
    for (const op of propose.filter((o) => o.type === "timeline.delete")) {
      const name = session.timelines[op.id]?.name ?? "a timeline";
      if (!(await this.options.confirm(`You deleted the timeline "${name}". Delete it for everyone?`))) {
        this.options.log(`"${name}" is kept for everyone and will be rebuilt here`);
        keep.push({ type: "timeline.create", ...structuredClone(session.timelines[op.id]!) });
      }
    }
    if (keep.length) propose = propose.filter((o) => o.type !== "timeline.delete" || !keep.some((k) => (k as { id: string }).id === o.id));

    const deletesTimeline = apply.some((op) => op.type === "timeline.delete");
    if (((mode === "catch-up" && apply.length) || deletesTimeline) && this.options.backupNeeded?.() !== false) {
      this.options.log(deletesTimeline ? "a timeline was deleted by someone: saving a backup of the project first" : "catching up timelines: saving a backup of the project first");
      if (!(await this.options.backup())) {
        this.options.log("backup failed, so nothing was changed; will retry");
        this.schedule();
        return;
      }
    }
    if (mode === "catch-up" && (propose.length || apply.length)) {
      this.options.log(`catching up timelines: sending ${propose.length} change(s), applying ${apply.length}`);
    }

    // The new base: this timeline's part from the plan, the others' kept.
    const old = this.base ?? emptyTimelines();
    const merged: Timelines = { timelines: plan.base.timelines, tracks: { ...plan.base.tracks }, items: { ...plan.base.items }, markers: { ...plan.base.markers } };
    for (const t of Object.values(old.tracks)) if (t.timeline !== timeline && merged.timelines[t.timeline]) merged.tracks[t.id] = t;
    for (const i of Object.values(old.items)) if (i.timeline !== timeline && merged.timelines[i.timeline]) merged.items[i.id] = i;
    for (const m of Object.values(old.markers)) if (m.timeline !== timeline && merged.timelines[m.timeline]) merged.markers[m.id] = m;
    this.base = merged;
    this.previous = ids.model;
    this.catchUp = false;

    for (const op of propose) this.sendProposal(op);
    this.retrySoon = false;
    for (const op of keep) await this.applyOp(op, session, timeline);
    await this.applyBatch(apply, session, timeline);
    this.save();
    if (this.retrySoon) this.retryLater();
  }

  private retryLater(): void {
    if (this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.schedule();
    }, RETRY_MS);
  }

  private warnUnsupported(unsupported: LocalItem[], model: Timelines): void {
    for (const it of unsupported) {
      if (this.warned.has(it.id)) continue;
      this.warned.add(it.id);
      this.options.log(`"${it.name}" at frame ${it.start} isn't synced: this kind of item (${it.template || it.kind}) isn't supported yet`);
    }
    for (const item of Object.values(model.items)) {
      if (this.warned.has(item.id)) continue;
      if (item.kind === "title") this.options.log(`title "${item.name}": its words don't sync (basic titles can't be read by scripts); use Text+ for titles that sync`);
      else if (item.kind === "generator") this.options.log(`generator "${item.name}": its settings (e.g. colour) don't sync`);
      else continue;
      this.warned.add(item.id);
    }
  }

  // --- proposals --------------------------------------------------------------

  private sendProposal(op: TimelineOp): void {
    const proposal = newId();
    const at = Date.now();
    const kind = op.type.split(".")[0]!;
    if (op.type.endsWith(".set")) {
      for (const [field, value] of Object.entries(op)) {
        if (field === "type" || field === "id") continue;
        if (field === "props") {
          for (const [k, v] of Object.entries(value as Record<string, unknown>)) this.pending.set(fieldKey(kind, op.id, `prop:${k}`), { value: v, at, proposal });
        } else {
          this.pending.set(fieldKey(kind, op.id, field), { value, at, proposal });
        }
      }
    } else {
      this.pending.set(fieldKey(kind, op.id, EXISTS), { value: op.type, at, proposal });
    }
    this.options.propose(op, proposal);
  }

  private settle(proposal: string): void {
    for (const [key, p] of this.pending) if (p.proposal === proposal) this.pending.delete(key);
  }

  // --- applying session changes to Resolve -----------------------------------

  private localItem(collab: string): string | undefined {
    for (const [local, id] of this.itemMap) if (id === collab && this.items.has(local)) return local;
    return undefined;
  }

  private trackSpot(track: string, timeline: string | undefined): { trackKind: string; trackIndex: number } | undefined {
    const lists = timeline && this.trackMap.get(timeline);
    if (!lists) return undefined;
    for (const kind of ["video", "audio"] as const) {
      const i = lists[kind].indexOf(track);
      if (i >= 0) return { trackKind: kind, trackIndex: i + 1 };
    }
    return undefined;
  }

  private async applyBatch(apply: TimelineOp[], session: Timelines, timeline: string | undefined): Promise<void> {
    const onTimeline = (op: TimelineOp) => /^(track|item|marker)\./.test(op.type);
    if (this.options.forceTier === 3 && timeline && apply.some(onTimeline)) {
      for (const op of apply.filter((o) => !onTimeline(o))) if (await this.applyOp(op, session, timeline)) this.agree(op, session);
      await this.swapTimeline(timeline);
      return;
    }
    let linksChanged = false;
    let applied = 0;
    for (const op of apply) {
      if (await this.applyOp(op, session, timeline)) {
        this.agree(op, session);
        applied++;
      }
      if (op.type === "item.create" || (op.type === "item.set" && op.link !== undefined)) linksChanged = true;
    }
    if (linksChanged && timeline) await this.applyLinks(session, timeline);
    // Look again once Resolve holds the changes: what it reports back is
    // compared, and warnings about new items are shown.
    if (applied) this.schedule();
  }

  // Brings one session change into Resolve. Returns true when Resolve now
  // matches the session for it.
  private async applyOp(op: TimelineOp, session: Timelines, timeline: string | undefined): Promise<boolean> {
    const kind = op.type.split(".")[0]!;
    const key = itemKey(kind, op.id);
    const localTimeline = timeline && this.localTimelines.get(timeline);
    switch (op.type) {
      case "timeline.create": {
        const result = await this.run(key, { type: "tl.create", name: op.name, fps: op.fps, width: op.width, height: op.height, rcId: op.id });
        if (result.ok && typeof result.id === "string") {
          this.localTimelines.set(op.id, result.id);
          // Resolve's next timeline list comes a moment later; until then the
          // new timeline must not look deleted here.
          this.timelines = [...this.timelines.filter((t) => t.id !== result.id),
            { id: result.id, rcId: op.id, name: op.name, fps: op.fps, width: op.width, height: op.height }];
        }
        return result.ok;
      }
      case "timeline.set": {
        const local = this.localTimelines.get(op.id);
        if (!local) return false;
        const { type: _, id: __, ...fields } = op;
        const ok = (await this.run(key, { type: "tl.set", id: local, ...(fields as Record<string, JsonValue>) })).ok;
        if (ok) this.timelines = this.timelines.map((t) => (t.id === local ? { ...t, ...fields } : t));
        return ok;
      }
      case "timeline.delete": {
        const local = this.localTimelines.get(op.id);
        if (!local) return true;
        const ok = (await this.run(key, { type: "tl.delete", id: local })).ok;
        if (ok) this.timelines = this.timelines.filter((t) => t.id !== local);
        return ok;
      }
      case "track.create": {
        if (!localTimeline || !this.tracks) return false;
        const count = this.tracks[op.kind].length;
        if (op.order !== count + 1) {
          // Resolve can only add tracks at the end.
          return this.escalate(timeline!, "a track was inserted between others");
        }
        const result = await this.run(key, { type: "track.add", timeline: localTimeline, kind: op.kind, subType: op.subType, name: op.name, enabled: op.enabled, locked: op.locked });
        if (result.ok) this.trackMap.get(timeline!)?.[op.kind].push(op.id);
        return result.ok;
      }
      case "track.set": {
        const spot = this.trackSpot(op.id, timeline);
        if (!localTimeline || !spot) return false;
        const { type: _, id: __, order: ___, ...fields } = op;
        if (!Object.keys(fields).length) return true; // order follows from deletes
        return (await this.run(key, { type: "track.set", timeline: localTimeline, kind: spot.trackKind, index: spot.trackIndex, ...(fields as Record<string, JsonValue>) })).ok;
      }
      case "track.delete": {
        const spot = this.trackSpot(op.id, timeline);
        if (!localTimeline || !spot) return true;
        const result = await this.run(key, { type: "track.delete", timeline: localTimeline, kind: spot.trackKind, index: spot.trackIndex });
        if (result.ok) {
          const list = this.trackMap.get(timeline!)![spot.trackKind as "video" | "audio"];
          list.splice(spot.trackIndex - 1, 1);
        }
        return result.ok;
      }
      case "item.create": {
        if (!localTimeline) return false;
        const item = session.items[op.id] ?? (op as Item);
        return this.addItem(item, localTimeline, timeline!);
      }
      case "item.set": {
        const local = this.localItem(op.id);
        const item = session.items[op.id];
        if (!localTimeline || !local || !item) return false;
        if (this.options.forceTier === 2 || op.media !== undefined || op.edge !== undefined) return this.rebuild(item, local, localTimeline, timeline!);
        const command = this.setCommand(op, item, local, localTimeline, timeline!);
        if (!command) return this.rebuild(item, local, localTimeline, timeline!);
        // A refusal here isn't reported: the rebuild says so if it fails too.
        const result = await this.run(key, command, true);
        if (result.ok) return true;
        if (TRANSIENT.has(String(result.error))) return false;
        return this.rebuild(item, local, localTimeline, timeline!);
      }
      case "item.delete": {
        const local = this.localItem(op.id);
        if (!local || !localTimeline) return true;
        return (await this.run(key, { type: "item.delete", timeline: localTimeline, id: local })).ok;
      }
      // Markers (SPEC §21.4): a change is the marker added again. Only the
      // current timeline's are in the plan.
      case "marker.create":
      case "marker.set": {
        const marker = session.markers[op.id];
        if (!marker || !localTimeline) return false;
        const owner = marker.item ? this.localItem(marker.item) : localTimeline;
        if (!owner) return false;
        const spot = this.markerSpots.get(op.id);
        if (op.type === "marker.set" && !spot) return false;
        const tried = JSON.stringify(marker);
        if (this.gaveUp.get(op.id) === tried) return false;
        const target = { timeline: localTimeline, owner: { kind: marker.item ? "item" : "timeline", id: owner } };
        const values = { ...markerValues(marker), tag: tagOf(op.id) };
        const result = await this.run(key, spot ? { type: "marker.set", ...target, at: spot.frame, ...values } : { type: "marker.add", ...target, ...values }, true);
        if (result.ok) this.gaveUp.delete(op.id);
        else if (!TRANSIENT.has(String(result.error))) {
          this.gaveUp.set(op.id, tried);
          this.options.log(markerFailure(marker, String(result.error)));
        }
        return result.ok;
      }
      case "marker.delete": {
        const spot = this.markerSpots.get(op.id);
        if (!spot || !localTimeline) return true;
        return (await this.run(key, { type: "marker.delete", timeline: localTimeline, owner: { kind: spot.kind, id: spot.owner }, frame: spot.frame })).ok;
      }
    }
  }

  private setCommand(op: Extract<TimelineOp, { type: "item.set" }>, item: Item, local: string, localTimeline: string, timeline: string): Command | null {
    const { type: _, id: __, track, link: ___, ...fields } = op;
    const command: Command = { type: "item.set", timeline: localTimeline, id: local, ...(fields as Record<string, JsonValue>) };
    if (track !== undefined) {
      const spot = this.trackSpot(track, timeline);
      if (!spot) return null;
      Object.assign(command, spot);
    }
    // Trims need the whole picture: where the item should start and end.
    if (op.start !== undefined || op.duration !== undefined || op.srcStart !== undefined) {
      Object.assign(command, { start: item.start, duration: item.duration, ...(item.srcStart !== undefined ? { srcStart: item.srcStart } : {}) });
    }
    // Only the link changed: applyLinks handles that.
    if (Object.keys(command).length === 3) return { type: "noop" };
    return command;
  }

  private addCommand(item: Item, localTimeline: string, timeline: string): Command | { error: string } {
    const spot = this.trackSpot(item.track, timeline);
    if (!spot) return { error: "unknown track" };
    const command: Command = {
      type: "item.add", timeline: localTimeline, kind: item.kind, ...spot, start: item.start, duration: item.duration,
      enabled: item.enabled, color: item.color, name: item.name,
    };
    if (item.kind === "clip") {
      const media = this.options.media.local(item.media!);
      if (!media) return { error: "media-missing" };
      Object.assign(command, { media, srcStart: item.srcStart ?? 0, speed: item.speed ?? 100 });
    }
    for (const k of ["fadeIn", "fadeOut", "template"] as const) if (item[k] !== undefined) command[k] = item[k]!;
    if (item.props) command.props = item.props;
    if (item.text) command.text = item.text as unknown as JsonValue;
    if (item.edge) {
      const edgeItem = this.localItem(item.edge.item);
      if (!edgeItem) return { error: "edge item missing" };
      command.edge = { item: edgeItem, side: item.edge.side, alignment: item.edge.alignment };
    }
    return command;
  }

  private async addItem(item: Item, localTimeline: string, timeline: string): Promise<boolean> {
    const command = this.addCommand(item, localTimeline, timeline);
    if ("error" in command) {
      if (command.error === "media-missing") this.retrySoon = true;
      if (command.error === "media-missing" && !this.warned.has(`media:${item.id}`)) {
        this.warned.add(`media:${item.id}`);
        this.options.log(`"${item.name}" is waiting for its media before it can be added to the timeline`);
      }
      return false;
    }
    const tried = JSON.stringify(item);
    if (this.gaveUp.get(item.id) === tried) return false;
    const result = await this.run(itemKey("item", item.id), command);
    if (result.ok && typeof result.id === "string") {
      this.itemMap.set(result.id, item.id);
      this.gaveUp.delete(item.id);
    } else if (!result.ok && !TRANSIENT.has(String(result.error))) {
      this.gaveUp.set(item.id, tried);
    }
    return result.ok;
  }

  // Tier 2 (SPEC §20.6): delete the item and add it again with every value.
  private async rebuild(item: Item, local: string, localTimeline: string, timeline: string): Promise<boolean> {
    if (this.gaveUp.get(item.id) === JSON.stringify(item)) return false;
    const deleted = await this.run(itemKey("item", item.id), { type: "item.delete", timeline: localTimeline, id: local });
    if (TRANSIENT.has(String(deleted.error))) return false;
    if (!deleted.ok) return this.escalate(timeline, `couldn't rebuild "${item.name}"`);
    this.itemMap.delete(local);
    this.items.delete(local);
    // Its markers went with it: they're still to add, not deleted on this PC.
    if (this.base) for (const m of Object.values(this.base.markers)) if (m.item === item.id) delete this.base.markers[m.id];
    if (await this.addItem(item, localTimeline, timeline)) return true;
    // It's gone from Resolve now: in the base too, so the next pass sees an
    // item still to add rather than one this PC deleted.
    if (this.base) applyTimelineOp(this.base, { type: "item.delete", id: item.id });
    if (TRANSIENT.has(String(this.lastError))) return false;
    return this.escalate(timeline, `couldn't rebuild "${item.name}"`);
  }

  private async escalate(timeline: string, why: string): Promise<boolean> {
    if (this.options.forceTier !== 3 || !this.options.swap) {
      const note = `escalate:${timeline}:${why}`;
      if (!this.failures.has(note)) {
        this.failures.add(note);
        this.options.log(`${why}; this change can't be synced here, so make it by hand on this PC`);
      }
      return false;
    }
    this.options.log(`${why}; replacing this timeline with a copy from another PC`);
    return this.swapTimeline(timeline);
  }

  // Tier 3 (SPEC §20.6). The swapped-in copy has new item IDs, so the maps
  // for this timeline are rebuilt from the session on the next pass.
  private async swapTimeline(timeline: string): Promise<boolean> {
    const local = this.localTimelines.get(timeline);
    if (!local || !this.options.swap) return false;
    const ok = await this.options.swap(timeline, local);
    if (ok) {
      this.trackMap.delete(timeline);
      const stale = new Set(Object.values(this.session?.items ?? {}).filter((i) => i.timeline === timeline).map((i) => i.id));
      for (const [l, c] of this.itemMap) if (stale.has(c)) this.itemMap.delete(l);
      this.catchUp = true;
      this.schedule();
    }
    return ok;
  }

  // Linked video and audio (SPEC §20.2): Resolve links what the session links.
  private async applyLinks(session: Timelines, timeline: string): Promise<void> {
    const localTimeline = this.localTimelines.get(timeline);
    if (!localTimeline) return;
    const groups = new Map<string, string[]>();
    for (const item of Object.values(session.items)) {
      if (item.timeline !== timeline || item.kind !== "clip" || !item.link) continue;
      const local = this.localItem(item.id);
      if (local) groups.set(item.link, [...(groups.get(item.link) ?? []), local]);
    }
    for (const ids of groups.values()) {
      if (ids.length < 2) continue;
      const linked = ids.every((id) => ids.every((other) => other === id || this.items.get(id)?.linked.includes(other)));
      if (!linked) await this.run(`link:${ids[0]}`, { type: "item.link", timeline: localTimeline, ids, linked: true });
    }
  }

  // Resolve now holds the session's value: that is the new agreed base.
  private agree(op: TimelineOp, session: Timelines): void {
    this.base ??= emptyTimelines();
    const kind = op.type.split(".")[0]!;
    const table = timelineDomain.table(this.base, kind);
    const current = timelineDomain.table(session, kind)[op.id];
    if (op.type.endsWith(".delete") || !current) applyTimelineOp(this.base, { type: `${kind}.delete`, id: op.id } as TimelineOp);
    else if (op.type.endsWith(".create") || !table[op.id]) table[op.id] = structuredClone(current);
    else applyTimelineOp(this.base, op);
  }

  private async run(key: string, command: Command, quiet = false): Promise<BridgeResult> {
    if (command.type === "noop") return { ok: true };
    if (this.options.userBusy?.()) {
      this.retrySoon = true;
      return { ok: false, error: "user-editing" };
    }
    this.busy.add(key);
    try {
      const result = await this.options.send(command);
      for (const record of Array.isArray(result.records) ? result.records : []) {
        const r = record as Record<string, JsonValue>;
        if (r.timeline === this.current) this.record(r);
      }
      for (const gone of Array.isArray(result.gone) ? result.gone : []) this.items.delete(String(gone));
      // Timeline marker commands say which frames they cleared.
      for (const frame of Array.isArray(result.markerGone) ? result.markerGone : []) this.markers.delete(Number(frame));
      // Track commands return the new track list (the bridge doesn't report
      // its own changes as events).
      const tracks = result.tracks as Record<string, JsonValue> | undefined;
      if (tracks && typeof tracks === "object" && tracks.timeline === this.current) {
        this.tracks = { video: (tracks.video ?? []) as unknown as LocalTrack[], audio: (tracks.audio ?? []) as unknown as LocalTrack[] };
      }
      this.lastError = result.ok ? undefined : result.error;
      // The user is still changing the timeline in Resolve, or Resolve can't
      // read the item back yet: try again shortly.
      if (result.error === "user-editing" || result.error === "unreadable") this.retrySoon = true;
      const failure = `${command.type}:${key}:${result.error}`;
      if (!result.ok && !quiet && !TRANSIENT.has(String(result.error)) && !this.failures.has(failure)) {
        this.failures.add(failure);
        this.options.log(`Resolve couldn't ${command.type} for ${key.split(":")[0]} ${key.slice(-8)} (${result.error})`);
      }
      return result;
    } finally {
      this.busy.delete(key);
    }
  }

  private record(r: Record<string, JsonValue>): void {
    if (r.type === "tl.marker") {
      const [marker] = localMarkers([r]);
      this.markers.set(marker!.frame, marker!);
      return;
    }
    const item = { ...(r as unknown as LocalItem), linked: Array.isArray(r.linked) ? r.linked.map(String) : [], markers: localMarkers(r.markers) };
    this.items.set(String(r.id), item);
  }

  // --- saved state -------------------------------------------------------------

  private load(): void {
    const store = this.options.store;
    if (!store || !existsSync(store)) return;
    const saved = JSON.parse(readFileSync(store, "utf8")) as { base: Timelines | null; itemMap: [string, string][]; trackMap: [string, TrackLists][] };
    this.base = saved.base;
    if (this.base) this.base.markers ??= {}; // saved before M5
    for (const [k, v] of saved.itemMap ?? []) this.itemMap.set(k, v);
    for (const [k, v] of saved.trackMap ?? []) this.trackMap.set(k, v);
  }

  private save(): void {
    const store = this.options.store;
    if (!store) return;
    mkdirSync(dirname(store), { recursive: true });
    const data = { base: this.base, itemMap: [...this.itemMap], trackMap: [...this.trackMap] };
    writeFileSync(`${store}.tmp`, JSON.stringify(data));
    renameSync(`${store}.tmp`, store);
  }
}
